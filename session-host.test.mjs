import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { captureNativeProfile, SessionHost } from "./session-host.mjs";
import { sessionRequest } from "./session-bridge.mjs";

async function configuration(label) {
  const parent = path.join(os.tmpdir(), "cubelv-e2e");
  await fs.mkdir(parent, { recursive: true });
  const stateDir = await fs.mkdtemp(path.join(parent, `session-${label}-`));
  return { provider: "claude-code", stateDir, cwd: stateDir,
    cliPath: process.env.PSBX_REAL_CLAUDE_CLI || "/not-spawned-in-negative-contract",
    socketPath: path.join(stateDir, "host.sock"), token: randomBytes(32).toString("hex"),
    agentId: randomBytes(12).toString("base64url"),
    adapterPath: fileURLToPath(new URL("./index.mjs", import.meta.url)),
    apiUrl: process.env.PARALLELSANDBOX_API_URL || "https://api.parallelsandbox.com",
    mcpUrl: process.env.PARALLELSANDBOX_MCP_URL || "https://mcp.parallelsandbox.com/mcp" };
}

async function stop(host) {
  if (host?.http?.listening) await host.stop();
  else { host?.controller.abort(); await host?.loop; }
}

// These three failure contracts use real Unix sockets and durable state, with
// no native response fixtures. A held busy flag models the negative case where
// the existing native writer has not finished; it is not an E2E success claim.
test("accepted queued prompt survives supervisor reconstruction", async () => {
  const config = await configuration("queued");
  const host = new SessionHost(config);
  try {
    await host.start();
    host.busy = true;
    const accepted = await sessionRequest(config.socketPath, config.token, "/send", { prompt: "accepted-before-crash-734b" });
    assert.equal(accepted.queued, true);
    await stop(host);
    const reconstructed = new SessionHost(config);
    assert.ok(reconstructed.queue.some((item) => item.id === accepted.id && item.prompt === "accepted-before-crash-734b"),
      "a 200 accepted user prompt disappeared from durable state");
  } finally { await stop(host); await fs.rm(config.stateDir, { recursive: true, force: true }); }
});

test("rejected second supervisor cannot mutate the running owner's delivery", async () => {
  const config = await configuration("writer");
  const childCode = `import{pathToFileURL}from'node:url';
    const{SessionHost}=await import(pathToFileURL(process.argv[1]));
    const host=new SessionHost(JSON.parse(process.argv[2]));
    process.send({kind:'constructed'});
    process.on('message',async(message)=>{
      if(message==='start')try{await host.start();host.busy=true;process.send({kind:'started',pid:process.pid});}
      catch(error){process.send({kind:'rejected',error:error.message});}
      if(message==='stop'){host.controller.abort();await host.loop;if(host.http?.listening)await host.stop();process.exit(0);}
    });`;
  function construct() {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childCode,
      fileURLToPath(new URL("./session-host.mjs", import.meta.url)), JSON.stringify(config)],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr.on("data", (part) => { stderr += part; });
    child.message = () => new Promise((resolve, reject) => {
      const onMessage = (message) => { clearTimeout(timer); child.off("error", onError); resolve(message); };
      const onError = (error) => { clearTimeout(timer); child.off("message", onMessage); reject(error); };
      const timer = setTimeout(() => { child.off("message", onMessage); reject(new Error(`host child timed out: ${stderr}`)); }, 5_000);
      child.once("message", onMessage); child.once("error", onError);
    });
    return child;
  }
  let first;
  let second;
  try {
    // Both real processes cache the unowned state before either has started.
    first = construct(); assert.equal((await first.message()).kind, "constructed");
    second = construct(); assert.equal((await second.message()).kind, "constructed");
    const ready = first.message(); first.send("start");
    assert.equal((await ready).kind, "started");
    const before = JSON.parse(await fs.readFile(path.join(config.stateDir, "state.json"), "utf8"));
    const later = second.message(); second.send("start");
    const response = await later;
    assert.equal(response.kind, "rejected", "a second real process deleted the live owner's socket and started from cached state");
    const persisted = JSON.parse(await fs.readFile(path.join(config.stateDir, "state.json"), "utf8"));
    assert.equal(persisted.pid, before.pid, "a rejected second host rewrote the active owner");
  } finally {
    for (const child of [second, first]) {
      if (!child || child.exitCode !== null) continue;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.send("stop"); await exited;
    }
    await fs.rm(config.stateDir, { recursive: true, force: true });
  }
});

