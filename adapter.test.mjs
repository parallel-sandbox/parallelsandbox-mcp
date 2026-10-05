// 同步挑檔的規則錯了就是「箱子裡少東西」或「上傳幾 GB」，兩種都很難查，所以這幾個純函式要有測試。
import { strict as assert } from "node:assert";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createReadStream, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync as mkdtempFeedback, rmSync as rmFeedback } from "node:fs";
import { tmpdir as feedbackTmp } from "node:os";
import { after as afterAllFeedback } from "node:test";
// Adapter runs write feedback tickets and start a relay; keep both out of the real home directory.
const feedbackDir = mkdtempFeedback(`${feedbackTmp()}/psbx-adapter-feedback-`);
afterAllFeedback(() => rmFeedback(feedbackDir, { recursive: true, force: true }));

// 假的 control：記下 adapter 打來的請求（心跳、離開、sync 上傳的那包 tar.gz）。
// sync 上傳的那包照 boxd 的樣子解進假的 /work（fakeWork/<dest>，合併在原有的東西上），回 changed；
// dest 在 failDests 裡的回 409，像凍住的箱子；在 failOnce 裡的第一次回那個狀態碼；在 slowAnswer 裡的收完整包後很久才回。
// fullOutputs 是假的 exec 完整輸出網址（outputUrl）；downloads 是假的預簽下載網址，值是依序回的 { status, body }。
const seen = [];
const fakeWork = mkdtempSync(join(tmpdir(), "psbx-fakework-"));
const failDests = new Set();
const failOnce = new Map();
const slowAnswer = new Set();
const fullOutputs = new Map();
const downloads = new Map();
const api = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw.toString(), raw });
    if (fullOutputs.has(req.url)) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(fullOutputs.get(req.url));
      return;
    }
    if (downloads.has(req.url)) {
      const queue = downloads.get(req.url);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      res.writeHead(next.status, { "Content-Type": "application/octet-stream" });
      res.end(next.body || "");
      return;
    }
    const sync = req.url.match(/^\/v1\/boxes\/[^/]+\/sync\?dest=([^&]*)/);
    if (sync) {
      const dest = decodeURIComponent(sync[1]);
      if (failDests.has(dest)) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end('{"error":"box frozen"}');
        return;
      }
      if (failOnce.has(dest)) {
        const status = failOnce.get(dest);
        failOnce.delete(dest);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end('{"error":"bad gateway"}');
        return;
      }
      if (slowAnswer.has(dest)) {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        }, 5_000).unref();
        return;
      }
      const into = join(fakeWork, dest);
      mkdirSync(into, { recursive: true });
      const names = execFileSync("tar", ["-tzf", "-"], { input: raw, encoding: "utf8" }).split("\n").filter((n) => n && !n.endsWith("/"));
      execFileSync("tar", ["-xzf", "-", "-C", into], { input: raw });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, dest, changed: names.length }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
api.unref();

// import 會在檔案最上面的賦值之前就執行，所以環境變數要在動態載入前設好。
process.env.PSBX_ADAPTER_NO_CONNECT = "1";
// 進度每 200 毫秒報一次（SILENCE_MS / 3），整包送完等回答的上限 1.5 秒：測試不用等真的 10 秒、10 分鐘。
process.env.PSBX_ADAPTER_SILENCE_MS = "600";
process.env.PSBX_ADAPTER_ANSWER_MS = "1500";
process.env.PARALLELSANDBOX_API_KEY = process.env.PARALLELSANDBOX_API_KEY || "test-key";
process.env.PARALLELSANDBOX_API_URL = `http://127.0.0.1:${api.address().port}`;
const { AGENT_ID, archiveCommit, baselineDest, boxRel, copyInto, gitFileList, globMatcher, ignoredTopLevel, localTool, matchStartedBox, networkCode, networkFailure, presence, pullTool, repoName, reviewWaitBudget, setBoxExecForTest, setBoxGetForTest, staleEntries, staleSyncWarning, syncTool, toolsHash, unpackDirectory, workRel } = await import("./index.mjs");

// 假的 sandbox_exec：指令在本機跑，/work 換成 fakeWork。比對、刪檔、看 dest 是不是資料夾都走這裡。
const execs = [];
function localExec({ cmd }) {
  execs.push(cmd);
  const r = spawnSync("bash", ["-c", cmd.replaceAll("/work/", `${fakeWork}/`)], { encoding: "utf8" });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr, truncated: false };
}
setBoxExecForTest(async (args) => ({ content: [{ type: "text", text: JSON.stringify(localExec(args)) }] }));

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "psbx-adapter-test-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, ".gitignore"), "dist\nnode_modules\n");
  writeFileSync(join(dir, "main.go"), "package main\n");
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "bundle.js"), "built\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  return { dir, git };
}

