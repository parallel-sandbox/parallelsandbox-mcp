#!/usr/bin/env node
// parallelsandbox-mcp: stdio in, ParallelSandbox Streamable HTTP out.
// Every tool call is forwarded to https://mcp.parallelsandbox.com/mcp with OAuth (or an optional API key), except sandbox_sync,
// which compares the local directory with the box, tars only the files that differ and uploads them through
// POST /v1/boxes/{id}/sync.

import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
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

// 箱子裡跑的比對程式：清單每行「雜湊 空格 路徑 bytes 的 hex」（檔名不一定是合法 UTF-8），
// 跟 dest 現有的檔一個個比，印出不一樣或不存在的路徑。雜湊是 "-" 的是照送、不比對的路徑（子模組這種資料夾），只拿來認得它不是多出來的。
// 有第四個參數（JSON）時再用 staleEntries 列出 dest 裡多出來的東西。清單讀進來就把自己這包刪掉。
const COMPARE_SCRIPT = `import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { dirname } from "node:path";
${entryHash.toString()}
${staleEntries.toString()}
const [manifest, dest, limit, staleOpts] = process.argv.slice(2);
const lines = readFileSync(manifest, "utf8").split("\\n").filter(Boolean);
rmSync(dirname(manifest), { recursive: true, force: true });
if (!existsSync(dest)) {
  console.log(JSON.stringify({ all: true, fresh: true }));
  process.exit(0);
}
const prefix = Buffer.from(dest.endsWith("/") ? dest : dest + "/");
const keep = new Set();
let changed = [];
let all = false;
for (const line of lines) {
  const space = line.indexOf(" ");
  const hash = line.slice(0, space);
  const hex = line.slice(space + 1);
  keep.add(hex);
  if (all || hash === "-") continue;
  if (entryHash(Buffer.concat([prefix, Buffer.from(hex, "hex")])) !== hash) {
    changed.push(hex);
    if (changed.length > Number(limit)) {
      all = true;
      changed = [];
    }
  }
}
const out = all ? { all: true } : { changed };
if (staleOpts) {
  const o = JSON.parse(staleOpts);
  Object.assign(out, staleEntries(Buffer.from(dest.replace(/\\/+$/, "")), keep, o.roots, new Set(o.skip), o.limit, o.dirFiles));
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

const remote = new Client({ name: "parallelsandbox-mcp", version: "0.5.2" });
// 同一個 headers 物件每次請求都會被讀到，所以握手拿到對方是誰之後直接塞進去。
// 沒有這個，control 只知道「某個 API key 開了箱子」，人在 app 裡看不出是 Claude 還是 Codex 在用。
const managedSession = sessionBridge();
const remoteHeaders = { ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}), "X-Psbx-Review-Wait-Sec": managedSession ? "0" : String(reviewWaitBudget()) };
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
const STALL_MS = 120_000;

async function upload(id, dest, src, list, repo = "", noDenylist = false) {
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
      cb(null, chunk);
    },
  });
  // 看門狗：沒在動就把 tar 殺掉，fetch 那邊會拿到串流中斷的錯誤，訊息裡帶上卡住的階段與已傳量。
  let stalled = false;
  const watchdog = setInterval(() => {
    if (Date.now() - movedAt < STALL_MS) return;
    stalled = true;
    clearInterval(watchdog);
    tar.kill("SIGKILL");
  }, 5_000);
  const stallNote = () => `stalled while uploading: nothing moved for ${Math.round(STALL_MS / 1000)}s after ${(bytes / 1024 / 1024).toFixed(1)} MB`;
  let tarErr = "";
  tar.stderr.on("data", (d) => {
    if (tarErr.length < 4096) tarErr += d.toString();
  });
  const exited = new Promise((res) => tar.on("close", res));

  let response;
  try {
    const query = `dest=${encodeURIComponent(dest)}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`;
    response = await fetch(`${API_URL}/v1/boxes/${encodeURIComponent(id)}/sync?${query}`, {
      method: "POST",
      headers: { ...Object.fromEntries(new Headers(headers)), "Content-Type": "application/gzip" },
      body: Readable.toWeb(tar.stdout.pipe(counter)),
      duplex: "half",
    });
  } catch (err) {
    clearInterval(watchdog);
    tar.kill("SIGKILL");
    if (stalled) return { error: stallNote() };
    return { error: `sync failed while uploading: ${err?.message || err}${tarErr ? ` (tar: ${tarErr.trim()})` : ""}` };
  }
  clearInterval(watchdog);
  if (stalled) return { error: stallNote() };
  // 對方沒讀完就回錯（dest 不合法、箱子凍住）時，tar 還卡在寫不出去的 pipe 上，等它結束會等到天荒地老：
  // 實際發生過整個目錄 sync 帶錯 dest，掛滿 1800 秒。回錯了就直接收掉 tar。
  if (!response.ok) tar.kill("SIGKILL");
  const code = await exited;
  const body = await response.text();
  if (!response.ok) {
    let message = body;
    try {
      message = JSON.parse(body).error || body;
    } catch {}
    return { error: `sync failed (HTTP ${response.status}): ${message}` };
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
let boxExec = (args, timeout) => remote.callTool({ name: "sandbox_exec", arguments: args }, undefined, { timeout });
const setBoxExecForTest = (fn) => {
  boxExec = fn;
};

// execOnBox 跑一條指令，回解析過的結果（stdout、exitCode…）；工具本身回錯就丟例外。
// note 是 control 規定必填的（人在 app 上看到的「現在在做什麼」）。
async function execOnBox(id, cmd, note, timeoutSec = 300) {
  const res = await boxExec({ id, cmd, timeoutSec, note: note.slice(0, 200) }, (timeoutSec + 30) * 1000);
  const text = (res.content || []).map((c) => c.text || "").join("");
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}

// runOnBox 把 files（檔名 → 內容）送進箱子的 /work/.psbx-sync/<亂數>，跑 command(那個資料夾)，回它最後印的那行 JSON。
// 程式自己會把那個資料夾刪掉。
async function runOnBox(id, files, command, note) {
  const nonce = randomBytes(6).toString("hex");
  const stage = mkdtempSync(join(tmpdir(), "psbx-sync-"));
  let sent;
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(stage, name), body);
    sent = await upload(id, `.psbx-sync/${nonce}`, stage, null);
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

// compareOnBox 把本機的雜湊清單送進箱子，在箱子裡比對 dest，回 { all: true } 或 { changed: [路徑 hex] }；
// dest 還不存在時多帶 fresh。staleOpts 有給時再帶 { stale: [路徑 hex], staleTotal }。
function compareOnBox(id, dest, manifest, staleOpts) {
  const extra = staleOpts ? ` ${shellQuote(JSON.stringify(staleOpts))}` : "";
  return runOnBox(id, { manifest: manifest.join("\n"), "compare.mjs": COMPARE_SCRIPT },
    (dir) => `node ${dir}/compare.mjs ${dir}/manifest ${shellQuote(`/work/${dest}`)} ${COMPARE_LIMIT}${extra}`,
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

// treeFileList 列出 dir 底下每個檔與連結（NUL 分隔、相對 dir，跟 gitFileList 同格式），skip 裡的名字整個略過。
// commit 模式的樹（git archive 解出來的）本身就是挑好的檔，有了清單就能跟箱子比對、只送有變的、列出 dest 裡多出來的。
function treeFileList(dir, skip = new Set()) {
  const out = [];
  const walk = (abs, rel) => {
    for (const d of readdirSync(abs, { withFileTypes: true, encoding: "buffer" })) {
      if (skip.has(d.name.toString())) continue;
      const r = rel ? Buffer.concat([rel, Buffer.from("/"), d.name]) : d.name;
      if (d.isDirectory()) walk(Buffer.concat([abs, Buffer.from("/"), d.name]), r);
      else out.push(r, Buffer.from([0]));
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
    const list = (!includeIgnored && gitFileList(join(src, sub))) || treeFileList(join(src, sub), new Set(includeIgnored ? [] : SYNC_EXCLUDES));
    const inside = splitNul(list);
    if (!inside.length) return { error: `alsoPaths: nothing to send under ${rel} (empty, or all of it ignored); pass includeIgnored: true to send it as it is on disk` };
    for (const p of inside) push(Buffer.concat([Buffer.from(`${at}/`), p]));
    roots.push(Buffer.from(at).toString("hex"));
  }
  return { list: Buffer.concat(parts), roots };
}

// sandbox_sync runs here. In a git working tree it hashes the selected files, asks the box which of them differ
// from what is already in dest (files edited inside the box count as different, so they get the local version back),
// and uploads only those. Outside git it uploads the whole directory minus SYNC_EXCLUDES.
// ignoredTopLevel 分開回兩件事：skipped 是整個沒送過去的頂層名字（.gitignore 忽略的、或黑名單擋掉的），
// partiallyIgnored 是有送、只是裡面少了幾個被忽略的檔的頂層目錄。
// 沒有 skipped 的話 dist、build 這種被默默跳過，箱子裡少東西要查很久才發現；
// 但把「只少幾個檔」的目錄也算進 skipped 就變成謊報：兩份使用回饋都寫「看起來像整個目錄沒送，要另外確認」。
// --directory 讓 git 對整個被忽略的目錄只印 "dir/" 一行，印出路徑的就代表那個目錄只有部分檔被忽略。
function ignoredTopLevel(src) {
  const out = spawnSync("git", ["-C", src, "ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"], { maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) return { skipped: [], partiallyIgnored: [] };
  const skipped = new Set();
  const partial = new Set();
  for (const buf of splitNul(out.stdout)) {
    const rel = buf.toString("utf8");
    const first = rel.split("/")[0];
    if (!first) continue;
    if (rel === first || rel === first + "/") skipped.add(first);
    else partial.add(first);
  }
  for (const name of skipped) partial.delete(name);
  return { skipped: [...skipped].sort(), partiallyIgnored: [...partial].sort() };
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

// pull 把箱子裡的檔案或資料夾寫回本機路徑：sandbox_get 只給預簽網址，之前都要自己 curl 或 base64 貼回來。
// 回傳列出寫了幾個檔、前幾個是哪些：並行開發時要看得出拉回來的是哪一版，也能跟箱子裡的 find | wc -l 對。
async function pull(args) {
  const { id, path: rawPath, localPath, extract = true } = args || {};
  if (!id || !rawPath || !localPath) return textResult("sandbox_pull needs id, path and localPath", true);
  const boxPath = workRel(rawPath);
  const res = await remote.callTool({ name: "sandbox_get", arguments: { id, path: boxPath } }, undefined, { timeout: DEFAULT_TIMEOUT_MS });
  const text = res?.content?.find?.((c) => c.type === "text")?.text || "";
  let meta;
  try {
    meta = JSON.parse(text);
  } catch {
    return res;
  }
  if (!meta?.url) return res;
  const dl = await fetch(meta.url);
  if (!dl.ok) return textResult(`sandbox_pull: download failed (${dl.status})`, true);
  const target = resolve(process.cwd(), localPath);
  if (meta.archive && extract) {
    const files = await unpackDirectory(Readable.fromWeb(dl.body), target);
    return textResult(JSON.stringify({ ok: true, localPath: target, bytes: meta.bytes, extracted: true, files: files.length, paths: files.slice(0, SHOW_PATHS) }, null, 2));
  }
  mkdirSync(dirname(target), { recursive: true });
  await new Promise((res2, rej) => {
    const out = createWriteStream(target);
    Readable.fromWeb(dl.body).pipe(out);
    out.on("finish", res2);
    out.on("error", rej);
  });
  return textResult(JSON.stringify({ ok: true, localPath: target, bytes: meta.bytes, extracted: false, files: 1 }, null, 2));
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
async function syncOneFile({ id, file, target }) {
  const name = basename(file);
  let intoDir = target.dir || target.rel === ".";
  if (!intoDir) {
    try {
      intoDir = await isDirOnBox(id, target.rel);
    } catch (err) {
      return notSynced(id, target.rel, `sync failed while checking dest on the box: ${err?.message || err}`, [name]);
    }
  }
  const remoteRel = intoDir ? posix.join(target.rel, name) : target.rel;
  const parent = posix.dirname(remoteRel);
  const only = mkdtempSync(join(tmpdir(), "psbx-one-"));
  try {
    copyFileSync(file, join(only, posix.basename(remoteRel)));
    const sent = await upload(id, parent, only, null, "", true);
    if (sent.error) return notSynced(id, target.rel, sent.error, [name]);
    syncSucceeded(id, target.rel);
    const out = { ok: true, dest: target.rel, remotePath: `/work/${remoteRel}`, uploadedBytes: sent.bytes, files: 1, sentFiles: 1,
      sentPaths: [posix.basename(remoteRel)], selected: `one file: ${name}` };
    if (sent.changed !== undefined) out.changedOnBox = sent.changed;
    const notes = [];
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

async function sync(args) {
  const { id, localPath, dest: rawDest, commit, alsoPaths, includeIgnored = false, baseline, prune = false, submodules = false } = args || {};
  if (!id || !localPath || !rawDest) {
    return textResult("sandbox_sync needs id, localPath and dest", true);
  }
  // dest 先驗：/work/app 換成 app，其他絕對路徑在開始掃檔、上傳之前就回錯。
  const target = boxRel(rawDest);
  if (target.error) return textResult(target.error, true);
  const dest = target.rel;
  const given = resolve(process.cwd(), localPath);
  if (!existsSync(given)) {
    return textResult(`localPath not found: ${given}`, true);
  }
  const extra = Array.isArray(alsoPaths) ? alsoPaths.filter((p) => typeof p === "string" && p.trim()) : [];

  // 單一檔案：送它所在的目錄會把整包鄰居一起送過去，所以複製到一個暫存目錄單獨送。
  // 回報「local directory not found」而那個檔明明在，只會讓人以為路徑打錯（使用回饋裡兩次）。
  if (!statSync(given).isDirectory()) {
    if (commit || extra.length) {
      return textResult("commit and alsoPaths need a directory in localPath, not a single file", true);
    }
    if (prune) return textResult("prune needs a directory in localPath, not a single file", true);
    return syncOneFile({ id, file: given, target });
  }

  if (prune) {
    if (dest === ".") return textResult("prune needs a dest below /work, not /work itself: everything else in /work would count as stale. Nothing was sent.", true);
    if (includeIgnored) return textResult("prune cannot be combined with includeIgnored: without the ignore rules the box cannot tell your deleted files from what it built itself. Nothing was sent.", true);
    const inGit = spawnSync("git", ["-C", given, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
    if (!commit && (inGit.status !== 0 || inGit.stdout.trim() !== "true")) {
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
  let main;
  try {
    main = await syncFrom({ id, dest, src, given, repo, includeIgnored, commit: commit || "", sha: made?.sha || "", only, prune });
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
  if (main.error) return notSynced(id, dest, main.error, main.attempted);
  syncSucceeded(id, dest);
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
  let baseOut;
  try {
    baseOut = await syncFrom({ id, dest: baseDest, src: base.dir, given, repo, includeIgnored, commit: baseline, sha: base.sha, prune });
  } finally {
    rmSync(base.dir, { recursive: true, force: true });
  }
  if (baseOut.error) {
    syncFailed(id, baseDest, baseOut.error);
    main.baseline = { dest: baseDest, commit: baseline, error: `${baseOut.error}\nNOT SYNCED: /work/${baseDest} still has its old files.` };
  } else {
    syncSucceeded(id, baseDest);
    main.baseline = { ...baseOut, dest: baseDest, commit: baseline };
  }
  main.note = `run the same command in ${dest} and ${baseDest} and compare: anything that fails in both was already failing before your change`;
  return textResult(JSON.stringify(main, null, 2), !!baseOut.error);
}

// syncFrom 送一棵樹到 dest，回結果物件，或 { error, attempted }（attempted 是原本要送的檔）。
async function syncFrom({ id, dest, src, given, repo, includeIgnored, commit, sha = "", only = null, prune = false }) {
  // 掃檔花多久要留著：卡住的時候訊息裡要講得出是卡在掃檔、比對還是上傳。
  const startedAt = Date.now();
  const remotePath = `/work/${dest}`;
  const ignored = commit || only ? { skipped: [], partiallyIgnored: [] } : ignoredTopLevel(given);
  // 挑檔清單：alsoPaths 指定的那幾個路徑；commit 模式列 archive 出來的樹；工作區問 git。
  // includeIgnored（only 以外）或不是 git 工作區時沒有清單，整包送。
  let fileList = null;
  if (only) fileList = only.list;
  else if (!includeIgnored) fileList = commit ? treeFileList(src) : gitFileList(src);
  if (!fileList) {
    // 不是 git 工作區：照黑名單整包送。commit 帶 includeIgnored 時的樹（疊上了磁碟上的 alsoPaths）也整包送，
    // 再套黑名單會把 dist 這種有被追蹤的目錄剔掉，拿它跟工作區版本對照就會失真。
    const noDenylist = includeIgnored || !!commit;
    const sent = await upload(id, dest, src, null, repo, noDenylist);
    if (sent.error) return { error: sent.error };
    const out = {
      ok: true, dest, remotePath, uploadedBytes: sent.bytes, uploadedMB: Number((sent.bytes / 1024 / 1024).toFixed(1)),
      selected: commit
        ? `git archive ${commit}: every file that commit tracks`
        : includeIgnored ? "everything under localPath, ignore rules not applied" : `denylist: ${SYNC_EXCLUDES.join(", ")}`,
    };
    if (sha) out.commitSha = sha;
    if (sent.changed !== undefined) out.changedOnBox = sent.changed;
    if (!noDenylist) out.skipped = SYNC_EXCLUDES;
    return out;
  }

  const srcPrefix = Buffer.from(src.endsWith("/") ? src : `${src}/`);
  // git 還追蹤、但本機已經刪掉的檔不傳：交給 tar 會 Cannot stat，整次 sync 失敗。
  // 用 lstat 不用 existsSync：指向不存在目標的 symlink 仍要照傳。
  const onDisk = (rel) => {
    try {
      lstatSync(Buffer.concat([srcPrefix, rel]));
      return true;
    } catch {
      return false;
    }
  };
  const paths = splitNul(fileList).filter(onDisk);
  const manifest = [];
  const always = [];
  for (const rel of paths) {
    const hash = entryHash(Buffer.concat([srcPrefix, rel]));
    if (hash) manifest.push(`${hash} ${rel.toString("hex")}`);
    else {
      always.push(rel);
      manifest.push(`- ${rel.toString("hex")}`);
    }
  }
  // dest 裡多出來的檔：整個 dest 都找（只送幾個路徑時只在那幾個資料夾裡找）；dest 是 /work 本身時不找。
  const roots = only ? only.roots : [""];
  const staleOpts = dest !== "." && roots.length ? { roots, skip: SYNC_EXCLUDES, limit: STALE_LIMIT, dirFiles: STALE_DIR_FILES } : null;
  let verdict;
  const scanMs = Date.now() - startedAt;
  try {
    verdict = await compareOnBox(id, dest, manifest, staleOpts);
  } catch (err) {
    return { error: `sync failed while comparing with the box (scanned ${paths.length} files in ${Math.round(scanMs / 1000)}s): ${err?.message || err}` };
  }
  const send = verdict.all ? paths : [...verdict.changed.map((hex) => Buffer.from(hex, "hex")), ...always];
  const sentPaths = send.map((p) => p.toString("utf8"));

  // uploadedMB 對小專案永遠是 0，看起來像什麼都沒傳；bytes 與檔數才看得出成功。
  // sentPaths 列出這次真的送了哪些檔（前 SHOW_PATHS 個）：並行開發時才看得出箱子裡測的是哪一版。
  const out = {
    ok: true, dest, remotePath, uploadedBytes: 0, uploadedMB: 0,
    selected: commit ? `git archive ${commit}` : only ? "only alsoPaths: git tracked + untracked files under them, honouring .gitignore" : "git tracked + untracked files, honouring .gitignore",
    files: paths.length, sentFiles: send.length, sentPaths: sentPaths.slice(0, SHOW_PATHS),
  };
  if (sha) out.commitSha = sha;
  if (ignored.skipped.length) out.skipped = ignored.skipped;
  if (ignored.partiallyIgnored.length) out.partiallyIgnored = ignored.partiallyIgnored;
  if (send.length) {
    const sent = await upload(id, dest, src, Buffer.concat(send.flatMap((p) => [p, Buffer.from([0])])), repo);
    if (sent.error) return { error: sent.error, attempted: sentPaths };
    out.uploadedBytes = sent.bytes;
    out.uploadedMB = Number((sent.bytes / 1024 / 1024).toFixed(1));
    if (sent.changed !== undefined) out.changedOnBox = sent.changed;
  } else {
    out.changedOnBox = 0;
  }
  const notes = [];
  // dest 是新建的就沒有開著的 dev server 在看它；整包送（all）時箱子只改了內容有變的檔，這裡看的是送出的清單，寧可多提醒。
  const reload = verdict.fresh || out.changedOnBox === 0 ? "" : devServerNote(sentPaths);
  if (reload) notes.push(reload);

  // dest 裡多出來的：先用本機的忽略規則篩掉箱子自己產生的東西，剩下的才是本機刪掉或改名、箱子還留著的。
  if (verdict.stale?.length) {
    const candidates = verdict.stale.map((hex) => Buffer.from(hex, "hex"));
    const kept = dropIgnored(given, candidates);
    const stale = kept ?? candidates;
    const capped = verdict.staleTotal > verdict.stale.length;
    if (stale.length) {
      out.staleInDest = { count: stale.length, paths: stale.slice(0, SHOW_FEW).map((p) => p.toString("utf8")) };
      if (capped) out.staleInDest.countIsPartial = true;
      if (!prune) {
        notes.push(`staleInDest: ${stale.length}${capped ? "+" : ""} files in ${remotePath} that localPath does not have (deleted or renamed locally, or created in the box) were left in place. Pass prune: true to delete them, or ignore them if the box made them.`);
      } else if (!kept) {
        notes.push("prune skipped: the local ignore rules could not be read (git check-ignore failed), so nothing was deleted.");
      } else {
        try {
          const done = await pruneOnBox(id, dest, stale.map((p) => p.toString("hex")));
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
const server = new Server({ name: "parallelsandbox", version: "0.5.2" }, {
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
server.oninitialized = () => {
  if (connected && oauth) server.sendToolListChanged().catch(() => {});
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

// callWithRetry：連線沒了（fetch failed，或看門狗判定結果回不來）時，能重試的再試一次；不能重試的就把話講清楚，
// 不要讓人以為「指令一定沒跑」。HTTP 503 是還沒進到工具就被擋下，任何工具都退避重試（見 UNAVAILABLE_BUDGET_MS）。
async function callWithRetry(name, args, timeout, onAlive, signal) {
  const shotIsReadOnly = name === "sandbox_shot" && !(args || {}).record;
  const canRetry = RETRY_SAFE.has(name) || shotIsReadOnly;
  let retriedLost = false;
  let unavailableTries = 0;
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
      if (!/fetch failed|socket hang up|ECONNRESET|ETIMEDOUT|EPIPE|network/i.test(msg)) throw err;
      out = { lost: msg };
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
    return textResult(`${name}: the result never came back (${out.lost}). It may have started or even finished on the box: check sandbox_status (steps[] lists what was run there) and what it should have produced before running it again.`, true);
  }
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
    if (name === "sandbox_sync") {
      return await sync(args);
    }
    if (name === "sandbox_pull") {
      return await pull(args);
    }
    const timeout = name === "sandbox_takeover" || name === "sandbox_review" ? TAKEOVER_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    let remoteArgs = managedSession && name === "sandbox_review" ? {...args, waitSec: 0} : args;
    // sandbox_get 的 path 常照抄 sandbox_exec 裡的 /work/...：換成相對 /work，舊映像的箱子也收得下。
    if (name === "sandbox_get" && args) {
      remoteArgs = {...args, ...(typeof args.path === "string" ? {path: workRel(args.path)} : {}), ...(Array.isArray(args.paths) ? {paths: args.paths.map(workRel)} : {})};
    }
    const result = await callWithRetry(name, remoteArgs, timeout, progressRelay(name, req.params._meta?.progressToken, extra), extra.signal);
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

export { AGENT_ID, archiveCommit, baselineDest, boxRel, copyInto, dropIgnored, gitFileList, ignoredTopLevel, onlyList, presence, pruneEntries, repoName, reviewWaitBudget, setBoxExecForTest, staleEntries, staleSyncWarning, startPresence, sync as syncTool, treeFileList, uncommittedPaths, unpackDirectory, watchForExit, workRel };