test("an idle supervisor can recover a Unix socket left by a dead process", async () => {
  const config = await configuration("stale");
  let dead;
  let host;
  try {
    dead = spawn(process.execPath, ["--input-type=module", "-e",
      "import{createServer}from'node:http';createServer().listen(process.argv[1],()=>console.log('READY'));", config.socketPath],
    { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      dead.stdout.once("data", resolve); dead.once("error", reject);
      dead.once("exit", (code) => reject(new Error(`socket fixture exited before ready: ${code}`)));
    });
    const exited = new Promise((resolve) => dead.once("exit", resolve));
    dead.kill("SIGKILL");
    await exited;
    assert.equal((await fs.stat(config.socketPath)).isSocket(), true);
    host = new SessionHost(config);
    await host.start();
    const state = await sessionRequest(config.socketPath, config.token, "/status");
    assert.equal(state.status, "idle");
  } finally { dead?.kill("SIGKILL"); await stop(host); await fs.rm(config.stateDir, { recursive: true, force: true }); }
});

test("recovery preserves an interrupted accepted message as explicitly retryable uncertainty", async () => {
  const config = await configuration("interrupted-input");
  let host = new SessionHost(config);
  try {
    await host.start();
    host.busy = true;
    const sessionId = "4ad3d671-22d9-4808-a26f-a357b0bb5520";
    host.state.sessionId = sessionId;
    // Negative durable crash state: no fake success or provider response.
    host.state.queue.push({ id: "accepted-interrupted-input", prompt: "原對話已接受的工作", status: "running", turnId: "interrupted-native-turn" });
    host.state.turns.push({ id: "interrupted-native-turn", messageId: "accepted-interrupted-input", sessionId, status: "running", pid: 2_147_483_600 });
    host.persist();
    await stop(host);
    host = new SessionHost(config);
    await host.start();
    const state = await sessionRequest(config.socketPath, config.token, "/status");
    const message = state.queue.find((item) => item.id === "accepted-interrupted-input");
    assert.equal(message?.status, "uncertain", "an interrupted accepted message remained running with no writer or recovery path");
    assert.equal(state.sessionId, sessionId);
    assert.equal(host.child, null, "unknown prior execution must not be replayed automatically");
  } finally { await stop(host); await fs.rm(config.stateDir, { recursive: true, force: true }); }
});

