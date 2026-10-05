#!/usr/bin/env node
// parallelsandbox-mcp: stdio in, ParallelSandbox Streamable HTTP out.
// Every tool call is forwarded to https://mcp.parallelsandbox.com/mcp with OAuth (or an optional API key), except sandbox_sync,
// which compares the local directory with the box, tars only the files that differ and uploads them through
// POST /v1/boxes/{id}/sync.

import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse as parsePath, posix, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { LoginRequired, OAuthSession } from "./oauth.mjs";
import { createClaudeChannel, CLAUDE_CHANNEL_CAPABILITIES, CLAUDE_CHANNEL_INSTRUCTIONS } from "./claude-channel.mjs";
import { createCodexFeedback } from "./codex-host.mjs";
import { createFeedbackRoute } from "./feedback-relay.mjs";
import { reviewInstallNote, setupInstructions } from "./feedback-install.mjs";
import { sessionBridge } from "./session-bridge.mjs";

// Subcommands share this bin: host hooks, their one-time install, and the feedback relay.
const subcommand = process.argv[2];
if (subcommand === "hook") process.exit(await (await import("./feedback-hook.mjs")).hookMain(process.argv.slice(2)));
if (subcommand === "install") process.exit((await import("./feedback-install.mjs")).installMain(process.argv.slice(2)));

const API_KEY = process.env.PARALLELSANDBOX_API_KEY || "";
const MCP_URL = process.env.PARALLELSANDBOX_MCP_URL || "https://mcp.parallelsandbox.com/mcp";
const API_URL = (process.env.PARALLELSANDBOX_API_URL || "https://api.parallelsandbox.com").replace(/\/+$/, "");
const TAKEOVER_TIMEOUT_MS = 31 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 65 * 60 * 1000;
// The host's absolute tool deadline is independent of this adapter's SDK timer.
function reviewWaitBudget(hostTimeoutSec = process.env.PSBX_TOOL_TIMEOUT_SEC) {
 const parsed = Number(hostTimeoutSec);
 const hostSec = Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
 return Math.min(1800, Math.max(0, Math.floor(hostSec) - 35));
}
const SYNC_EXCLUDES = ["node_modules", ".git", "dist", "dist-web", "build", ".cache", "coverage", ".venv", "venv", "__pycache__", "target", ".next", ".turbo"];
// 箱子回報要傳的檔超過這個數就整包傳：清單比整包還長時比對沒有意義，exec 的輸出也有上限。
const COMPARE_LIMIT = 400;
// dest 裡多出來的檔（這次挑檔規則下會送、本機卻沒有的）箱子最多列這麼多個。一個資料夾底下沒有任何要送的檔時，
// 檔數在 STALE_DIR_FILES 以內就一個個列，超過就整個資料夾算一筆（dir/），箱子自己產生的大目錄才不會塞滿清單。
const STALE_LIMIT = 1000;
const STALE_DIR_FILES = 200;
// 回傳裡的路徑清單只列前面這麼多個，總數另外寫。
const SHOW_PATHS = 50;
const SHOW_FEW = 20;
// 這幾種檔一改，開著的 dev server（vite、webpack、Metro）會整頁重載或重啟，頁面上的狀態跟著沒了。
const RELOADS_DEV_SERVER = /^(package\.json|vite\.config\..+|tsconfig.*|\.env.*)$/;
// 一次 sync 要送的量（磁碟上的大小）超過這麼多 MB 就先不送，回最大的幾個資料夾，maxMB 可以調。
// 使用回饋：沒被 .gitignore 的 dist-win（191.6 MB）、過大的 work 目錄整包送進去，只能中止後縮小範圍。
const DEFAULT_MAX_MB = 100;
const MB = 1024 * 1024;
// 建置要的設定檔：被 ignore 規則略過時，回傳提醒怎麼補送（使用回饋：插件自己的 .gitignore 排掉 tsconfig.json，tsc -p 找不到）。
const BUILD_CONFIG = /^(package\.json|tsconfig.*\.json|jsconfig\.json|.+\.config\.[^.]+|\.env.*)$/;
// 這幾種 lockfile 所在的資料夾要有 node_modules；sync 從不送 node_modules，箱子裡要自己裝。
const LOCKFILES = { "package-lock.json": "npm ci", "npm-shrinkwrap.json": "npm ci", "pnpm-lock.yaml": "pnpm install --frozen-lockfile", "yarn.lock": "yarn install --frozen-lockfile" };
// 常被直接 ./ 執行的腳本：git 記成 100644 時送過去就沒有執行權限（使用回饋：./gradlew 回 Permission denied）。
const RUN_DIRECTLY = /^(gradlew|mvnw)$|\.sh$/;

// entryHash：一般檔是內容加可執行位元（boxd 判斷同一個檔也看這兩樣），連結是指向的路徑。
// 其他東西（目錄、已刪掉的檔）回 null，一律照送，交給 tar 與 boxd 照原本的方式處理。
// 箱子裡的比對程式嵌入的是這個函式的原始碼，兩邊算法不會分岔。
function entryHash(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return createHash("sha1").update("l:").update(readlinkSync(p, { encoding: "buffer" })).digest("hex");
  if (st.isFile()) return createHash("sha1").update("f:" + (st.mode & 0o111).toString(8) + ":").update(readFileSync(p)).digest("hex");
  return null;
}

// staleEntries 在箱子裡跑（原始碼嵌進比對程式）：走一遍 base（dest 的絕對路徑，Buffer），找出不在 keep（這次要送的路徑，hex）裡的東西。
// 本機刪掉、改名的檔留在箱子裡，tsc、go build 會多報錯，還容易被當成新錯誤（使用回饋九次）。
// 只走 roots（相對 dest 的資料夾，hex；"" 是整個 dest）。skip 裡的名字（node_modules 這類）底下沒有要送的檔就整個略過。
// 連結一律當成一個檔，不跟進去：底下有要送的檔的連結（指向別處的資料夾）既不走進去、也不算多出來的。
// 回 { stale: [hex，結尾 / 的是整個資料夾], staleTotal }。
function staleEntries(base, keep, roots, skip, limit, dirFiles) {
  const slash = Buffer.from("/");
  const at = (rel) => (rel.length ? Buffer.concat([base, slash, rel]) : base);
  const child = (rel, name) => (rel.length ? Buffer.concat([rel, slash, name]) : name);
  const list = (rel) => {
    try {
      return readdirSync(at(rel), { withFileTypes: true, encoding: "buffer" });
    } catch {
      return [];
    }
  };
  // holds：底下有要送的檔的資料夾，要走進去一個個比。
  const holds = new Set();
  for (const hex of keep) {
    const p = Buffer.from(hex, "hex");
    for (let i = 0; i < p.length; i++) if (p[i] === 47) holds.add(p.subarray(0, i).toString("hex"));
  }
  const stale = [];
  let staleTotal = 0;
  const add = (rel) => {
    staleTotal++;
    if (stale.length < limit) stale.push(rel.toString("hex"));
  };
  // everything：整個資料夾都不在 keep 裡，列出底下的檔；超過 dirFiles 個就回 null。
  const everything = (rel, out) => {
    for (const d of list(rel)) {
      if (skip.has(d.name.toString())) continue;
      const c = child(rel, d.name);
      if (d.isDirectory()) {
        if (!everything(c, out)) return null;
      } else {
        out.push(c);
        if (out.length > dirFiles) return null;
      }
    }
    return out;
  };
  const walk = (rel) => {
    for (const d of list(rel)) {
      const c = child(rel, d.name);
      const hex = c.toString("hex");
      if (keep.has(hex)) continue;
      if (holds.has(hex)) {
        if (d.isDirectory()) walk(c);
        continue;
      }
      if (skip.has(d.name.toString())) continue;
      if (!d.isDirectory()) {
        add(c);
        continue;
      }
      const files = everything(c, []);
      if (files) files.forEach(add);
      else add(Buffer.concat([c, slash]));
    }
  };
  for (const r of roots) walk(Buffer.from(r, "hex"));
  return { stale, staleTotal };
}

// pruneEntries 在箱子裡跑（原始碼嵌進刪檔程式）：刪掉 dest 底下這些路徑（hex，結尾 / 的是整個資料夾），
// 再把因此變空的上層資料夾收掉。路徑都是比對那一步從 dest 自己列出來的；這裡還是擋掉 ..、絕對路徑與穿過連結跑出 dest 的。
function pruneEntries(dest, hexes) {
  const root = realpathSync(Buffer.from(dest), { encoding: "buffer" });
  const parentOf = (p) => p.subarray(0, p.lastIndexOf(47));
  const inside = (p) => p.equals(root) || (p.length > root.length && p[root.length] === 47 && p.subarray(0, root.length).equals(root));
  let deleted = 0;
  const failed = [];
  for (const hex of hexes) {
    let rel = Buffer.from(hex, "hex");
    while (rel.length && rel[rel.length - 1] === 47) rel = rel.subarray(0, rel.length - 1);
    if (!rel.length || rel[0] === 47 || rel.toString("latin1").split("/").some((s) => s === "" || s === "." || s === "..")) {
      failed.push(hex);
      continue;
    }
    const target = Buffer.concat([root, Buffer.from("/"), rel]);
    try {
      if (!inside(realpathSync(parentOf(target), { encoding: "buffer" }))) {
        failed.push(hex);
        continue;
      }
      const st = lstatSync(target);
      rmSync(target, { recursive: st.isDirectory(), force: true });
      deleted++;
      for (let up = parentOf(target); up.length > root.length; up = parentOf(up)) {
        try {
          rmdirSync(up);
        } catch {
          break;
        }
      }
    } catch {
      failed.push(hex);
    }
  }
  return { deleted, failed };
}

// depsState 在箱子裡跑（原始碼嵌進比對程式）：plan 是送去的樹裡每個 lockfile 所在的資料夾（相對 dest，"." 是 dest 本身），
// 看那裡的 node_modules 在不在；npm 的 lockfile 另外帶 want（[套件路徑, 版本]），一個個讀裝好的 package.json 比版本。
// 回有問題的那幾個：state missing（沒有 node_modules）或 stale（differ 個套件沒裝或版本不同，examples 是前幾個）。
// 使用回饋：增量同步後 node_modules 還是舊的（缺 @tiptap/react、@capacitor/clipboard），tsc 被缺模組的錯誤淹沒；
// Go 專案裡的 sdk/ 子專案沒裝依賴，整合測試報 Cannot find module 'express'。
function depsState(base, plan) {
  const out = [];
  for (const d of plan) {
    const at = d.dir === "." ? base : base + "/" + d.dir;
    if (!existsSync(at + "/node_modules")) {
      out.push({ dir: d.dir, lock: d.lock, state: "missing" });
      continue;
    }
    if (!d.want) continue;
    let differ = 0;
    const examples = [];
    for (const [key, version] of d.want) {
      let have = null;
      try {
        have = JSON.parse(readFileSync(at + "/" + key + "/package.json", "utf8")).version || null;
      } catch {}
      if (have === version) continue;
      differ++;
      if (examples.length < 5) {
        const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
        examples.push(have ? name + " " + have + " (lockfile: " + version + ")" : name + " (not installed)");
      }
    }
    if (differ) out.push({ dir: d.dir, lock: d.lock, state: "stale", differ, wanted: d.want.length, examples });
  }
  return out;
}

// 箱子裡跑的比對程式：<dir>/manifest 每行「雜湊 空格 路徑 bytes 的 hex」（檔名不一定是合法 UTF-8），
// 跟 dest 現有的檔一個個比，印出不一樣或不存在的路徑。雜湊是 "-" 的是照送、不比對的路徑（子模組這種資料夾），
// "=" 的是 exclude 擋下、不送也不比的檔；兩種都只拿來認得它不是多出來的。
// <dir>/opts.json：limit（不一樣的超過這麼多就回 all）、stale（有給時用 staleEntries 列出 dest 裡多出來的東西）、
// deps（depsState 的 plan）。讀進來就把自己這包刪掉。
const COMPARE_SCRIPT = `import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
${entryHash.toString()}
${staleEntries.toString()}
${depsState.toString()}
const [dir, dest] = process.argv.slice(2);
const lines = readFileSync(dir + "/manifest", "utf8").split("\\n").filter(Boolean);
const opts = JSON.parse(readFileSync(dir + "/opts.json", "utf8"));
rmSync(dir, { recursive: true, force: true });
const base = dest.replace(/\\/+$/, "");
const deps = opts.deps && opts.deps.length ? depsState(base, opts.deps) : [];
if (!existsSync(dest)) {
  console.log(JSON.stringify({ all: true, fresh: true, deps }));
  process.exit(0);
}
const prefix = Buffer.from(base + "/");
const keep = new Set();
let changed = [];
let all = false;
for (const line of lines) {
  const space = line.indexOf(" ");
  const hash = line.slice(0, space);
  const hex = line.slice(space + 1);
  keep.add(hex);
  if (all || hash === "-" || hash === "=") continue;
  if (entryHash(Buffer.concat([prefix, Buffer.from(hex, "hex")])) !== hash) {
    changed.push(hex);
    if (changed.length > Number(opts.limit)) {
      all = true;
      changed = [];
    }
  }
}
const out = all ? { all: true, deps } : { changed, deps };
if (opts.stale) {
  const o = opts.stale;
  Object.assign(out, staleEntries(Buffer.from(base), keep, o.roots, new Set(o.skip), o.limit, o.dirFiles));
}
console.log(JSON.stringify(out));
`;

// 箱子裡跑的刪檔程式（sandbox_sync 帶 prune 時）：清單每行一個路徑的 hex。
const PRUNE_SCRIPT = `import { lstatSync, readFileSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
${pruneEntries.toString()}
const [list, dest] = process.argv.slice(2);
const hexes = readFileSync(list, "utf8").split("\\n").filter(Boolean);
rmSync(dirname(list), { recursive: true, force: true });
console.log(JSON.stringify(pruneEntries(dest, hexes)));
`;

const log = (...args) => console.error("[parallelsandbox-mcp]", ...args);

const oauth = API_KEY ? null : new OAuthSession({ mcpUrl: MCP_URL, log });
const authorizedFetch = (url, init) => oauth ? oauth.fetch(url, init) : fetch(url, init);

const remote = new Client({ name: "parallelsandbox-mcp", version: "0.5.3" });
// 同一個 headers 物件每次請求都會被讀到，所以握手拿到對方是誰之後直接塞進去。
// 沒有這個，control 只知道「某個 API key 開了箱子」，人在 app 裡看不出是 Claude 還是 Codex 在用。
const managedSession = sessionBridge();
// X-Psbx-Tool-Wait-Sec 是 host 撐得住的一次工具呼叫等待：sandbox_start 的 waitForCapacitySec 照它封頂。
// 受託管的對話交件一律馬上回（Review-Wait 0），但開箱等位子照樣能等，所以兩個分開帶。
const remoteHeaders = { ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}), "X-Psbx-Review-Wait-Sec": managedSession ? "0" : String(reviewWaitBudget()),
  "X-Psbx-Tool-Wait-Sec": String(reviewWaitBudget()) };
let connected = false;
let connecting = null;
// SDK 出錯（回應串流斷掉、解析不了）預設一個字都不留；寫到 stderr，client 的 MCP log 才查得到。
remote.onerror = (err) => log("remote:", err?.message || err);

