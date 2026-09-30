// Isolated protocol tests. These do not claim a real Claude idle-wake E2E pass.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { CLAUDE_CHANNEL_CAPABILITIES, createClaudeChannel } from "./claude-channel.mjs";

const readyName = "parallelsandbox_channel_ready";
const ackName = "parallelsandbox_feedback_ack";
const toolResult = (data, error = false) => ({ content: [{ type: "text", text: JSON.stringify(data) }], ...(error ? { isError: true } : {}) });
const parsed = (result) => JSON.parse(result.content[0].text);
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const event = (extra = {}) => ({ eventId: "opaque-event-one", reportId: "report-one", boxId: "box-one", reviewId: "review-one", leaseToken: "private-lease-one", leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), ...extra });
const report = (reportId = "report-one") => toolResult({ ok: true, reportId, fromHuman: JSON.stringify({ notes: ["Read the actual report"] }) });

async function until(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the protocol test condition.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function fixture(t, options = {}) {
  const requests = [];
  const notifications = [];
  const queue = [];
  const waiting = new Set();
  let notificationFailure = false;
  // This is an injected protocol fixture, not native Claude queue evidence.
  const guardState = { sessionId: "unit-original-session" };
  const proof = ({ boxId, reviewId }) => ({ boxId, reviewId, sessionId: guardState.sessionId, bindingId: `unit-binding-${reviewId}`, queueScope: { kind: "native-session", sessionId: guardState.sessionId, proofId: `unit-queue-${guardState.sessionId}` } });
  const unitGuard = { bindReview: proof, checkDispatch: proof, checkAck: proof };
  const channel = createClaudeChannel({
    server: { notification: async (notice) => {
      if (notificationFailure) throw new Error("stdio closed");
      notifications.push(notice);
    } },
    apiUrl: "https://api.unit.example",
    headers: { "X-Psbx-Agent": "original-agent", Authorization: "Bearer isolated-test-key" },
    consumerId: options.consumerId || "original-consumer",
    trustedSessionGuard: options.noSessionGuard ? undefined : options.guard || unitGuard,
    authorizedFetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body, headers: init.headers });
      if (url.endsWith("/ack")) return options.ack ? options.ack(body) : response({ ok: true });
      if (!url.endsWith("/claim")) return options.bind ? options.bind(body) : response({ ok: true });
      if (body.waitSec === 0) return response({ events: options.zeroClaim ? options.zeroClaim() : queue.shift() || [] });
      if (queue.length) return response({ events: queue.shift() });
      return new Promise((resolve, reject) => {
        const item = { resolve: (events) => { cleanup(); resolve(response({ events })); } };
        const abort = () => { cleanup(); reject(init.signal.reason || new Error("aborted")); };
        const cleanup = () => { waiting.delete(item); init.signal.removeEventListener("abort", abort); };
        waiting.add(item);
        init.signal.addEventListener("abort", abort, { once: true });
        if (init.signal.aborted) abort();
      });
    },
  });
  t.after(() => channel.shutdown());
  const push = (...events) => {
    const first = [...waiting][0];
    if (first) first.resolve(events); else queue.push(events);
  };
  const activate = async () => {
    await channel.startHandshake();
    const challenge = notifications.find((notice) => notice.params.meta?.kind === "activation");
    assert.ok(challenge);
    assert.equal(parsed(await channel.handleTool(readyName, { nonce: challenge.params.meta.nonce })).activated, true);
  };
  const bind = (boxId = "box-one", reviewId = "review-one", extra = {}) => channel.onReviewResult(boxId, toolResult({ ok: true, reviewId, ...extra }));
  const feedbackNotices = () => notifications.filter((notice) => notice.params.meta?.report_id);
  return { channel, requests, notifications, push, activate, bind, feedbackNotices, setNotificationFailure: (value) => { notificationFailure = value; }, changeSession: (sessionId) => { guardState.sessionId = sessionId; } };
}