test("saved native profile survives recovery shell changes without persisting credentials", async () => {
  assert.equal(captureNativeProfile("codex", {}).PSBX_CODEX_ALLOWED_MCP_TOOLS, "sandbox_report,sandbox_review,sandbox_status");
  assert.equal(captureNativeProfile("codex", {PSBX_CODEX_ALLOWED_MCP_TOOLS: ""}).PSBX_CODEX_ALLOWED_MCP_TOOLS, "");
  assert.equal(captureNativeProfile("codex", {PSBX_CODEX_ALLOWED_MCP_TOOLS: "sandbox_report"}).PSBX_CODEX_ALLOWED_MCP_TOOLS, "sandbox_report");
  for (const baseURL of ["https://user:password@example.test", "https://example.test?key=private", "https://example.test#private"]) {
    assert.throws(() => captureNativeProfile("gemini", {GOOGLE_GEMINI_BASE_URL: baseURL}), /without credentials, query or fragment/);
    assert.throws(() => captureNativeProfile("claude-code", {ANTHROPIC_BASE_URL: baseURL}), /without credentials, query or fragment/);
  }
  const config = await configuration("profile");
  config.nativeProfile = captureNativeProfile("claude-code", {
    PSBX_CLAUDE_MODEL: "haiku", PSBX_CLAUDE_ALLOWED_TOOLS: "Read,Write,Edit",
    ANTHROPIC_API_KEY: "credential-must-not-persist", PARALLELSANDBOX_API_KEY: "another-private-credential",
    PSBX_SESSION_TOKEN: "session-secret-must-not-enter-native-profile",
  });
  let host = new SessionHost(config);
  try {
    await host.start();
    const sessionId = "4ad3d671-22d9-4808-a26f-a357b0bb5520";
    host.state.sessionId = sessionId;
    host.persist();
    await stop(host);
    const recoveryConfig = {...config, nativeProfile: captureNativeProfile("claude-code", {
      PSBX_CLAUDE_MODEL: "sonnet", PSBX_CLAUDE_ALLOWED_TOOLS: "mcp__parallelsandbox__sandbox_report",
    })};
    host = new SessionHost(recoveryConfig);
    await host.start();
    const recovered = await sessionRequest(config.socketPath, config.token, "/status");
    assert.deepEqual(recovered.nativeProfile, {PSBX_CLAUDE_MODEL: "haiku", PSBX_CLAUDE_ALLOWED_TOOLS: "Read,Write,Edit", PSBX_CLAUDE_BASE_URL: ""});
    assert.equal(recovered.sessionId, sessionId);
    assert.equal(JSON.stringify(recovered).includes("credential-must-not-persist"), false);
    assert.equal(JSON.stringify(recovered.nativeProfile).includes("PSBX_SESSION_TOKEN"), false);
    assert.deepEqual(captureNativeProfile("gemini", {
      GEMINI_MODEL: "gemini-selected-model", GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:4401", GEMINI_CLI_TRUST_WORKSPACE: "true",
      GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: "project-selected", GOOGLE_CLOUD_LOCATION: "region-selected", GEMINI_API_KEY: "private",
    }), {PSBX_GEMINI_MODEL: "gemini-selected-model", PSBX_GEMINI_APPROVAL_MODE: "",
      PSBX_GEMINI_BASE_URL: "http://127.0.0.1:4401", PSBX_GEMINI_TRUST_WORKSPACE: "true",
      PSBX_GEMINI_VERTEX_AI: "true", PSBX_GEMINI_PROJECT: "project-selected", PSBX_GEMINI_LOCATION: "region-selected"});
  } finally { await stop(host); await fs.rm(config.stateDir, {recursive: true, force: true}); }
});

test("first native init reconciliation rejects conflicting session identities", async () => {
  for (const mode of ["multiple native IDs", "saved session mismatch", "saved turn mismatch"]) {
    const config = await configuration("conflicting-init");
    let host = new SessionHost(config);
    try {
      await host.start();
      const firstID = "4ad3d671-22d9-4808-a26f-a357b0bb5520";
      const otherID = "60d05442-6e24-4358-bf0a-0afca37f4904";
      host.state.sessionId = mode === "saved session mismatch" ? otherID : "";
      host.state.turns.push({id: "interrupted-first-init", sessionId: mode === "saved turn mismatch" ? otherID : "", status: "running", pid: 2_147_483_600});
      // Synthetic negative identity records only; never an E2E success claim.
      const init = {type: "system", subtype: "init", session_id: firstID};
      await fs.writeFile(path.join(config.stateDir, "native-interrupted-first-init.jsonl"), JSON.stringify(init) + "\n" +
        (mode === "multiple native IDs" ? JSON.stringify({...init, session_id: otherID}) + "\n" : ""));
      host.persist();
      await host.stop();
      host = new SessionHost(config);
      await assert.rejects(host.start(), /conflicts with the original session identity/);
      assert.equal(host.child, null);
    } finally { await stop(host); await fs.rm(config.stateDir, {recursive: true, force: true}); }
  }
});