// 每一次轉給 control 的呼叫都有看門狗。control 對跑超過 20 秒的工具每 20 秒在連線上送一則 still running
// （sandbox_takeover 每 15 秒），所以正常的呼叫連線上一直有位元組。SDK 的 Streamable HTTP client 在回應串流斷掉、
// 或串流結束了卻沒拿到結果時什麼都不做（伺服器沒給 event id 就不重連），那次呼叫會一直等到 65 分鐘逾時，
// Claude Code 在 30 分鐘沒動靜時先砍掉。實際發生過：control 在第 363 秒把 10 KB 的結果送完了，這裡一直沒交出去，卡滿 30 分鐘。
// 看門狗管兩件事：串流結束了 ENDED_GRACE_MS 還沒拿到結果；連線 SILENCE_MS 沒有任何位元組（就把它切掉）。兩種都立刻回錯。
const SILENCE_MS = Number(process.env.PSBX_ADAPTER_SILENCE_MS) || 75_000;
const ENDED_GRACE_MS = Math.min(5_000, SILENCE_MS / 3);
const WATCH_TICK_MS = Math.min(5_000, SILENCE_MS / 5);
// 轉給 client 的進度最多這麼久一則（client 靠它知道呼叫還活著，Claude Code 30 分鐘沒有就砍）。
const PROGRESS_EVERY_MS = Math.min(10_000, SILENCE_MS / 3);
const callScope = new AsyncLocalStorage();

class CallWatch {
  constructor(onAlive) {
    this.onAlive = onAlive;
    this.fetches = 0;
    this.bytes = 0;
    this.lastByte = Date.now();
    this.lastTick = Date.now();
    this.ended = null;
    this.lost = null;
    this.conn = new AbortController(); // 切掉往 control 的那條連線
    this.call = new AbortController(); // 結束 SDK 裡等結果的那次呼叫
  }
  alive(n) {
    this.lastByte = Date.now();
    this.bytes += n;
    if (n > 0) this.onAlive?.();
  }
  end(why) {
    if (!this.ended) this.ended = { at: Date.now(), why };
  }
  check() {
    const now = Date.now();
    // 電腦睡著時計時器不跑：醒來看到的空檔不算連線沒聲音，重新給它一段時間。
    if (now - this.lastTick > WATCH_TICK_MS * 3) this.lastByte = now;
    this.lastTick = now;
    if (this.ended && now - this.ended.at > ENDED_GRACE_MS) {
      this.lose(`the response stream ${this.ended.why} without the result (${this.bytes} bytes received)`);
    } else if (!this.ended && this.fetches > 0 && now - this.lastByte > SILENCE_MS) {
      const why = `no data from ParallelSandbox for ${Math.round((now - this.lastByte) / 1000)}s (${this.bytes} bytes received)`;
      this.conn.abort(new Error(why));
      this.lose(why);
    }
  }
  lose(why) {
    if (this.lost) return;
    this.lost = why;
    this.call.abort(new Error(why));
  }
}

// watchedFetch 是給 SDK 用的 fetch：在一次呼叫的範圍裡（callScope）發出去的請求，回應串流的每一塊都記在那次呼叫的看門狗上。
async function watchedFetch(url, init = {}) {
  const w = callScope.getStore();
  if (!w) return authorizedFetch(url, init);
  w.fetches++;
  w.ended = null;
  w.lastByte = Date.now();
  const signal = init.signal ? anySignal(init.signal, w.conn.signal) : w.conn.signal;
  const res = await authorizedFetch(url, { ...init, signal });
  w.alive(0);
  if (!res.body || [101, 204, 205, 304].includes(res.status)) {
    w.end("closed");
    return res;
  }
  const reader = res.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        w.end(`broke (${err?.message || err})`);
        controller.error(err);
        return;
      }
      if (chunk.done) {
        w.end("ended");
        controller.close();
        return;
      }
      w.alive(chunk.value.byteLength);
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      w.end("was cancelled");
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

// anySignal：兩個訊號任一個中止就中止（AbortSignal.any 要 Node 20.3 以上）。
function anySignal(a, b) {
  if (AbortSignal.any) return AbortSignal.any([a, b]);
  const both = new AbortController();
  for (const s of [a, b]) {
    if (s.aborted) both.abort(s.reason);
    else s.addEventListener("abort", () => both.abort(s.reason), { once: true });
  }
  return both.signal;
}

// callWatched 呼叫一次遠端工具；結果沒回來而是看門狗判定連線沒了，回 { lost }。
async function callWatched(name, args, timeout, onAlive, signal) {
  const w = new CallWatch(onAlive);
  const cancel = () => {
    w.conn.abort(signal.reason);
    w.call.abort(signal.reason);
  };
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  const timer = setInterval(() => w.check(), WATCH_TICK_MS);
  try {
    const result = await callScope.run(w, () =>
      remote.callTool({ name, arguments: args || {} }, undefined, {
        timeout, resetTimeoutOnProgress: true, signal: w.call.signal,
        onprogress: onAlive ? (progress) => onAlive(progress) : undefined,
      }));
    return { result };
  } catch (err) {
    if (w.lost) return { lost: w.lost };
    throw err;
  } finally {
    clearInterval(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

// 這個對話還在不在（control 的 agents 表）。一個 adapter 程序就是一個對話：啟動時取一個隨機 id 放在 X-Psbx-Agent，
// control 記下每個箱子最後是哪個對話在動。第一次呼叫工具之後每分鐘打一次心跳；對話被關掉（stdin 斷、收到結束訊號）
// 就打 leave，這個對話動過、沒交件也沒收掉的箱子，在 app 上變成「AI 停手了」，人一看就知道要接著做還是收掉。
// kill -9 來不及打 leave，control 三分鐘沒收到心跳也會當它走了。
const AGENT_ID = managedSession?.agentId || randomBytes(9).toString("base64url");
remoteHeaders["X-Psbx-Agent"] = AGENT_ID;
const HEARTBEAT_MS = 60_000;
let heartbeat = null;

// presence 打 heartbeat 或 leave；失敗不影響任何工具，回 false 就好。
async function presence(what, timeoutMs) {
  try {
    const res = await authorizedFetch(`${API_URL}/v1/agents/${AGENT_ID}/${what}`, {
      method: "POST",
      headers: { ...remoteHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(what === "heartbeat" ? { client: remoteHeaders["X-Psbx-Client"] || "" } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// startPresence 在第一次呼叫工具時才開始跳：只是設定了 MCP、從沒用過箱子的對話不必每分鐘打來。
function startPresence() {
  // A managed native turn is a temporary writer; its supervisor owns the
  // original conversation's presence while waiting between these processes.
  if (managedSession) return;
  if (heartbeat) return;
  presence("heartbeat", 10_000);
  heartbeat = setInterval(() => presence("heartbeat", 10_000), HEARTBEAT_MS);
  heartbeat.unref();
}

let leaving = false;
let claudeChannel = null;
let codexFeedback = null;
async function leaveAndExit(code) {
  if (leaving) return;
  leaving = true;
  await claudeChannel?.shutdown();
  await codexFeedback?.stop();
  if (heartbeat) {
    clearInterval(heartbeat);
    await presence("leave", 2_000);
  }
  process.exit(code);
}

// watchForExit：client 關掉對話時通常是關 stdin，或送 SIGTERM／SIGINT／SIGHUP；每一種都先說一聲再走。
function watchForExit() {
  process.stdin.on("end", () => leaveAndExit(0));
  for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]]) {
    process.on(sig, () => leaveAndExit(code));
  }
}

async function connectRemote() {
  if (connected) return;
  if (connecting) return connecting;
  connecting = (async () => {
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: remoteHeaders }, fetch: watchedFetch });
    try {
      await remote.connect(transport);
      connected = true;
      log("connected to", MCP_URL);
    } catch (err) { await transport.close(); throw err; }
  })().finally(() => { connecting = null; });
  return connecting;
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

// gitFileList 問 repo 自己：追蹤中的檔案加上沒被 .gitignore 忽略的新檔，NUL 分隔。
// 這比固定黑名單準得多——開發者早就在 .gitignore 宣告過什麼是產物。實測 CubeLV 的 renderer：
// 黑名單口徑 4,434 MB（ios/DerivedData、ios/App/build、android/.gradle、dist-web-public 全都跟著上傳），
// git 口徑 18 MB。不是 git 工作區就回 null，退回黑名單。
function gitFileList(src) {
  const inRepo = spawnSync("git", ["-C", src, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (inRepo.status !== 0 || inRepo.stdout.trim() !== "true") return null;
  const ls = spawnSync("git", ["-C", src, "ls-files", "-co", "--exclude-standard", "-z"], { maxBuffer: 512 * 1024 * 1024 });
  if (ls.status !== 0) return null;
  // ls-files 連「還被追蹤、但本機已經刪掉」的檔也會列出來，tar 對這種檔會 Cannot stat 然後整包 exit 1，
  // 一次同步全滅。開發中刪掉一個追蹤檔是再平常不過的狀態，所以這裡先把它們挑掉。
  const gone = spawnSync("git", ["-C", src, "ls-files", "-d", "-z"], { maxBuffer: 512 * 1024 * 1024 });
  if (gone.status !== 0 || gone.stdout.length === 0) return ls.stdout;
  const deleted = new Set(splitNul(gone.stdout).map((p) => p.toString("binary")));
  const kept = splitNul(ls.stdout).filter((p) => !deleted.has(p.toString("binary")));
  return kept.length === 0 ? Buffer.alloc(0) : Buffer.concat(kept.flatMap((p) => [p, Buffer.from([0])]));
}

// repoName 回這個目錄所屬 git repo 的名字（工作區根目錄的資料夾名），不是 git 工作區就回空字串。
// 箱子卡片上的標籤只列這個：同步進去的 scratch 目錄（tools、deps、暫時的複本）不是 repo，不該被當成 repo。
function repoName(src) {
  const top = spawnSync("git", ["-C", src, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) return "";
  return basename(top.stdout.trim());
}

// upload tars src (only the NUL-separated paths in list when given, otherwise the whole directory minus
// SYNC_EXCLUDES) and streams it to the box through control. Returns { bytes } or { error }.
// STALL_MS：上傳多久沒有任何位元組移動就算卡住。真的在傳的時候每幾毫秒就有一塊，
// 兩分鐘不動代表另一頭沒在收——與其讓呼叫端等滿 30 分鐘的逾時，不如講清楚卡在哪一步、傳到哪。
const STALL_MS = Number(process.env.PSBX_ADAPTER_STALL_MS) || 120_000;
// 拿到 control 的回應之後，tar 最多再等這麼久結束：對方讀完整包才會回成功，tar 早該寫完；
// 以前在這裡無限等 tar 的 close，一次卡住就是整個工具呼叫沒有回應。
const TAR_EXIT_GRACE_MS = 10_000;
// 整包送完之後等箱子回答的上限：箱子要解開、一個個比對寫進 dest，大的樹也是幾十秒的事。
const ANSWER_MS = Number(process.env.PSBX_ADAPTER_ANSWER_MS) || 10 * 60_000;

// meter（可省略）：上傳中隨時更新 meter.bytes（已送出的壓縮後位元組），給進度回報讀。
async function upload(id, dest, src, list, repo = "", noDenylist = false, meter = null) {
  // A tar stream cannot be replayed after a 401. Refresh before starting it.
  const headers = oauth ? await oauth.headers(remoteHeaders, { minValidityMs: 5 * 60_000 }) : remoteHeaders;
  // 串流上傳，不把整包 tar 讀進記憶體：真實專案很容易超過幾 GB，buffer 起來會直接 OOM。
  // COPYFILE_DISABLE=1：macOS 的 bsdtar 預設把每個檔的擴充屬性另存成 AppleDouble 成員（._foo），
  // 在 Mac 上列檔會自己合回去所以看不出來，到 Linux 箱子裡就是一堆真的垃圾檔。
  // 實測同步 CubeLV：4,160 個成員裡 2,063 個是這種，*.json 之類的 glob 會掃到二進位檔。
  const tarEnv = { ...process.env, COPYFILE_DISABLE: "1" };
  const tar = list
    ? spawn("tar", ["-czf", "-", "-C", src, "--null", "-T", "-"], { env: tarEnv })
    : spawn("tar", ["-czf", "-", "-C", src, ...(noDenylist ? [] : SYNC_EXCLUDES.map((e) => `--exclude=${e}`)), "."], { env: tarEnv });
  if (list) {
    tar.stdin.on("error", () => {});
    tar.stdin.end(list);
  }
  let bytes = 0;
  let movedAt = Date.now();
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      movedAt = Date.now();
      if (meter) meter.bytes = bytes;
      cb(null, chunk);
    },
  });
  // 看門狗兩件事：tar 還在送卻 STALL_MS 沒有任何位元組移動（另一頭沒在收）；整包送完了 ANSWER_MS 還沒拿到箱子的回答。
  // 兩種都切掉這次請求，訊息裡講卡在哪一步、送了多少，不讓呼叫端等滿 client 的 30 分鐘。
  const ac = new AbortController();
  let stalled = "";
  let sentAt = 0;
  tar.on("close", () => (sentAt = Date.now()));
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (!sentAt && now - movedAt >= STALL_MS) stalled = "upload";
    else if (sentAt && now - sentAt >= ANSWER_MS) stalled = "answer";
    else return;
    clearInterval(watchdog);
    tar.kill("SIGKILL");
    ac.abort(new Error(`stalled (${stalled})`));
  }, Math.min(5_000, STALL_MS / 4, ANSWER_MS / 4));
  const stallNote = () => stalled === "answer"
    ? `stalled after uploading: the box did not answer within ${Math.round(ANSWER_MS / 1000)}s of receiving all ${(bytes / MB).toFixed(1)} MB`
    : `stalled while uploading: nothing moved for ${Math.round(STALL_MS / 1000)}s after ${(bytes / MB).toFixed(1)} MB`;
  let tarErr = "";
  tar.stderr.on("data", (d) => {
    if (tarErr.length < 4096) tarErr += d.toString();
  });
  const exited = new Promise((res) => tar.on("close", res));

  let response;
  let body;
  try {
    const query = `dest=${encodeURIComponent(dest)}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`;
    response = await fetch(`${API_URL}/v1/boxes/${encodeURIComponent(id)}/sync?${query}`, {
      method: "POST",
      headers: { ...Object.fromEntries(new Headers(headers)), "Content-Type": "application/gzip" },
      body: Readable.toWeb(tar.stdout.pipe(counter)),
      duplex: "half",
      signal: ac.signal,
    });
    // 回應的 body 也在看門狗底下讀：control 回了標頭卻一直不給內容，一樣算卡住。
    body = await response.text();
  } catch (err) {
    clearInterval(watchdog);
    tar.kill("SIGKILL");
    if (stalled) return { error: stallNote(), stalled: true };
    return { error: `sync failed while uploading: ${err?.message || err}${tarErr ? ` (tar: ${tarErr.trim()})` : ""}` };
  }
  clearInterval(watchdog);
  if (stalled) return { error: stallNote(), stalled: true };
  // 對方沒讀完就回錯（dest 不合法、箱子凍住）時，tar 還卡在寫不出去的 pipe 上，等它結束會等到天荒地老：
  // 實際發生過整個目錄 sync 帶錯 dest，掛滿 1800 秒。回錯了就直接收掉 tar；成功了也只再等它一小段。
  if (!response.ok) tar.kill("SIGKILL");
  let late = null;
  const code = await Promise.race([exited, new Promise((res) => {
    late = setTimeout(() => {
      tar.kill("SIGKILL");
      res("late");
    }, TAR_EXIT_GRACE_MS);
  })]);
  clearTimeout(late);
  if (!response.ok) {
    let message = body;
    try {
      message = JSON.parse(body).error || body;
    } catch {}
    return { error: `sync failed (HTTP ${response.status}): ${message}`, status: response.status };
  }
  if (code === "late") {
    return { error: `tar did not exit within ${TAR_EXIT_GRACE_MS / 1000}s after the box answered, so whether every file went over is unknown` };
  }
  if (code !== 0) {
    return { error: `tar failed (exit ${code}): ${tarErr.trim() || "no output"}` };
  }
  // changed 是 boxd 實際寫進 dest 的檔數（內容沒變的不碰）；舊版 control 不轉這個欄位。
  let changed;
  try {
    const n = JSON.parse(body).changed;
    if (Number.isInteger(n)) changed = n;
  } catch {}
  return { bytes, changed };
}

// 傳到一半連線斷掉（fetch failed、ECONNRESET）或 control 回 502／504：sync 是合併語意，再送一次結果一樣，所以自動重試一次。
// 使用回饋：commit: HEAD 第一次回「sync failed while uploading: fetch failed」、箱子 ready 了第一次 sync 回 502，原樣重試都好了。
// 卡住（stalled）不重試：兩分鐘沒動靜的再等兩分鐘多半一樣。成功的話回傳帶 retried（第一次的錯）。
const TRANSIENT_UPLOAD = /fetch failed|ECONNRESET|socket hang up|EPIPE|ETIMEDOUT|other side closed|terminated|HTTP 50[24]\b/i;

async function uploadWithRetry(id, dest, src, list, repo = "", noDenylist = false, meter = null) {
  const first = await upload(id, dest, src, list, repo, noDenylist, meter);
  if (!first.error || first.stalled || !TRANSIENT_UPLOAD.test(first.error)) return first;
  log(`sync to ${dest}: ${first.error}; retrying once`);
  if (meter) meter.bytes = 0;
  const again = await upload(id, dest, src, list, repo, noDenylist, meter);
  if (again.error) return { ...again, error: `${again.error} (retried once; the first try failed with: ${first.error})` };
  return { ...again, retried: first.error };
}

// splitNul 切 git ls-files -z 的原始 bytes（不是字串：檔名不一定是合法 UTF-8，轉字串會壞掉）。
function splitNul(buf) {
  const out = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) continue;
    if (i > start) out.push(buf.subarray(start, i));
    start = i + 1;
  }
  if (start < buf.length) out.push(buf.subarray(start));
  return out;
}