test("native ready without a trusted session/queue guard cannot bind or poll feedback", async (t) => {
  const f = fixture(t, { noSessionGuard: true });
  await f.channel.startHandshake();
  const nonce = f.notifications[0].params.meta.nonce;
  const receipt = parsed(await f.channel.handleTool(readyName, { nonce }));
  assert.equal(receipt.activated, true);
  assert.equal(receipt.sessionRouting, false);
  assert.deepEqual(await f.bind(), { bound: false, reason: "original_session_guard_unavailable" });
  f.push(event());
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.requests.length, 0);
  assert.equal(f.feedbackNotices().length, 0);
});

test("a guard's boolean declaration is not an immutable native session proof", async (t) => {
  const f = fixture(t, { guard: { queueScoped: true, bindReview: () => true, checkDispatch: () => true, checkAck: () => true } });
  await f.activate();
  assert.equal((await f.bind()).bound, false);
  assert.equal(f.requests.length, 0);
});

test("activation requires an actual native challenge and never guesses the client name", async (t) => {
  const f = fixture(t);
  assert.equal((await f.bind()).reason, "channel_not_activated");
  assert.equal((await f.channel.handleTool(readyName, { nonce: "invented" })).isError, true);
  assert.equal(f.requests.length, 0);
  await f.channel.startHandshake();
  const notice = f.notifications[0];
  assert.equal(notice.method, "notifications/claude/channel");
  assert.equal((await f.channel.handleTool(readyName, { nonce: "wrong" })).isError, true);
  assert.equal(f.requests.length, 0);
  await f.activate();
  await until(() => f.requests.some((request) => request.url.endsWith("/claim")));
  assert.equal(f.notifications.filter((item) => item.params.meta?.kind === "activation").length, 1);
  assert.equal(f.requests.filter((request) => request.url.endsWith("/feedback-consumers")).length, 1);
});

test("a challenge from another original session cannot activate this connection", async (t) => {
  const a = fixture(t, { consumerId: "consumer-a" });
  const b = fixture(t, { consumerId: "consumer-b" });
  await a.channel.startHandshake();
  await b.channel.startHandshake();
  const otherNonce = a.notifications[0].params.meta.nonce;
  const rejected = await b.channel.handleTool(readyName, { nonce: otherNonce });
  assert.equal(rejected.isError, true);
  assert.equal(b.requests.length, 0);
  assert.ok(!JSON.stringify(rejected).includes(b.notifications[0].params.meta.nonce));
});

test("notification writes contain only report pointers and do not acknowledge delivery", async (t) => {
  const f = fixture(t);
  await f.activate();
  await f.bind();
  f.push(event());
  await until(() => f.feedbackNotices().length === 1);
  assert.deepEqual(f.feedbackNotices()[0].params.meta, { box_id: "box-one", report_id: "report-one" });
  assert.ok(!JSON.stringify(f.feedbackNotices()).includes("private-lease-one"));
  assert.ok(!JSON.stringify(f.feedbackNotices()).includes("opaque-event-one"));
  assert.equal(f.requests.filter((request) => request.url.endsWith("/ack")).length, 0);
  const binding = f.requests.find((request) => request.url.endsWith("/feedback-consumers"));
  assert.deepEqual(binding.body, { consumerId: "original-consumer", boxId: "box-one", reviewId: "review-one", host: "claude-code", capability: "claude/channel" });
  assert.equal(binding.headers["X-Psbx-Agent"], "original-agent");
});