test("unknown first native session refuses retry and queued replacement writers", async () => {
  const config = await configuration("unproven-init");
  let host = new SessionHost(config);
  try {
    await host.start();
    host.state.turns.push({id: "unknown-first-native-turn", messageId: "original-input", sessionId: "", status: "running", pid: 2_147_483_600});
    host.state.queue.push({id: "original-input", prompt: "原對話需求", status: "running", turnId: "unknown-first-native-turn"});
    host.state.queue.push({id: "already-accepted-next-input", prompt: "稍後補充", status: "queued"});
    host.persist();
    await host.stop();
    host = new SessionHost(config);
    await host.start();
    await assert.rejects(sessionRequest(config.socketPath, config.token, "/retry", {messageId: "original-input"}), /replacement conversation/);
    await assert.rejects(sessionRequest(config.socketPath, config.token, "/send", {prompt: "不可改送別個對話"}), /proven session ID/);
    for (let i = 0; i < 20 && host.queue.find((item) => item.id === "already-accepted-next-input").status !== "uncertain"; i++) await delay(25);
    assert.equal(host.state.sessionId, "");
    assert.equal(host.state.turns.length, 1, "an unknown first session started a replacement native turn");
    assert.equal(host.child, null);
    assert.equal(host.queue.find((item) => item.id === "already-accepted-next-input").status, "uncertain");
  } finally { await stop(host); await fs.rm(config.stateDir, {recursive: true, force: true}); }
});

test("an ENOENT attempt with no native PID can retry first initialization", async () => {
  const config = await configuration("no-writer-spawned");
  config.cliPath = "/not-installed-native-cli-ENOENT";
  const host = new SessionHost(config);
  try {
    await host.start();
    const accepted = await sessionRequest(config.socketPath, config.token, "/send", {prompt: "尚未啟動原生 CLI 的第一則需求"});
    for (let i = 0; i < 80 && host.queue.find((item) => item.id === accepted.id).status !== "failed"; i++) await delay(25);
    const message = host.queue.find((item) => item.id === accepted.id);
    const turn = host.state.turns.find((item) => item.id === message.turnId);
    assert.equal(message.status, "failed");
    assert.match(turn.error, /ENOENT/);
    assert.equal(turn.pid, undefined);
    assert.equal(host.state.sessionId, "");
    const retried = await sessionRequest(config.socketPath, config.token, "/retry", {messageId: accepted.id});
    assert.equal(retried.retryQueued, true);
  } finally { await stop(host); await fs.rm(config.stateDir, {recursive: true, force: true}); }
});

test("managed drivers isolate legacy feedback ownership from native and MCP environments", async () => {
  const previousHost = process.env.PSBX_FEEDBACK_HOST;
  process.env.PSBX_FEEDBACK_HOST = "claude-code";
  try {
    for (const provider of ["claude-code", "codex", "gemini"]) {
      const config = await configuration(`legacy-owner-${provider}`);
      config.provider = provider;
      config.cliPath = "/not-installed-native-cli-ENOENT";
      const host = new SessionHost(config);
      try {
        await host.start();
        const nativeDriver = host.driver;
        let checked = false;
        host.driver = {...nativeDriver, async buildInvocation(input) {
          assert.equal(Object.hasOwn(input.env, "PSBX_FEEDBACK_HOST"), false);
          assert.equal(Object.hasOwn(input.mcp.env, "PSBX_FEEDBACK_HOST"), false);
          assert.equal(input.mcp.env.PSBX_SESSION_AGENT_ID, config.agentId);
          const invocation = await nativeDriver.buildInvocation(input);
          assert.equal(Object.hasOwn(invocation.env, "PSBX_FEEDBACK_HOST"), false,
            "a native driver reintroduced the legacy feedback owner");
          checked = true;
          return invocation;
        }};
        // Real driver configuration, then an intentional missing CLI. No fake
        // native response or successful App delivery is used in this contract.
        const turn = await host.runTurn("check legacy owner isolation");
        assert.equal(checked, true);
        assert.equal(turn.status, "failed");
        assert.match(turn.error, /ENOENT/);
        assert.equal(process.env.PSBX_FEEDBACK_HOST, "claude-code",
          "managed isolation changed the ordinary client's launch environment");
      } finally { await stop(host); await fs.rm(config.stateDir, {recursive: true, force: true}); }
    }
  } finally {
    if (previousHost === undefined) delete process.env.PSBX_FEEDBACK_HOST;
    else process.env.PSBX_FEEDBACK_HOST = previousHost;
  }
});