const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// boxExec 在箱子裡跑一條指令（sandbox_exec），回 control 的結果。測試換成在本機模擬的箱子。
// 跟轉給 control 的工具一樣走 callWithRetry：有看門狗（回應串流斷掉不會掛到 client 的 30 分鐘逾時）、503 會退避重試，
// 結果回不來時是 isError 的說明。以前直接 remote.callTool，比對那一步卡住就是整個 sandbox_sync 1800 秒沒有回應。
let boxExec = (args, timeout) => callWithRetry("sandbox_exec", args, timeout);
const setBoxExecForTest = (fn) => {
  boxExec = fn;
};

// relayScope：一次 sandbox_sync／sandbox_pull 呼叫裡，adapter 自己打的 sandbox_exec 帶回來的附加內容
// （人在 app 留給這個對話的話 fromHuman 與附圖、點數與收箱提醒）。control 只交一次，adapter 吞掉就沒了，
// 所以收在這裡，最後接在工具結果後面交給 agent。
const relayScope = new AsyncLocalStorage();

function relayExtras(content, parsed) {
  const box = relayScope.getStore();
  if (!box) return;
  if (Array.isArray(parsed?.fromHuman) && parsed.fromHuman.length) box.fromHuman.push(...parsed.fromHuman);
  for (const c of content) {
    if (c.type === "text") box.texts.add(c.text);
    else box.items.push(c);
  }
}

// withRelayed 把收到的附加內容接在結果後面：fromHuman 一段 JSON、圖、其他文字（重複的只留一份）。
function withRelayed(result, box) {
  const extra = [];
  if (box.fromHuman.length) extra.push({ type: "text", text: JSON.stringify({ fromHuman: box.fromHuman }) });
  extra.push(...box.items);
  for (const text of box.texts) extra.push({ type: "text", text });
  if (extra.length) result.content = [...(result.content || []), ...extra];
  return result;
}

// localTool 跑 adapter 自己實作的 sandbox_sync／sandbox_pull，最後接上它們打 sandbox_exec 時收到的附加內容。
async function localTool(name, args, onProgress, signal) {
  const relayed = { fromHuman: [], items: [], texts: new Set() };
  const result = await relayScope.run(relayed, () => (name === "sandbox_sync" ? sync(args, onProgress) : pull(args, onProgress, signal)));
  return withRelayed(result, relayed);
}

// execOnBox 跑一條指令，回解析過的結果（stdout、exitCode…）；工具本身回錯就丟例外。
// note 是 control 規定必填的（人在 app 上看到的「現在在做什麼」）。
// 結果的第一段文字才是 exec 的 JSON：control 會在後面多接點數、收箱提醒與人的留言（圖），全部接起來再 parse 會壞
// （使用回饋：比對 783 個檔後報 Unexpected non-whitespace character after JSON at position 8）。
async function execOnBox(id, cmd, note, timeoutSec = 300) {
  const res = await boxExec({ id, cmd, timeoutSec, note: note.slice(0, 200) }, (timeoutSec + 30) * 1000);
  const content = res?.content || [];
  if (res?.isError) throw new Error(content.filter((c) => c.type === "text").map((c) => c.text).join("\n") || "sandbox_exec failed");
  const first = content.findIndex((c) => c.type === "text");
  const text = first < 0 ? "" : content[first].text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`unreadable sandbox_exec result (${err?.message || err}): ${text.slice(0, 500)}`);
  }
  relayExtras(content.filter((_, i) => i !== first), parsed);
  return parsed;
}

// runOnBox 把 files（檔名 → 內容）送進箱子的 /work/.psbx-sync/<亂數>，跑 command(那個資料夾)，回它最後印的那行 JSON。
// 程式自己會把那個資料夾刪掉。
async function runOnBox(id, files, command, note) {
  const nonce = randomBytes(6).toString("hex");
  const stage = mkdtempSync(join(tmpdir(), "psbx-sync-"));
  let sent;
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(stage, name), body);
    sent = await uploadWithRetry(id, `.psbx-sync/${nonce}`, stage, null);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  if (sent.error) throw new Error(sent.error);
  const run = await execOnBox(id, command(`/work/.psbx-sync/${nonce}`), note);
  if (run.exitCode !== 0) throw new Error(`exited ${run.exitCode}: ${(run.stderr || run.stdout || "").trim()}`);
  let stdout = run.stdout || "";
  // exec 的輸出只留最後 16 KB，長的清單（幾百個路徑的 hex）會被切掉開頭，JSON 就壞了；完整輸出在 outputUrl。
  if (run.truncated && run.outputUrl) {
    const full = await fetch(run.outputUrl);
    if (!full.ok) throw new Error(`reading its full output failed (HTTP ${full.status})`);
    stdout = await full.text();
  }
  const last = stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  if (!last) throw new Error(`no result in its output: ${stdout.trim().slice(-300)}`);
  return JSON.parse(last);
}

// compareOnBox 把本機的雜湊清單送進箱子，在箱子裡比對 dest，回 { all: true } 或 { changed: [路徑 hex] }，都帶 deps（depsState 的結果）；
// dest 還不存在時多帶 fresh。opts.stale 有給時再帶 { stale: [路徑 hex], staleTotal }。
function compareOnBox(id, dest, manifest, opts) {
  return runOnBox(id, { manifest: manifest.join("\n"), "opts.json": JSON.stringify({ limit: COMPARE_LIMIT, ...opts }), "compare.mjs": COMPARE_SCRIPT },
    (dir) => `node ${dir}/compare.mjs ${dir} ${shellQuote(`/work/${dest}`)}`,
    `Compare local files with ${dest} before syncing`);
}

// pruneOnBox 刪掉 dest 裡這些多出來的路徑（hex），回 { deleted, failed: [hex] }。
function pruneOnBox(id, dest, hexes) {
  return runOnBox(id, { list: hexes.join("\n"), "prune.mjs": PRUNE_SCRIPT },
    (dir) => `node ${dir}/prune.mjs ${dir}/list ${shellQuote(`/work/${dest}`)}`,
    `Delete ${hexes.length} files from ${dest} that no longer exist locally`);
}

// dropIgnored 用本機 repo 的忽略規則篩掉 rels（相對 src 的路徑 Buffer）裡被忽略的：箱子裡的 .env、建置產物本來就不從本機來，
// 不算多出來的檔。問不到 git（不是 git 工作區、路徑穿過連結）就回 null，呼叫端不能拿沒篩過的清單去刪。
function dropIgnored(src, rels) {
  if (!rels.length) return rels;
  const input = Buffer.concat(rels.flatMap((p) => [p, Buffer.from([0])]));
  const r = spawnSync("git", ["-C", src, "check-ignore", "--stdin", "-z"], { input, maxBuffer: 64 * 1024 * 1024 });
  // check-ignore：0 有被忽略的，1 一個都沒有，其他是出錯。
  if (r.status !== 0 && r.status !== 1) return null;
  const ignored = new Set(splitNul(r.stdout).map((p) => p.toString("hex")));
  return rels.filter((p) => !ignored.has(p.toString("hex")));
}

// uncommittedPaths 列出 src 底下跟 HEAD 不一樣的路徑（git status，相對 src，前面帶狀態碼）。
// 不帶 commit 時送的是磁碟上的樣子，共用 checkout 時別的 session 改到一半的檔也一起進箱子（使用回饋八次），
// 列出來才看得出箱子裡有哪些不是 commit 過的東西。
function uncommittedPaths(src) {
  const st = spawnSync("git", ["-C", src, "status", "--porcelain=v1", "-z", "--", "."], { maxBuffer: 64 * 1024 * 1024 });
  if (st.status !== 0) return [];
  const prefix = spawnSync("git", ["-C", src, "rev-parse", "--show-prefix"], { encoding: "utf8" }).stdout?.trim() || "";
  const entries = splitNul(st.stdout).map((b) => b.toString("utf8"));
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i].slice(0, 2);
    let p = entries[i].slice(3);
    // 改名、複製的下一筆是原本的路徑。
    if (code[0] === "R" || code[0] === "C") i++;
    if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length);
    out.push(`${code.trim()} ${p}`);
  }
  return out;
}

// isDirOnBox：箱子裡 /work/<rel> 是不是資料夾（連結指向資料夾也算）。
async function isDirOnBox(id, rel) {
  const run = await execOnBox(id, `if [ -d ${shellQuote(`/work/${rel}`)} ]; then echo dir; else echo other; fi`,
    `Check whether ${rel} is a folder before syncing one file`, 60);
  if (run.exitCode !== 0) throw new Error(`exited ${run.exitCode}: ${(run.stderr || run.stdout || "").trim()}`);
  return (run.stdout || "").trim() === "dir";
}

// boxRel 把 sandbox_sync 的 dest 換成相對 /work 的路徑：/work/app → app。agent 在 sandbox_exec 裡都寫絕對路徑，
// 照抄到 dest 是回報最多的錯（三十幾次），整個目錄 sync 時還會上傳到一半卡住。其他絕對路徑與跑出 /work 的在上傳前就擋下。
// 回 { rel, dir }：dir 是結尾帶 /（明說是資料夾）。
function boxRel(p) {
  let s = String(p ?? "").trim();
  if (s === "/work" || s.startsWith("/work/")) s = s.slice(5).replace(/^\/+/, "");
  else if (s.startsWith("/") || s.startsWith("~")) {
    return { error: `dest ${p} is not under /work. dest is relative to /work: app, not /work/app. Nothing was sent.` };
  }
  const dir = s.endsWith("/");
  const clean = posix.normalize(s || ".").replace(/\/+$/, "") || ".";
  if (clean === ".." || clean.startsWith("../")) return { error: `dest ${p} leaves /work. dest is relative to /work, such as app or app/src. Nothing was sent.` };
  return { rel: clean, dir };
}

// workRel 只把 /work 開頭的路徑換成相對 /work（/work/shots → shots），給 sandbox_get、sandbox_pull 的 path 用；
// 其他照原樣交給箱子判斷（它可能也收 /tmp 這類路徑）。
function workRel(p) {
  if (typeof p !== "string") return p;
  const s = p.trim();
  if (s === "/work" || s === "/work/") return ".";
  return s.startsWith("/work/") ? s.slice(6).replace(/^\/+/, "") || "." : p;
}

// treeFileList 列出 dir 底下每個檔與連結（NUL 分隔、相對 dir，跟 gitFileList 同格式），skip 裡的名字整個略過，
// 略過了哪些名字記進 skipped（有給的話）。socket、FIFO 這類不是檔的東西不列。
// commit 模式的樹（git archive 解出來的）本身就是挑好的檔；不是 git 的資料夾照黑名單挑。有了清單就能跟箱子比對、只送有變的、列出 dest 裡多出來的。
function treeFileList(dir, skip = new Set(), skipped = null) {
  const out = [];
  const walk = (abs, rel) => {
    for (const d of readdirSync(abs, { withFileTypes: true, encoding: "buffer" })) {
      const name = d.name.toString();
      if (skip.has(name)) {
        skipped?.add(name);
        continue;
      }
      const r = rel ? Buffer.concat([rel, Buffer.from("/"), d.name]) : d.name;
      if (d.isDirectory()) walk(Buffer.concat([abs, Buffer.from("/"), d.name]), r);
      else if (d.isFile() || d.isSymbolicLink()) out.push(r, Buffer.from([0]));
    }
  };
  walk(Buffer.from(dir), null);
  return Buffer.concat(out);
}

// onlyList：沒帶 commit 時 alsoPaths 就是「只送這幾個路徑」（git diff --name-only 的清單、一支檢查腳本），
// 送到 dest 底下同一個相對位置，跟整個送時的合併規則一樣。資料夾挑檔也一樣：git 追蹤的加上沒被忽略的新檔，
// includeIgnored 時照磁碟上的樣子。回 { list, roots }：roots 是其中的資料夾，dest 裡多出來的檔只在這些資料夾裡找。
function onlyList(src, paths, includeIgnored) {
  const seen = new Set();
  const parts = [];
  const roots = [];
  const push = (p) => {
    const key = p.toString("hex");
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(p, Buffer.from([0]));
  };
  for (const rel of paths) {
    const sub = relative(src, resolve(src, rel));
    if (!sub || sub === ".." || sub.startsWith(`..${sep}`) || isAbsolute(sub)) return { error: `alsoPaths: ${rel} is not a path under ${src}` };
    let st;
    try {
      st = lstatSync(join(src, sub));
    } catch {
      return { error: `alsoPaths: ${rel} not found under ${src}` };
    }
    const at = sub.split(sep).join("/");
    if (!st.isDirectory()) {
      push(Buffer.from(at));
      continue;
    }
    const list = (!includeIgnored && gitFileList(join(src, sub))) || treeFileList(join(src, sub), new Set(includeIgnored ? [".git"] : SYNC_EXCLUDES));
    const inside = splitNul(list);
    if (!inside.length) return { error: `alsoPaths: nothing to send under ${rel} (empty, or all of it ignored); pass includeIgnored: true to send it as it is on disk` };
    for (const p of inside) push(Buffer.concat([Buffer.from(`${at}/`), p]));
    roots.push(Buffer.from(at).toString("hex"));
  }
  return { list: Buffer.concat(parts), roots };
}