test("ACK requires the complete successful report and opaque lease stays private", async (t) => {
  const f = fixture(t);
  await f.activate(); await f.bind(); f.push(event());
  await until(() => f.feedbackNotices().length === 1);
  const args = { id: "box-one", reportId: "report-one" };
  assert.equal((await f.channel.handleTool(ackName, args)).isError, true);
  f.channel.onToolResult("sandbox_report", args, report("different-report"));
  assert.equal((await f.channel.handleTool(ackName, args)).isError, true);
  f.channel.onToolResult("sandbox_report", args, toolResult({ ok: true, reportId: "report-one", fromHuman: "partial" }, true));
  assert.equal((await f.channel.handleTool(ackName, args)).isError, true);
  f.channel.onToolResult("sandbox_report", args, toolResult({ ok: true, reportId: "report-one", humanDeliveryError: "media unavailable" }));
  assert.equal((await f.channel.handleTool(ackName, args)).isError, true);
  f.channel.onToolResult("sandbox_report", args, report());
  assert.equal(parsed(await f.channel.handleTool(ackName, args)).state, "read");
  const receipts = f.requests.filter((request) => request.url.endsWith("/ack"));
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].body, { eventId: "opaque-event-one", reportId: "report-one", leaseToken: "private-lease-one", state: "read" });
  assert.equal(parsed(await f.channel.handleTool(ackName, args)).alreadyAcknowledged, true);
  assert.equal(f.requests.filter((request) => request.url.endsWith("/ack")).length, 1);
});

test("duplicate leases renew privately without enqueueing the same report twice", async (t) => {
  const f = fixture(t);
  await f.activate(); await f.bind(); f.push(event());
  await until(() => f.feedbackNotices().length === 1);
  f.push(event({ leaseToken: "renewed-private-lease" }));
  await until(() => f.requests.filter((request) => request.url.endsWith("/claim")).length >= 3);
  const args = { id: "box-one", reportId: "report-one" };
  f.channel.onToolResult("sandbox_report", args, report());
  assert.equal(parsed(await f.channel.handleTool(ackName, args)).state, "read");
  assert.equal(f.feedbackNotices().length, 1);
  assert.equal(f.requests.find((request) => request.url.endsWith("/ack")).body.leaseToken, "renewed-private-lease");
});

test("an expired lease is renewed before reading ACK without another native event", async (t) => {
  const renewed = event({ leaseToken: "new-lease" });
  const f = fixture(t, { zeroClaim: () => [renewed] });
  await f.activate(); await f.bind(); f.push(event({ leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() }));
  await until(() => f.feedbackNotices().length === 1);
  const args = { id: "box-one", reportId: "report-one" };
  f.channel.onToolResult("sandbox_report", args, report());
  assert.equal(parsed(await f.channel.handleTool(ackName, args)).state, "read");
  assert.ok(f.requests.some((request) => request.body.waitSec === 0));
  assert.equal(f.requests.find((request) => request.url.endsWith("/ack")).body.leaseToken, "new-lease");
  assert.equal(f.feedbackNotices().length, 1);
});

test("same report id across two boxes never mixes their event ids or leases", async (t) => {
  const f = fixture(t);
  await f.activate(); await f.bind(); await f.bind("box-two", "review-two");
  f.push(event(), event({ eventId: "different-opaque-event", boxId: "box-two", reviewId: "review-two", leaseToken: "box-two-private-lease" }));
  await until(() => f.feedbackNotices().length === 2);
  const a = { id: "box-one", reportId: "report-one" };
  const b = { id: "box-two", reportId: "report-one" };
  f.channel.onToolResult("sandbox_report", a, report());
  assert.equal((await f.channel.handleTool(ackName, b)).isError, true);
  await f.channel.handleTool(ackName, a);
  f.channel.onToolResult("sandbox_report", b, report());
  await f.channel.handleTool(ackName, b);
  assert.deepEqual(f.requests.filter((request) => request.url.endsWith("/ack")).map((request) => request.body.eventId), ["opaque-event-one", "different-opaque-event"]);
});

test("a different current session cannot receive the original review's event", async (t) => {
  const f = fixture(t);
  await f.activate(); await f.bind();
  f.changeSession("unit-new-cleared-session");
  f.push(event());
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.feedbackNotices().length, 0);
  assert.equal(f.requests.filter((request) => request.url.endsWith("/ack")).length, 0);
});

test("an event already sent cannot be ACKed by a subsequently switched session", async (t) => {
  const f = fixture(t);
  await f.activate(); await f.bind(); f.push(event());
  await until(() => f.feedbackNotices().length === 1);
  const args = { id: "box-one", reportId: "report-one" };
  f.changeSession("unit-new-resumed-session");
  f.channel.onToolResult("sandbox_report", args, report());
  assert.equal((await f.channel.handleTool(ackName, args)).isError, true);
  assert.equal(f.requests.filter((request) => request.url.endsWith("/ack")).length, 0);
});