test("adapter still rejects two explicit feedback owners for one managed session", async () => {
  const config = await configuration("dual-owner");
  try {
    const child = spawn(process.execPath, [config.adapterPath], {env: {...process.env,
      PSBX_ADAPTER_NO_CONNECT: "1", PSBX_FEEDBACK_HOST: "claude-code",
      PSBX_SESSION_SOCKET: config.socketPath, PSBX_SESSION_TOKEN: config.token,
      PSBX_SESSION_AGENT_ID: config.agentId, PSBX_SESSION_GENERATION: randomBytes(16).toString("hex")},
      stdio: ["ignore", "pipe", "pipe"]});
    let stderr = "";
    child.stderr.on("data", (part) => { stderr += part; });
    const code = await new Promise((resolve, reject) => {child.once("error", reject); child.once("close", resolve);});
    assert.notEqual(code, 0);
    assert.match(stderr, /A managed session must have one feedback owner/);
  } finally { await fs.rm(config.stateDir, {recursive: true, force: true}); }
});

test("supervisor presence lasts while idle and leaves only when its writer has exited", async () => {
  const config = await configuration("presence");
  const requests = [];
  // Local presence-only contract endpoint, not a native or App E2E fixture.
  const api = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({path: req.url, agent: req.headers["x-psbx-agent"], body: JSON.parse(raw), writerExited: host.child === null});
    res.writeHead(200, {"content-type": "application/json"});
    res.end("{}");
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  config.apiUrl = `http://127.0.0.1:${api.address().port}`;
  // This negative contract uses only its local REST endpoint. Explicit fixture
  // auth prevents an ambient OAuth login from swallowing the heartbeat.
  const previousKey = process.env.PARALLELSANDBOX_API_KEY;
  let host;
  try {
    process.env.PARALLELSANDBOX_API_KEY = "presence-contract-local-only";
    host = new SessionHost(config);
  } finally {
    if (previousKey === undefined) delete process.env.PARALLELSANDBOX_API_KEY;
    else process.env.PARALLELSANDBOX_API_KEY = previousKey;
  }
  try {
    await host.start();
    await host.presenceFlight;
    assert.equal(requests[0].path, `/v1/agents/${config.agentId}/heartbeat`);
    assert.equal(requests[0].agent, config.agentId);
    assert.equal(requests[0].body.client, "claude-code");
    assert.equal(host.state.status, "idle");
    assert.ok(host.presenceTimer, "idle session lost its supervisor presence timer");
    assert.equal(requests.some((req) => req.path.endsWith("/leave")), false);
    // Negative lifecycle contract: a real child process must close before leave.
    host.child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {stdio: "ignore"});
    const writer = host.child;
    const currentLoop = host.loop;
    host.loop = Promise.all([currentLoop, new Promise((resolve) => writer.once("close", () => {host.child = null; resolve();}))]);
    await host.stop();
    assert.equal(requests.at(-1).path, `/v1/agents/${config.agentId}/leave`);
    assert.equal(requests.at(-1).writerExited, true);
    assert.equal(host.presenceTimer, null);
  } finally {
    await stop(host);
    await new Promise((resolve) => api.close(resolve));
    await fs.rm(config.stateDir, {recursive: true, force: true});
  }
});

