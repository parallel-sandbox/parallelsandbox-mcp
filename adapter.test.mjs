// 同步挑檔的規則錯了就是「箱子裡少東西」或「上傳幾 GB」，兩種都很難查，所以這幾個純函式要有測試。
import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 假的 control：只記下 adapter 打來的請求（心跳、離開）。
const seen = [];
const api = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
api.unref();

// import 會在檔案最上面的賦值之前就執行，所以環境變數要在動態載入前設好。
process.env.PSBX_ADAPTER_NO_CONNECT = "1";
process.env.PARALLELSANDBOX_API_KEY = process.env.PARALLELSANDBOX_API_KEY || "test-key";
process.env.PARALLELSANDBOX_API_URL = `http://127.0.0.1:${api.address().port}`;
const { AGENT_ID, archiveCommit, baselineDest, copyInto, gitFileList, ignoredTopLevel, presence, repoName, syncTool } = await import("./index.mjs");

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
    assert.deepEqual(ignoredTopLevel(dir), { skipped: ["dist"], partiallyIgnored: [] });
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
    const name = msg.params?.name;
    const call = { name, closed: false };
    mcpCalls.push(call);
    req.socket.on("close", () => (call.closed = true));
    // control 的 keepAlive：20 秒後把回應升級成 SSE，之後定時送一則 still running。
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const event = (m) => res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
    const ping = () => event({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: `${name} still running` } });
    const done = () => event(reply({ content: [{ type: "text", text: `${name} done` }] }));
    ping();
    const tries = mcpCalls.filter((c) => c.name === name).length;
    if (name === "ends_early" || (name === "sandbox_status" && tries === 1)) {
      res.end(); // 串流結束了，結果沒來
    } else if (name === "goes_silent") {
      hanging.add(res); // 連線還在，一個位元組都不再來
    } else {
      let n = 0;
      const t = setInterval(() => {
        if (++n < 6) return ping();
        clearInterval(t);
        done();
        res.end();
      }, 200);
    }
  });
});
await new Promise((r) => mcp.listen(0, "127.0.0.1", r));
mcp.unref();

async function adapterClient() {
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

test("只讀的工具結果弄丟了就自己重試一次", async () => {
  const client = await adapterClient();
  try {
    const out = await client.callTool({ name: "sandbox_status", arguments: {} });
    assert.equal(out.content[0].text, "sandbox_status done");
    assert.equal(mcpCalls.filter((c) => c.name === "sandbox_status").length, 2);
  } finally {
    await client.close();
  }
});