test("parallel acknowledgements share one request and cannot override owner fields", async (t) => {
  let finishAck;
  const f = fixture(t, { ack: () => new Promise((resolve) => { finishAck = () => resolve(response({ ok: true })); }) });
  await f.activate(); await f.bind(); f.push(event());
  await until(() => f.feedbackNotices().length === 1);
  const args = { id: "box-one", reportId: "report-one" };
  f.channel.onToolResult("sandbox_report", args, report());
  assert.equal((await f.channel.handleTool(ackName, { ...args, consumerId: "other-session" })).isError, true);
  const a = f.channel.handleTool(ackName, args);
  const b = f.channel.handleTool(ackName, args);
  await until(() => !!finishAck);
  finishAck();
  assert.equal(parsed(await a).state, "read");
  assert.equal(parsed(await b).state, "read");
  assert.equal(f.requests.filter((request) => request.url.endsWith("/ack")).length, 1);
});

test("failed ACK leaves feedback pending and retries with the same consumer", async (t) => {
  let attempt = 0;
  const f = fixture(t, { ack: () => response({ ok: ++attempt > 1 }, attempt === 1 ? 503 : 200) });
  await f.activate(); await f.bind(); f.push(event());
  await until(() => f.feedbackNotices().length === 1);
  const args = { id: "box-one", reportId: "report-one" };
  f.channel.onToolResult("sandbox_report", args, report());
  assert.equal((await f.channel.handleTool(ackName, args)).isError, true);
  assert.equal(parsed(await f.channel.handleTool(ackName, args)).state, "read");
  assert.equal(f.feedbackNotices().length, 1);
  assert.equal(f.requests.filter((request) => request.url.endsWith("/ack")).length, 2);
});

test("a 200 response without a true receipt cannot mark feedback read", async (t) => {
  let attempt = 0;
  const f = fixture(t, { ack: () => response({ ok: ++attempt > 1 }) });
  await f.activate(); await f.bind(); f.push(event());
  await until(() => f.feedbackNotices().length === 1);
  const args = { id: "box-one", reportId: "report-one" };
  f.channel.onToolResult("sandbox_report", args, report());
  assert.equal((await f.channel.handleTool(ackName, args)).isError, true);
  assert.equal(parsed(await f.channel.handleTool(ackName, args)).state, "read");
  assert.equal(f.requests.filter((request) => request.url.endsWith("/ack")).length, 2);
});

test("a failed native transport write is retryable and never counts as accepted", async (t) => {
  const f = fixture(t);
  await f.activate(); await f.bind();
  f.setNotificationFailure(true);
  f.push(event());
  await until(() => f.requests.filter((request) => request.url.endsWith("/claim")).length === 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.feedbackNotices().length, 0);
  assert.equal(f.requests.filter((request) => request.url.endsWith("/ack")).length, 0);
  f.setNotificationFailure(false);
  f.push(event({ leaseToken: "retry-private-lease" }));
  await until(() => f.feedbackNotices().length === 1);
  assert.equal(f.requests.filter((request) => request.url.endsWith("/ack")).length, 0);
});