test("real Claude supervisor closes first writer and resumes the exact native session", {
  skip: !process.env.PSBX_REAL_CLAUDE_CLI || !process.env.ANTHROPIC_API_KEY,
  timeout: 90_000,
}, async () => {
  const config = await configuration("native-claude");
  let host = new SessionHost(config);
  async function waitTurn(id) {
    for (let i = 0; i < 260; i++) {
      const state = await sessionRequest(config.socketPath, config.token, "/status");
      const turn = state.turns.find((turn) => turn.inputId === id) || state.turns.at(-1);
      if (turn && !["queued", "running"].includes(turn.status)) return { state, turn };
      await delay(150);
    }
    throw new Error("real native Claude supervisor turn did not finish");
  }
  try {
    await host.start();
    const accepted = await sessionRequest(config.socketPath, config.token, "/send", {
      prompt: "這是 ETF 需求的原對話接續測試。這輪要檢查的 ETF 依序是 00888 與 00712，配息日欄位使用 YYYY/MM/DD。請用一行摘要這兩個代碼、欄位與日期格式。" });
    const first = await waitTurn(accepted.id);
    assert.equal(first.turn.status, "completed", first.turn.error);
    assert.match(first.turn.output, /00888/);
    assert.match(first.turn.output, /00712/);
    assert.match(first.turn.output, /YYYY\/MM\/DD/);
    assert.equal(host.child, null, "first native writer must have exited before second starts");
    const next = await sessionRequest(config.socketPath, config.token, "/send", {
      prompt: "延續剛剛的 ETF 需求，用相同順序再說一次那兩個 ETF 代碼、欄位與我們約定的日期格式。" });
    // Waiting for the previous turn here would falsely pass; require a new turn.
    while (host.state.turns.length < 2) await delay(25);
    const resumed = await waitTurn(next.id);
    assert.equal(resumed.turn.status, "completed", resumed.turn.error);
    assert.equal(resumed.state.sessionId, first.state.sessionId);
    assert.equal(resumed.turn.sessionId, first.turn.sessionId);
    assert.notEqual(resumed.turn.pid, first.turn.pid);
    assert.match(resumed.turn.output, /00888/);
    assert.match(resumed.turn.output, /00712/);
    assert.match(resumed.turn.output, /YYYY\/MM\/DD/);
    await fs.writeFile(path.join(config.stateDir, "native-proof.json"), JSON.stringify({
      sessionId: first.state.sessionId, first: first.turn, resumed: resumed.turn,
      oneWriterAtATime: true, source: "real Anthropic API and official native CLI; no App feedback submission in this test",
    }, null, 2));
    console.log(`native Claude supervisor evidence: ${config.stateDir}`);
  } finally { await stop(host); }
});