test("被忽略而沒送過去的頂層名字要講出來，不能默默跳過", () => {
  const { dir } = repo();
  try {
    assert.deepEqual(ignoredTopLevel(dir), { skipped: ["dist"], partiallyIgnored: [], configs: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commit 模式送的是那顆 commit 的樹，不含工作區裡沒提交的改動", () => {
  const { dir, git } = repo();
  let made;
  try {
    writeFileSync(join(dir, "main.go"), "package main // 別人還沒提交的半成品\n");
    writeFileSync(join(dir, "broken.go"), "這個編不過\n");
    const head = git("rev-parse", "HEAD").trim();
    made = archiveCommit(dir, head);
    assert.equal(made.error, undefined);
    assert.equal(readFileSync(join(made.dir, "main.go"), "utf8"), "package main\n");
    assert.equal(existsSync(join(made.dir, "broken.go")), false);
  } finally {
    if (made?.dir) rmSync(made.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("alsoPaths 把自己正在改的檔疊回乾淨樹上", () => {
  const { dir, git } = repo();
  let made;
  try {
    writeFileSync(join(dir, "main.go"), "package main // 我的改動\n");
    made = archiveCommit(dir, git("rev-parse", "HEAD").trim());
    assert.equal(copyInto(dir, made.dir, ["main.go"]).error, undefined);
    assert.equal(readFileSync(join(made.dir, "main.go"), "utf8"), "package main // 我的改動\n");
    assert.match(copyInto(dir, made.dir, ["nope.go"]).error, /not found/);
  } finally {
    if (made?.dir) rmSync(made.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// 9/29 實際發生過：alsoPaths 給 renderer/src/components/plugins/parallelsandbox，箱子裡多一層 parallelsandbox/parallelsandbox/，
// vite 從那份舊檔解析 import 失敗，tsc 也檢查到它。
test("alsoPaths 給資料夾：整個換成工作區那份，不多一層、本機刪掉的不留、被忽略的不帶", () => {
  const { dir, git } = repo();
  let made;
  try {
    const ui = join(dir, "web", "ui");
    mkdirSync(join(ui, "pages"), { recursive: true });
    writeFileSync(join(ui, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(ui, "old.ts"), "import '../gone';\n");
    writeFileSync(join(ui, "pages", "p.ts"), "p\n");
    git("add", "-A");
    git("commit", "-qm", "ui");
    writeFileSync(join(ui, "a.ts"), "export const a = 2; // 我的改動\n");
    rmSync(join(ui, "old.ts"));
    writeFileSync(join(ui, "new.ts"), "還沒 add 的新檔\n");
    mkdirSync(join(ui, "node_modules", "x"), { recursive: true });
    writeFileSync(join(ui, "node_modules", "x", "index.js"), "本機裝的\n");
    made = archiveCommit(dir, git("rev-parse", "HEAD").trim());
    const got = join(made.dir, "web", "ui");

    assert.equal(copyInto(dir, made.dir, ["web/ui"]).error, undefined);
    assert.ok(!existsSync(join(got, "ui")), "不能多一層 web/ui/ui");
    assert.equal(readFileSync(join(got, "a.ts"), "utf8"), "export const a = 2; // 我的改動\n");
    assert.equal(readFileSync(join(got, "new.ts"), "utf8"), "還沒 add 的新檔\n");
    assert.equal(readFileSync(join(got, "pages", "p.ts"), "utf8"), "p\n");
    assert.ok(!existsSync(join(got, "old.ts")), "本機刪掉的檔不能從 commit 那份冒回來");
    assert.ok(!existsSync(join(got, "node_modules")), ".gitignore 忽略的不送，免得蓋掉箱子裡自己裝的");

    assert.equal(copyInto(dir, made.dir, ["web/ui/"], true).error, undefined);
    assert.ok(existsSync(join(got, "node_modules", "x", "index.js")), "includeIgnored 照磁碟上的樣子整份複製");
    assert.ok(!existsSync(join(got, "ui")));

    assert.match(copyInto(dir, made.dir, ["dist"]).error, /includeIgnored/, "整個被忽略的資料夾不能默默送一個空的");
  } finally {
    if (made?.dir) rmSync(made.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// copyInto 會先刪掉樹裡原本那份：路徑一旦穿出暫存樹，刪的就是別處的真檔案。
test("alsoPaths 刪不到也寫不到樹外面：../、絕對路徑、穿出去的連結都擋下", () => {
  const { dir, git } = repo();
  const outside = mkdtempSync(join(tmpdir(), "psbx-outside-"));
  let made;
  try {
    writeFileSync(join(outside, "keep.txt"), "別刪我\n");
    symlinkSync(outside, join(dir, "linked"));
    git("add", "-A");
    git("commit", "-qm", "link");
    made = archiveCommit(dir, "HEAD");
    for (const rel of ["../x", outside, ".", "linked/keep.txt"]) {
      assert.ok(copyInto(dir, made.dir, [rel]).error, `${rel} 要擋下`);
    }
    assert.equal(copyInto(dir, made.dir, ["linked"]).error, undefined, "連結本身照樣複製");
    assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "別刪我\n");
  } finally {
    if (made?.dir) rmSync(made.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("commit + alsoPaths 資料夾：送進箱子的那包裡是工作區那份，沒有巢狀的同名資料夾", async () => {
  const { dir, git } = repo();
  const box = mkdtempSync(join(tmpdir(), "psbx-box-"));
  try {
    mkdirSync(join(dir, "ui"));
    writeFileSync(join(dir, "ui", "a.ts"), "1\n");
    git("add", "-A");
    git("commit", "-qm", "ui");
    writeFileSync(join(dir, "ui", "a.ts"), "2\n");
    const res = await syncTool({ id: "bx", localPath: dir, dest: "app", commit: "HEAD", alsoPaths: ["ui"] });
    assert.equal(res.isError, false, res.content[0].text);
    const upload = seen.findLast((r) => r.url.startsWith("/v1/boxes/bx/sync?dest=app"));
    execFileSync("tar", ["-xzf", "-", "-C", box], { input: upload.raw });
    assert.equal(readFileSync(join(box, "ui", "a.ts"), "utf8"), "2\n");
    assert.ok(!existsSync(join(box, "ui", "ui")), "箱子裡不能多一層 ui/ui");
    assert.equal(readFileSync(join(box, "main.go"), "utf8"), "package main\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(box, { recursive: true, force: true });
  }
});

test("repo 名字取工作區根目錄，不是 git 就回空字串", () => {
  const { dir } = repo();
  const plain = mkdtempSync(join(tmpdir(), "psbx-plain-"));
  try {
    assert.equal(repoName(join(dir)), dir.split("/").pop());
    assert.equal(repoName(plain), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

test("本機刪掉一個被追蹤的檔，挑檔清單不能還留著它", () => {
  const { dir, git } = repo();
  rmSync(join(dir, "main.go"));
  const list = gitFileList(dir).toString("utf8").split("\0").filter(Boolean);
  assert.ok(!list.includes("main.go"), `刪掉的檔還在清單裡，tar 會 Cannot stat 整包同步就死：${list.join(",")}`);
  assert.ok(list.includes(".gitignore"), "其他檔還是要照送");
  git("status");
});

test("目錄只有部分檔被忽略時，不能把整個目錄講成沒送", () => {
  const { dir, git } = repo();
  try {
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "app.json"), "{}\n");
    writeFileSync(join(dir, "config", "secrets.json"), "{}\n");
    writeFileSync(join(dir, ".gitignore"), "dist\nnode_modules\nconfig/secrets.json\n");
    git("add", "-A");
    git("commit", "-qm", "config");
    const r = ignoredTopLevel(dir);
    assert.deepEqual(r.skipped, ["dist"], "整個沒送的只有 dist");
    assert.deepEqual(r.partiallyIgnored, ["config"], "config 有送，只是裡面少幾個檔");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox_pull 拉資料夾：裡面的東西直接放進 localPath，不多一層資料夾名", async () => {
  const dir = mkdtempSync(join(tmpdir(), "psbx-pull-"));
  try {
    // 照箱子打包的方式：tar -czf <檔> -C <上一層> <資料夾名>
    mkdirSync(join(dir, "box", "app", "dist", "assets"), { recursive: true });
    writeFileSync(join(dir, "box", "app", "dist", "index.html"), "<html></html>\n");
    writeFileSync(join(dir, "box", "app", "dist", "assets", "a.js"), "x\n");
    const archive = join(dir, "dist.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", join(dir, "box", "app"), "dist"]);
    const target = join(dir, "local", "dist");
    await unpackDirectory(createReadStream(archive), target);
    assert.equal(readFileSync(join(target, "index.html"), "utf8"), "<html></html>\n");
    assert.equal(readFileSync(join(target, "assets", "a.js"), "utf8"), "x\n");
    assert.ok(!existsSync(join(target, "dist")), "不該多一層 dist/dist");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("localPath 給單一檔案不該說「找不到資料夾」", async () => {
  const dir = mkdtempSync(join(tmpdir(), "psbx-onefile-"));
  try {
    const file = join(dir, "patch.diff");
    writeFileSync(file, "--- a\n+++ b\n");
    const res = await syncTool({ id: "bx", localPath: file, dest: "d", commit: "HEAD" });
    const text = res.content[0].text;
    assert.ok(!text.includes("local directory not found"), `檔案明明在，不該說找不到資料夾：${text}`);
    assert.ok(text.includes("single file"), `commit 配單一檔案要講清楚為什麼不行：${text}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// baseline 的價值全在「兩邊挑的檔一樣」。commit 模式原本會掉進黑名單那條路，
// 把 dist 這種有被 git 追蹤的目錄剔掉，於是同一支測試在工作區那份有 dist、
// 對照組沒有，結果不同——對照就白做了。
test("commit 模式不套黑名單：git 追蹤的 dist 要跟工作區那份一樣送過去", () => {
  const { dir, git } = repo();
  try {
    // dist 本來在 .gitignore，改成追蹤它：git archive 會含它，黑名單卻會剔掉它。
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    git("add", "-A");
    git("commit", "-qm", "track dist");

    const out = execFileSync("git", ["-C", dir, "ls-tree", "-r", "--name-only", "HEAD"], { encoding: "utf8" });
    assert.ok(out.includes("dist/bundle.js"), `這顆 commit 要真的追蹤 dist：${out}`);

    const made = archiveCommit(dir, "HEAD");
    assert.ok(!made.error, made.error);
    try {
      assert.ok(existsSync(join(made.dir, "dist", "bundle.js")),
        "git archive 出來的樹要含 dist；黑名單是在上傳那一步才會剔掉它");
    } finally {
      rmSync(made.dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("baseline 的對照組送到 <dest>-baseline", () => {
  assert.equal(baselineDest("api"), "api-baseline");
  assert.equal(baselineDest("repo/sub"), "repo/sub-baseline");
});

test("agent id 要是 control 收的格式（英數、-、_，64 字以內）", () => {
  assert.match(AGENT_ID, /^[A-Za-z0-9_-]{1,64}$/);
});

test("心跳與離開打到這個對話自己的 id，帶 API key 與 X-Psbx-Agent", async () => {
  seen.length = 0;
  assert.equal(await presence("heartbeat", 2000), true);
  assert.equal(await presence("leave", 2000), true);
  assert.deepEqual(seen.map((r) => `${r.method} ${r.url}`), [`POST /v1/agents/${AGENT_ID}/heartbeat`, `POST /v1/agents/${AGENT_ID}/leave`]);
  for (const r of seen) {
    assert.equal(r.headers.authorization, `Bearer ${process.env.PARALLELSANDBOX_API_KEY}`);
    assert.equal(r.headers["x-psbx-agent"], AGENT_ID);
  }
});

// 對話被關掉的兩種樣子：client 關掉 stdin，或送結束訊號。兩種都要先打 leave 再結束，箱子才會變成「AI 停手了」。
async function childLeaves(howToClose, wantCode) {
  const index = fileURLToPath(new URL("./index.mjs", import.meta.url));
  const script = `process.env.PSBX_ADAPTER_NO_CONNECT = "1";
    const m = await import(${JSON.stringify(index)});
    m.watchForExit(); m.startPresence(); process.stdin.resume();
    console.log(m.AGENT_ID);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, PSBX_ADAPTER_NO_CONNECT: "1" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const id = await new Promise((r) => child.stdout.once("data", (d) => r(d.toString().trim())));
  const deadline = Date.now() + 5000;
  while (!seen.some((r) => r.url === `/v1/agents/${id}/heartbeat`) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(seen.some((r) => r.url === `/v1/agents/${id}/heartbeat`), "第一次呼叫工具之後要打心跳");
  const exited = new Promise((r) => child.once("exit", (code) => r(code)));
  howToClose(child);
  assert.equal(await exited, wantCode);
  assert.ok(seen.some((r) => r.url === `/v1/agents/${id}/leave`), "結束前要打 leave");
}

test("client 關掉 stdin：先打 leave 再結束", () => childLeaves((c) => c.stdin.end(), 0));
test("收到 SIGTERM：先打 leave 再結束", () => childLeaves((c) => c.kill("SIGTERM"), 143));

// 假的 control MCP：tools/call 照工具名演出各種回應串流的死法。
// 實際發生過：control 在第 363 秒把結果送完了，adapter 裡的 SDK 把它弄丟，呼叫一直掛到 Claude Code 30 分鐘砍掉。
const mcpCalls = [];
const hanging = new Set();
// fakeTools 是假 control 的工具清單；測試改它，模擬 control 上版後 schema 變了。
let fakeTools = [{ name: "sandbox_start", description: "start", inputSchema: { type: "object", properties: {} } }];
const mcp = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const msg = JSON.parse(body);
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
    if (msg.method === "initialize") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-control", version: "1" } })));
      return;
    }
    if (msg.method === "tools/list") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply({ tools: fakeTools })));
      return;
    }
    const name = msg.params?.name;
    const call = { name, closed: false, reviewBudget: req.headers["x-psbx-review-wait-sec"], toolBudget: req.headers["x-psbx-tool-wait-sec"], args: msg.params?.arguments };
    mcpCalls.push(call);
    req.socket.on("close", () => (call.closed = true));
    // control 的驗證上游出事：還沒進到工具就回 503（auth_blip 前兩次、auth_down 一直、lb_down 是 ALB 的 HTML）。
    const seenTimes = mcpCalls.filter((c) => c.name === name).length;
    if ((name === "auth_blip" && seenTimes <= 2) || name === "auth_down" || name === "lb_down") {
      if (name === "lb_down") {
        res.writeHead(503, { "Content-Type": "text/html" });
        res.end("<html><body><h1>503 Service Temporarily Unavailable</h1></body></html>");
        return;
      }
      const body = name === "auth_down"
        ? { error: "auth unavailable: the CubeLV member center, which verifies ParallelSandbox sign-ins and API keys, is under maintenance. This call did not run and your boxes keep running; retry after 1s.", reason: "maintenance", retryAfterSec: 1 }
        : { error: "auth unavailable: ParallelSandbox could not verify this token right now (the CubeLV member center answered HTTP 404). This call did not run and your boxes keep running; retry after 15s.", reason: "upstream_auth", retryAfterSec: 0 };
      res.writeHead(503, { "Content-Type": "application/json", "Retry-After": String(body.retryAfterSec) });
      res.end(JSON.stringify(body));
      return;
    }
    // 短的呼叫 control 直接回整包 JSON：送到一半連線被切，Node 的 fetch 讀 body 時丟「terminated」。
    // sandbox_shot 第一次被切、第二次正常；cuts_json 每次都被切。
    if ((name === "sandbox_shot" && seenTimes === 1) || name === "cuts_json") {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "5000" });
      res.write(`{"jsonrpc":"2.0","id":${JSON.stringify(msg.id)},"result":{"content":[{"type":"text","text":"`);
      setTimeout(() => res.destroy(), 50);
      return;
    }
    if (name === "sandbox_shot") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply({ content: [{ type: "text", text: "sandbox_shot done" }] })));
      return;
    }
    // control 的 keepAlive：20 秒後把回應升級成 SSE，之後定時送一則 still running。
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const event = (m) => res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
    const ping = () => event({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: `${name} still running` } });
    const done = () => event(reply({ content: [{ type: "text", text: `${name} done` }] }));
    ping();
    const tries = mcpCalls.filter((c) => c.name === name).length;
    if (name === "ends_early" || (name === "sandbox_report" && tries === 1) || name === "sandbox_status") {
      res.end(); // 串流結束了，結果沒來
    } else if (name === "goes_silent" || (name === "sandbox_exec" && msg.params.arguments?.cmd === "silent")) {
      hanging.add(res); // 連線還在，一個位元組都不再來
    } else {
      if (name === "sandbox_review" && msg.params._meta?.progressToken !== undefined) {
        event({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: msg.params._meta.progressToken, progress: 0, total: 1800, message: "Review round-1 is available now: https://app.example.test/box/box-1; waiting for feedback" } });
      }
      let n = 0;
      const t = setInterval(() => {
        if (name === "sandbox_review" && msg.params.arguments.reviewId === "cancel-round") return ping();
        if (++n < 6) return ping();
        clearInterval(t);
        done();
        res.end();
      }, 200);
      res.on("close", () => clearInterval(t));
    }
  });
});
await new Promise((r) => mcp.listen(0, "127.0.0.1", r));
mcp.unref();

async function adapterClient(env = {}) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "adapter-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./index.mjs", import.meta.url))],
    env: {
      PARALLELSANDBOX_API_KEY: "test-key",
      PARALLELSANDBOX_API_URL: process.env.PARALLELSANDBOX_API_URL,
      PARALLELSANDBOX_MCP_URL: `http://127.0.0.1:${mcp.address().port}/mcp`,
      PSBX_ADAPTER_SILENCE_MS: "1500",
      PSBX_FEEDBACK_DIR: feedbackDir,
      ...env,
    },
    stderr: "ignore",
  }));
  return client;
}

async function timed(p) {
  const start = Date.now();
  const out = await p;
  return { out, sec: (Date.now() - start) / 1000 };
}

test("回應串流結束了卻沒有結果：幾秒內回錯，叫人先查 sandbox_status，不能掛著", async () => {
  const client = await adapterClient();
  try {
    const { out, sec } = await timed(client.callTool({ name: "ends_early", arguments: {} }));
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /never came back.*ended without the result.*sandbox_status/s);
    assert.ok(sec < 5, `要幾秒內回，花了 ${sec}s`);
    assert.equal(mcpCalls.filter((c) => c.name === "ends_early").length, 1, "會改東西的工具不能自己重跑");
  } finally {
    await client.close();
  }
});

test("連線一直開著卻沒有任何位元組：過了靜默上限就切掉連線、回錯", async () => {
  const client = await adapterClient();
  try {
    const { out, sec } = await timed(client.callTool({ name: "goes_silent", arguments: {} }));
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /never came back.*no data from ParallelSandbox for \d+s.*sandbox_status/s);
    assert.ok(sec >= 1.4 && sec < 5, `靜默上限 1.5 秒，花了 ${sec}s`);
    const call = mcpCalls.findLast((c) => c.name === "goes_silent");
    const deadline = Date.now() + 2000;
    while (!call.closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(call.closed, "往 control 的那條連線要切掉，不能留著");
  } finally {
    for (const res of hanging) res.destroy();
    await client.close();
  }
});

test("前景 exec 的結果在路上斷了：回事先給的 execId，叫 agent 用 sandbox_procs wait 取結果，不要重跑", async () => {
  const client = await adapterClient();
  try {
    const out = await client.callTool({ name: "sandbox_exec", arguments: { id: "box-1", cmd: "silent", note: "n" } });
    assert.equal(out.isError, true);
    const call = mcpCalls.findLast((c) => c.name === "sandbox_exec" && c.args?.cmd === "silent");
    assert.match(call.args.execId, /^[0-9a-f]{16}$/, "前景 exec 要事先帶 execId 給 control");
    const text = out.content[0].text;
    assert.ok(text.includes(`"action": "wait", "bgId": "${call.args.execId}"`), text);
    assert.match(text, /keeps running on the box.*Do not run it again/s);
  } finally {
    for (const res of hanging) res.destroy();
    await client.close();
  }
});

test("背景 exec 不帶 execId（它自己有 bgId）", async () => {
  const client = await adapterClient();
  try {
    await client.callTool({ name: "sandbox_exec", arguments: { id: "box-1", cmd: "sleep 1", note: "n", background: true } });
    const call = mcpCalls.findLast((c) => c.name === "sandbox_exec" && c.args?.background);
    assert.equal(call.args.execId, undefined);
  } finally {
    await client.close();
  }
});

test("control 的工具清單改版：送 tools/list_changed 叫 client 重抓", async () => {
  const { ToolListChangedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const client = await adapterClient({ PSBX_ADAPTER_TOOLS_CHECK_MS: "200" });
  try {
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed++; });
    const first = await client.listTools();
    assert.ok(first.tools.some((t) => t.name === "sandbox_start"));
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(changed, 0, "沒改版就不通知");
    fakeTools = [{ name: "sandbox_start", description: "start", inputSchema: { type: "object", required: ["goal"], properties: { goal: { type: "string" } } } }];
    const deadline = Date.now() + 3000;
    while (changed === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(changed, 1, "改版要通知一次");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(changed, 1, "同一次改版不重複通知");
  } finally {
    await client.close();
  }
});

test("連線錯誤講清楚斷在哪一段與原因（err.cause）", () => {
  const err = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND mcp.parallelsandbox.com"), { code: "ENOTFOUND" }) });
  const text = networkFailure(err);
  assert.match(text, /^connection from this computer to ParallelSandbox \(.+\) failed: fetch failed \(ENOTFOUND: getaddrinfo ENOTFOUND mcp\.parallelsandbox\.com\)$/);
  assert.match(networkFailure(new Error("socket hang up")), /failed: socket hang up$/);
  assert.notEqual(toolsHash([{ name: "a" }]), toolsHash([{ name: "a", inputSchema: { required: ["goal"] } }]));
});

test("control 一直出聲的長呼叫照常拿到結果，進度轉給 client", async () => {
  const client = await adapterClient();
  try {
    const progress = [];
    const { out, sec } = await timed(client.callTool({ name: "sandbox_exec", arguments: {} }, undefined, { onprogress: (p) => progress.push(p) }));
    assert.equal(out.isError, undefined);
    assert.equal(out.content[0].text, "sandbox_exec done");
    assert.ok(sec > 1, `假 control 要跑 1.2 秒，花了 ${sec}s`);
    assert.ok(progress.length >= 1, "control 出聲時要轉進度給 client");
    assert.match(progress[0].message, /sandbox_exec still running/);
  } finally {
    await client.close();
  }
});

test("持久 report 重讀的結果弄丟了就自己重試一次", async () => {
  const client = await adapterClient();
  try {
    const out = await client.callTool({ name: "sandbox_report", arguments: { id: "box-1", reportId: "report-1" } });
    assert.equal(out.content[0].text, "sandbox_report done");
    assert.equal(mcpCalls.filter((c) => c.name === "sandbox_report").length, 2);
  } finally {
    await client.close();
  }
});

test("回應送到一半被切（terminated）：唯讀的截圖自己重試一次；會改東西的講清楚可能已經跑了", async () => {
  const client = await adapterClient();
  try {
    const shot = await client.callTool({ name: "sandbox_shot", arguments: { id: "box-1" } });
    assert.equal(shot.isError, undefined, JSON.stringify(shot));
    assert.equal(shot.content[0].text, "sandbox_shot done");
    assert.equal(mcpCalls.filter((c) => c.name === "sandbox_shot").length, 2, "被切一次就重試一次");

    const cut = await client.callTool({ name: "cuts_json", arguments: {} });
    assert.equal(cut.isError, true);
    assert.match(cut.content[0].text, /never came back \(connection from this computer to ParallelSandbox .* failed: terminated.*sandbox_status/s);
    assert.equal(mcpCalls.filter((c) => c.name === "cuts_json").length, 1, "不能重試的不重跑");
  } finally {
    await client.close();
  }
});

test("status 可能已領取一次性 fromHuman：結果遺失不能自動重試而藏掉回饋", async () => {
  const client = await adapterClient();
  try {
    const out = await client.callTool({ name: "sandbox_status", arguments: { id: "box-1" } });
    assert.equal(out.isError, true);
    assert.equal(mcpCalls.filter((c) => c.name === "sandbox_status").length, 1);
  } finally {
    await client.close();
  }
});

test("review 等待的進度保留原round及可開啟URL", async () => {
  const client = await adapterClient();
  try {
    const progress = [];
    const out = await client.callTool({ name: "sandbox_review", arguments: { id: "box-1", reviewId: "round-1" } }, undefined, { onprogress: (p) => progress.push(p) });
    assert.equal(out.content[0].text, "sandbox_review done");
    assert.ok(progress.some((p) => /round-1.*https:\/\/app\.example\.test/.test(p.message)), "語意進度不能被still running蓋掉");
    assert.ok(progress.every((p, i) => i === 0 || p.progress >= progress[i - 1].progress), "byte heartbeat與remote進度交錯時不能倒退");
  } finally {
    await client.close();
  }
});

test("client 取消review等待會關閉control連線，不留下背景等待", async () => {
  const client = await adapterClient();
  const cancel = new AbortController();
  try {
    const waiting = client.callTool({ name: "sandbox_review", arguments: { id: "box-1", reviewId: "cancel-round" } }, undefined, { signal: cancel.signal, onprogress: () => {} });
    const rejected = assert.rejects(waiting);
    const deadline = Date.now() + 3000;
    while (!mcpCalls.findLast((c) => c.name === "sandbox_review" && !c.closed) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const call = mcpCalls.findLast((c) => c.name === "sandbox_review");
    assert.ok(call && !call.closed, "取消前control應仍在等");
    cancel.abort(new Error("new user input"));
    await rejected;
    const closedBy = Date.now() + 2000;
    while (!call.closed && Date.now() < closedBy) await new Promise((r) => setTimeout(r, 20));
    assert.ok(call.closed, "取消必須傳到HTTP，而非只取消本機結果");
  } finally {
    await client.close();
  }
});


test("review budget reflects the configured host deadline, not the adapter SDK timer", () => {
 for (const [configured,want] of [[undefined,25],["bad",25],["60",25],["10",0],["1920",1800],["3600",1800]]) {
  assert.equal(reviewWaitBudget(configured),want,String(configured));
 }
});

test("review transport declares the real host budget for both default and configured clients", async () => {
 for (const [env,want] of [[{},"25"],[{PSBX_TOOL_TIMEOUT_SEC:"1920"},"1800"]]) {
  const client = await adapterClient(env);
  try {
   const out = await client.callTool({name:"sandbox_review",arguments:{reviewId:"budget-round"}});
   assert.equal(out.isError,undefined);
   assert.equal(mcpCalls.findLast(c=>c.name==="sandbox_review").reviewBudget,want);
   assert.equal(mcpCalls.findLast(c=>c.name==="sandbox_review").toolBudget,want);
  } finally {await client.close();}
 }
});

// 9/28：驗證上游出事時 control 回 503，adapter 不重試，agent 只拿到一行 "auth unavailable"。503 是還沒進到工具就被擋下，
// 所以連會改東西的工具也退避重試；試完還不行要講已經中斷多久、原因是什麼。
const unavailableEnv = { PSBX_ADAPTER_UNAVAILABLE_FIRST_MS: "50", PSBX_ADAPTER_UNAVAILABLE_BUDGET_MS: "1500" };

test("503 是還沒進到工具就被擋下：短暫的上游抖動自己退避重試，連 exec 這種工具也一樣", async () => {
  const client = await adapterClient(unavailableEnv);
  try {
    const progress = [];
    const out = await client.callTool({ name: "auth_blip", arguments: {} }, undefined, { onprogress: (p) => progress.push(p) });
    assert.equal(out.isError, undefined);
    assert.equal(out.content[0].text, "auth_blip done");
    assert.equal(mcpCalls.filter((c) => c.name === "auth_blip").length, 3);
    assert.ok(progress.some((p) => /answered 503 \(upstream_auth\), retrying/.test(p.message)), "重試中要轉進度給 client");
  } finally {
    await client.close();
  }
});

test("503 一直不好：在期限內放棄，講已經中斷多久與 control 給的原因", async () => {
  const client = await adapterClient(unavailableEnv);
  try {
    const { out, sec } = await timed(client.callTool({ name: "auth_down", arguments: {} }));
    assert.equal(out.isError, true);
    const text = out.content[0].text;
    assert.match(text, /answered HTTP 503 for \d+s \(since \d{4}-\d\d-\d\dT.*tries in this call, reason: maintenance\)/);
    assert.match(text, /under maintenance/);
    assert.match(text, /safe to call this again later/);
    assert.ok(sec < 4, `重試總長 1.5 秒，花了 ${sec}s`);
    assert.ok(mcpCalls.filter((c) => c.name === "auth_down").length >= 2);

    // ALB 的 503（HTML）也一樣處理，原因說不出來就照實講
    const lb = await client.callTool({ name: "lb_down", arguments: {} });
    assert.equal(lb.isError, true);
    assert.match(lb.content[0].text, /reason: unavailable\).*load balancer/s);
  } finally {
    await client.close();
  }
});

afterAllFeedback(() => rmSync(fakeWork, { recursive: true, force: true }));

const parsed = (res) => JSON.parse(res.content[0].text);
const boxFile = (rel) => join(fakeWork, rel);
const uploadsTo = (dest) => seen.filter((r) => r.url.startsWith(`/v1/boxes/bx/sync?dest=${encodeURIComponent(dest)}`));
const tarNames = (raw) => execFileSync("tar", ["-tzf", "-"], { input: raw, encoding: "utf8" }).split("\n").filter((n) => n && !n.endsWith("/")).map((n) => n.replace(/^\.\//, "")).sort();

// 使用回饋三十幾次：agent 在 exec 裡寫絕對路徑，照抄到 dest；整個目錄 sync 時還卡在上傳一半。
test("dest 寫 /work/... 照樣收，其他絕對路徑與跑出 /work 的在上傳前就擋下", async () => {
  assert.deepEqual(boxRel("/work/app"), { rel: "app", dir: false });
  assert.deepEqual(boxRel("/work/app/src/"), { rel: "app/src", dir: true });
  assert.deepEqual(boxRel("/work"), { rel: ".", dir: false });
  assert.deepEqual(boxRel("a/./b//c"), { rel: "a/b/c", dir: false });
  for (const bad of ["/tmp/x", "/Users/me/app", "../x", "a/../../x", "~/x"]) assert.ok(boxRel(bad).error, `${bad} 要擋下`);
  assert.equal(workRel("/work/shots/a.png"), "shots/a.png");
  assert.equal(workRel("/tmp/e2e/a.png"), "/tmp/e2e/a.png", "其他絕對路徑交給箱子判斷");
  assert.equal(workRel("shots"), "shots");

  const { dir } = repo();
  try {
    const before = seen.length;
    const res = await syncTool({ id: "bx", localPath: dir, dest: "/var/app" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /not \/work\/app/);
    assert.equal(seen.length, before, "不合法的 dest 不能開始上傳");
    const ok = await syncTool({ id: "bx", localPath: dir, dest: "/work/abs-dest" });
    assert.equal(ok.isError, false, ok.content[0].text);
    assert.equal(parsed(ok).remotePath, "/work/abs-dest");
    assert.ok(existsSync(boxFile("abs-dest/main.go")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 使用回饋十四次：dest 寫 renderer/.env，結果箱子裡多一個 renderer/.env/ 資料夾，檔案在裡面。
test("單一檔案：dest 就是它在箱子裡的路徑；結尾 / 或箱子裡已經是資料夾才放進去", async () => {
  const dir = mkdtempSync(join(tmpdir(), "psbx-onefile-"));
  try {
    const file = join(dir, "local.env");
    writeFileSync(file, "API=1\n");
    let out = parsed(await syncTool({ id: "bx", localPath: file, dest: "one/renderer/.env" }));
    assert.equal(out.remotePath, "/work/one/renderer/.env");
    assert.ok(statSync(boxFile("one/renderer/.env")).isFile(), "dest 要是檔案，不是資料夾");
    assert.equal(readFileSync(boxFile("one/renderer/.env"), "utf8"), "API=1\n");

    writeFileSync(file, "API=2\n");
    out = parsed(await syncTool({ id: "bx", localPath: file, dest: "one/renderer/.env" }));
    assert.equal(readFileSync(boxFile("one/renderer/.env"), "utf8"), "API=2\n", "箱子裡已經是檔案時直接蓋過去");

    out = parsed(await syncTool({ id: "bx", localPath: file, dest: "one/tools/" }));
    assert.equal(out.remotePath, "/work/one/tools/local.env");
    assert.ok(existsSync(boxFile("one/tools/local.env")));

    mkdirSync(boxFile("one/existing"), { recursive: true });
    out = parsed(await syncTool({ id: "bx", localPath: file, dest: "one/existing" }));
    assert.equal(out.remotePath, "/work/one/existing/local.env", "箱子裡已經是資料夾就放進去");

    const prune = await syncTool({ id: "bx", localPath: file, dest: "one/x", prune: true });
    assert.equal(prune.isError, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 使用回饋九次：本機刪掉的檔留在箱子裡，tsc、go build 多報錯。
test("dest 裡多出來的檔列在 staleInDest，被忽略的與 node_modules 不算；prune 才刪", async () => {
  const { dir, git } = repo();
  try {
    writeFileSync(join(dir, ".gitignore"), "dist\nnode_modules\n*.log\n");
    writeFileSync(join(dir, "old.go"), "package main\n");
    git("add", "-A");
    git("commit", "-qm", "old");
    assert.equal(parsed(await syncTool({ id: "bx", localPath: dir, dest: "stale" })).ok, true);
    rmSync(join(dir, "old.go"));
    mkdirSync(boxFile("stale/node_modules/x"), { recursive: true });
    writeFileSync(boxFile("stale/node_modules/x/index.js"), "box installed\n");
    writeFileSync(boxFile("stale/run.log"), "box log\n");
    mkdirSync(boxFile("stale/legacy/deep"), { recursive: true });
    writeFileSync(boxFile("stale/legacy/a.go"), "a\n");
    writeFileSync(boxFile("stale/legacy/deep/b.go"), "b\n");

    let out = parsed(await syncTool({ id: "bx", localPath: dir, dest: "stale" }));
    assert.equal(out.sentFiles, 0, "沒有改動就不送");
    assert.deepEqual(out.sentPaths, []);
    assert.equal(out.changedOnBox, 0);
    assert.deepEqual(out.staleInDest.paths.sort(), ["legacy/a.go", "legacy/deep/b.go", "old.go"]);
    assert.equal(out.staleInDest.count, 3);
    assert.ok(out.notes.some((n) => /prune: true/.test(n)));
    assert.ok(existsSync(boxFile("stale/old.go")), "沒帶 prune 不刪");

    out = parsed(await syncTool({ id: "bx", localPath: dir, dest: "stale", prune: true }));
    assert.equal(out.pruned, 3);
    assert.ok(!existsSync(boxFile("stale/old.go")));
    assert.ok(!existsSync(boxFile("stale/legacy")), "刪空的資料夾一起收掉");
    assert.ok(existsSync(boxFile("stale/node_modules/x/index.js")), "node_modules 不能動");
    assert.ok(existsSync(boxFile("stale/run.log")), "被忽略的檔不能動");
    assert.ok(existsSync(boxFile("stale/main.go")));

    assert.match((await syncTool({ id: "bx", localPath: dir, dest: "/work", prune: true })).content[0].text, /not \/work itself/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("不是 git 工作區時 prune 不做，什麼都不送", async () => {
  const plain = mkdtempSync(join(tmpdir(), "psbx-plain-prune-"));
  try {
    writeFileSync(join(plain, "a.txt"), "a\n");
    const before = seen.length;
    const res = await syncTool({ id: "bx", localPath: plain, dest: "plain", prune: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /git working tree/);
    assert.equal(seen.length, before);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test("箱子自己產生的大資料夾整個算一筆，不塞滿清單", () => {
  const base = mkdtempSync(join(tmpdir(), "psbx-stale-"));
  try {
    mkdirSync(join(base, "src"));
    writeFileSync(join(base, "src", "a.ts"), "a\n");
    writeFileSync(join(base, "src", "gone.ts"), "x\n");
    mkdirSync(join(base, "out"));
    for (let i = 0; i < 5; i++) writeFileSync(join(base, "out", `${i}.js`), "x\n");
    mkdirSync(join(base, "node_modules", "y"), { recursive: true });
    writeFileSync(join(base, "node_modules", "y", "i.js"), "x\n");
    const hex = (s) => Buffer.from(s).toString("hex");
    const got = staleEntries(Buffer.from(base), new Set([hex("src/a.ts")]), [""], new Set(["node_modules"]), 100, 3);
    assert.deepEqual(got.stale.map((h) => Buffer.from(h, "hex").toString()).sort(), ["out/", "src/gone.ts"]);
    assert.equal(got.staleTotal, 2);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// 使用回饋：sync 只回檔數，並行開發時看不出箱子裡測的是哪一版；改到 package.json 時 vite 整頁重載沒人知道。
test("sync 回傳列出送了哪些檔、箱子改了幾個；改到 package.json 附上 dev server 的提醒", async () => {
  const { dir, git } = repo();
  try {
    writeFileSync(join(dir, "package.json"), "{}\n");
    git("add", "-A");
    git("commit", "-qm", "pkg");
    let out = parsed(await syncTool({ id: "bx", localPath: dir, dest: "sent" }));
    assert.deepEqual(out.sentPaths.sort(), [".gitignore", "main.go", "package.json"]);
    assert.equal(out.changedOnBox, 3);
    assert.ok(!(out.notes || []).some((n) => /dev server/.test(n)), "新的 dest 沒有開著的 dev server，不用提醒");

    writeFileSync(join(dir, "package.json"), '{"name":"x"}\n');
    out = parsed(await syncTool({ id: "bx", localPath: dir, dest: "sent" }));
    assert.deepEqual(out.sentPaths, ["package.json"]);
    assert.ok(out.notes.some((n) => /package\.json changed: a running dev server/.test(n)), JSON.stringify(out));
    assert.deepEqual(out.uncommitted.paths, ["M package.json"]);
    assert.ok(out.notes.some((n) => /commit: "HEAD"/.test(n)), "有未提交的檔要建議改用 commit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("沒有 commit 時 alsoPaths 只送那幾個路徑，送到 dest 底下同一個位置", async () => {
  const { dir } = repo();
  try {
    mkdirSync(join(dir, "web", "ui"), { recursive: true });
    writeFileSync(join(dir, "web", "ui", "a.ts"), "a\n");
    mkdirSync(join(dir, "web", "ui", "node_modules"));
    writeFileSync(join(dir, "web", "ui", "node_modules", "n.js"), "n\n");
    writeFileSync(join(dir, "other.go"), "package main\n");
    const res = await syncTool({ id: "bx", localPath: dir, dest: "only", alsoPaths: ["main.go", "web/ui"] });
    assert.equal(res.isError, false, res.content[0].text);
    const out = parsed(res);
    assert.equal(out.uncommitted, undefined);
    assert.deepEqual(tarNames(uploadsTo("only").at(-1).raw), ["main.go", "web/ui/a.ts"]);
    assert.ok(existsSync(boxFile("only/web/ui/a.ts")));
    assert.ok(!existsSync(boxFile("only/other.go")), "沒列的不送");
    assert.match((await syncTool({ id: "bx", localPath: dir, dest: "only", alsoPaths: ["nope"] })).content[0].text, /not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 使用回饋：打錯的 revision 回 ok、uploaded 10240 bytes，實際 dest 是空的，測試白跑。
test("commit 給不存在的 revision 直接回錯，什麼都不送", async () => {
  const { dir } = repo();
  try {
    const before = seen.length;
    const res = await syncTool({ id: "bx", localPath: dir, dest: "badrev", commit: "no-such-branch" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /no-such-branch is not a commit/);
    assert.equal(seen.length, before);
    assert.match(archiveCommit(dir, "--output=/tmp/x").error, /not a commit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commit 模式也只送有變的檔，回傳解析後的 commit；baseline 一起送", async () => {
  const { dir, git } = repo();
  try {
    const head = git("rev-parse", "HEAD").trim();
    let out = parsed(await syncTool({ id: "bx", localPath: dir, dest: "cm", commit: "HEAD", baseline: "HEAD" }));
    assert.equal(out.commitSha, head);
    assert.ok(existsSync(boxFile("cm/main.go")));
    assert.ok(existsSync(boxFile("cm/dist/bundle.js")) === false, "commit 沒追蹤 dist");
    assert.equal(out.baseline.dest, "cm-baseline");
    assert.equal(out.baseline.commitSha, head);
    assert.ok(existsSync(boxFile("cm-baseline/main.go")));
    out = parsed(await syncTool({ id: "bx", localPath: dir, dest: "cm", commit: "HEAD" }));
    assert.equal(out.sentFiles, 0, "第二次沒改動就不送");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 使用回饋：sync 回 409 之後 exec 照跑，cp 因為檔案沒同步失敗，被當成測試失敗。
test("sync 失敗：明講箱子裡還是舊檔，列出原本要送的檔，下一個 exec 附提醒", async () => {
  const { dir } = repo();
  try {
    failDests.add("frozen");
    const res = await syncTool({ id: "bx-frozen", localPath: dir, dest: "frozen", alsoPaths: ["main.go"] });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /box frozen/);
    assert.match(res.content[0].text, /NOT SYNCED: \/work\/frozen still has its old files/);
    assert.match(res.content[0].text, /sending 1 files: main.go/);
    assert.match(staleSyncWarning("bx-frozen"), /last sandbox_sync to \/work\/frozen on this box failed/);
    assert.equal(staleSyncWarning("bx-frozen"), "", "只提醒一次");

    await syncTool({ id: "bx-frozen", localPath: dir, dest: "frozen", alsoPaths: ["main.go"] });
    failDests.delete("frozen");
    assert.equal(parsed(await syncTool({ id: "bx-frozen", localPath: dir, dest: "frozen", alsoPaths: ["main.go"] })).ok, true);
    assert.equal(staleSyncWarning("bx-frozen"), "", "重送成功就不用提醒");
  } finally {
    failDests.delete("frozen");
    rmSync(dir, { recursive: true, force: true });
  }
});

// exec 只回最後 16 KB；長的比對清單要從 outputUrl 拿完整輸出，不然 JSON 被切掉開頭，sync 整個失敗。
test("比對結果超過 exec 的輸出上限時改讀完整輸出", async () => {
  const { dir } = repo();
  let n = 0;
  setBoxExecForTest(async (args) => {
    const run = localExec(args);
    if (args.cmd.includes("compare.mjs")) {
      const url = `/full-output-${++n}`;
      fullOutputs.set(url, run.stdout);
      Object.assign(run, { stdout: run.stdout.slice(-10), truncated: true, outputUrl: `${process.env.PARALLELSANDBOX_API_URL}${url}` });
    }
    return { content: [{ type: "text", text: JSON.stringify(run) }] };
  });
  try {
    const out = parsed(await syncTool({ id: "bx", localPath: dir, dest: "trunc" }));
    assert.equal(out.ok, true);
    assert.ok(existsSync(boxFile("trunc/main.go")));
  } finally {
    setBoxExecForTest(async (args) => ({ content: [{ type: "text", text: JSON.stringify(localExec(args)) }] }));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("submodules: commit 模式把子模組照 gitlink 的版本放進樹裡；沒 init 的列出來", () => {
  const sub = mkdtempSync(join(tmpdir(), "psbx-sub-"));
  const { dir, git } = repo();
  let made;
  try {
    const sg = (...args) => execFileSync("git", ["-C", sub, ...args], { encoding: "utf8" });
    sg("init", "-q");
    sg("config", "user.email", "t@example.com");
    sg("config", "user.name", "t");
    writeFileSync(join(sub, "lib.go"), "package lib // v1\n");
    sg("add", "-A");
    sg("commit", "-qm", "v1");
    git("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor/lib");
    git("commit", "-qm", "sub");
    writeFileSync(join(dir, "vendor", "lib", "lib.go"), "package lib // 沒提交的\n");

    made = archiveCommit(dir, "HEAD");
    assert.ok(!existsSync(join(made.dir, "vendor", "lib", "lib.go")), "沒帶 submodules 時 git archive 不展開");
    rmSync(made.dir, { recursive: true, force: true });

    made = archiveCommit(dir, "HEAD", { submodules: true });
    assert.equal(made.error, undefined);
    assert.equal(readFileSync(join(made.dir, "vendor", "lib", "lib.go"), "utf8"), "package lib // v1\n", "用 gitlink 記錄的版本，不是工作區");
    assert.deepEqual(made.submodules.map((s) => s.path), ["vendor/lib"]);
    assert.deepEqual(made.submodulesMissing, []);
    rmSync(made.dir, { recursive: true, force: true });

    rmSync(join(dir, "vendor", "lib"), { recursive: true, force: true });
    mkdirSync(join(dir, "vendor", "lib"));
    made = archiveCommit(dir, "HEAD", { submodules: true });
    assert.deepEqual(made.submodulesMissing.map((s) => s.path), ["vendor/lib"]);
    assert.match(made.submodulesMissing[0].why, /not initialized/);
  } finally {
    if (made?.dir) rmSync(made.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(sub, { recursive: true, force: true });
  }
});

test("sandbox_pull 解資料夾時回寫了哪些檔", async () => {
  const dir = mkdtempSync(join(tmpdir(), "psbx-pull-list-"));
  try {
    mkdirSync(join(dir, "box", "dist", "assets"), { recursive: true });
    writeFileSync(join(dir, "box", "dist", "index.html"), "<html></html>\n");
    writeFileSync(join(dir, "box", "dist", "assets", "a.js"), "x\n");
    const archive = join(dir, "dist.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", join(dir, "box"), "dist"]);
    const files = await unpackDirectory(createReadStream(archive), join(dir, "local"));
    assert.deepEqual(files.sort(), ["assets/a.js", "index.html"]);
    assert.ok(lstatSync(join(dir, "local", "assets", "a.js")).isFile());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// sandbox_start 的結果沒回來（或被 host 切掉）：照 sandbox_list 找這個對話剛用同一個名字與目的開的箱子。
test("a lost sandbox_start is matched to the box this conversation just created", () => {
  const since = Date.parse("2026-10-06T01:00:00Z");
  const list = { boxes: [
    { id: "old", name: "退款流程", goal: "驗退款", agent: { thisConversation: true }, createdAt: "2026-10-06T00:30:00Z", status: "ready" },
    { id: "other", name: "退款流程", goal: "驗退款", agent: { thisConversation: false }, createdAt: "2026-10-06T01:00:05Z", status: "ready" },
    { id: "mine", name: "退款流程", goal: "驗退款", agent: { thisConversation: true }, createdAt: "2026-10-06T01:00:04Z", status: "claimed" },
    { id: "diffgoal", name: "退款流程", goal: "別的", agent: { thisConversation: true }, createdAt: "2026-10-06T01:00:06Z", status: "ready" },
  ] };
  assert.equal(matchStartedBox(list, { name: " 退款流程\n", goal: "驗退款 " }, since)?.id, "mine");
  assert.equal(matchStartedBox(list, { name: "退款流程", goal: "驗退款" }, since).id, "mine");
  assert.equal(matchStartedBox(list, { name: "沒有這個", goal: "驗退款" }, since), null);
  assert.equal(matchStartedBox({}, { name: "x", goal: "y" }, since), null);
});

// 連線還沒建立就失敗（DNS、拒絕連線）：碼在 fetch 錯誤的 cause 裡，這種請求沒送出去，可以安全重試。
test("network errors before the request is sent are recognised from the cause chain", () => {
  const dns = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND mcp.parallelsandbox.com"), { code: "ENOTFOUND" }) });
  assert.equal(networkCode(dns), "ENOTFOUND");
  const reset = new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
  assert.equal(networkCode(reset), "");
  assert.equal(networkCode(new Error("boom")), "");
});

const restoreExec = () => setBoxExecForTest(async (args) => ({ content: [{ type: "text", text: JSON.stringify(localExec(args)) }] }));
const apiURL = (path) => `${process.env.PARALLELSANDBOX_API_URL}${path}`;

// 使用回饋：只改一支 .mjs，再 sync 一次仍重傳整個 15.9 MB 的資料夾（不是 git 的資料夾以前整包送）。
test("不是 git 的資料夾也只送有變的檔，略過的黑名單名字照實列出", async () => {
  const plain = mkdtempSync(join(tmpdir(), "psbx-plain-sync-"));
  try {
    writeFileSync(join(plain, "a.mjs"), "a\n");
    writeFileSync(join(plain, "b.mjs"), "b\n");
    mkdirSync(join(plain, "node_modules", "x"), { recursive: true });
    writeFileSync(join(plain, "node_modules", "x", "i.js"), "x\n");
    let out = parsed(await syncTool({ id: "bx", localPath: plain, dest: "plain-delta" }));
    assert.equal(out.sentFiles, 2);
    assert.deepEqual(out.skipped, ["node_modules"]);
    assert.ok(existsSync(boxFile("plain-delta/a.mjs")));
    writeFileSync(join(plain, "b.mjs"), "b2\n");
    out = parsed(await syncTool({ id: "bx", localPath: plain, dest: "plain-delta" }));
    assert.deepEqual(out.sentPaths, ["b.mjs"]);
    assert.deepEqual(tarNames(uploadsTo("plain-delta").at(-1).raw), ["b.mjs"]);
    assert.equal(readFileSync(boxFile("plain-delta/b.mjs"), "utf8"), "b2\n");
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test("exclude 的 glob：沒有 / 的比任何一層的名字，有 / 的從 localPath 算起，比到資料夾就整個擋", () => {
  const m = globMatcher(["*.log", "android/app/build.gradle", "/dist", "renderer/dist-win/**", "a?c", "cache/"]);
  assert.ok(m("x/y/z.log"));
  assert.ok(m("android/app/build.gradle"));
  assert.ok(!m("x/android/app/build.gradle"), "有 / 的從 localPath 算起");
  assert.ok(m("dist/a.js"));
  assert.ok(!m("src/dist/a.js"));
  assert.ok(m("renderer/dist-win/x/setup.exe"));
  assert.ok(m("abc") && !m("abbc"));
  assert.ok(m("deep/cache/x.bin"), "沒有 / 的資料夾名字，任何一層都擋");
  assert.ok(!m("src/main.ts"));
  assert.equal(globMatcher([]), null);
});

// 使用回饋：sync 把本機的 capacitor.config.ts 蓋回箱子，覆寫了為 debug APK 改的 url，每次 sync 完都要重新 sed。
test("exclude：比到的檔不送也不比，箱子裡那份不算多出來，prune 也不刪", async () => {
  const { dir, git } = repo();
  try {
    writeFileSync(join(dir, "capacitor.config.ts"), "url: prod\n");
    mkdirSync(join(dir, "big"));
    writeFileSync(join(dir, "big", "x.bin"), "x\n");
    git("add", "-A");
    git("commit", "-qm", "cap");
    assert.equal(parsed(await syncTool({ id: "bx", localPath: dir, dest: "excl" })).ok, true);
    writeFileSync(boxFile("excl/capacitor.config.ts"), "url: http://localhost:5173/\n");
    writeFileSync(join(dir, "capacitor.config.ts"), "url: prod2\n");
    rmSync(join(dir, "big"), { recursive: true });
    git("add", "-A");
    git("commit", "-qm", "rm big");
    const out = parsed(await syncTool({ id: "bx", localPath: dir, dest: "excl", exclude: ["capacitor.config.ts", "big/"], prune: true }));
    assert.equal(readFileSync(boxFile("excl/capacitor.config.ts"), "utf8"), "url: http://localhost:5173/\n", "箱子裡改過的那份要留著");
    assert.ok(existsSync(boxFile("excl/big/x.bin")), "exclude 擋下的不刪");
    assert.deepEqual(out.excluded, { count: 1, paths: ["capacitor.config.ts"] });
    assert.equal(out.staleInDest, undefined);
    assert.ok(!out.sentPaths.includes("capacitor.config.ts"));
    const bad = await syncTool({ id: "bx", localPath: dir, dest: "excl", exclude: "capacitor.config.ts" });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /exclude takes an array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 使用回饋：沒被 .gitignore 的 dist-win（191.6 MB）整包送進去，只能中止後縮小範圍。
test("要送的超過 maxMB 就不送，講最大的資料夾；dryRun 只列出會送什麼", async () => {
  const { dir } = repo();
  try {
    mkdirSync(join(dir, "app", "dist-win"), { recursive: true });
    writeFileSync(join(dir, "app", "dist-win", "setup.exe"), Buffer.alloc(3 * 1024 * 1024, 1));
    writeFileSync(join(dir, "app", "main.ts"), "x\n");
    const before = uploadsTo("big").length;
    let res = await syncTool({ id: "bx", localPath: dir, dest: "big", maxMB: 2 });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /over the 2\.0 MB limit/);
    assert.match(res.content[0].text, /app\/ 3\.0 MB in 2 files \(app\/dist-win\/ 3\.0 MB\)/);
    assert.match(res.content[0].text, /maxMB: 4/);
    assert.match(res.content[0].text, /NOT SYNCED/);
    assert.equal(uploadsTo("big").length, before, "超過上限什麼都不送");

    res = await syncTool({ id: "bx", localPath: dir, dest: "big", maxMB: 2, dryRun: true });
    assert.equal(res.isError, false, res.content[0].text);
    const out = parsed(res);
    assert.equal(out.dryRun, true);
    assert.equal(out.sentFiles, 4);
    assert.equal(out.sendMB, 3);
    assert.equal(out.largest[0].path, "app/");
    assert.ok(out.notes.some((n) => /dryRun: nothing was sent.*refused unless you pass maxMB/.test(n)));
    assert.equal(uploadsTo("big").length, before, "dryRun 什麼都不送");
    assert.ok(!existsSync(boxFile("big")));

    assert.equal(parsed(await syncTool({ id: "bx", localPath: dir, dest: "big", maxMB: 4 })).ok, true);
    assert.equal(statSync(boxFile("big/app/dist-win/setup.exe")).size, 3 * 1024 * 1024);
    assert.equal((await syncTool({ id: "bx", localPath: dir, dest: "big", maxMB: 0 })).isError, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 使用回饋：sdk/ 子專案的 node_modules 沒裝，整合測試報 Cannot find module 'express'；
// 增量同步後箱子裡的 node_modules 是舊的，tsc 被缺模組的錯誤淹沒。
test("lockfile 所在的資料夾沒有 node_modules、或裝的跟 lockfile 不合時提醒重裝", async () => {
  const { dir, git } = repo();
  try {
    const lock = (pkgs) => JSON.stringify({ name: "x", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "x", version: "1.0.0" }, ...pkgs } });
    writeFileSync(join(dir, "package-lock.json"), lock({
      "node_modules/express": { version: "4.19.2" },
      "node_modules/fsevents": { version: "2.3.3", optional: true },
    }));
    mkdirSync(join(dir, "sdk"));
    writeFileSync(join(dir, "sdk", "package-lock.json"), lock({ "node_modules/@modelcontextprotocol/sdk": { version: "1.30.0", dev: true } }));
    git("add", "-A");
    git("commit", "-qm", "locks");
    let out = parsed(await syncTool({ id: "bx", localPath: dir, dest: "deps" }));
    assert.deepEqual(out.deps.map((d) => [d.dir, d.state]).sort(), [[".", "missing"], ["sdk", "missing"]]);
    assert.ok(out.notes.some((n) => /\/work\/deps \(package-lock\.json\), \/work\/deps\/sdk \(package-lock\.json\) have lockfiles but no node_modules/.test(n) && /"dir": "deps", "cmd": "npm ci"/.test(n)), JSON.stringify(out.notes));

    const install = (at, version) => {
      mkdirSync(boxFile(at), { recursive: true });
      writeFileSync(boxFile(`${at}/package.json`), JSON.stringify({ version }));
    };
    install("deps/node_modules/express", "4.19.2");
    install("deps/sdk/node_modules/@modelcontextprotocol/sdk", "1.20.0");
    out = parsed(await syncTool({ id: "bx", localPath: dir, dest: "deps" }));
    assert.deepEqual(out.deps, [{ dir: "sdk", lock: "package-lock.json", state: "stale", differ: 1, wanted: 1 }], "optional 的 fsevents 沒裝不算");
    assert.ok(out.notes.some((n) => /node_modules in \/work\/deps\/sdk does not match its package-lock\.json: 1 of 1 packages.*@modelcontextprotocol\/sdk 1\.20\.0 \(lockfile: 1\.30\.0\).*npm ci/.test(n)), JSON.stringify(out.notes));

    install("deps/sdk/node_modules/@modelcontextprotocol/sdk", "1.30.0");
    out = parsed(await syncTool({ id: "bx", localPath: dir, dest: "deps" }));
    assert.equal(out.deps, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 使用回饋：baseline 樹沒有 node_modules，要手動 symlink 兩層；symlink 又讓兩個 vite 共用 .vite 快取互蓋，畫面卡在開機遮罩。
test("baseline 用硬連結拿到自己的一份 node_modules，Vite 快取不共用", async () => {
  const { dir } = repo();
  try {
    assert.equal(parsed(await syncTool({ id: "bx", localPath: dir, dest: "bl" })).ok, true);
    mkdirSync(boxFile("bl/node_modules/x"), { recursive: true });
    writeFileSync(boxFile("bl/node_modules/x/index.js"), "x\n");
    mkdirSync(boxFile("bl/node_modules/.vite/deps"), { recursive: true });
    writeFileSync(boxFile("bl/node_modules/.vite/deps/chunk.js"), "c\n");
    mkdirSync(boxFile("bl/web/node_modules/y"), { recursive: true });
    writeFileSync(boxFile("bl/web/node_modules/y/i.js"), "y\n");
    const out = parsed(await syncTool({ id: "bx", localPath: dir, dest: "bl", baseline: "HEAD" }));
    assert.deepEqual(out.baseline.depsCopied.sort(), ["node_modules", "web/node_modules"]);
    assert.equal(statSync(boxFile("bl-baseline/node_modules/x/index.js")).ino, statSync(boxFile("bl/node_modules/x/index.js")).ino, "硬連結，不另佔空間");
    assert.ok(!existsSync(boxFile("bl-baseline/node_modules/.vite")), "Vite 快取各用各的");
    assert.ok(existsSync(boxFile("bl/node_modules/.vite/deps/chunk.js")), "原本那份不能動");
    assert.ok(existsSync(boxFile("bl-baseline/web/node_modules/y/i.js")));
    assert.ok(existsSync(boxFile("bl-baseline/main.go")));

    const again = parsed(await syncTool({ id: "bx", localPath: dir, dest: "bl", baseline: "HEAD" }));
    assert.equal(again.baseline.depsCopied, undefined, "baseline 已經有的不再複製");
    rmSync(boxFile("bl-baseline"), { recursive: true, force: true });
    const off = parsed(await syncTool({ id: "bx", localPath: dir, dest: "bl", baseline: "HEAD", baselineDeps: false }));
    assert.equal(off.baseline.depsCopied, undefined);
    assert.ok(!existsSync(boxFile("bl-baseline/node_modules")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("第一次送進 dest：講被 ignore 擋下的設定檔與沒有 .git；gradlew 沒有執行權限時講怎麼跑", async () => {
  const { dir, git } = repo();
  try {
    writeFileSync(join(dir, ".gitignore"), "dist\nnode_modules\ntsconfig.json\n.env.local\n");
    writeFileSync(join(dir, "tsconfig.json"), "{}\n");
    writeFileSync(join(dir, ".env.local"), "A=1\n");
    writeFileSync(join(dir, "gradlew"), "#!/bin/sh\n", { mode: 0o644 });
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(dir, "lib.sh"), "x=1\n", { mode: 0o644 });
    git("add", "-A");
    git("commit", "-qm", "scripts");
    const out = parsed(await syncTool({ id: "bx", localPath: dir, dest: "fresh-notes" }));
    const all = out.notes.join("\n");
    assert.match(all, /\.env\.local, tsconfig\.json were not sent: the ignore rules skip them/);
    assert.match(all, /alsoPaths: \[".env.local","tsconfig.json"\]/);
    assert.match(all, /No \.git is sent, so git commands in \/work\/fresh-notes fail/);
    const mode = out.notes.find((n) => /not executable/.test(n));
    assert.match(mode, /^gradlew is not executable here.*bash gradlew.*git update-index --chmod=\+x gradlew/);
    assert.ok(!/run\.sh|lib\.sh/.test(mode), "有執行權限的、沒有 #! 的 .sh 不用提");

    const again = parsed(await syncTool({ id: "bx", localPath: dir, dest: "fresh-notes" }));
    assert.ok(!(again.notes || []).some((n) => /No \.git|were not sent|not executable/.test(n)), "只在第一次、或那個檔有送時講");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 使用回饋：比對 783 個檔後報 Unexpected non-whitespace character after JSON at position 8。
// control 在 exec 結果後面多接了點數提醒、人的留言（附圖），adapter 把它們全接起來 parse。
test("exec 結果後面多接的點數提醒與人的留言不會弄壞比對，留言轉交給 agent", async () => {
  const { dir } = repo();
  let first = true;
  setBoxExecForTest(async (args) => {
    const run = localExec(args);
    const content = [{ type: "text", text: JSON.stringify(first ? { ...run, fromHuman: ["請順便看一下登入頁"] } : run) }];
    if (first) content.push({ type: "image", data: "aGk=", mimeType: "image/png" });
    first = false;
    content.push({ type: "text", text: "credits: 12 left, about 30m at the current rate." });
    return { content };
  });
  try {
    const res = await localTool("sandbox_sync", { id: "bx", localPath: dir, dest: "extras" });
    assert.equal(res.isError, false, res.content[0].text);
    assert.equal(parsed(res).ok, true);
    const texts = res.content.filter((c) => c.type === "text").map((c) => c.text);
    assert.ok(texts.some((t) => t.includes("請順便看一下登入頁")), "人的留言要交給 agent");
    assert.equal(texts.filter((t) => t.startsWith("credits:")).length, 1, "重複的提醒只留一份");
    assert.ok(res.content.some((c) => c.type === "image"));
  } finally {
    restoreExec();
    rmSync(dir, { recursive: true, force: true });
  }
});

// 使用回饋：commit: HEAD 第一次回 fetch failed、箱子 ready 了第一次 sync 回 502，原樣重試都好了。
test("上傳遇到 502 自動重試一次，回傳講明重試過", async () => {
  const { dir } = repo();
  try {
    failOnce.set("retry502", 502);
    const res = await syncTool({ id: "bx", localPath: dir, dest: "retry502" });
    assert.equal(res.isError, false, res.content[0].text);
    const out = parsed(res);
    assert.ok(out.notes.some((n) => /first upload failed \(sync failed \(HTTP 502\).*sent again once/.test(n)), JSON.stringify(out.notes));
    assert.ok(existsSync(boxFile("retry502/main.go")));
  } finally {
    failOnce.delete("retry502");
    rmSync(dir, { recursive: true, force: true });
  }
});

// 使用回饋：sync 完全沒有回應，1800 秒後 client 才砍掉。
test("整包送完箱子一直不回答：過了上限就回錯，不會掛著，也不重送", async () => {
  const { dir } = repo();
  try {
    slowAnswer.add("slow");
    const { out, sec } = await timed(syncTool({ id: "bx", localPath: dir, dest: "slow" }));
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /stalled after uploading: the box did not answer within 2s/);
    assert.match(out.content[0].text, /NOT SYNCED/);
    assert.ok(sec < 5, `上限 1.5 秒，花了 ${sec}s`);
    assert.equal(uploadsTo("slow").length, 1, "卡住的不重送");
  } finally {
    slowAnswer.delete("slow");
    rmSync(dir, { recursive: true, force: true });
  }
});

// 使用回饋：233 秒的 sync 中間沒有任何輸出，分不出是在傳還是卡住。
test("sync 進行中定時回報做到哪一步", async () => {
  const { dir } = repo();
  setBoxExecForTest(async (args) => {
    await new Promise((r) => setTimeout(r, 700));
    return { content: [{ type: "text", text: JSON.stringify(localExec(args)) }] };
  });
  try {
    const progress = [];
    const res = await syncTool({ id: "bx", localPath: dir, dest: "prog" }, (p) => progress.push(p.message));
    assert.equal(res.isError, false, res.content[0].text);
    assert.ok(progress.some((m) => /^sandbox_sync to \/work\/prog: asking the box which of 2 files differ$/.test(m)), progress.join("\n"));
  } finally {
    restoreExec();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox_pull：clean 把 localPath 換成箱子那份；寫成 dest 也收；下載連結被拒就重拿一次", async () => {
  const dir = mkdtempSync(join(tmpdir(), "psbx-pull-clean-"));
  try {
    mkdirSync(join(dir, "box", "shots"), { recursive: true });
    writeFileSync(join(dir, "box", "shots", "a.png"), "a");
    writeFileSync(join(dir, "box", "shots", "b.png"), "b");
    const archive = execFileSync("tar", ["-czf", "-", "-C", join(dir, "box"), "shots"]);
    downloads.set("/files/shots.tgz", [{ status: 403 }, { status: 200, body: archive }]);
    let gets = 0;
    setBoxGetForTest(async (args) => {
      gets++;
      assert.equal(args.path, "shots");
      return { content: [{ type: "text", text: JSON.stringify({ url: apiURL("/files/shots.tgz"), archive: true, bytes: archive.length, ...(gets === 2 ? { changedWhileReading: ["shots/b.png"] } : {}) }) }] };
    });
    const local = join(dir, "local");
    mkdirSync(local);
    writeFileSync(join(local, "old.png"), "old");
    const out = parsed(await pullTool({ id: "bx", path: "/work/shots", dest: local, clean: true }));
    assert.equal(gets, 2, "被拒之後要再拿一條新的");
    assert.deepEqual(readdirSync(local).sort(), ["a.png", "b.png"]);
    assert.equal(out.removed, 1);
    assert.deepEqual(out.removedPaths, ["old.png"]);
    assert.deepEqual(out.changedWhileReading, ["shots/b.png"]);
    assert.ok(out.notes.some((n) => /first download link was refused \(HTTP 403\)/.test(n)));
    assert.ok(out.notes.some((n) => /changed on the box while it was being packed/.test(n)));
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes("psbx-pull")), [], "暫存資料夾要收掉");

    mkdirSync(join(dir, "repo", ".git"), { recursive: true });
    const bad = await pullTool({ id: "bx", path: "shots", localPath: join(dir, "repo"), clean: true });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /git checkout/);
    assert.equal(gets, 2, "拒絕 clean 時什麼都不拿");
    assert.match((await pullTool({ id: "bx", path: "shots" })).content[0].text, /localPath .*not dest/);

    downloads.set("/files/empty.log", [{ status: 200, body: "" }]);
    setBoxGetForTest(async () => ({ content: [{ type: "text", text: JSON.stringify({ url: apiURL("/files/empty.log"), archive: false, bytes: 0 }) }] }));
    const file = parsed(await pullTool({ id: "bx", path: "build.log", localPath: join(dir, "logs", "build.log") }));
    assert.equal(file.files, 1);
    assert.equal(readFileSync(join(dir, "logs", "build.log"), "utf8"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