// sandbox_sync runs here. In a git working tree it hashes the selected files, asks the box which of them differ
// from what is already in dest (files edited inside the box count as different, so they get the local version back),
// and uploads only those. Outside git it does the same with every file except SYNC_EXCLUDES.
// ignoredTopLevel 分開回兩件事：skipped 是整個沒送過去的頂層名字（.gitignore 忽略的、或黑名單擋掉的），
// partiallyIgnored 是有送、只是裡面少了幾個被忽略的檔的頂層目錄。
// 沒有 skipped 的話 dist、build 這種被默默跳過，箱子裡少東西要查很久才發現；
// 但把「只少幾個檔」的目錄也算進 skipped 就變成謊報：兩份使用回饋都寫「看起來像整個目錄沒送，要另外確認」。
// --directory 讓 git 對整個被忽略的目錄只印 "dir/" 一行，印出路徑的就代表那個目錄只有部分檔被忽略。
// configs 是被忽略的檔裡看起來是建置設定的（package.json、tsconfig*.json、*.config.*、.env*），整個被忽略的資料夾裡的不算。
function ignoredTopLevel(src) {
  const out = spawnSync("git", ["-C", src, "ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"], { maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) return { skipped: [], partiallyIgnored: [], configs: [] };
  const skipped = new Set();
  const partial = new Set();
  const configs = [];
  for (const buf of splitNul(out.stdout)) {
    const rel = buf.toString("utf8");
    const first = rel.split("/")[0];
    if (!first) continue;
    if (!rel.endsWith("/") && BUILD_CONFIG.test(posix.basename(rel))) configs.push(rel);
    if (rel === first || rel === first + "/") skipped.add(first);
    else partial.add(first);
  }
  for (const name of skipped) partial.delete(name);
  return { skipped: [...skipped].sort(), partiallyIgnored: [...partial].sort(), configs: configs.sort() };
}

// archiveCommit 把某個 commit 的乾淨樹解到暫存目錄，回 { dir, sha }；不是 git 或 commit 不存在就回 { error }。
// 共用工作區常常同時有別人沒 commit 的改動，整包同步過去會編不過（使用體驗記錄裡出現四次）。
// 先用 rev-parse 確認有這顆 commit：以前直接 git archive | tar，管線只看 tar 的結束碼，打錯的 revision 回成功、dest 是空的。
// submodules 時再把 commit 記錄的子模組版本解進樹裡（見 addSubmodules），回傳多帶 submodules、submodulesMissing。
function archiveCommit(src, commit, { submodules = false } = {}) {
  const rev = String(commit ?? "").trim();
  const found = rev && !rev.startsWith("-")
    ? spawnSync("git", ["-C", src, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { encoding: "utf8" })
    : { status: 1 };
  if (found.status !== 0) {
    return { error: `${rev || "(empty)"} is not a commit in ${src} (git rev-parse --verify found nothing), so nothing was sent. Check the name with git log --oneline or git branch -a, or git fetch first.` };
  }
  const sha = found.stdout.trim();
  const dir = mkdtempSync(join(tmpdir(), "psbx-archive-"));
  const ar = spawnSync("bash", ["-c", 'set -o pipefail; git -C "$0" archive "$1" | tar -x -C "$2"', src, sha, dir], { encoding: "utf8" });
  if (ar.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    return { error: `git archive ${rev} failed: ${(ar.stderr || "").trim() || `exit ${ar.status}`}` };
  }
  if (!submodules) return { dir, sha };
  const subs = addSubmodules(src, sha, dir);
  if (subs.error) {
    rmSync(dir, { recursive: true, force: true });
    return { error: subs.error };
  }
  return { dir, sha, submodules: subs.added, submodulesMissing: subs.missing };
}

// addSubmodules：git archive 不展開子模組（樹裡只有一個空資料夾），這裡照 commit 記錄的 gitlink，
// 從本機已 init 的子模組自己的 repo 把那顆 commit 解進對應的資料夾，巢狀的也照做。
// 沒 init、或本機子模組裡沒有那顆 commit 的列進 missing（附原因），不擋整次同步。
function addSubmodules(src, sha, dir, shown = "") {
  const ls = spawnSync("git", ["-C", src, "ls-tree", "-r", "-z", sha], { maxBuffer: 512 * 1024 * 1024 });
  if (ls.status !== 0) return { error: `git ls-tree ${sha} failed: ${ls.stderr.toString().trim()}` };
  const added = [];
  const missing = [];
  for (const entry of splitNul(ls.stdout)) {
    const line = entry.toString("utf8");
    // 「160000 commit <sha>\t<路徑>」是子模組。
    if (!line.startsWith("160000 commit ")) continue;
    const tab = line.indexOf("\t");
    const subSha = line.slice("160000 commit ".length, tab);
    const path = line.slice(tab + 1);
    const from = join(src, path);
    const name = shown + path;
    if (!existsSync(join(from, ".git"))) {
      missing.push({ path: name, commit: subSha, why: "not initialized locally: git submodule update --init" });
      continue;
    }
    const to = join(dir, path);
    mkdirSync(to, { recursive: true });
    const ar = spawnSync("bash", ["-c", 'set -o pipefail; git -C "$0" archive "$1" | tar -x -C "$2"', from, subSha, to], { encoding: "utf8" });
    if (ar.status !== 0) {
      missing.push({ path: name, commit: subSha, why: `that commit is not in the local submodule (git -C ${path} fetch): ${(ar.stderr || "").trim().split("\n")[0]}` });
      continue;
    }
    added.push({ path: name, commit: subSha });
    const nested = addSubmodules(from, subSha, to, `${name}/`);
    if (nested.error) return nested;
    added.push(...nested.added);
    missing.push(...nested.missing);
  }
  return { added, missing };
}

// copyInto 把工作區的某些路徑疊到乾淨樹上（commit + 自己正在改的檔），每個路徑都換成工作區裡的樣子。
// 檔案照原樣複製。資料夾整個換掉，裡面放不帶 commit 同步時會從那裡送的檔（追蹤中的加上沒被 .gitignore 忽略的新檔）：
// 本機刪掉、改名的檔不會從 commit 那份冒回來，node_modules、build 產物也不會上去蓋掉箱子裡自己裝的；
// includeIgnored 時照磁碟上的樣子整份複製。
// 以前資料夾是 cp -a 到樹裡已經有的同名資料夾，cp 會把它放進「裡面」：箱子裡多一層 parallelsandbox/parallelsandbox/，
// vite 從那份舊檔解析 import 失敗，tsc 也跟著檢查舊的那份。
function copyInto(src, dir, paths, includeIgnored = false) {
  try {
    const root = realpathSync(dir);
    for (const rel of paths) {
      const sub = relative(src, resolve(src, rel));
      if (!sub || sub === ".." || sub.startsWith(`..${sep}`) || isAbsolute(sub)) return { error: `alsoPaths: ${rel} is not a path under ${src}` };
      const from = join(src, sub);
      let st;
      try {
        st = lstatSync(from);
      } catch {
        return { error: `alsoPaths: ${rel} not found under ${src}` };
      }
      const to = join(dir, sub);
      // 下面會先刪掉樹裡原本那份。路徑中間要是有連結，刪和寫都會穿出這棵暫存樹，落到連結指的地方（可能就是工作區本身）。
      let up = dirname(to);
      while (!existsSync(up)) up = dirname(up);
      const real = realpathSync(up);
      if (real !== root && !real.startsWith(root + sep)) return { error: `alsoPaths: ${rel} goes through a symlink that leads out of the tree` };
      const list = st.isDirectory() && !includeIgnored ? gitFileList(from) : null;
      if (list && !list.length) return { error: `alsoPaths: git sends nothing under ${rel} (empty, or all of it ignored); pass includeIgnored: true to copy it as it is on disk` };
      rmSync(to, { recursive: true, force: true });
      mkdirSync(dirname(to), { recursive: true });
      let cp;
      if (!st.isDirectory()) {
        cp = spawnSync("cp", ["-a", from, to], { encoding: "utf8" });
      } else {
        mkdirSync(to);
        cp = list
          ? spawnSync("bash", ["-c", 'set -o pipefail; tar -cf - -C "$0" --null -T - | tar -xf - -C "$1"', from, to], { input: list, env: { ...process.env, COPYFILE_DISABLE: "1" }, encoding: "utf8" })
          : spawnSync("cp", ["-a", `${from}/.`, to], { encoding: "utf8" });
      }
      if (cp.status !== 0) return { error: `alsoPaths: copy ${rel}: ${(cp.stderr || "").trim()}` };
    }
  } catch (err) {
    return { error: `alsoPaths: ${err?.message || err}` };
  }
  return {};
}

// unpackDirectory 把 sandbox_get 回的資料夾 tar.gz 解進 target。箱子打包時帶著資料夾本身那一層
// （tar -C <上一層> <資料夾名>），這裡把那一層去掉，資料夾裡的東西直接放進 target：
// path /work/app/dist、localPath ./dist 拿到 ./dist/<內容>，跟 sandbox_sync 反方向一樣。以前會多一層變成 ./dist/dist/…
// 回寫進 target 的檔（相對 target，不含資料夾）：同一份串流另外給一個 tar -t 列清單，不用先存成檔再讀兩次。
async function unpackDirectory(stream, target) {
  mkdirSync(target, { recursive: true });
  const tar = spawn("tar", ["-xzf", "-", "-C", target, "--strip-components=1"]);
  const lister = spawn("tar", ["-tzf", "-"]);
  const errs = [];
  let names = "";
  tar.stderr.on("data", (d) => errs.push(d.toString()));
  lister.stdout.on("data", (d) => (names += d.toString()));
  tar.stdin.on("error", () => {});
  lister.stdin.on("error", () => {});
  const listed = new Promise((res2) => {
    lister.on("close", res2);
    lister.on("error", res2);
  });
  await new Promise((res2, rej) => {
    stream.on("error", rej);
    stream.pipe(tar.stdin);
    stream.pipe(lister.stdin);
    tar.on("close", (code) => (code === 0 ? res2() : rej(new Error(errs.join("").trim() || `tar exit ${code}`))));
    tar.on("error", rej);
  });
  await listed;
  return names.split("\n")
    .map((n) => n.replace(/^\.\//, "").split("/").slice(1).join("/"))
    .filter((n) => n && !n.endsWith("/"));
}

// progressTicker：sync／pull 在本機做事（掃檔、比對、上傳、下載）的時候，每 PROGRESS_EVERY_MS 跟 client 報一次做到哪。
// 使用回饋：233 秒的 sync、一分鐘的 pull 中間都沒有任何輸出，分不出是在傳還是卡住。client 沒給 progressToken 就不報。
function progressTicker(onProgress, describe) {
  if (!onProgress) return { stop() {} };
  const timer = setInterval(() => {
    try {
      onProgress({ message: describe() });
    } catch {}
  }, PROGRESS_EVERY_MS);
  return { stop: () => clearInterval(timer) };
}

const mb = (n) => (n / MB).toFixed(1);

// boxGet 叫 control 的 sandbox_get（RETRY_SAFE：連線斷掉自己再試一次）。測試換成本機的假箱子。
let boxGet = (args, onProgress, signal) => callWithRetry("sandbox_get", args, DEFAULT_TIMEOUT_MS, onProgress, signal);
const setBoxGetForTest = (fn) => {
  boxGet = fn;
};

// download 下載預簽網址，回 { status } 或 { stream }；stream 讀的時候更新 meter.got。
// STALL_MS 沒有任何位元組進來就切掉，stream 會以「stalled」的錯誤結束，不會一直掛著。
async function download(url, meter, signal) {
  const ac = new AbortController();
  const stop = () => ac.abort(signal.reason);
  signal?.addEventListener("abort", stop, { once: true });
  let movedAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - movedAt < STALL_MS) return;
    ac.abort(new Error(`stalled while downloading: nothing arrived for ${Math.round(STALL_MS / 1000)}s after ${mb(meter.got)} MB`));
  }, Math.min(5_000, STALL_MS / 4));
  const done = () => {
    clearInterval(watchdog);
    signal?.removeEventListener("abort", stop);
  };
  let res;
  try {
    res = await fetch(url, { signal: ac.signal });
  } catch (err) {
    done();
    throw ac.signal.aborted && ac.signal.reason instanceof Error ? ac.signal.reason : err;
  }
  if (!res.ok || !res.body) {
    done();
    await res.body?.cancel().catch(() => {});
    return { status: res.status };
  }
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      meter.got += chunk.length;
      movedAt = Date.now();
      cb(null, chunk);
    },
    flush(cb) {
      done();
      cb();
    },
  });
  const body = Readable.fromWeb(res.body);
  body.on("error", (err) => {
    done();
    counter.destroy(ac.signal.aborted && ac.signal.reason instanceof Error ? ac.signal.reason : err);
  });
  return { stream: body.pipe(counter) };
}

// cleanRefusal：clean 會把 localPath 整個換成箱子那份，這幾種地方不准：根目錄、家目錄（與它的上層）、
// adapter 的工作目錄（與它的上層）、git checkout（有 .git）、不是資料夾的東西。可以就回空字串。
function cleanRefusal(target) {
  const refuse = (why) => `clean refused for ${target}: ${why}. Nothing was pulled. Pull into a folder of its own, or leave clean out to merge into it.`;
  const within = (inner, outer) => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
  if (target === parsePath(target).root) return refuse("it is a filesystem root");
  if (within(homedir(), target)) return refuse("it is your home directory or holds it");
  if (within(process.cwd(), target)) return refuse("it is the adapter's working directory or holds it");
  let st;
  try {
    st = lstatSync(target);
  } catch {
    return "";
  }
  if (!st.isDirectory()) return refuse("it is not a directory");
  if (existsSync(join(target, ".git"))) return refuse("it is a git checkout (it has .git)");
  return "";
}

// replaceDirectory：clean 時先解到 target 旁邊的暫存資料夾，解成功了才把 target 換掉，解壞了 target 原封不動。
// 回寫進去的檔，與原本 target 裡、箱子那份沒有而被拿掉的檔（相對 target）。
async function replaceDirectory(stream, target) {
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const fresh = mkdtempSync(join(parent, `.${basename(target)}.psbx-pull-`));
  let files;
  try {
    files = await unpackDirectory(stream, fresh);
  } catch (err) {
    rmSync(fresh, { recursive: true, force: true });
    throw err;
  }
  let removed = [];
  if (existsSync(target)) {
    const now = new Set(files);
    removed = splitNul(treeFileList(target)).map((p) => p.toString("utf8")).filter((p) => !now.has(p));
    const old = `${fresh}.old`;
    renameSync(target, old);
    renameSync(fresh, target);
    rmSync(old, { recursive: true, force: true });
  } else {
    renameSync(fresh, target);
  }
  return { files, removed };
}