test("an event for an unbound review cannot be injected into this session", async (t) => {
  const f = fixture(t);
  await f.activate(); await f.bind();
  f.push(event({ reviewId: "somebody-elses-review" }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.feedbackNotices().length, 0);
  f.channel.onToolResult("sandbox_report", { id: "box-one", reportId: "report-one" }, report());
  assert.equal((await f.channel.handleTool(ackName, { id: "box-one", reportId: "report-one" })).isError, true);
  assert.equal(f.requests.filter((request) => request.url.endsWith("/ack")).length, 0);
});

test("a foreground complete report is deduped without claiming a nonexistent ACK lease", async (t) => {
  const f = fixture(t);
  await f.activate();
  await f.bind("box-one", "review-one", { reportId: "report-one", fromHuman: "complete foreground report" });
  f.push(event());
  await until(() => f.requests.filter((request) => request.url.endsWith("/claim")).length >= 2);
  assert.equal(f.feedbackNotices().length, 0);
  assert.equal(f.requests.filter((request) => request.url.endsWith("/ack")).length, 0);
});

test("shutdown aborts the idle claim and leaves unacknowledged feedback replayable", async (t) => {
  const first = fixture(t);
  await first.activate(); await first.bind(); first.push(event());
  await until(() => first.feedbackNotices().length === 1);
  await first.channel.shutdown();
  assert.equal(first.requests.filter((request) => request.url.endsWith("/ack")).length, 0);
  assert.equal((await first.channel.handleTool(ackName, { id: "box-one", reportId: "report-one" })).isError, true);
  const next = fixture(t);
  await next.activate(); await next.bind(); next.push(event({ leaseToken: "reclaimed-lease" }));
  await until(() => next.feedbackNotices().length === 1);
  assert.equal(next.feedbackNotices().length, 1);
});

test("plugin declares the native channel route without permission relay or lifecycle wake hooks", () => {
  assert.deepEqual(CLAUDE_CHANNEL_CAPABILITIES, { experimental: { "claude/channel": {} } });
  const config = JSON.parse(readFileSync(new URL("./.mcp.json", import.meta.url), "utf8"));
  assert.deepEqual(config.mcpServers.parallelsandbox, { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/index.mjs"], env: { PSBX_FEEDBACK_HOST: "claude-code" } });
  const manifest = JSON.parse(readFileSync(new URL("./.claude-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "parallelsandbox");
  assert.equal(manifest.hooks, undefined);
  assert.equal(manifest.channels?.some((channel) => channel.permission), undefined);
});

test("stdio integration exposes the native ready tool before OAuth without leaking its nonce", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "psbx-channel-stdio-"));
  const child = spawn(process.execPath, [new URL("./index.mjs", import.meta.url).pathname], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PSBX_ADAPTER_NO_CONNECT: "", PSBX_FEEDBACK_HOST: "claude-code", PARALLELSANDBOX_API_KEY: "", PARALLELSANDBOX_AUTH_DIR: directory, PARALLELSANDBOX_NO_BROWSER: "1", PARALLELSANDBOX_MCP_URL: "http://127.0.0.1:9/mcp", PARALLELSANDBOX_API_URL: "http://127.0.0.1:9" },
  });
  const replies = new Map();
  const notices = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined) replies.get(message.id)?.(message);
    else notices.push(message);
  });
  t.after(async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      const ended = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGTERM");
      await ended;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const request = (id, method, params) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`stdio ${method} timed out: ${stderr}`)), 3_000);
    replies.set(id, (message) => { clearTimeout(timeout); replies.delete(id); resolve(message); });
    send({ id, method, params });
  });
  const initialize = await request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "isolated-protocol-client", version: "1" } });
  assert.deepEqual(initialize.result.capabilities.experimental, { "claude/channel": {} });
  send({ method: "notifications/initialized" });
  const listed = await request(2, "tools/list", {});
  assert.ok(listed.result.tools.some((tool) => tool.name === readyName));
  assert.ok(listed.result.tools.some((tool) => tool.name === "parallelsandbox_connect"));
  assert.ok(!listed.result.tools.some((tool) => tool.name === "sandbox_review"));
  await until(() => notices.some((notice) => notice.method === "notifications/claude/channel"));
  const nonce = notices.find((notice) => notice.params?.meta?.kind === "activation").params.meta.nonce;
  assert.ok(!JSON.stringify(initialize).includes(nonce));
  assert.ok(!JSON.stringify(listed).includes(nonce));
  const ready = await request(3, "tools/call", { name: readyName, arguments: { nonce } });
  assert.equal(parsed(ready.result).activated, true);
  assert.equal(parsed(ready.result).sessionRouting, false);
  assert.ok(!JSON.stringify(ready).includes(nonce));
});
