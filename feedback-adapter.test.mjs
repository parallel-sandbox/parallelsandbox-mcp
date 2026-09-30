// Protocol integration unit tests. The HTTP service below is a fixture, not an
// end-to-end proof that Claude or Codex received a real report.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function adapterFixture(host, env = {}) {
  const requests = [];
  const api = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({url: req.url, body});
    if (req.url !== "/mcp") {
      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({ok: true, events: []}));
      return;
    }
    if (!Object.hasOwn(body, "id")) {
      res.writeHead(202); res.end(); return;
    }
    const result = body.method === "initialize"
      ? {protocolVersion: body.params.protocolVersion, capabilities: {tools: {}}, serverInfo: {name: "unit-control", version: "1"}}
      : body.method === "tools/list"
      ? {tools: [{name: "sandbox_review", description: "Unit fixture", inputSchema: {type: "object", properties: {}}}]}
      : {content: [{type: "text", text: JSON.stringify({ok: true, reviewId: "unit-review", outcome: "timed_out"})}]};
    res.writeHead(200, {"Content-Type": "application/json"});
    res.end(JSON.stringify({jsonrpc: "2.0", id: body.id, result}));
  });
  await new Promise(resolve => api.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${api.address().port}`;
  const child = spawn(process.execPath, ["index.mjs"], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    env: {...process.env, PARALLELSANDBOX_API_KEY: "unit-key", PARALLELSANDBOX_MCP_URL: `${base}/mcp`, PARALLELSANDBOX_API_URL: base,
      PSBX_ADAPTER_NO_CONNECT: "", PSBX_FEEDBACK_HOST: host || "", PSBX_CODEX_HOST_SOCKET: "", ...env},
    stdio: ["pipe", "pipe", "pipe"],
  });
  const replies = new Map();
  const notifications = [];
  let nextId = 1, buffer = "", stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  child.stdout.on("data", data => {
    buffer += data;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (Object.hasOwn(message, "id")) replies.get(message.id)?.(message);
      else notifications.push(message);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { replies.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); }, 5000);
    replies.set(id, reply => { clearTimeout(timer); replies.delete(id); reply.error ? reject(new Error(JSON.stringify(reply.error))) : resolve(reply.result); });
    child.stdin.write(JSON.stringify({jsonrpc: "2.0", id, method, params}) + "\n");
  });
  const close = async () => {
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), 1000);
    await exited;
    clearTimeout(timer);
    api.closeAllConnections();
    await new Promise(resolve => api.close(resolve));
  };
  try {
    const initialized = await call("initialize", {protocolVersion: "2025-03-26", capabilities: {}, clientInfo: {name: "unit-client", version: "1"}});
    child.stdin.write(JSON.stringify({jsonrpc: "2.0", method: "notifications/initialized"}) + "\n");
    return {initialized, call, close, requests, notifications};
  } catch (err) { await close(); throw err; }
}

test("ordinary MCP keeps the existing tool flow and does not enroll automatic feedback", async () => {
  const f = await adapterFixture();
  try {
    assert.equal(f.initialized.capabilities.experimental?.["claude/channel"], undefined);
    const list = await f.call("tools/list");
    assert.deepEqual(list.tools.map(t => t.name), ["sandbox_review"]);
    const result = await f.call("tools/call", {name: "sandbox_review", arguments: {id: "unit-box", what: "fixture"}});
    assert.equal(JSON.parse(result.content[0].text).reviewId, "unit-review");
    assert.equal(f.requests.some(r => r.url.startsWith("/v1/feedback-consumers")), false);
  } finally { await f.close(); }
});

test("declaring Claude channel support does not register a route before the native challenge is acknowledged", async () => {
  const f = await adapterFixture("claude-code");
  try {
    assert.ok(Object.hasOwn(f.initialized.capabilities.experimental || {}, "claude/channel"));
    const list = await f.call("tools/list");
    assert.ok(list.tools.some(t => t.name === "parallelsandbox_channel_ready"));
    await f.call("tools/call", {name: "sandbox_review", arguments: {id: "unit-box", what: "fixture"}});
    assert.equal(f.requests.some(r => r.url.startsWith("/v1/feedback-consumers")), false);
  } finally { await f.close(); }
});

test("Codex review carries an adapter binding token only in private MCP metadata", async () => {
  const parent = join(tmpdir(), "cubelv-e2e");
  await mkdir(parent, {recursive: true});
  const stateDir = await mkdtemp(join(parent, "feedback-adapter-"));
  const f = await adapterFixture("codex", {PSBX_CODEX_CLI: "/unit/codex", PSBX_CODEX_HOST_SOCKET: "/unit/socket", PSBX_CODEX_FEEDBACK_DIR: stateDir});
  try {
    const result = await f.call("tools/call", {name: "sandbox_review", arguments: {id: "unit-box", what: "fixture"}});
    const token = result._meta?.psbxCodexFeedback?.token;
    assert.match(token, /^[a-f0-9]{48}$/);
    assert.equal(JSON.stringify(result.content).includes(token), false);
    const files = await readdir(stateDir);
    const ticket = JSON.parse(await readFile(join(stateDir, files.find(name => name.endsWith(".ticket.json"))), "utf8"));
    assert.equal(ticket.token, token);
    assert.equal(f.requests.some(r => r.url.startsWith("/v1/feedback-consumers")), false);
  } finally { await f.close(); await rm(stateDir, {recursive: true, force: true}); }
});
