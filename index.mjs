#!/usr/bin/env node
// parallelsandbox-mcp: stdio in, ParallelSandbox Streamable HTTP out.
// Every tool call is forwarded to https://mcp.parallelsandbox.com/mcp with the API key, except sandbox_sync,
// which compares the local directory with the box, tars only the files that differ and uploads them through
// POST /v1/boxes/{id}/sync.

import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const API_KEY = process.env.PARALLELSANDBOX_API_KEY || "";
const MCP_URL = process.env.PARALLELSANDBOX_MCP_URL || "https://mcp.parallelsandbox.com/mcp";
const API_URL = (process.env.PARALLELSANDBOX_API_URL || "https://api.parallelsandbox.com").replace(/\/+$/, "");
const TAKEOVER_TIMEOUT_MS = 31 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 65 * 60 * 1000;
const SYNC_EXCLUDES = ["node_modules", ".git", "dist", "dist-web", "build", ".cache", "coverage", ".venv", "venv", "__pycache__", "target", ".next", ".turbo"];
// 箱子回報要傳的檔超過這個數就整包傳：清單比整包還長時比對沒有意義，exec 的輸出也有上限。
const COMPARE_LIMIT = 400;

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

// 箱子裡跑的比對程式：清單每行「雜湊 空格 路徑 bytes 的 hex」（檔名不一定是合法 UTF-8），
// 跟 dest 現有的檔一個個比，印出不一樣或不存在的路徑。清單讀進來就把自己這包刪掉。
const COMPARE_SCRIPT = `import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { dirname } from "node:path";
${entryHash.toString()}
const [manifest, dest, limit] = process.argv.slice(2);
const lines = readFileSync(manifest, "utf8").split("\\n").filter(Boolean);
rmSync(dirname(manifest), { recursive: true, force: true });
if (!existsSync(dest)) {
  console.log(JSON.stringify({ all: true }));
  process.exit(0);
}
const prefix = Buffer.from(dest.endsWith("/") ? dest : dest + "/");
const changed = [];
for (const line of lines) {
  const space = line.indexOf(" ");
  const hex = line.slice(space + 1);
  if (entryHash(Buffer.concat([prefix, Buffer.from(hex, "hex")])) !== line.slice(0, space)) {
    changed.push(hex);
    if (changed.length > Number(limit)) {
      console.log(JSON.stringify({ all: true }));
      process.exit(0);
    }
  }
}
console.log(JSON.stringify({ changed }));
`;

const log = (...args) => console.error("[parallelsandbox-mcp]", ...args);

if (!API_KEY) {
  log("PARALLELSANDBOX_API_KEY is required (create a key in the app at https://app.parallelsandbox.com)");
  process.exit(2);
}

const remote = new Client({ name: "parallelsandbox-mcp", version: "0.1.0" });
// 同一個 headers 物件每次請求都會被讀到，所以握手拿到對方是誰之後直接塞進去。
// 沒有這個，control 只知道「某個 API key 開了箱子」，人在 app 裡看不出是 Claude 還是 Codex 在用。
const remoteHeaders = { Authorization: `Bearer ${API_KEY}` };
const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
  requestInit: { headers: remoteHeaders },
  fetch: watchedFetch,
});
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
  if (!w) return fetch(url, init);
  w.fetches++;
  w.ended = null;
  w.lastByte = Date.now();
  const signal = init.signal ? anySignal(init.signal, w.conn.signal) : w.conn.signal;
  const res = await fetch(url, { ...init, signal });
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
async function callWatched(name, args, timeout, onAlive) {
  const w = new CallWatch(onAlive);
  const timer = setInterval(() => w.check(), WATCH_TICK_MS);
  try {
    const result = await callScope.run(w, () =>
      remote.callTool({ name, arguments: args || {} }, undefined, { timeout, resetTimeoutOnProgress: true, signal: w.call.signal }));
    return { result };
  } catch (err) {
    if (w.lost) return { lost: w.lost };
    throw err;
  } finally {
    clearInterval(timer);
  }
}