// pull 把箱子裡的檔案或資料夾寫回本機路徑：sandbox_get 只給預簽網址，之前都要自己 curl 或 base64 貼回來。
// 回傳列出寫了幾個檔、前幾個是哪些：並行開發時要看得出拉回來的是哪一版，也能跟箱子裡的 find | wc -l 對。
// 下載網址被拒（403：簽名用的暫時憑證提早失效）就再要一條重下一次。
async function pull(args, onProgress, signal) {
  const { id, path: rawPath, extract = true, clean = false } = args || {};
  // 本機路徑的參數叫 localPath；照 sync 的習慣寫成 dest 也收（使用回饋：先用 dest 報錯才知道叫 localPath）。
  const localPath = args?.localPath ?? args?.dest;
  if (!id || !rawPath || !localPath) {
    return textResult("sandbox_pull needs id, path (the file or directory on the box, relative to /work) and localPath (where to write it on this machine; the parameter is localPath, not dest)", true);
  }
  const boxPath = workRel(rawPath);
  const target = resolve(process.cwd(), localPath);
  if (clean && extract) {
    const why = cleanRefusal(target);
    if (why) return textResult(why, true);
  }
  const meter = { phase: "packing it on the box", got: 0, total: 0 };
  const ticker = progressTicker(onProgress, () => meter.phase === "downloading"
    ? `sandbox_pull ${boxPath}: downloaded ${mb(meter.got)} of ${mb(meter.total)} MB`
    : `sandbox_pull ${boxPath}: ${meter.phase}`);
  const notes = [];
  try {
    for (let attempt = 1; ; attempt++) {
      meter.phase = "packing it on the box";
      const res = await boxGet({ id, path: boxPath }, onProgress, signal);
      const text = res?.content?.find?.((c) => c.type === "text")?.text || "";
      let meta;
      try {
        meta = JSON.parse(text);
      } catch {
        return res;
      }
      if (!meta?.url) return res;
      meter.phase = "downloading";
      meter.got = 0;
      meter.total = meta.bytes || 0;
      const dl = await download(meta.url, meter, signal);
      if (dl.status) {
        if (attempt === 1 && (dl.status === 403 || dl.status === 400)) {
          notes.push(`the first download link was refused (HTTP ${dl.status}), so a fresh one was fetched`);
          continue;
        }
        return textResult(`sandbox_pull: download failed (HTTP ${dl.status})${attempt > 1 ? " with a fresh link too" : ""}. Call sandbox_pull again.`, true);
      }
      const out = { ok: true, localPath: target, bytes: meta.bytes };
      if (meta.archive && extract) {
        if (clean) {
          const done = await replaceDirectory(dl.stream, target);
          Object.assign(out, { extracted: true, files: done.files.length, paths: done.files.slice(0, SHOW_PATHS), removed: done.removed.length });
          if (done.removed.length) out.removedPaths = done.removed.slice(0, SHOW_FEW);
        } else {
          const files = await unpackDirectory(dl.stream, target);
          Object.assign(out, { extracted: true, files: files.length, paths: files.slice(0, SHOW_PATHS) });
        }
      } else {
        mkdirSync(dirname(target), { recursive: true });
        await pipeline(dl.stream, createWriteStream(target));
        Object.assign(out, { extracted: false, files: 1 });
        if (clean && meta.archive) notes.push("clean applies only when a directory is unpacked (extract), so it was ignored");
        else if (clean) notes.push("clean applies to directories only, so it was ignored");
      }
      if (Array.isArray(meta.changedWhileReading) && meta.changedWhileReading.length) {
        out.changedWhileReading = meta.changedWhileReading;
        notes.push(`these files changed on the box while it was being packed (something was still writing them), so their copies may be partial: ${meta.changedWhileReading.slice(0, 5).join(", ")}. Pull again once the writer is done.`);
      }
      if (notes.length) out.notes = notes;
      return textResult(JSON.stringify(out, null, 2));
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    return textResult(`sandbox_pull: ${err?.message || err}. Nothing more will arrive from this call; call sandbox_pull again.`, true);
  } finally {
    ticker.stop();
  }
}

// baselineDest 是對照組放的地方。固定接在後面，agent 不用猜，回傳裡也會寫。
function baselineDest(dest) {
  return `${dest}-baseline`;
}

// syncFailures：這個對話裡 sync 失敗、還沒重送成功的 dest（箱子 id → dest → 原因）。
// 使用回饋：sync 回 409 之後下一個 exec 照跑，cp 因為檔案沒同步 exit 1，被當成測試失敗。下一次 sandbox_exec 的結果附上提醒。
const syncFailures = new Map();

function syncFailed(id, dest, why) {
  if (!syncFailures.has(id)) syncFailures.set(id, new Map());
  syncFailures.get(id).set(dest, why);
}

function syncSucceeded(id, dest) {
  syncFailures.get(id)?.delete(dest);
}

// staleSyncWarning 給 sandbox_exec 的結果用：這顆箱子有 dest 上次 sync 失敗就回一段提醒（只提醒一次）。
function staleSyncWarning(id) {
  const failed = syncFailures.get(id);
  if (!failed?.size) return "";
  const dests = [...failed.keys()].map((d) => `/work/${d}`).join(", ");
  syncFailures.delete(id);
  return `Warning: the last sandbox_sync to ${dests} on this box failed, so those files are the old ones (or only partly updated). A failure here may come from that, not from your change: sync again and rerun.`;
}

// notSynced：sync 沒做完時的回應。一律講清楚箱子裡還是舊檔，並列出這次原本要送的檔。
function notSynced(id, dest, why, attempted = []) {
  syncFailed(id, dest, why);
  let text = `${why}\nNOT SYNCED: /work/${dest} still has its old files (or only part of this sync), so commands you run there next see the old code. Fix the cause and run sandbox_sync again before sandbox_exec.`;
  if (attempted.length) {
    const shown = attempted.slice(0, SHOW_PATHS).join(", ");
    text += `\nThis sync was sending ${attempted.length} files: ${shown}${attempted.length > SHOW_PATHS ? `, and ${attempted.length - SHOW_PATHS} more` : ""}`;
  }
  return textResult(text, true);
}

// devServerNote：送過去的檔裡有 package.json、vite.config.*、tsconfig*、.env* 時，提醒開著的 dev server 會整頁重載或重啟。
// 使用回饋：有時整頁重載洗掉語言、頁面與塞進去的假資料，有時只做 HMR，事前看不出是哪一種。
function devServerNote(paths) {
  const hit = [...new Set(paths.filter((p) => RELOADS_DEV_SERVER.test(posix.basename(p))))];
  if (!hit.length) return "";
  return `${hit.slice(0, 5).join(", ")} changed: a running dev server (vite, webpack, Metro) reloads the whole page or restarts on these, so page state such as language, route and injected data is lost; if the page stays blank or stale, restart the dev server. Edits to other source files are normally hot-updated in place.`;
}

// syncOneFile：localPath 是一個檔時，dest 是它在箱子裡的路徑（renderer/.env 就落在 /work/renderer/.env）。
// 以前 dest 一律當資料夾，檔案落在 dest/檔名，接著就是「Is a directory」、找不到環境變數（使用回饋十四次）。
// dest 結尾是 /、或箱子裡已經是資料夾時，才照舊放進去。
async function syncOneFile({ id, file, target, dryRun = false, maxBytes = DEFAULT_MAX_MB * MB }) {
  const name = basename(file);
  const size = statSync(file).size;
  let intoDir = target.dir || target.rel === ".";
  if (!intoDir) {
    try {
      intoDir = await isDirOnBox(id, target.rel);
    } catch (err) {
      return notSynced(id, target.rel, `sync failed while checking dest on the box: ${err?.message || err}`, [name]);
    }
  }
  const remoteRel = intoDir ? posix.join(target.rel, name) : target.rel;
  if (dryRun) {
    return textResult(JSON.stringify({ ok: true, dryRun: true, dest: target.rel, remotePath: `/work/${remoteRel}`, files: 1, sentFiles: 1, sendMB: Number(mb(size)),
      notes: ["dryRun: nothing was sent"] }, null, 2));
  }
  if (size > maxBytes) {
    return notSynced(id, target.rel, `not sent: ${name} is ${mb(size)} MB, over the ${mb(maxBytes)} MB limit. To send it anyway, pass maxMB: ${Math.ceil(size / MB)}.`);
  }
  const parent = posix.dirname(remoteRel);
  const only = mkdtempSync(join(tmpdir(), "psbx-one-"));
  try {
    copyFileSync(file, join(only, posix.basename(remoteRel)));
    const sent = await uploadWithRetry(id, parent, only, null, "", true);
    if (sent.error) return notSynced(id, target.rel, sent.error, [name]);
    syncSucceeded(id, target.rel);
    const out = { ok: true, dest: target.rel, remotePath: `/work/${remoteRel}`, uploadedBytes: sent.bytes, files: 1, sentFiles: 1,
      sentPaths: [posix.basename(remoteRel)], selected: `one file: ${name}` };
    if (sent.changed !== undefined) out.changedOnBox = sent.changed;
    const notes = [];
    if (sent.retried) notes.push(retriedNote(sent.retried));
    if (intoDir && !target.dir && target.rel !== "." && posix.basename(target.rel) === name) {
      notes.push(`/work/${target.rel} is already a folder in the box, so the file went inside it. If an older adapter made that folder by mistake, remove it (rm -r /work/${target.rel}) and sync again.`);
    }
    const reload = sent.changed === 0 ? "" : devServerNote([name]);
    if (reload) notes.push(reload);
    if (notes.length) out.notes = notes;
    return textResult(JSON.stringify(out, null, 2));
  } finally {
    rmSync(only, { recursive: true, force: true });
  }
}

const retriedNote = (why) => `the first upload failed (${why}) and was sent again once; this result is from the second try`;

// globMatcher 把 exclude 的 glob 變成判斷函式（相對 localPath 的路徑 → 要不要擋下）。規則照 .gitignore 的常見寫法：
// 沒有 / 的（capacitor.config.ts、*.log）比對任何一層的名字；有 / 的從 localPath 算起（android/app/build.gradle、/dist）；
// * 不跨 /，** 跨好幾層，? 一個字元。比到的是資料夾時，裡面全部一起擋。
function globMatcher(patterns) {
  const rules = [];
  for (const raw of patterns) {
    let p = raw.trim().replace(/^\.\//, "").replace(/\/+$/, "");
    if (!p) continue;
    const anchored = p.includes("/");
    p = p.replace(/^\/+/, "");
    let re = "";
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === "*" && p[i + 1] === "*") {
        i++;
        if (p[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else if (c === "*") {
        re += "[^/]*";
      } else if (c === "?") {
        re += "[^/]";
      } else {
        re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      }
    }
    rules.push({ anchored, re: new RegExp(`^${re}$`) });
  }
  if (!rules.length) return null;
  return (rel) => {
    const segs = rel.replace(/\/+$/, "").split("/");
    for (const r of rules) {
      if (!r.anchored) {
        if (segs.some((s) => r.re.test(s))) return true;
        continue;
      }
      for (let i = 1; i <= segs.length; i++) if (r.re.test(segs.slice(0, i).join("/"))) return true;
    }
    return false;
  };
}

// depsPlan：送去的檔裡每個 lockfile（node_modules 裡的不算）所在的資料夾，給箱子的 depsState 看那裡裝了沒、裝得對不對。
// npm 的 lockfile 帶 want：照 lockfile 該裝好的套件與版本。optional（平台限定）、bundled、workspace 連結不算。
// 一個資料夾只看一份 lockfile（package-lock 優先），最多 20 個資料夾。
function depsPlan(src, paths) {
  const byDir = new Map();
  for (const rel of paths) {
    const s = rel.toString("utf8");
    const lock = posix.basename(s);
    if (!LOCKFILES[lock] || s.split("/").includes("node_modules")) continue;
    const dir = posix.dirname(s);
    const npm = lock === "package-lock.json" || lock === "npm-shrinkwrap.json";
    if (byDir.has(dir) && !npm) continue;
    if (!byDir.has(dir) && byDir.size >= 20) continue;
    const entry = { dir, lock };
    if (npm) {
      try {
        const parsed = JSON.parse(readFileSync(join(src, s), "utf8"));
        entry.want = Object.entries(parsed.packages || {})
          .filter(([key, v]) => (key.startsWith("node_modules/") || key.includes("/node_modules/")) && v && v.version && !v.optional && !v.devOptional && !v.inBundle && !v.link)
          .map(([key, v]) => [key, v.version]);
      } catch {}
    }
    byDir.set(dir, entry);
  }
  return [...byDir.values()];
}

// depsNotes 把箱子回報的 deps 寫成給 agent 的提醒：沒裝的叫它裝（附 sandbox_build 的寫法），裝的跟 lockfile 不合的叫它重裝。
function depsNotes(dest, deps) {
  const notes = [];
  const boxDir = (d) => posix.normalize(posix.join(dest, d.dir));
  const where = (d) => posix.join("/work", boxDir(d));
  const missing = deps.filter((d) => d.state === "missing");
  if (missing.length) {
    const first = missing[0];
    const shown = missing.slice(0, 5).map((d) => `${where(d)} (${d.lock})`).join(", ");
    notes.push(`${shown}${missing.length > 5 ? `, and ${missing.length - 5} more` : ""} ${missing.length > 1 ? "have lockfiles" : "has a lockfile"} but no node_modules in the box: sync never sends node_modules, so install there before building or testing, e.g. sandbox_build { "dir": "${boxDir(first)}", "cmd": "${LOCKFILES[first.lock]}", "out": ["node_modules"] } (later boxes reuse it), or the same command in sandbox_exec.`);
  }
  for (const d of deps.filter((d) => d.state === "stale").slice(0, 5)) {
    notes.push(`node_modules in ${where(d)} does not match its ${d.lock}: ${d.differ} of ${d.wanted} packages are missing or at another version (${d.examples.join(", ")}). "Cannot find module" and type errors about them come from that, not from your change: run ${LOCKFILES[d.lock]} there (or sandbox_build with that cmd).`);
  }
  return notes;
}

// largestDirs：要送的檔照頂層資料夾加總，最大的幾個；某個子資料夾佔了一半以上時一起講（renderer/ 裡的 renderer/dist-win/）。
function largestDirs(rels, sizeOf, n = 5) {
  const tops = new Map();
  for (const rel of rels) {
    const parts = rel.toString("utf8").split("/");
    const size = sizeOf(rel);
    const top = parts.length > 1 ? `${parts[0]}/` : parts[0];
    const t = tops.get(top) || { path: top, bytes: 0, files: 0, children: new Map() };
    t.bytes += size;
    t.files++;
    if (parts.length > 2) {
      const child = `${parts[0]}/${parts[1]}/`;
      t.children.set(child, (t.children.get(child) || 0) + size);
    }
    tops.set(top, t);
  }
  return [...tops.values()].sort((a, b) => b.bytes - a.bytes).slice(0, n).map((t) => {
    const o = { path: t.path, MB: Number(mb(t.bytes)), files: t.files };
    const [child, bytes] = [...t.children].sort((a, b) => b[1] - a[1])[0] || [];
    if (child && bytes * 2 > t.bytes) o.mostly = { path: child, MB: Number(mb(bytes)) };
    return o;
  });
}

const describeLargest = (list) => list.map((d) => `${d.path} ${d.MB.toFixed(1)} MB in ${d.files} files${d.mostly ? ` (${d.mostly.path} ${d.mostly.MB.toFixed(1)} MB)` : ""}`).join(", ");

// scriptModeNote：要送的檔裡有 gradlew、mvnw 或帶 #! 的 *.sh 卻沒有執行權限（git 記成 100644）時提醒怎麼跑。
function scriptModeNote(src, rels) {
  const plain = [];
  for (const rel of rels) {
    const s = rel.toString("utf8");
    if (!RUN_DIRECTLY.test(posix.basename(s))) continue;
    const p = join(src, s);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isFile() || st.mode & 0o111) continue;
    if (s.endsWith(".sh") && readFileSync(p).subarray(0, 2).toString() !== "#!") continue;
    plain.push(s);
  }
  if (!plain.length) return "";
  const first = plain[0];
  return `${plain.slice(0, 5).join(", ")} ${plain.length > 1 ? "are" : "is"} not executable here (git records mode 100644), so ./${first} fails with Permission denied in the box: run bash ${first}, or chmod +x it there. To fix it in the repo: git update-index --chmod=+x ${first}.`;
}

// inGitWorkTree：dir 在不在 git 工作區裡。
function inGitWorkTree(dir) {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === "true";
}

// copyDepsOnBox：baseline 樹沒有依賴（只有 commit 追蹤的檔），以前要自己把 node_modules 連過去，連結又讓兩個 vite 共用
// node_modules/.vite 互蓋快取（使用回饋：firebase 分塊來自兩次打包，畫面卡在開機遮罩）。這裡把 dest 裡每個 node_modules
// 用硬連結複製到 baseline 的同一個位置（baseline 那裡已經有的不動）：不佔空間、幾秒完成，兩棵樹各有自己的資料夾與快取
// （.vite、.cache 不複製）。回複製了哪些（相對 dest）。
async function copyDepsOnBox(id, dest, baseDest) {
  const script = 'src="$1"; dst="$2"; [ -d "$src" ] || exit 0; cd "$src" || exit 1; ' +
    'find . -name node_modules -type d -prune -print | while IFS= read -r p; do rel="${p#./}"; ' +
    '[ -e "$dst/$rel" ] && continue; mkdir -p "$dst/$(dirname "$rel")" && cp -al "$src/$rel" "$dst/$rel" && ' +
    'rm -rf "$dst/$rel/.vite" "$dst/$rel/.vite-temp" "$dst/$rel/.cache" && printf "%s\\n" "$rel"; done';
  const run = await execOnBox(id, `bash -c ${shellQuote(script)} _ ${shellQuote(`/work/${dest}`)} ${shellQuote(`/work/${baseDest}`)}`,
    `Give ${baseDest} its own copy of the node_modules in ${dest} (hard links)`);
  if (run.exitCode !== 0) throw new Error(`exited ${run.exitCode}: ${(run.stderr || run.stdout || "").trim()}`);
  return (run.stdout || "").split("\n").filter(Boolean);
}

// describeSync 是 sync 進度回報的那一句。
function describeSync(state) {
  const at = `sandbox_sync to /work/${state.dest || "?"}`;
  switch (state.phase) {
    case "hashing":
      return `${at}: hashing ${state.files} local files`;
    case "comparing":
      return `${at}: asking the box which of ${state.files} files differ`;
    case "uploading":
      return `${at}: uploading ${state.sendFiles} files (${mb(state.sendBytes)} MB on disk), ${mb(state.meter?.bytes || 0)} MB of compressed data sent so far`;
    case "pruning":
      return `${at}: deleting stale files`;
    case "deps":
      return `${at}: copying node_modules into the baseline tree`;
    default:
      return `${at}: picking files`;
  }
}

async function sync(args, onProgress) {
  const state = { phase: "picking", dest: "" };
  const ticker = progressTicker(onProgress, () => describeSync(state));
  try {
    return await syncWith(args || {}, state);
  } finally {
    ticker.stop();
  }
}

async function syncWith(args, state) {
  const { id, localPath, dest: rawDest, commit, alsoPaths, includeIgnored = false, baseline, prune = false, submodules = false,
    exclude, dryRun = false, maxMB, baselineDeps = true } = args;
  if (!id || !localPath || !rawDest) {
    return textResult("sandbox_sync needs id, localPath and dest", true);
  }
  // dest 先驗：/work/app 換成 app，其他絕對路徑在開始掃檔、上傳之前就回錯。
  const target = boxRel(rawDest);
  if (target.error) return textResult(target.error, true);
  const dest = target.rel;
  state.dest = dest;
  const given = resolve(process.cwd(), localPath);
  if (!existsSync(given)) {
    return textResult(`localPath not found: ${given}`, true);
  }
  if (exclude !== undefined && (!Array.isArray(exclude) || exclude.some((p) => typeof p !== "string"))) {
    return textResult('exclude takes an array of globs relative to localPath, such as ["capacitor.config.ts", "renderer/dist-win"]. Nothing was sent.', true);
  }
  const skip = globMatcher(exclude || []);
  if (maxMB !== undefined && !(Number(maxMB) > 0)) return textResult("maxMB must be a positive number of megabytes. Nothing was sent.", true);
  const maxBytes = (maxMB !== undefined ? Number(maxMB) : DEFAULT_MAX_MB) * MB;
  const extra = Array.isArray(alsoPaths) ? alsoPaths.filter((p) => typeof p === "string" && p.trim()) : [];

  // 單一檔案：送它所在的目錄會把整包鄰居一起送過去，所以複製到一個暫存目錄單獨送。
  // 回報「local directory not found」而那個檔明明在，只會讓人以為路徑打錯（使用回饋裡兩次）。
  if (!statSync(given).isDirectory()) {
    if (commit || extra.length) {
      return textResult("commit and alsoPaths need a directory in localPath, not a single file", true);
    }
    if (prune) return textResult("prune needs a directory in localPath, not a single file", true);
    return syncOneFile({ id, file: given, target, dryRun, maxBytes });
  }

  if (prune) {
    if (dest === ".") return textResult("prune needs a dest below /work, not /work itself: everything else in /work would count as stale. Nothing was sent.", true);
    if (includeIgnored) return textResult("prune cannot be combined with includeIgnored: without the ignore rules the box cannot tell your deleted files from what it built itself. Nothing was sent.", true);
    if (!commit && !inGitWorkTree(given)) {
      return textResult("prune needs localPath in a git working tree (or commit): outside git the box cannot tell your deleted files from what it built itself. Delete them with sandbox_exec, or sync to a fresh dest. Nothing was sent.", true);
    }
  }

  // commit：送那顆 commit 的乾淨樹（可再疊上 alsoPaths），不帶別的 session 未提交的改動。
  // 沒有 commit 時 alsoPaths 就是「只送這幾個路徑」。
  let src = given;
  let temp = "";
  let made = null;
  let only = null;
  const repo = repoName(given);
  if (commit) {
    made = archiveCommit(given, commit, { submodules });
    if (made.error) return textResult(made.error, true);
    temp = made.dir;
    src = made.dir;
    if (extra.length) {
      const copied = copyInto(given, temp, extra, includeIgnored);
      if (copied.error) {
        rmSync(temp, { recursive: true, force: true });
        return textResult(copied.error, true);
      }
    }
  } else if (extra.length) {
    only = onlyList(given, extra, includeIgnored);
    if (only.error) return textResult(only.error, true);
  }
  const pick = { includeIgnored, skip, dryRun, maxBytes, state };
  let main;
  try {
    main = await syncFrom({ id, dest, src, given, repo, commit: commit || "", sha: made?.sha || "", only, prune, ...pick });
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
  if (main.error) return notSynced(id, dest, main.error, main.attempted);
  if (!dryRun) syncSucceeded(id, dest);
  if (made?.submodules) {
    main.submodules = made.submodules;
    if (made.submodulesMissing.length) main.submodulesMissing = made.submodulesMissing;
  }
  // 工作區模式：列出跟 HEAD 不一樣的檔。共用 checkout 時那裡面可能有別人改到一半的東西。
  if (!commit && !only) {
    const dirty = uncommittedPaths(given);
    if (dirty.length) {
      main.uncommitted = { count: dirty.length, paths: dirty.slice(0, SHOW_FEW) };
      main.notes = [...(main.notes || []), `${dirty.length} paths under localPath differ from HEAD and went over as they are on disk. If other sessions share this checkout, some may be their unfinished work: sync commit: "HEAD" with alsoPaths listing your own files instead.`];
    }
  }
  if (!baseline) return textResult(JSON.stringify(main, null, 2));

  // 對照組：同一次呼叫裡，把某顆 commit 的樹也送到旁邊一個 dest。
  // 「同一支測試在改動前後各跑一次、比對失敗清單」是每個人都在手做的事（使用回饋裡三次），
  // 而且手做很容易做歪：分兩次呼叫，中間工作區可能又變了；用 commit 模式送對照組，
  // 挑檔規則以前還跟工作區那次不一樣。這裡一次做完，兩邊都從同一刻的同一個 repo 來。
  const baseDest = baselineDest(dest);
  const base = archiveCommit(given, baseline, { submodules });
  if (base.error) {
    main.baseline = { dest: baseDest, commit: baseline, error: `${base.error} (baseline)` };
    return textResult(JSON.stringify(main, null, 2), true);
  }
  // 依賴先接過去，比對那一步才看得到它們，跟 baseline 的 lockfile 不合時會照樣提醒。
  let depsCopied = [];
  let depsError = "";
  if (baselineDeps && !dryRun) {
    state.phase = "deps";
    try {
      depsCopied = await copyDepsOnBox(id, dest, baseDest);
    } catch (err) {
      depsError = `${err?.message || err}`;
    }
  }
  let baseOut;
  try {
    baseOut = await syncFrom({ id, dest: baseDest, src: base.dir, given, repo, commit: baseline, sha: base.sha, prune, ...pick });
  } finally {
    rmSync(base.dir, { recursive: true, force: true });
  }
  if (baseOut.error) {
    if (!dryRun) syncFailed(id, baseDest, baseOut.error);
    main.baseline = { dest: baseDest, commit: baseline, error: `${baseOut.error}\nNOT SYNCED: /work/${baseDest} still has its old files.` };
  } else {
    if (!dryRun) syncSucceeded(id, baseDest);
    main.baseline = { ...baseOut, dest: baseDest, commit: baseline };
  }
  if (depsCopied.length) {
    main.baseline.depsCopied = depsCopied;
    main.baseline.notes = [...(main.baseline.notes || []), `node_modules copied from /work/${dest} as hard links: ${depsCopied.join(", ")}. Each tree has its own folders and Vite cache, so both can run at once; to reinstall in /work/${baseDest}, run npm ci there (it replaces the copy).`];
  }
  if (depsError) main.baseline.depsError = `copying node_modules into ${baseDest} failed, so install its dependencies there yourself: ${depsError}`;
  main.note = `run the same command in ${dest} and ${baseDest} and compare: anything that fails in both was already failing before your change`;
  return textResult(JSON.stringify(main, null, 2), !!baseOut.error);
}

// syncFrom 送一棵樹到 dest，回結果物件，或 { error, attempted }（attempted 是原本要送的檔）。
// skip 是 exclude 的判斷函式；dryRun 只比對、列出會送什麼，不送也不刪；送的量超過 maxBytes 就不送。state 給進度回報讀。
async function syncFrom({ id, dest, src, given, repo, includeIgnored, commit, sha = "", only = null, prune = false, skip = null, dryRun = false,
  maxBytes = DEFAULT_MAX_MB * MB, state = {} }) {
  // 掃檔花多久要留著：卡住的時候訊息裡要講得出是卡在掃檔、比對還是上傳。
  const startedAt = Date.now();
  const remotePath = `/work/${dest}`;
  state.dest = dest;
  state.phase = "picking";
  // 挑檔清單：alsoPaths 指定的那幾個路徑；includeIgnored 照磁碟上的樣子（.git 以外）；commit 模式列 archive 出來的樹；
  // 工作區問 git；不是 git 工作區照黑名單。每一種都有清單，都先跟箱子比對、只送有變的
  // （以前 commit 模式與非 git 的資料夾每次整包重傳：只改一支 .mjs 也要重送 15.9 MB）。
  let fileList;
  let selected;
  let fromGit = false;
  const denied = new Set();
  if (only) {
    fileList = only.list;
    selected = "only alsoPaths: git tracked + untracked files under them, honouring .gitignore";
  } else if (includeIgnored) {
    fileList = treeFileList(src, new Set([".git"]));
    selected = commit ? `git archive ${commit}, with alsoPaths as they are on disk` : "everything under localPath except .git, ignore rules not applied";
  } else if (commit) {
    fileList = treeFileList(src);
    selected = `git archive ${commit}`;
  } else if ((fileList = gitFileList(src))) {
    fromGit = true;
    selected = "git tracked + untracked files, honouring .gitignore";
  } else {
    fileList = treeFileList(src, new Set(SYNC_EXCLUDES), denied);
    selected = `not a git working tree: everything except ${SYNC_EXCLUDES.join(", ")}`;
  }
  const ignored = fromGit ? ignoredTopLevel(given) : { skipped: [...denied].sort(), partiallyIgnored: [], configs: [] };

  const srcPrefix = Buffer.from(src.endsWith("/") ? src : `${src}/`);
  const at = (rel) => Buffer.concat([srcPrefix, rel]);
  // git 還追蹤、但本機已經刪掉的檔不傳：交給 tar 會 Cannot stat，整次 sync 失敗。
  // 用 lstat 不用 existsSync：指向不存在目標的 symlink 仍要照傳。
  const paths = [];
  const excluded = [];
  for (const rel of splitNul(fileList)) {
    try {
      lstatSync(at(rel));
    } catch {
      continue;
    }
    if (skip?.(rel.toString("utf8"))) excluded.push(rel);
    else paths.push(rel);
  }
  state.phase = "hashing";
  state.files = paths.length;
  const manifest = [];
  const always = [];
  for (const rel of paths) {
    const hash = entryHash(at(rel));
    if (hash) manifest.push(`${hash} ${rel.toString("hex")}`);
    else {
      always.push(rel);
      manifest.push(`- ${rel.toString("hex")}`);
    }
  }
  // exclude 擋下的檔不送也不比，但箱子裡那份不算多出來的（不列進 staleInDest、prune 不刪）。
  for (const rel of excluded) manifest.push(`= ${rel.toString("hex")}`);
  // dest 裡多出來的檔：整個 dest 都找（只送幾個路徑時只在那幾個資料夾裡找）；dest 是 /work 本身時不找。
  const roots = only ? only.roots : [""];
  const stale = dest !== "." && roots.length ? { roots, skip: SYNC_EXCLUDES, limit: STALE_LIMIT, dirFiles: STALE_DIR_FILES } : null;
  // includeIgnored 時 node_modules 跟著送，不必看。
  const deps = includeIgnored ? [] : depsPlan(src, paths);
  let verdict;
  const scanMs = Date.now() - startedAt;
  state.phase = "comparing";
  try {
    verdict = await compareOnBox(id, dest, manifest, { stale, deps });
  } catch (err) {
    return { error: `sync failed while comparing with the box (scanned ${paths.length} files in ${Math.round(scanMs / 1000)}s): ${err?.message || err}` };
  }
  const send = verdict.all ? paths : [...verdict.changed.map((hex) => Buffer.from(hex, "hex")), ...always];
  const sentPaths = send.map((p) => p.toString("utf8"));
  const sizeOf = (rel) => {
    try {
      const st = lstatSync(at(rel));
      return st.isFile() ? st.size : 0;
    } catch {
      return 0;
    }
  };
  const sendBytes = send.reduce((n, rel) => n + sizeOf(rel), 0);

  // uploadedMB 對小專案永遠是 0，看起來像什麼都沒傳；bytes 與檔數才看得出成功。
  // sentPaths 列出這次真的送了哪些檔（前 SHOW_PATHS 個）：並行開發時才看得出箱子裡測的是哪一版。
  const out = {
    ok: true, dest, remotePath, uploadedBytes: 0, uploadedMB: 0, selected,
    files: paths.length, sentFiles: send.length, sentPaths: sentPaths.slice(0, SHOW_PATHS),
  };
  if (sha) out.commitSha = sha;
  if (ignored.skipped.length) out.skipped = ignored.skipped;
  if (ignored.partiallyIgnored.length) out.partiallyIgnored = ignored.partiallyIgnored;
  if (excluded.length) out.excluded = { count: excluded.length, paths: excluded.slice(0, SHOW_FEW).map((p) => p.toString("utf8")) };
  const notes = [];
  if (dryRun) {
    Object.assign(out, { dryRun: true, totalMB: Number(mb(paths.reduce((n, rel) => n + sizeOf(rel), 0))), sendMB: Number(mb(sendBytes)), largest: largestDirs(send, sizeOf) });
    notes.push(`dryRun: nothing was sent or deleted. A sync now would send the ${send.length} files in sentPaths (${mb(sendBytes)} MB on disk)${sendBytes > maxBytes ? `, which is over the ${mb(maxBytes)} MB limit, so it would be refused unless you pass maxMB` : ""}.`);
  } else if (sendBytes > maxBytes) {
    return {
      error: `not sent: this sync would upload ${send.length} files, ${mb(sendBytes)} MB on disk, over the ${mb(maxBytes)} MB limit. Largest: ${describeLargest(largestDirs(send, sizeOf))}. ` +
        `If those are build output or downloads, add them to .gitignore or pass exclude (such as ["${largestDirs(send, sizeOf, 1)[0]?.mostly?.path || largestDirs(send, sizeOf, 1)[0]?.path || "dist"}"]), or send just your files with commit: "HEAD" plus alsoPaths. ` +
        `To send all of it anyway, pass maxMB: ${Math.ceil(sendBytes / MB)}. dryRun: true lists what would go without sending anything.`,
    };
  } else if (send.length) {
    state.phase = "uploading";
    state.sendFiles = send.length;
    state.sendBytes = sendBytes;
    state.meter = { bytes: 0 };
    const sent = await uploadWithRetry(id, dest, src, Buffer.concat(send.flatMap((p) => [p, Buffer.from([0])])), repo, false, state.meter);
    if (sent.error) return { error: sent.error, attempted: sentPaths };
    out.uploadedBytes = sent.bytes;
    out.uploadedMB = Number(mb(sent.bytes));
    if (sent.changed !== undefined) out.changedOnBox = sent.changed;
    if (sent.retried) notes.push(retriedNote(sent.retried));
  } else {
    out.changedOnBox = 0;
  }
  if (verdict.deps?.length) {
    out.deps = verdict.deps.map(({ examples, ...d }) => d);
    notes.push(...depsNotes(dest, verdict.deps));
  }
  // dest 是新建的就沒有開著的 dev server 在看它；整包送（all）時箱子只改了內容有變的檔，這裡看的是送出的清單，寧可多提醒。
  const reload = dryRun || verdict.fresh || out.changedOnBox === 0 ? "" : devServerNote(sentPaths);
  if (reload) notes.push(reload);

  // dest 裡多出來的：先用本機的忽略規則篩掉箱子自己產生的東西，剩下的才是本機刪掉或改名、箱子還留著的。exclude 擋下的也不算。
  if (verdict.stale?.length) {
    const candidates = verdict.stale.map((hex) => Buffer.from(hex, "hex")).filter((p) => !skip?.(p.toString("utf8")));
    const kept = dropIgnored(given, candidates);
    const staleFound = kept ?? candidates;
    const capped = verdict.staleTotal > verdict.stale.length;
    if (staleFound.length) {
      out.staleInDest = { count: staleFound.length, paths: staleFound.slice(0, SHOW_FEW).map((p) => p.toString("utf8")) };
      if (capped) out.staleInDest.countIsPartial = true;
      const what = `staleInDest: ${staleFound.length}${capped ? "+" : ""} files in ${remotePath} that localPath does not have (deleted or renamed locally, or created in the box)`;
      if (dryRun) {
        notes.push(`${what}; a sync with prune: true would delete them.`);
      } else if (!prune) {
        notes.push(commit || inGitWorkTree(given)
          ? `${what} were left in place. Pass prune: true to delete them, or ignore them if the box made them.`
          : `${what} were left in place. localPath is not a git working tree, so prune cannot tell them from what the box built: delete the ones that should go with sandbox_exec.`);
      } else if (!kept) {
        notes.push("prune skipped: the local ignore rules could not be read (git check-ignore failed), so nothing was deleted.");
      } else {
        state.phase = "pruning";
        try {
          const done = await pruneOnBox(id, dest, staleFound.map((p) => p.toString("hex")));
          out.pruned = done.deleted;
          if (done.failed.length) out.pruneFailed = done.failed.slice(0, SHOW_FEW).map((hex) => Buffer.from(hex, "hex").toString("utf8"));
          if (capped) notes.push(`prune looked at the first ${STALE_LIMIT} stale entries only; sync again with prune to delete the rest.`);
        } catch (err) {
          out.pruneError = `${err?.message || err}`;
          notes.push(`prune failed, so the stale files listed in staleInDest are still in ${remotePath}.`);
        }
      }
    }
  }
  const plain = scriptModeNote(src, send);
  if (plain) notes.push(plain);
  // 第一次送進這個 dest 時講一次：設定檔被 ignore 規則擋下、箱子裡沒有 .git。
  if (verdict.fresh) {
    const configs = ignored.configs || [];
    if (configs.length) {
      const shown = configs.slice(0, 5);
      notes.push(`${shown.join(", ")}${configs.length > 5 ? `, and ${configs.length - 5} more` : ""} ${configs.length > 1 ? "were" : "was"} not sent: the ignore rules skip ${configs.length > 1 ? "them" : "it"}. If a build in the box needs ${configs.length > 1 ? "them" : "it"}, sync again with alsoPaths: ${JSON.stringify(shown)} (that sends only those) or with includeIgnored: true.`);
    }
    notes.push(`No .git is sent, so git commands in ${remotePath} fail with "not a git repository".${sha ? ` This tree is commit ${sha.slice(0, 12)} (commitSha).` : ""} When you need git there (git diff, git log, git describe), git clone in the box instead.`);
  }
  if (notes.length) out.notes = notes;
  return out;
}

// PSBX_ADAPTER_NO_CONNECT 是給測試用的：只載入這支模組拿裡面的純函式，不連遠端、不接 stdio。
const connect = !process.env.PSBX_ADAPTER_NO_CONNECT;
if (connect && API_KEY) await connectRemote();

// instructions 照 control 給的轉交：client 會放進 agent 的 system prompt（例如用完要填 sandbox_feedback）。
const feedbackHost = process.env.PSBX_FEEDBACK_HOST || "";
if (managedSession && feedbackHost) throw new Error("A managed session must have one feedback owner; remove PSBX_FEEDBACK_HOST");
if (feedbackHost && !["claude-code", "codex"].includes(feedbackHost)) throw new Error("PSBX_FEEDBACK_HOST must be claude-code or codex");
const server = new Server({ name: "parallelsandbox", version: "0.5.3" }, {
  capabilities: { tools: { listChanged: true }, ...(feedbackHost === "claude-code" ? CLAUDE_CHANNEL_CAPABILITIES : {}) },
  instructions: [connected ? remote.getInstructions() : "ParallelSandbox is signing in. Call parallelsandbox_connect to get the sign-in link or check completion. After sign-in, its sandbox_* and logs_* tools become available. Give every box a goal and finish with sandbox_review or sandbox_stop.", feedbackHost === "claude-code" ? CLAUDE_CHANNEL_INSTRUCTIONS : "", !managedSession && !feedbackHost ? setupInstructions() : ""].filter(Boolean).join("\n\n"),
});
claudeChannel = feedbackHost === "claude-code" ? createClaudeChannel({server, authorizedFetch, apiUrl: API_URL, headers: remoteHeaders, consumerId: AGENT_ID}) : null;
codexFeedback = feedbackHost === "codex" ? createCodexFeedback({
  apiUrl: API_URL, headers: remoteHeaders, authorizedFetch,
  socketPath: process.env.PSBX_CODEX_HOST_SOCKET,
  stateDir: process.env.PSBX_CODEX_FEEDBACK_DIR,
  cliPath: process.env.PSBX_CODEX_CLI,
  callRemoteReport: ({id, reportId, signal}) => callWithRetry("sandbox_report", {id, reportId}, DEFAULT_TIMEOUT_MS, undefined, signal),
  onState: (state) => log("feedback:", state),
}) : null;
// App feedback back to the conversation that asked for the review (see feedback-relay.mjs).
const feedbackRoute = connect && !managedSession && !feedbackHost ? createFeedbackRoute({
  apiUrl: API_URL, mcpUrl: MCP_URL, agentId: AGENT_ID, authorizedFetch, headers: remoteHeaders, log,
}) : null;
const connectTool = { name: "parallelsandbox_connect", description: "Connect ParallelSandbox, or check sign-in status. If sign-in is pending, show the person the returned link to sign in and allow their AI tool. Call again after they finish.", inputSchema: { type: "object", properties: {} } };
let signingIn = null;
function beginSignIn() {
  if (signingIn) return;
  connected = false;
  signingIn = (async () => {
    await remote.close();
    await oauth.ensureLogin();
    try { await connectRemote(); }
    catch (err) {
      if (!(err instanceof LoginRequired)) throw err;
      // Saved credentials may have expired or been revoked since the last run.
      await oauth.ensureLogin();
      await connectRemote();
    }
    await server.sendToolListChanged().catch(() => {});
  })().catch((err) => log(err instanceof LoginRequired ? err.message : `Connection failed: ${err.message}`))
    .finally(() => { signingIn = null; });
}
// 工具清單改版：client 只在連線時抓一次清單，長對話裡一直用舊的（9/26 sandbox_start 加了必填的 goal，舊清單沒有那一欄，
// 連續七次第一次呼叫被拒）。定期問 control 現在的清單，跟上次交給 client 的不一樣就送 notifications/tools/list_changed，
// client 自己重抓；工具回「… is required」這種像是清單過期的錯誤時也立刻看一次。
const TOOLS_CHECK_MS = Number(process.env.PSBX_ADAPTER_TOOLS_CHECK_MS) || 10 * 60_000;
let servedToolsHash = null;
let checkingTools = null;
function toolsHash(tools) {
  return createHash("sha256").update(JSON.stringify(tools)).digest("hex");
}
function checkToolsChanged() {
  if (!connected || servedToolsHash === null) return Promise.resolve(false);
  checkingTools ??= (async () => {
    try {
      const { tools } = await remote.listTools();
      const hash = toolsHash(tools);
      if (hash === servedToolsHash) return false;
      servedToolsHash = hash; // 一次改版只通知一次：client 不重抓的話也不要每十分鐘吵一次
      await server.sendToolListChanged();
      log("the ParallelSandbox tool list changed; asked the client to fetch it again");
      return true;
    } catch (err) {
      log("tool list check:", err?.message || err);
      return false;
    }
  })().finally(() => { checkingTools = null; });
  return checkingTools;
}
const STALE_SCHEMA_ERROR = /\b(is|are) required\b/;

server.oninitialized = () => {
  if (connected && oauth) server.sendToolListChanged().catch(() => {});
  if (connect) setInterval(() => { checkToolsChanged(); }, TOOLS_CHECK_MS).unref();
  if (connect) {
    claudeChannel?.startHandshake().catch((err) => log("channel:", err?.message || err));
    Promise.resolve(codexFeedback?.start()).catch((err) => log("feedback:", err?.message || err));
    if (feedbackRoute) {
      // A relay that crashed while this host stays open comes back within a minute.
      const resume = () => feedbackRoute.resumeRelay().catch((err) => log("feedback relay:", err?.message || err));
      resume();
      setInterval(resume, 60_000).unref();
    }
  }
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Native activation can arrive before ParallelSandbox OAuth finishes. Its
  // local ready tool must already be discoverable to answer that exact nonce.
  const localTools = [...(oauth ? [connectTool] : []), ...(claudeChannel?.readyToolDefs || [])];
  if (oauth && !connected) return { tools: localTools };
  if (oauth && !oauth.hasTokens()) { beginSignIn(); return { tools: localTools }; }
  try {
    const { tools } = await remote.listTools();
    servedToolsHash = toolsHash(tools);
    return { tools: [...tools, ...localTools] };
  } catch (err) {
    if (!(err instanceof LoginRequired)) throw err;
    beginSignIn();
    return { tools: localTools };
  }
});

// tellRemoteWhoIsCalling：把呼叫端 initialize 時報的名字轉給 control（X-Psbx-Client）。
// 報不出來就不帶，control 那邊就不顯示，不猜。
function tellRemoteWhoIsCalling() {
  const who = server.getClientVersion?.();
  if (!who?.name) return;
  remoteHeaders["X-Psbx-Client"] = who.version ? `${who.name}/${who.version}` : who.name;
}

// 連線斷掉時可以直接重試的工具：只讀、或再做一次結果一樣。
// 會改東西的（exec、sync、start、stop…）一律不重試：連線失敗不代表指令沒跑，重跑等於做兩次 build。
const RETRY_SAFE = new Set([
  "sandbox_report", "sandbox_list", "sandbox_get", "sandbox_versions", "sandbox_secrets", "sandbox_environments",
  "logs_search", "logs_errors", "logs_tail",
]);

// control 的驗證上游（會員中心，經 CubeLV router）出事時整個 /mcp 回 HTTP 503，ALB 後面沒有健康的 control 時也是 503：
// 兩種都還沒進到工具、什麼都沒跑，所以任何工具（exec、start 也一樣）都可以退避重試。9/28 這種 503 連著回了約 80 分鐘，
// agent 只拿到一行 "auth unavailable"。退避的總長配合 host 的工具期限（PSBX_TOOL_TIMEOUT_SEC，跟 reviewWaitBudget 同一個），
// 試完還是 503 就講清楚已經中斷多久、原因是什麼。
const UNAVAILABLE_FIRST_MS = Number(process.env.PSBX_ADAPTER_UNAVAILABLE_FIRST_MS) || 2_000;
const UNAVAILABLE_MAX_DELAY_MS = 30_000;
const UNAVAILABLE_BUDGET_MS = Number(process.env.PSBX_ADAPTER_UNAVAILABLE_BUDGET_MS) || unavailableBudgetMs();
let unavailableSince = null; // 這一串 503 的第一次（跨呼叫），有呼叫拿到回應就清掉

function unavailableBudgetMs(hostTimeoutSec = process.env.PSBX_TOOL_TIMEOUT_SEC) {
  const parsed = Number(hostTimeoutSec);
  const hostSec = Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
  return Math.min(180, Math.max(20, Math.floor(hostSec) - 15)) * 1000;
}

// unavailable 認 SDK 丟出來的 HTTP 503（StreamableHTTPError：code 是狀態碼，message 尾巴是回應 body）。
// control 的 body 是 {error, reason: maintenance|upstream_auth, retryAfterSec}；ALB 的是 HTML，就只知道是 503。
function unavailable(err) {
  if (err?.code !== 503) return null;
  const text = String(err.message || "");
  let body = null;
  try { body = JSON.parse(text.slice(text.indexOf("{"))); } catch { body = null; }
  return {
    reason: typeof body?.reason === "string" ? body.reason : "",
    retryAfterMs: Number(body?.retryAfterSec) > 0 ? Number(body.retryAfterSec) * 1000 : 0,
    message: typeof body?.error === "string" ? body.error : "",
  };
}

function seconds(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function sleepUnlessAborted(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

function unavailableResult(name, down, tries) {
  const since = unavailableSince ?? Date.now();
  const why = down.message || "no ParallelSandbox server answered (HTTP 503 from the load balancer). This call did not run and your boxes keep running.";
  return textResult(`${name}: ParallelSandbox has answered HTTP 503 for ${seconds(Date.now() - since)} (since ${new Date(since).toISOString()}; ${tries} tries in this call, reason: ${down.reason || "unavailable"}). ${why} ` +
    "Nothing reached the box, so it is safe to call this again later. While this lasts every sandbox_* tool fails the same way: tell the person ParallelSandbox is unavailable instead of working around it.", true);
}

// LOST_CONNECTION 認「往 control 的連線斷了」的錯。terminated 是 Node（undici）讀回應 body 讀到一半連線被切斷時丟的
// （cause 是 other side closed 或逾時，networkFailure 會帶上）：短的呼叫 control 直接回整包 JSON，不是 SSE，看門狗看不到，錯誤直接從 SDK 冒上來。
// 回報過 sandbox_shot 回「error: terminated」、重試就好，所以算成連線斷了，唯讀的照樣自己重試一次。
// 只認開頭（或「…: terminated」）：control 回的錯誤裡也可能有「box … is terminated」，那不是連線斷了。
const LOST_CONNECTION = /fetch failed|(?:^|: )terminated\b|other side closed|socket hang up|ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|network/i;

// 連線還沒建立就失敗的錯誤碼（DNS 查不到、連不上）：請求根本沒送出去，任何工具都可以安全重試。
// 9/29 有一段約 4 分鐘的 DNS 異常，每個工具都只回一行 fetch failed，agent 分不出是箱子出事還是這台機器的網路。
const NOT_SENT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
const NOT_SENT_RETRIES = 2;
const NOT_SENT_DELAY_MS = Number(process.env.PSBX_ADAPTER_NOT_SENT_DELAY_MS) || 5_000;

// networkCode 從錯誤（與它的 cause 鏈）找出 Node 的網路錯誤碼；fetch 的 TypeError 本身沒有，碼在 cause 裡。
function networkCode(err) {
  for (let e = err, i = 0; e && i < 5; e = e.cause, i++) {
    if (typeof e.code === "string" && NOT_SENT_CODES.has(e.code)) return e.code;
  }
  return "";
}

// 給名字、目的照 control 的規則整理（cleanBoxName、cleanGoal），才比得出是不是同一個 sandbox_start 開的箱子。
function startKey(args) {
  const name = [...String(args?.name || "").trim().replace(/[\n\r\t]/g, " ")].slice(0, 60).join("");
  const goal = [...String(args?.goal || "").trim()].slice(0, 500).join("");
  return { name, goal };
}

// matchStartedBox 在 sandbox_list 的結果裡找這個對話剛剛用同一個名字與目的開的箱子（since 之後建立的，最新的一個）。
// 使用回饋：sandbox_start 的結果沒回來（或 host 先把呼叫切掉，畫面上寫「被中斷」），箱子其實已經開好，要自己翻清單才找得到。
function matchStartedBox(listPayload, args, since) {
  const want = startKey(args);
  const boxes = Array.isArray(listPayload?.boxes) ? listPayload.boxes : [];
  return boxes
    .filter((b) => b?.agent?.thisConversation && (b.name || "") === want.name && (b.goal || "") === want.goal && Date.parse(b.createdAt) >= since - 60_000)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] || null;
}

// findStartedBox 問 control 的 sandbox_list，回 matchStartedBox 的結果；問不到回 undefined（不知道有沒有開）。
async function findStartedBox(args, since) {
  try {
    const out = await callWatched("sandbox_list", {}, 30_000);
    if (out.lost || out.result?.isError) return undefined;
    const text = out.result?.content?.find((c) => c.type === "text")?.text;
    return matchStartedBox(JSON.parse(text), args, since);
  } catch {
    return undefined;
  }
}

function startedBoxText(box) {
  return `It did create box ${box.id} (status ${box.status}, created ${box.createdAt}). Use that box: sandbox_status {"id": "${box.id}"} gives its URLs and state. Do not start another one for the same work.`;
}

// interruptedStarts：這個對話裡被 host 切掉（被中斷、逾時）的 sandbox_start，結果沒交到 agent 手上。
// 下一個呼叫時查一次它有沒有開出箱子：同名同目的再開一次就直接回那個箱子，其他工具的結果後面附一句。
const interruptedStarts = [];

async function interruptedStartNote(nextName, nextArgs) {
  if (!interruptedStarts.length) return { note: "" };
  const pending = interruptedStarts.splice(0);
  const notes = [];
  let reuse = null;
  for (const p of pending) {
    const box = await findStartedBox(p.args, p.since);
    if (!box) continue;
    const same = nextName === "sandbox_start" && JSON.stringify(startKey(nextArgs)) === JSON.stringify(startKey(p.args)) && !nextArgs?.restore;
    if (same && !reuse) reuse = box;
    else notes.push(`An earlier sandbox_start in this conversation was interrupted before its result came back. ${startedBoxText(box)}`);
  }
  return { note: notes.join("\n"), reuse };
}

// callWithRetry：連線沒了（fetch failed，或看門狗判定結果回不來）時，能重試的再試一次；不能重試的就把話講清楚，
// 不要讓人以為「指令一定沒跑」。HTTP 503 是還沒進到工具就被擋下，任何工具都退避重試（見 UNAVAILABLE_BUDGET_MS）。
async function callWithRetry(name, args, timeout, onAlive, signal) {
  const shotIsReadOnly = name === "sandbox_shot" && !(args || {}).record;
  const canRetry = RETRY_SAFE.has(name) || shotIsReadOnly;
  const startedAt = Date.now();
  let retriedLost = false;
  let unavailableTries = 0;
  let notSentTries = 0;
  let retryUntil = 0;
  for (;;) {
    let out;
    try {
      out = await callWatched(name, args, timeout, onAlive, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      const down = unavailable(err);
      if (down) {
        const now = Date.now();
        unavailableSince ??= now;
        retryUntil ||= now + UNAVAILABLE_BUDGET_MS;
        const delay = Math.min(UNAVAILABLE_MAX_DELAY_MS, Math.max(down.retryAfterMs, UNAVAILABLE_FIRST_MS * 2 ** unavailableTries));
        unavailableTries++;
        if (now + delay > retryUntil) return unavailableResult(name, down, unavailableTries);
        log(`${name}: HTTP 503 (${down.reason || "unavailable"}), retrying in ${seconds(delay)}`);
        onAlive?.({ message: `${name}: ParallelSandbox answered 503 (${down.reason || "unavailable"}), retrying in ${seconds(delay)}` });
        await sleepUnlessAborted(delay, signal);
        continue;
      }
      const msg = err?.message || String(err);
      const code = networkCode(err);
      if (code) {
        // 連線還沒建立：請求沒送出去，任何工具都能重試，等一下再試
        if (notSentTries < NOT_SENT_RETRIES) {
          notSentTries++;
          const delay = NOT_SENT_DELAY_MS * notSentTries;
          log(`${name}: could not reach ParallelSandbox (${code}), retrying in ${seconds(delay)}`);
          onAlive?.({ message: `${name}: could not reach ParallelSandbox (${code}), retrying in ${seconds(delay)}` });
          await sleepUnlessAborted(delay, signal);
          continue;
        }
        return textResult(`${name}: ${networkFailure(err)}. A temporary network or DNS problem between this computer and ParallelSandbox, not a problem with the box. ` +
          `The request was never sent, so nothing ran; ${notSentTries + 1} tries in this call. Call it again in a minute; if it keeps failing, check this machine's network.`, true);
      }
      if (!LOST_CONNECTION.test(msg)) throw err;
      out = { lost: networkFailure(err), network: true };
    }
    if (!out.lost) {
      unavailableSince = null;
      return out.result;
    }
    log(`${name}: ${out.lost}`);
    if (signal?.aborted) throw signal.reason;
    if (canRetry && !retriedLost) {
      retriedLost = true;
      continue;
    }
    if (name === "sandbox_review") {
      return textResult(`${name}: the result never came back (${out.lost}). The review and feedback may still exist. Resume with the reviewId shown in progress instead of creating a new card with what. To recover a submitted report, use sandbox_report with the box id and the reportId from the app.`, true);
    }
    if (name === "sandbox_status") {
      return textResult(`${name}: the result never came back (${out.lost}). This call may already have prepared pending human feedback, so it was not retried. Recover the report with sandbox_report using the box id and the reportId from the app; a repeated status call cannot replay a report already handed off.`, true);
    }
    const where = out.network ? " This broke between this computer and ParallelSandbox, not inside the box: the box's own connections to your environment are in sandbox_status environment.connections[]." : "";
    if (name === "sandbox_exec" && args?.execId) {
      return textResult(`${name}: the result never came back (${out.lost}).${where} The command keeps running on the box until it ends or its timeoutSec runs out. ` +
        `Get its result with sandbox_procs {"id": ${JSON.stringify(args.id ?? "")}, "action": "wait", "bgId": "${args.execId}"}: it returns the exitCode and the end of the output once the command ends. ` +
        "Do not run it again before that. If that answers bgId not found, the command never reached the box (or the box runs an older image): check sandbox_status steps[] instead.", true);
    }
    if (name === "sandbox_start" && !(args || {}).restore) {
      const box = await findStartedBox(args, startedAt);
      if (box) return textResult(`${name}: the result never came back (${out.lost}). ${startedBoxText(box)}`, true);
      if (box === null) return textResult(`${name}: the result never came back (${out.lost}). No box with this name and goal from this conversation is in sandbox_list, so it did not start: call sandbox_start again.`, true);
      return textResult(`${name}: the result never came back (${out.lost}). It may have started a box: look in sandbox_list for one with this name and goal (agent.thisConversation true) before starting another.`, true);
    }
    return textResult(`${name}: the result never came back (${out.lost}).${where} It may have started or even finished on the box: check sandbox_status (steps[] lists what was run there) and what it should have produced before running it again.`, true);
  }
}

// networkFailure 說連線斷在哪一段、為什麼：以前只有一句 fetch failed，分不出是這台電腦連不到 ParallelSandbox，
// 還是箱子連不到使用者的環境。undici 把真正的原因（ENOTFOUND、ECONNREFUSED、ENETUNREACH…）放在 err.cause。
function networkFailure(err) {
  const msg = err?.message || String(err);
  const cause = err?.cause;
  const code = cause?.code || "";
  const detail = cause?.message && cause.message !== msg && !String(cause.message).startsWith(code + " ") ? cause.message : "";
  const why = [code, detail].filter(Boolean).join(": ");
  let host = MCP_URL;
  try { host = new URL(MCP_URL).host; } catch {}
  return `connection from this computer to ParallelSandbox (${host}) failed: ${msg}${why ? ` (${why})` : ""}`;
}

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  tellRemoteWhoIsCalling();
  const { name, arguments: args } = req.params;
  if (claudeChannel?.handlesTool(name)) return await claudeChannel.handleTool(name, args || {});
  if (oauth && name === "parallelsandbox_connect") {
    if (connected && oauth.hasTokens()) return textResult("ParallelSandbox is connected. Its sandbox_* and logs_* tools are ready.");
    beginSignIn();
    const url = oauth.status();
    return textResult(url ? `Sign in and allow ParallelSandbox: ${url}\nAfterwards call parallelsandbox_connect again.` : "ParallelSandbox is preparing sign-in. Call parallelsandbox_connect again shortly for the link.");
  }
  if (oauth && !connected) { beginSignIn(); return textResult(new LoginRequired().message, true); }
  startPresence();
  try {
    if (name === "sandbox_sync" || name === "sandbox_pull") {
      return await localTool(name, args, progressRelay(name, req.params._meta?.progressToken, extra), extra.signal);
    }
    // 上一個 sandbox_start 被 host 切掉了：先查它有沒有開出箱子。同名同目的再開一次就回那個箱子，不開第二個。
    const earlier = await interruptedStartNote(name, args);
    if (earlier.reuse) {
      return textResult(`sandbox_start: an earlier sandbox_start with this name and goal was interrupted before its result came back. ${startedBoxText(earlier.reuse)} To start a second box anyway, call sandbox_start again.`);
    }
    const timeout = name === "sandbox_takeover" || name === "sandbox_review" ? TAKEOVER_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    let remoteArgs = managedSession && name === "sandbox_review" ? {...args, waitSec: 0} : args;
    // 前景的 sandbox_exec 事先給一個編號：結果在路上斷了（看門狗、client 逾時），叫 agent 拿它去 sandbox_procs 取結果。
    if (name === "sandbox_exec" && args && !args.background && !args.execId) {
      remoteArgs = {...args, execId: randomBytes(8).toString("hex")};
    }
    // sandbox_get 的 path 常照抄 sandbox_exec 裡的 /work/...：換成相對 /work，舊映像的箱子也收得下。
    if (name === "sandbox_get" && args) {
      remoteArgs = {...args, ...(typeof args.path === "string" ? {path: workRel(args.path)} : {}), ...(Array.isArray(args.paths) ? {paths: args.paths.map(workRel)} : {})};
    }
    const callStarted = Date.now();
    let result;
    try {
      result = await callWithRetry(name, remoteArgs, timeout, progressRelay(name, req.params._meta?.progressToken, extra), extra.signal);
    } catch (err) {
      if (name === "sandbox_start" && extra.signal?.aborted && !args?.restore) interruptedStarts.push({ args: args || {}, since: callStarted });
      throw err;
    }
    if (result?.isError && STALE_SCHEMA_ERROR.test(result.content?.find?.((c) => c.type === "text")?.text || "")) checkToolsChanged();
    if (earlier.note) result.content = [...(result.content || []), {type: "text", text: earlier.note}];
    if (name === "sandbox_exec" && typeof args?.id === "string") {
      const warning = staleSyncWarning(args.id);
      if (warning) result.content = [...(result.content || []), {type: "text", text: warning}];
    }
    if (name === "sandbox_review" && !result?.isError) {
      const payload = result?.structuredContent || result?.content?.filter((item) => item.type === "text").map((item) => {
        try { return JSON.parse(item.text); } catch { return null; }
      }).find((item) => item?.ok === true && typeof item.reviewId === "string");
      if (payload?.ok === true && payload.reviewId && typeof args?.id === "string") {
        try {
          if (managedSession) {
            const registered = await managedSession.bindReview({boxId: args.id, reviewId: payload.reviewId});
            result.content = [...(result.content || []), {type: "text", text: JSON.stringify({automaticFeedback: registered,
              note: "The original native session's supervisor owns feedback delivery. This tool hands off immediately; App feedback will resume this same session after its current turn finishes."})}];
          }
          const claudeBinding = await claudeChannel?.onReviewResult(args.id, result);
          if (claudeBinding && !claudeBinding.bound) {
            result.content = [...(result.content || []), {type: "text", text: JSON.stringify({automaticFeedback: {host: "claude-code", registered: false, reason: claudeBinding.reason || "unavailable"}, note: "The review card was created. Native event activation alone does not verify routing to the original session. The saved report remains available through sandbox_report."})}];
          }
          if (feedbackRoute) {
            const route = await feedbackRoute.trackReview({boxId: args.id, reviewId: payload.reviewId, clientName: server.getClientVersion?.()?.name, meta: req.params._meta});
            const missing = reviewInstallNote(server.getClientVersion?.()?.name, {id: args.id, reviewId: payload.reviewId});
            const automatic = route.automatic === true || (route.automatic && !missing);
            result.content = [...(result.content || []), {type: "text", text: automatic
              ? "App feedback for this review returns to this same conversation as a follow-up message. You may finish your turn; the follow-up tells you which report to read with sandbox_report."
              : missing || "Automatic delivery to this conversation is not available; read a submitted report with sandbox_report."}];
          }
          const tracked = await codexFeedback?.trackReview({boxId: args.id, reviewId: payload.reviewId});
          if (tracked?.hookMeta) result._meta = {...result._meta, psbxCodexFeedback: tracked.hookMeta};
          if (codexFeedback && !tracked?.supported) {
            result.content = [...(result.content || []), {type: "text", text: tracked?.configured
              ? "Codex automatic feedback pairing is pending its trusted review hook and original App Server thread check. This review result does not confirm an automatic continuation route."
              : "Codex automatic continuation is unavailable: this adapter has no paired official App Server endpoint. The current Desktop private stdio connection does not provide that endpoint."}];
          }
        } catch (err) {
          log("feedback binding:", err?.message || err);
          result.content = [...(result.content || []), {type: "text", text: "The review card was created, but its automatic feedback route could not be registered. This result does not mean that a stopped conversation will restart. Keep this reviewId; the saved report can still be recovered with sandbox_report."}];
        }
      }
    }
    try {
      await claudeChannel?.onToolResult(name, args || {}, result);
      if (feedbackRoute && name === "sandbox_report" && !result?.isError && args?.reportId) {
        await feedbackRoute.onReportRead({boxId: args.id, reportId: args.reportId}).catch((error) => log("feedback read:", error.message));
      }
      if (managedSession && name === "sandbox_report" && !result?.isError) {
        // Only the complete successful native tool result acknowledges this read.
        // Ordinary report replay outside a dispatched turn need not register one.
        await managedSession.reportRead({boxId: args?.id, reportId: args?.reportId}).catch((error) => log("session report:", error.message));
      }
    } catch (err) {
      log("feedback receipt:", err?.message || err);
    }
    return result;
  } catch (err) {
    if (!(err instanceof LoginRequired)) throw err;
    beginSignIn();
    return textResult(err.message, true);
  }
});

// progressRelay：control 在連線上出聲（still running）時，轉一則進度給 client。client 有給 progressToken 才轉。
// 沒有這個，Claude Code 只看得到「30 分鐘沒動靜」，跑超過 30 分鐘的 build 會被它砍掉。
function progressRelay(name, token, extra) {
  if (token === undefined) return undefined;
  const started = Date.now();
  let sent = 0;
  let progressValue = 0;
  return (progress) => {
    const now = Date.now();
    // Preserve semantic progress, especially the review URL, after a byte heartbeat.
    if (!progress && now - sent < PROGRESS_EVERY_MS) return;
    sent = now;
    progressValue = Math.max(progressValue, progress?.progress ?? 0, (now - started) / 1000);
    extra.sendNotification({
      method: "notifications/progress",
      params: { ...progress, progressToken: token, progress: progressValue, message: progress?.message ?? `${name} still running (${Math.round((now - started) / 1000)}s)` },
    }).catch(() => {});
  };
}

if (connect) {
  watchForExit();
  await server.connect(new StdioServerTransport());
  // Start stdio before waiting for the browser so clients' startup timers keep working.
  if (oauth) beginSignIn();
}

export { AGENT_ID, archiveCommit, baselineDest, boxRel, cleanRefusal, copyInto, depsPlan, dropIgnored, gitFileList, globMatcher, ignoredTopLevel, largestDirs, localTool, matchStartedBox, networkCode, networkFailure, onlyList, presence, pruneEntries, pull as pullTool, repoName, reviewWaitBudget, setBoxExecForTest, setBoxGetForTest, staleEntries, staleSyncWarning, startPresence, sync as syncTool, toolsHash, treeFileList, uncommittedPaths, unpackDirectory, watchForExit, workRel };