test("real Claude resumes and edits a scratch file with explicit Read Write Edit permission", {
  skip: !process.env.PSBX_REAL_CLAUDE_CLI || !process.env.ANTHROPIC_API_KEY ||
    process.env.PSBX_REAL_CLAUDE_EDIT_PROBE !== "1",
  timeout: 90_000,
}, async () => {
  assert.equal(process.env.PSBX_CLAUDE_ALLOWED_TOOLS, "Read,Write,Edit");
  const config = await configuration("native-claude-edits");
  let host = new SessionHost(config);
  const requestedFile = path.join(config.cwd, "etf-requirements.md");
  async function waitMessage(id) {
    for (let i = 0; i < 350; i++) {
      const state = await sessionRequest(config.socketPath, config.token, "/status");
      const message = state.queue.find((item) => item.id === id);
      const turn = state.turns.find((item) => item.id === message?.turnId);
      if (turn && !["queued", "running"].includes(turn.status)) return { state, turn };
      await delay(150);
    }
    throw new Error("real native Claude scratch edit did not finish");
  }
  async function nativeEvidence(turn) {
    const events = (await fs.readFile(path.join(config.stateDir, `native-${turn.id}.jsonl`), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const result = events.find((event) => event.type === "result");
    assert.equal(result?.subtype, "success");
    assert.equal(result?.is_error, false);
    assert.deepEqual(result.permission_denials, []);
    assert.equal(result.session_id, turn.sessionId);
    const toolNames = events.flatMap((event) => event.message?.content || [])
      .filter((block) => block.type === "tool_use").map((block) => block.name);
    return { result: { sessionId: result.session_id, model: result.modelUsage,
      initModel: events.find((event) => event.type === "system" && event.subtype === "init")?.model,
      permissionDenials: result.permission_denials }, toolNames };
  }
  try {
    await host.start();
    const accepted = await sessionRequest(config.socketPath, config.token, "/send", {
      prompt: "請在目前工作目錄建立 etf-requirements.md，實際使用 Write 工具寫入以下四行，不執行 Bash：\n# ETF 篩選器需求\nETF：00888、00712\n配息日：待確認\n走勢期間：1 年\n完成後簡短回報。" });
    const first = await waitMessage(accepted.id);
    assert.equal(first.turn.status, "completed", first.turn.error);
    const before = await fs.readFile(requestedFile, "utf8");
    assert.match(before, /ETF：00888、00712/);
    assert.match(before, /配息日：待確認/);
    assert.match(before, /走勢期間：1 年/);
    const firstEvidence = await nativeEvidence(first.turn);
    assert.ok(firstEvidence.toolNames.includes("Write"));
    assert.equal(host.child, null, "first native writer must exit before resuming");
    await fs.writeFile(path.join(config.stateDir, "config.json"), JSON.stringify(config), {mode: 0o600});
    const recoveryCLI = spawn(process.execPath, [fileURLToPath(new URL("./feedback-agent.mjs", import.meta.url)),
      "recover", "--session", config.stateDir], {env: process.env, stdio: ["ignore", "pipe", "pipe"]});
    let recoveredStdout = "";
    let recoveredStderr = "";
    recoveryCLI.stdout.on("data", (part) => { recoveredStdout += part; });
    recoveryCLI.stderr.on("data", (part) => { recoveredStderr += part; });
    const rejectedExit = await new Promise((resolve) => recoveryCLI.once("close", resolve));
    assert.equal(rejectedExit, 1);
    assert.equal(recoveredStdout.includes('"recovered":true'), false);
    assert.match(recoveredStderr, /original supervisor is still available/);
    assert.equal((await sessionRequest(config.socketPath, config.token, "/status")).sessionId, first.turn.sessionId);
    // Simulate only the state-not-flushed boundary. The init/result log below
    // came from the official CLI and real API; this is not an actual kill window.
    host.state.sessionId = "";
    const unflushedTurn = host.state.turns.find((item) => item.id === first.turn.id);
    unflushedTurn.sessionId = "";
    unflushedTurn.status = "running";
    host.queue.find((item) => item.id === accepted.id).status = "running";
    host.persist();
    await host.stop();
    host = new SessionHost({...config, nativeProfile: {
      PSBX_CLAUDE_MODEL: "invalid-model-recovery-sentinel", PSBX_CLAUDE_ALLOWED_TOOLS: "mcp__parallelsandbox__sandbox_report",
    }});
    await host.start();
    assert.equal(host.state.sessionId, first.turn.sessionId);
    assert.equal(host.state.nativeProfile.PSBX_CLAUDE_MODEL, process.env.PSBX_CLAUDE_MODEL);
    assert.equal(host.state.nativeProfile.PSBX_CLAUDE_ALLOWED_TOOLS, "Read,Write,Edit");
    const resumedInput = await sessionRequest(config.socketPath, config.token, "/send", {
      prompt: "延續剛才建立的 ETF 需求檔，收到新需求：配息日欄位使用 YYYY/MM/DD，走勢期間改成 10 年。請實際使用 Read 讀取 etf-requirements.md，再用 Edit 更新這兩行，保留原來兩個 ETF 代碼。不執行 Bash。" });
    const resumed = await waitMessage(resumedInput.id);
    assert.equal(resumed.turn.status, "completed", resumed.turn.error);
    assert.equal(resumed.turn.sessionId, first.turn.sessionId);
    assert.notEqual(resumed.turn.pid, first.turn.pid);
    const after = await fs.readFile(requestedFile, "utf8");
    assert.match(after, /ETF：00888、00712/);
    assert.match(after, /配息日：YYYY\/MM\/DD/);
    assert.match(after, /走勢期間：10 年/);
    const resumedEvidence = await nativeEvidence(resumed.turn);
    assert.equal(resumedEvidence.result.initModel, firstEvidence.result.initModel);
    assert.ok(resumedEvidence.toolNames.includes("Read"));
    assert.ok(resumedEvidence.toolNames.includes("Edit"));
    assert.equal([...firstEvidence.toolNames, ...resumedEvidence.toolNames].includes("Bash"), false);
    await fs.writeFile(path.join(config.stateDir, "native-edit-proof.json"), JSON.stringify({
      sessionId: first.turn.sessionId, requestedFile, before, after,
      first: { ...first.turn, nativeEvidence: firstEvidence },
      resumed: { ...resumed.turn, nativeEvidence: resumedEvidence },
      oneWriterAtATime: true,
      recoveredFromUnflushedFirstInit: true,
      source: "real Anthropic API and official native CLI; state-not-flushed boundary simulated without a real kill window; actual same-session Read/Edit; no App submission",
    }, null, 2));
    console.log(`native Claude same-session file-edit evidence: ${config.stateDir}`);
  } finally { await stop(host); }
});

test("real Claude permission denial stays visible after native-result recovery", {
  skip: !process.env.PSBX_REAL_CLAUDE_CLI || !process.env.ANTHROPIC_API_KEY ||
    process.env.PSBX_REAL_CLAUDE_DENIAL_PROBE !== "1",
  timeout: 90_000,
}, async () => {
  const config = await configuration("native-claude-denial");
  config.nativeProfile = captureNativeProfile("claude-code", {PSBX_CLAUDE_MODEL: process.env.PSBX_CLAUDE_MODEL});
  let host = new SessionHost(config);
  try {
    await host.start();
    const accepted = await sessionRequest(config.socketPath, config.token, "/send", {
      prompt: "請實際使用 Write 工具在目前工作目錄建立 etf-requirements.md，內容一行：ETF：00888、00712。不要執行 Bash。若原生權限拒絕 Write，直接如實回報，不要改用其他工具。" });
    let state;
    let turn;
    for (let i = 0; i < 350; i++) {
      state = await sessionRequest(config.socketPath, config.token, "/status");
      turn = state.turns.find((item) => item.messageId === accepted.id);
      if (turn && !["queued", "running"].includes(turn.status)) break;
      await delay(150);
    }
    assert.equal(turn?.status, "completed", turn?.error);
    assert.ok(turn.permissionDenials.some((denial) => denial.tool_name === "Write"), "actual native Write denial was hidden from status");
    assert.equal(await fs.stat(path.join(config.cwd, "etf-requirements.md")).then(() => true, () => false), false);
    const nativeDenials = turn.permissionDenials;
    const originalSession = turn.sessionId;
    // Genuine native output is durable. Simulate a crash before its final state
    // update, rather than fabricating provider success or permission denials.
    const durableTurn = host.state.turns.find((item) => item.id === turn.id);
    durableTurn.status = "running";
    delete durableTurn.permissionDenials;
    host.state.queue.find((item) => item.id === accepted.id).status = "running";
    host.persist();
    await host.stop();
    host = new SessionHost(config);
    await host.start();
    state = await sessionRequest(config.socketPath, config.token, "/status");
    const recovered = state.turns.find((item) => item.id === turn.id);
    assert.equal(state.sessionId, originalSession);
    assert.deepEqual(recovered.permissionDenials, nativeDenials);
    assert.equal(recovered.status, "completed"); // Native completion does not mean the requested write happened.
    await fs.writeFile(path.join(config.stateDir, "native-denial-proof.json"), JSON.stringify({
      sessionId: originalSession, original: turn, recovered,
      requestedFileExists: false, source: "official CLI and real Anthropic API; denied write is not completed work",
    }, null, 2));
    console.log(`native Claude permission denial and recovery evidence: ${config.stateDir}`);
  } finally { await stop(host); }
});