// 這個對話還在不在（control 的 agents 表）。一個 adapter 程序就是一個對話：啟動時取一個隨機 id 放在 X-Psbx-Agent，
// control 記下每個箱子最後是哪個對話在動。第一次呼叫工具之後每分鐘打一次心跳；對話被關掉（stdin 斷、收到結束訊號）
// 就打 leave，這個對話動過、沒交件也沒收掉的箱子，在 app 上變成「AI 停手了」，人一看就知道要接著做還是收掉。
// kill -9 來不及打 leave，control 三分鐘沒收到心跳也會當它走了。
const AGENT_ID = randomBytes(9).toString("base64url");
remoteHeaders["X-Psbx-Agent"] = AGENT_ID;
const HEARTBEAT_MS = 60_000;
let heartbeat = null;

// presence 打 heartbeat 或 leave；失敗不影響任何工具，回 false 就好。
async function presence(what, timeoutMs) {
  try {
    const res = await fetch(`${API_URL}/v1/agents/${AGENT_ID}/${what}`, {
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
  if (heartbeat) return;
  presence("heartbeat", 10_000);
  heartbeat = setInterval(() => presence("heartbeat", 10_000), HEARTBEAT_MS);
  heartbeat.unref();
}

let leaving = false;
async function leaveAndExit(code) {
  if (leaving) return;
  leaving = true;
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
  await remote.connect(transport);
  log("connected to", MCP_URL);
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
      headers: { ...remoteHeaders, "Content-Type": "application/gzip" },
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
  const code = await exited;
  const body = await response.text();
  if (code !== 0) {
    return { error: `tar failed (exit ${code}): ${tarErr.trim() || "no output"}` };
  }
  if (!response.ok) {
    let message = body;
    try {
      message = JSON.parse(body).error || body;
    } catch {}
    return { error: `sync failed (HTTP ${response.status}): ${message}` };
  }
  return { bytes };
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

// compareOnBox 把本機的雜湊清單送進箱子，在箱子裡比對 dest，回 { all: true } 或 { changed: [路徑 hex] }。
async function compareOnBox(id, dest, manifest) {
  const nonce = randomBytes(6).toString("hex");
  const stage = mkdtempSync(join(tmpdir(), "psbx-sync-"));
  let sent;
  try {
    writeFileSync(join(stage, "manifest"), manifest.join("\n"));
    writeFileSync(join(stage, "compare.mjs"), COMPARE_SCRIPT);
    sent = await upload(id, `.psbx-sync/${nonce}`, stage, null);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  if (sent.error) throw new Error(sent.error);
  const dir = `/work/.psbx-sync/${nonce}`;
  const cmd = `node ${dir}/compare.mjs ${dir}/manifest ${shellQuote(`/work/${dest}`)} ${COMPARE_LIMIT}`;
  // note 是 control 規定必填的（人在 app 上看到的「現在在做什麼」）。
  const note = `Compare local files with ${dest} before syncing`.slice(0, 200);
  const res = await remote.callTool({ name: "sandbox_exec", arguments: { id, cmd, timeoutSec: 300, note } }, undefined, { timeout: 330000 });
  const text = (res.content || []).map((c) => c.text || "").join("");
  if (res.isError) throw new Error(text);
  const run = JSON.parse(text);
  if (run.exitCode !== 0) throw new Error(`compare exited ${run.exitCode}: ${(run.stderr || run.stdout || "").trim()}`);
  return JSON.parse(run.stdout.trim().split("\n").pop());
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

// archiveCommit 把某個 commit 的乾淨樹解到暫存目錄，回那個目錄；不是 git 或 commit 不存在就回 { error }。
// 共用工作區常常同時有別人沒 commit 的改動，整包同步過去會編不過（使用體驗記錄裡出現四次）。
function archiveCommit(src, commit) {
  const dir = mkdtempSync(join(tmpdir(), "psbx-archive-"));
  const ar = spawnSync("bash", ["-c", `git -C ${JSON.stringify(src)} archive ${JSON.stringify(commit)} | tar -x -C ${JSON.stringify(dir)}`], { encoding: "utf8" });
  if (ar.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    return { error: `git archive ${commit} failed: ${(ar.stderr || "").trim() || "not a git commit"}` };
  }
  return { dir };
}

// copyInto 把工作區的某些路徑疊到乾淨樹上（commit + 自己正在改的檔）。
function copyInto(src, dir, paths) {
  for (const rel of paths) {
    const from = resolve(src, rel);
    if (!existsSync(from)) return { error: `alsoPaths: ${rel} not found under ${src}` };
    const to = resolve(dir, rel);
    mkdirSync(dirname(to), { recursive: true });
    const cp = spawnSync("cp", ["-a", from, to], { encoding: "utf8" });
    if (cp.status !== 0) return { error: `alsoPaths: copy ${rel}: ${(cp.stderr || "").trim()}` };
  }
  return {};
}

// pull 把箱子裡的檔案或資料夾寫回本機路徑：sandbox_get 只給預簽網址，之前都要自己 curl 或 base64 貼回來。
async function pull(args) {
  const { id, path: boxPath, localPath, extract = true } = args || {};
  if (!id || !boxPath || !localPath) return textResult("sandbox_pull needs id, path and localPath", true);
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
    mkdirSync(target, { recursive: true });
    const tar = spawn("tar", ["-xzf", "-", "-C", target]);
    const errs = [];
    tar.stderr.on("data", (d) => errs.push(d.toString()));
    await new Promise((res2, rej) => {
      Readable.fromWeb(dl.body).pipe(tar.stdin);
      tar.on("close", (code) => (code === 0 ? res2() : rej(new Error(errs.join("").trim() || `tar exit ${code}`))));
      tar.on("error", rej);
    });
    return textResult(JSON.stringify({ ok: true, localPath: target, bytes: meta.bytes, extracted: true }, null, 2));
  }
  mkdirSync(dirname(target), { recursive: true });
  await new Promise((res2, rej) => {
    const out = createWriteStream(target);
    Readable.fromWeb(dl.body).pipe(out);
    out.on("finish", res2);
    out.on("error", rej);
  });
  return textResult(JSON.stringify({ ok: true, localPath: target, bytes: meta.bytes, extracted: false }, null, 2));
}

// baselineDest 是對照組放的地方。固定接在後面，agent 不用猜，回傳裡也會寫。
function baselineDest(dest) {
  return `${dest}-baseline`;
}

async function sync(args) {
  const { id, localPath, dest, commit, alsoPaths, includeIgnored = false, baseline } = args || {};
  if (!id || !localPath || !dest) {
    return textResult("sandbox_sync needs id, localPath and dest", true);
  }
  const given = resolve(process.cwd(), localPath);
  if (!existsSync(given)) {
    return textResult(`localPath not found: ${given}`, true);
  }
  // 單一檔案：送它所在的目錄會把整包鄰居一起送過去，所以複製到一個暫存目錄單獨送。
  // 回報「local directory not found」而那個檔明明在，只會讓人以為路徑打錯（使用回饋裡兩次）。
  let oneFile = "";
  if (!statSync(given).isDirectory()) {
    oneFile = given;
  }

  if (oneFile) {
    if (commit || (Array.isArray(alsoPaths) && alsoPaths.length)) {
      return textResult("commit and alsoPaths need a directory in localPath, not a single file", true);
    }
    const only = mkdtempSync(join(tmpdir(), "psbx-one-"));
    try {
      copyFileSync(oneFile, join(only, basename(oneFile)));
      const sent = await upload(id, dest, only, null, "", true);
      if (sent.error) return textResult(sent.error, true);
      return textResult(JSON.stringify({ ok: true, dest, uploadedBytes: sent.bytes, files: 1, sentFiles: 1,
        selected: `one file: ${basename(oneFile)}` }, null, 2));
    } finally {
      rmSync(only, { recursive: true, force: true });
    }
  }

  // commit：送那顆 commit 的乾淨樹（可再疊上 alsoPaths），不帶別的 session 未提交的改動。
  let src = given;
  let temp = "";
  const repo = repoName(given);
  if (commit) {
    const made = archiveCommit(given, commit);
    if (made.error) return textResult(made.error, true);
    temp = made.dir;
    src = made.dir;
    if (Array.isArray(alsoPaths) && alsoPaths.length) {
      const copied = copyInto(given, temp, alsoPaths);
      if (copied.error) {
        rmSync(temp, { recursive: true, force: true });
        return textResult(copied.error, true);
      }
    }
  } else if (Array.isArray(alsoPaths) && alsoPaths.length) {
    return textResult("alsoPaths only makes sense with commit", true);
  }
  let main;
  try {
    main = await syncFrom({ id, dest, src, given, repo, includeIgnored, commit: commit || "" });
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
  if (!baseline || main.isError) return main;

  // 對照組：同一次呼叫裡，把某顆 commit 的樹也送到旁邊一個 dest。
  // 「同一支測試在改動前後各跑一次、比對失敗清單」是每個人都在手做的事（使用回饋裡三次），
  // 而且手做很容易做歪：分兩次呼叫，中間工作區可能又變了；用 commit 模式送對照組，
  // 挑檔規則以前還跟工作區那次不一樣。這裡一次做完，兩邊都從同一刻的同一個 repo 來。
  const baseDest = baselineDest(dest);
  const made = archiveCommit(given, baseline);
  if (made.error) return textResult(`${made.error} (baseline)`, true);
  let baseOut;
  try {
    baseOut = await syncFrom({ id, dest: baseDest, src: made.dir, given, repo, includeIgnored, commit: baseline });
  } finally {
    rmSync(made.dir, { recursive: true, force: true });
  }
  const mainJSON = JSON.parse(main.content[0].text);
  const baseJSON = baseOut.isError ? { error: baseOut.content[0].text } : JSON.parse(baseOut.content[0].text);
  mainJSON.baseline = { dest: baseDest, commit: baseline, ...baseJSON };
  mainJSON.note = `run the same command in ${dest} and ${baseDest} and compare: anything that fails in both was already failing before your change`;
  return textResult(JSON.stringify(mainJSON, null, 2), baseOut.isError);
}

async function syncFrom({ id, dest, src, given, repo, includeIgnored, commit }) {
  // 掃檔花多久要留著：卡住的時候訊息裡要講得出是卡在掃檔、比對還是上傳。
  const startedAt = Date.now();
  const ignored = commit ? { skipped: [], partiallyIgnored: [] } : ignoredTopLevel(given);
  const fileList = includeIgnored ? null : gitFileList(src);
  if (!fileList) {
    // commit 模式的 src 是 git archive 解出來的樹，本身不是 git 工作區，所以問不到 git 的挑檔清單。
    // 那棵樹已經「剛好是那顆 commit 追蹤的檔」，再套黑名單會把 dist 這種有被追蹤的目錄剔掉，
    // 拿它跟工作區版本對照就會失真（同一支測試在一邊有 dist、另一邊沒有，結果不同）。
    const noDenylist = includeIgnored || !!commit;
    const sent = await upload(id, dest, src, null, repo, noDenylist);
    if (sent.error) return textResult(sent.error, true);
    const out = {
      ok: true, dest, uploadedBytes: sent.bytes, uploadedMB: Number((sent.bytes / 1024 / 1024).toFixed(1)),
      selected: commit
        ? `git archive ${commit}: every file that commit tracks`
        : includeIgnored ? "everything under localPath, ignore rules not applied" : `denylist: ${SYNC_EXCLUDES.join(", ")}`,
    };
    if (!noDenylist) out.skipped = SYNC_EXCLUDES;
    return textResult(JSON.stringify(out, null, 2));
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
    else always.push(rel);
  }
  let verdict;
  const scanMs = Date.now() - startedAt;
  try {
    verdict = await compareOnBox(id, dest, manifest);
  } catch (err) {
    return textResult(`sync failed while comparing with the box (scanned ${paths.length} files in ${Math.round(scanMs / 1000)}s): ${err?.message || err}`, true);
  }
  const send = verdict.all ? paths : [...verdict.changed.map((hex) => Buffer.from(hex, "hex")), ...always];

  // uploadedMB 對小專案永遠是 0，看起來像什麼都沒傳；bytes 與檔數才看得出成功。
  const out = { ok: true, dest, uploadedBytes: 0, uploadedMB: 0, selected: commit ? `git archive ${commit}` : "git tracked + untracked files, honouring .gitignore", files: paths.length, sentFiles: send.length };
  if (ignored.skipped.length) out.skipped = ignored.skipped;
  if (ignored.partiallyIgnored.length) out.partiallyIgnored = ignored.partiallyIgnored;
  if (send.length) {
    const sent = await upload(id, dest, src, Buffer.concat(send.flatMap((p) => [p, Buffer.from([0])])), repo);
    if (sent.error) return textResult(sent.error, true);
    out.uploadedBytes = sent.bytes;
    out.uploadedMB = Number((sent.bytes / 1024 / 1024).toFixed(1));
  }
  return textResult(JSON.stringify(out, null, 2));
}

// PSBX_ADAPTER_NO_CONNECT 是給測試用的：只載入這支模組拿裡面的純函式，不連遠端、不接 stdio。
const connect = !process.env.PSBX_ADAPTER_NO_CONNECT;
if (connect) await connectRemote();

// instructions 照 control 給的轉交：client 會放進 agent 的 system prompt（例如用完要填 sandbox_feedback）。
const server = new Server({ name: "parallelsandbox", version: "0.1.0" }, { capabilities: { tools: {} }, instructions: connect ? remote.getInstructions() : undefined });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await remote.listTools();
  return { tools };
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
  "sandbox_status", "sandbox_list", "sandbox_get", "sandbox_versions", "sandbox_secrets", "sandbox_environments",
  "logs_search", "logs_errors", "logs_tail",
]);

// callWithRetry：連線沒了（fetch failed，或看門狗判定結果回不來）時，能重試的再試一次；不能重試的就把話講清楚，
// 不要讓人以為「指令一定沒跑」。
async function callWithRetry(name, args, timeout, onAlive) {
  const shotIsReadOnly = name === "sandbox_shot" && !(args || {}).record;
  const canRetry = RETRY_SAFE.has(name) || shotIsReadOnly;
  for (let attempt = 0; ; attempt++) {
    let out;
    try {
      out = await callWatched(name, args, timeout, onAlive);
    } catch (err) {
      const msg = err?.message || String(err);
      if (!/fetch failed|socket hang up|ECONNRESET|ETIMEDOUT|EPIPE|network/i.test(msg)) throw err;
      out = { lost: msg };
    }
    if (!out.lost) return out.result;
    log(`${name}: ${out.lost}`);
    if (canRetry && attempt === 0) continue;
    return textResult(`${name}: the result never came back (${out.lost}). It may have started or even finished on the box: check sandbox_status (steps[] lists what was run there) and what it should have produced before running it again.`, true);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  tellRemoteWhoIsCalling();
  startPresence();
  const { name, arguments: args } = req.params;
  if (name === "sandbox_sync") {
    return sync(args);
  }
  if (name === "sandbox_pull") {
    return pull(args);
  }
  const timeout = name === "sandbox_takeover" ? TAKEOVER_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  return callWithRetry(name, args, timeout, progressRelay(name, req.params._meta?.progressToken, extra));
});

// progressRelay：control 在連線上出聲（still running）時，轉一則進度給 client。client 有給 progressToken 才轉。
// 沒有這個，Claude Code 只看得到「30 分鐘沒動靜」，跑超過 30 分鐘的 build 會被它砍掉。
function progressRelay(name, token, extra) {
  if (token === undefined) return undefined;
  const started = Date.now();
  let sent = 0;
  return () => {
    const now = Date.now();
    if (now - sent < PROGRESS_EVERY_MS) return;
    sent = now;
    extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress: (now - started) / 1000, message: `${name} still running (${Math.round((now - started) / 1000)}s)` },
    }).catch(() => {});
  };
}

if (connect) {
  watchForExit();
  await server.connect(new StdioServerTransport());
}

export { AGENT_ID, archiveCommit, baselineDest, copyInto, gitFileList, ignoredTopLevel, presence, repoName, startPresence, sync as syncTool, watchForExit };
