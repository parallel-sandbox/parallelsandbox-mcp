import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { LoginRequired, OAuthSession } from "./oauth.mjs";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "psbx-oauth-test-"));
  let base;
  let client;
  let challenge;
  let access = "access-1";
  let refresh = "refresh-1";
  let rejectAccess = false;
  let refreshFails = false;
  let rotates = 0;
  let registrations = 0;
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    seen.push({ url: req.url, auth: req.headers.authorization, body });
    const json = (status, data) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    if (req.url.startsWith("/.well-known/oauth-protected-resource")) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (req.url === "/.well-known/oauth-authorization-server") return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    if (req.url === "/register") {
      registrations++;
      client = JSON.parse(body);
      return json(201, { ...client, client_id: "client-1" });
    }
    if (req.url.startsWith("/authorize")) {
      const url = new URL(req.url, base);
      assert.equal(url.searchParams.get("resource"), `${base}/mcp`);
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      challenge = url.searchParams.get("code_challenge");
      const callback = new URL(url.searchParams.get("redirect_uri"));
      assert.equal(callback.href, client.redirect_uris[0]);
      callback.searchParams.set("state", url.searchParams.get("state"));
      callback.searchParams.set("code", "code-1");
      return res.writeHead(302, { Location: callback.href }).end();
    }
    if (req.url === "/token") {
      const form = new URLSearchParams(body.toString());
      assert.equal(form.get("client_id"), "client-1");
      assert.equal(form.get("resource"), `${base}/mcp`);
      if (form.get("grant_type") === "authorization_code") {
        assert.equal(form.get("code"), "code-1");
        assert.equal(form.get("redirect_uri"), client.redirect_uris[0]);
        assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"), challenge);
      } else {
        assert.equal(form.get("grant_type"), "refresh_token");
        if (form.get("refresh_token") !== refresh) return json(400, { error: "invalid_grant", error_description: "refresh replayed" });
        rotates++;
        access = `access-${rotates + 1}`;
        refresh = `refresh-${rotates + 1}`;
        rejectAccess = false;
        await delay(150); // Other processes observe a refresh in progress.
        if (refreshFails) return json(500, { error: "server_error" });
      }
      return json(200, { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 });
    }
    if (req.headers.authorization !== `Bearer ${access}` || rejectAccess) return json(401, { error: "invalid_token" });
    if (req.url === "/mcp") {
      if (req.method !== "POST") return res.writeHead(405).end();
      const msg = JSON.parse(body);
      if (msg.id === undefined) return res.writeHead(202).end();
      const reply = (result) => json(200, { jsonrpc: "2.0", id: msg.id, result });
      if (msg.method === "initialize") return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-control", version: "1" }, instructions: "Give boxes a goal." });
      if (msg.method === "tools/list") return reply({ tools: [{ name: "sandbox_list", description: "List boxes", inputSchema: { type: "object", properties: {} } }] });
      // sandbox_sync 先在箱子裡比對（adapter 自己打 sandbox_exec）：當成箱子裡還沒有這個 dest，整包送。
      if (msg.method === "tools/call" && msg.params?.name === "sandbox_exec") {
        return reply({ content: [{ type: "text", text: JSON.stringify({ exitCode: 0, stdout: '{"all":true,"fresh":true,"deps":[]}\n', stderr: "" }) }] });
      }
      if (msg.method === "tools/call") return reply({ content: [{ type: "text", text: "boxes listed" }] });
    }
    return json(200, { ok: true });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const session = new OAuthSession({ mcpUrl: `${base}/mcp`, directory, open: (url) => { fetch(url).catch(() => {}); } });
  return {
    base, directory, session, seen,
    get rotates() { return rotates; }, get registrations() { return registrations; },
    reject() { rejectAccess = true; }, failRefresh() { refreshFails = true; },
    expire() { const state = session.read(); state.expiresAt = 0; session.write(state); },
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("OAuth login uses PKCE, resource, state, a loopback callback and a private token file", async () => {
  const f = await fixture();
  try {
    await f.session.ensureLogin();
    assert.equal(await f.session.accessToken(), "access-1");
    assert.equal(statSync(f.session.file).mode & 0o777, 0o600);
    assert.equal(f.session.status(), undefined);
    assert.equal((await f.session.fetch(`${f.base}/api`)).status, 200);
    const other = new OAuthSession({ mcpUrl: `${f.base}/other`, directory: f.directory });
    assert.notEqual(other.file, f.session.file);
    await assert.rejects(other.accessToken(), LoginRequired);
  } finally { await f.close(); }
});

test("401 refreshes once, retries with the new token, and presence uses that token", async () => {
  const f = await fixture();
  try {
    await f.session.ensureLogin();
    f.reject();
    assert.equal((await f.session.fetch(`${f.base}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).status, 202);
    assert.equal(f.rotates, 1);
    assert.equal((await f.session.fetch(`${f.base}/v1/agents/a/heartbeat`, { method: "POST" })).status, 200);
    assert.equal(f.seen.at(-1).auth, "Bearer access-2");
  } finally { await f.close(); }
});

test("two adapters starting together open only one sign-in", async () => {
  const f = await fixture();
  try {
    const second = new OAuthSession({ mcpUrl: `${f.base}/mcp`, directory: f.directory, open: () => { throw new Error("A second browser must not open"); } });
    await Promise.all([f.session.ensureLogin(), second.ensureLogin()]);
    assert.equal(f.registrations, 1);
    assert.equal(await second.accessToken(), "access-1");
  } finally { await f.close(); }
});

test("concurrent processes share one sign-in and rotate a refresh token only once", async () => {
  const f = await fixture();
  try {
    await f.session.ensureLogin();
    f.expire();
    const code = `import { OAuthSession } from ${JSON.stringify(new URL("./oauth.mjs", import.meta.url).href)}; const s = new OAuthSession({mcpUrl: process.argv[1], directory: process.argv[2]}); console.log(await s.accessToken());`;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code, `${f.base}/mcp`, f.directory], { stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; let error = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { error += d; });
      child.on("error", reject);
      child.on("exit", (status) => status === 0 ? resolve(out.trim()) : reject(new Error(error)));
    });
    assert.deepEqual(await Promise.all([run(), run(), run()]), ["access-2", "access-2", "access-2"]);
    assert.equal(f.rotates, 1);
    assert.equal(f.registrations, 1);
  } finally { await f.close(); }
});

test("an uncertain or interrupted refresh is never replayed", async () => {
  const f = await fixture();
  try {
    await f.session.ensureLogin();
    f.expire();
    f.failRefresh();
    await assert.rejects(f.session.accessToken(), LoginRequired);
    await assert.rejects(f.session.accessToken(), LoginRequired);
    assert.equal(f.rotates, 1);
    const state = f.session.read();
    state.tokens = { access_token: "old", refresh_token: "already-used" };
    state.refreshing = true;
    f.session.write(state);
    await assert.rejects(f.session.accessToken(), LoginRequired);
    assert.equal(f.rotates, 1);
  } finally { await f.close(); }
});

test("a wrong callback state cannot complete sign-in", async () => {
  const f = await fixture();
  try {
    let sentWrong = false;
    f.session.open = async (link) => {
      const url = new URL(link);
      const wrong = new URL(url.searchParams.get("redirect_uri"));
      wrong.searchParams.set("state", "wrong"); wrong.searchParams.set("code", "wrong");
      assert.equal((await fetch(wrong)).status, 400);
      sentWrong = true;
      await fetch(link);
    };
    await f.session.ensureLogin();
    assert.ok(sentWrong);
    assert.equal(await f.session.accessToken(), "access-1");
  } finally { await f.close(); }
});

test("a crashed lock owner is recovered without replaying credentials", async () => {
  const f = await fixture();
  try {
    await f.session.ensureLogin(); f.expire();
    mkdirSync(f.session.lock);
    writeFileSync(join(f.session.lock, "2147483647"), "");
    assert.equal(await f.session.accessToken(), "access-2");
    assert.equal(f.rotates, 1);
  } finally { await f.close(); }
});

async function adapter(f) {
  const client = new Client({ name: "oauth-adapter-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("./index.mjs", import.meta.url))], env: {
    PARALLELSANDBOX_API_KEY: "", PARALLELSANDBOX_AUTH_DIR: f.directory,
    PARALLELSANDBOX_NO_BROWSER: "1",
    PARALLELSANDBOX_MCP_URL: `${f.base}/mcp`, PARALLELSANDBOX_API_URL: f.base,
  }, stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  await client.connect(transport);
  return client;
}

async function until(check, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw new Error("Test timed out"); await delay(50); }
}

test("stdio starts before sign-in, exposes a link, then announces the real tools", async () => {
  const f = await fixture();
  let client;
  try {
    const started = Date.now();
    client = await adapter(f);
    assert.ok(Date.now() - started < 3_000);
    let changed = false;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed = true; });
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["parallelsandbox_connect"]);
    const url = await until(() => f.session.status());
    const pending = await client.callTool({ name: "parallelsandbox_connect", arguments: {} });
    assert.ok(pending.content[0].text.includes(url));
    await fetch(url);
    await until(() => changed);
    assert.ok((await client.listTools()).tools.some((t) => t.name === "sandbox_list"));
    assert.equal((await client.callTool({ name: "sandbox_list", arguments: {} })).content[0].text, "boxes listed");
    f.reject();
    assert.equal((await client.callTool({ name: "sandbox_list", arguments: {} })).content[0].text, "boxes listed");
    assert.equal(f.rotates, 1);
  } finally { await client?.close(); await f.close(); }
});

test("OAuth adapter presence and streamed upload use the current token", async () => {
  const f = await fixture();
  let client;
  try {
    await f.session.ensureLogin();
    client = await adapter(f);
    await until(async () => (await client.listTools()).tools.some((t) => t.name === "sandbox_list"));
    const state = f.session.read(); state.expiresAt = Date.now() + 120_000; f.session.write(state);
    const src = join(f.directory, "source"); mkdirSync(src); writeFileSync(join(src, "hello.txt"), "hello");
    const out = await client.callTool({ name: "sandbox_sync", arguments: { id: "test-box", localPath: src, dest: "source" } });
    assert.equal(out.isError, false, JSON.stringify(out));
    assert.equal(f.rotates, 1);
    const uploaded = f.seen.findLast((r) => r.url.includes("/sync?"));
    assert.equal(uploaded.auth, "Bearer access-2");
    assert.ok(uploaded.body.length > 0);
    await client.callTool({ name: "sandbox_list", arguments: {} });
    await client.close(); client = null;
    assert.equal(f.seen.findLast((r) => r.url.endsWith("/leave")).auth, "Bearer access-2");
  } finally { await client?.close(); await f.close(); }
});

test("a rejected saved refresh opens sign-in while stdio stays available", async () => {
  const f = await fixture();
  let client;
  try {
    await f.session.ensureLogin(); f.expire(); f.failRefresh();
    client = await adapter(f);
    const url = await until(() => f.session.status());
    assert.equal(f.rotates, 1);
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["parallelsandbox_connect"]);
    await fetch(url);
    await until(async () => (await client.listTools()).tools.some((t) => t.name === "sandbox_list"));
    assert.equal((await client.callTool({ name: "sandbox_list", arguments: {} })).content[0].text, "boxes listed");
  } finally { await client?.close(); await f.close(); }
});
