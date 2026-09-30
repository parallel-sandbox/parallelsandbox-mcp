// Unit fixtures exercise bridge contracts. They do not prove a real Codex host wakes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { CodexHostError, CODEX_REVIEW_TOOLS, connectCodexHost, createCodexFeedback, reportToolOutput, reviewHookBinding } from "./codex-host.mjs";
import { runCodexFeedbackHook } from "./codex-host-hook.mjs";

const report = { content: [{ type: "text", text: JSON.stringify({ ok: true, reportId: "report-1", fromHuman: [{ files: [{ url: "https://example.test/video.mp4", kind: "video" }], transcript: [{ startMs: 4331, endMs: 7031, text: "The loading is stuck." }] }] }) }, { type: "image", mimeType: "image/png", data: Buffer.from("frame").toString("base64") }] };
const hook = (reviewId = "review-1", boxId = "box-1", token = "ticket-secret") => ({ hook_event_name: "PostToolUse", tool_name: CODEX_REVIEW_TOOLS[0], session_id: "original-thread", cwd: "/work/project", tool_input: { id: boxId, session_id: "model-forged-thread" }, tool_response: { _meta: { psbxCodexFeedback: { token } }, content: [{ type: "text", text: JSON.stringify({ ok: true, id: boxId, reviewId }) }] } });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const waitUntil = async (fn) => { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw new Error("condition did not settle"); await new Promise((r) => setTimeout(r, 10)); } };
async function fixture(t) { const base = join(tmpdir(), "cubelv-e2e"); await (await import("node:fs/promises")).mkdir(base, { recursive: true }); const dir = await mkdtemp(join(base, "codex-host-unit-")); await chmod(dir, 0o700); t.after(() => rm(dir, { force: true, recursive: true })); return dir; }

test("MCP report content becomes schema-correct standalone tool output with all references", () => {
  const output = reportToolOutput(report);
  assert.equal(output.name, "sandbox_report");
  assert.equal(output.namespace, "parallelsandbox");
  assert.equal(output.output[0].text, report.content[0].text);
  assert.deepEqual(JSON.parse(output.output[0].text).fromHuman[0].transcript[0], { startMs: 4331, endMs: 7031, text: "The loading is stuck." });
  assert.deepEqual(output.output[1], { type: "input_image", image_url: "data:image/png;base64,ZnJhbWU=" });
});

test("failed preparation, unsupported media and invalid image fail before partial delivery", () => {
  assert.throws(() => reportToolOutput({ ...report, isError: true }), /complete human report/);
  assert.throws(() => reportToolOutput({ content: [...report.content, { type: "resource_link", uri: "https://example.test/file" }] }), /Unsupported.*resource_link/);
  assert.throws(() => reportToolOutput({ content: [{ type: "audio", data: "YWJj", mimeType: "audio/wav" }] }), /Unsupported.*audio/);
  assert.throws(() => reportToolOutput({ content: [{ type: "image", data: "bad!", mimeType: "image/png" }] }), /invalid base64/);
  assert.throws(() => reportToolOutput({ content: [] }), /no report content/);
});

test("only exact review tool names bind trusted parent session metadata", () => {
  const ticket = { boxId: "box-1", reviewId: "review-1", token: "ticket-secret" };
  const value = reviewHookBinding(hook(), ticket);
  assert.equal(value.sessionId, "original-thread");
  assert.equal(value.token, "ticket-secret");
  assert.equal(reviewHookBinding({ ...hook(), tool_name: `${CODEX_REVIEW_TOOLS[0]}_evil` }, ticket), null);
  assert.equal(reviewHookBinding({ ...hook(), hook_event_name: "Stop" }, ticket), null);
  assert.equal(reviewHookBinding({ ...hook(), tool_response: { ...hook().tool_response, _meta: undefined } }, ticket), null);
  assert.throws(() => reviewHookBinding(hook("wrong-review"), ticket), /does not match/);
  assert.throws(() => reviewHookBinding(hook("review-1", "wrong-box"), ticket), /does not match/);
  assert.throws(() => reviewHookBinding({ ...hook(), session_id: "" }, ticket), /session_id/);
});

test("current Desktop without explicit official endpoint remains unsupported and inert", async (t) => {
  const stateDir = await fixture(t);
  let calls = 0;
  const feedback = createCodexFeedback({ stateDir, authorizedFetch: () => { calls++; } });
  assert.equal(feedback.start().running, false);
  assert.equal(feedback.status().reason, "current_desktop_stdio_unsupported");
  assert.equal((await feedback.trackReview({ boxId: "box-1", reviewId: "review-1" })).supported, false);
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(stateDir), []);
  await feedback.stop();
  await assert.rejects(connectCodexHost({}), /explicitly paired/);
});

async function coordinator(t, overrides = {}) {
  const stateDir = await fixture(t), calls = [], deliveries = [], states = [];
  const event = { eventId: "opaque-event-other-than-report", reportId: "report-1", boxId: "box-1", reviewId: "review-1", leaseToken: "lease-1", leaseExpiresAt: new Date(Date.now() + 120_000).toISOString() };
  let acked = false;
  const feedback = createCodexFeedback({
    stateDir, apiUrl: "https://api.example.test", cliPath: "/explicit/codex", socketPath: "/explicit/host.sock", headers: { "X-Psbx-Agent": "actual-agent" }, claimWaitSec: 0,
    authorizedFetch: async (url, init) => { const body = JSON.parse(init.body); calls.push({ url, body, headers: init.headers }); if (url.endsWith("/claim")) return response({ events: acked ? [] : [event] }); if (url.endsWith("/ack")) { acked = true; return response({ ok: true }); } return response({ ok: true }); },
    callRemoteReport: async (args) => { assert.equal(args.reportId, "report-1"); return report; },
    connectHost: async () => ({ probeThread: async (id) => { assert.equal(id, "original-thread"); return { threadLoaded: true }; }, deliverReport: async (id, content) => { deliveries.push({ id, content }); return { state: "host_accepted", turnId: "turn-accepted" }; }, close() {} }),
    onState: (state) => states.push(state), ...overrides,
  });
  t.after(() => feedback.stop());
  const tracked = await feedback.trackReview({ boxId: "box-1", reviewId: "review-1" });
  await runCodexFeedbackHook(hook("review-1", "box-1", tracked.hookMeta.token), { stateDir });
  feedback.start();
  return { feedback, stateDir, calls, deliveries, states, event };
}

test("trusted hook tickets are owner-only and unsolicited review hooks create no ticket", async (t) => {
  const stateDir = await fixture(t);
  assert.deepEqual(await runCodexFeedbackHook(hook(), { stateDir }), { bound: false, reason: "no_adapter_ticket" });
  const feedback = createCodexFeedback({ stateDir, cliPath: "/codex", socketPath: "/host.sock", headers: { "X-Psbx-Agent": "actual-agent" } });
  await feedback.trackReview({ boxId: "box-1", reviewId: "review-1" });
  const name = (await readdir(stateDir)).find((x) => x.endsWith(".ticket.json"));
  assert.equal((await stat(join(stateDir, name))).mode & 0o777, 0o600);
  await chmod(join(stateDir, name), 0o644);
  await assert.rejects(runCodexFeedbackHook(hook(), { stateDir }), /mode 0600/);
});

test("real hook subprocess requires the matching private result marker and exits after binding", async (t) => {
  const stateDir = await fixture(t);
  const feedback = createCodexFeedback({ stateDir, cliPath: "/codex", socketPath: "/host.sock", headers: { "X-Psbx-Agent": "actual-agent" } });
  const tracked = await feedback.trackReview({ boxId: "box-1", reviewId: "review-1" });
  const run = async (input) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./codex-host-hook.mjs", import.meta.url)), "--state-dir", stateDir], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", (data) => { stderr += data; });
    child.stdin.end(JSON.stringify(input));
    const [code] = await once(child, "exit");
    assert.equal(code, 0, stderr);
  };
  const missing = hook(); delete missing.tool_response._meta;
  await run(missing);
  assert.equal((await readdir(stateDir)).some((n) => n.endsWith(".binding.json")), false);
  await run(hook("review-1", "box-1", "wrong-marker"));
  assert.equal((await readdir(stateDir)).some((n) => n.endsWith(".binding.json")), false);
  await run(hook("review-1", "box-1", tracked.hookMeta.token));
  const bindingPath = join(stateDir, (await readdir(stateDir)).find((n) => n.endsWith(".binding.json")));
  const binding = JSON.parse(await readFile(bindingPath, "utf8"));
  assert.equal(binding.sessionId, "original-thread");
  assert.equal((await stat(bindingPath)).mode & 0o777, 0o600);
});

test("consumer uses actual actor, opaque event identity, original thread and host acceptance ACK", async (t) => {
  const f = await coordinator(t);
  await waitUntil(() => f.calls.some((x) => x.url.endsWith("/ack")));
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].id, "original-thread");
  assert.deepEqual(f.deliveries[0].content, report);
  const registration = f.calls.find((x) => x.url.endsWith("feedback-consumers"));
  assert.equal(registration.body.host, "codex");
  assert.equal(registration.body.capability, "codex/turn-start-tool-output");
  assert.equal(registration.headers["X-Psbx-Agent"], "actual-agent");
  assert.deepEqual(f.calls.find((x) => x.url.endsWith("/ack")).body, { eventId: f.event.eventId, reportId: f.event.reportId, leaseToken: f.event.leaseToken, state: "host_accepted" });
  const journal = JSON.parse(await readFile(join(f.stateDir, (await readdir(f.stateDir)).find((x) => x.endsWith(".delivery.json"))), "utf8"));
  assert.equal(journal.state, "host_accepted");
  assert.equal(journal.turnId, "turn-accepted");
});

test("failed ACK retries the lease ACK without enqueueing the accepted report twice", async (t) => {
  let ackAttempts = 0, deliveries = 0;
  const event = { eventId: "opaque-id", reportId: "report-1", boxId: "box-1", reviewId: "review-1", leaseToken: "fresh-lease" };
  const f = await coordinator(t, {
    authorizedFetch: async (url) => { if (url.endsWith("/claim")) return response({ events: ackAttempts >= 2 ? [] : [event] }); if (url.endsWith("/ack")) return response({}, ++ackAttempts === 1 ? 503 : 200); return response({}); },
    connectHost: async () => ({ probeThread: async () => ({}), deliverReport: async () => { deliveries++; return { state: "host_accepted", turnId: "turn-once" }; }, close() {} }),
  });
  await waitUntil(() => ackAttempts >= 2);
  assert.equal(deliveries, 1);
  assert.equal(f.feedback.status().reason, "host_accepted");
});

test("disconnect after sending keeps an uncertain journal and never false-ACKs or retries the turn", async (t) => {
  let deliveries = 0, acks = 0, claims = 0;
  const event = { eventId: "opaque-id", reportId: "report-1", boxId: "box-1", reviewId: "review-1", leaseToken: "lease" };
  const f = await coordinator(t, {
    authorizedFetch: async (url) => { if (url.endsWith("/claim")) { claims++; return response({ events: [event] }); } if (url.endsWith("/ack")) acks++; return response({}); },
    connectHost: async () => ({ probeThread: async () => ({}), deliverReport: async () => { deliveries++; throw new CodexHostError("disconnected after write", { uncertain: true, code: "disconnected" }); }, close() {} }),
  });
  await waitUntil(() => claims >= 2);
  assert.equal(deliveries, 1);
  assert.equal(acks, 0);
  const journal = JSON.parse(await readFile(join(f.stateDir, (await readdir(f.stateDir)).find((x) => x.endsWith(".delivery.json"))), "utf8"));
  assert.equal(journal.state, "sending");
});

test("missing original-thread ownership never registers a wake-capable consumer", async (t) => {
  const f = await coordinator(t, { connectHost: async () => ({ probeThread: async () => { throw new CodexHostError("thread not loaded"); }, close() {} }) });
  await waitUntil(() => f.states.some((s) => s.reason === "pairing_pending"));
  assert.equal(f.calls.length, 0);
  assert.equal(f.feedback.status().supported, false);
});

test("incomplete report preparation never starts a turn or ACKs a lease", async (t) => {
  const f = await coordinator(t, { callRemoteReport: async () => ({ ...report, isError: true }) });
  await waitUntil(() => f.states.some((s) => s.error?.includes("complete human report")));
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.calls.filter((x) => x.url.endsWith("/ack")).length, 0);
  assert.equal((await readdir(f.stateDir)).some((x) => x.endsWith(".delivery.json")), false);
});

test("one original-thread consumer registers multiple box/review scopes", async (t) => {
  const registrations = [];
  const f = await coordinator(t, { authorizedFetch: async (url, init) => { if (url.endsWith("/claim")) return response({ events: [] }); registrations.push(JSON.parse(init.body)); return response({}); } });
  const tracked = await f.feedback.trackReview({ boxId: "box-2", reviewId: "review-2" });
  await runCodexFeedbackHook(hook("review-2", "box-2", tracked.hookMeta.token), { stateDir: f.stateDir });
  await waitUntil(() => registrations.length >= 2);
  assert.equal(registrations[0].consumerId, registrations[1].consumerId);
  assert.deepEqual(registrations.map((x) => [x.boxId, x.reviewId]).sort(), [["box-1", "review-1"], ["box-2", "review-2"]]);
});

test("the same report UUID on two boxes delivers both opaque events to one original-thread consumer", async (t) => {
  const events = [
    { eventId: "event-box-1", reportId: "report-1", boxId: "box-1", reviewId: "review-1", leaseToken: "lease-1" },
    { eventId: "event-box-2", reportId: "report-1", boxId: "box-2", reviewId: "review-2", leaseToken: "lease-2" },
  ];
  const acked = [], deliveries = [];
  let scopes = 0;
  const f = await coordinator(t, {
    authorizedFetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith("/claim")) return response({ events: scopes === 2 ? events.filter((e) => !acked.includes(e.eventId)).slice(0, 1) : [] });
      if (url.endsWith("/ack")) acked.push(body.eventId); else scopes++;
      return response({});
    },
    callRemoteReport: async (args) => { deliveries.push(args.id); return report; },
  });
  const tracked = await f.feedback.trackReview({ boxId: "box-2", reviewId: "review-2" });
  await runCodexFeedbackHook(hook("review-2", "box-2", tracked.hookMeta.token), { stateDir: f.stateDir });
  await waitUntil(() => acked.length === 2);
  assert.deepEqual(deliveries, ["box-1", "box-2"]);
  const journals = await Promise.all((await readdir(f.stateDir)).filter((n) => n.endsWith(".delivery.json")).map(async (n) => JSON.parse(await readFile(join(f.stateDir, n), "utf8"))));
  assert.equal(journals.length, 2);
  assert.deepEqual(journals.map((j) => [j.boxId, j.eventId, j.reviewId, j.reportId, j.threadId]).sort(), [["box-1", "event-box-1", "review-1", "report-1", "original-thread"], ["box-2", "event-box-2", "review-2", "report-1", "original-thread"]]);
});

// This fixture checks JSONL client behavior only; it is deliberately not a Codex E2E.
async function protocolFixture(t, { active = false, loseAfterTurn = false, requestApproval = false, onHostRequest, onNotification } = {}) {
  const dir = await fixture(t), socketPath = join(dir, "app-server-control.sock"), messages = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    createInterface({ input: socket }).on("line", (line) => {
      const msg = JSON.parse(line); messages.push(msg);
      let result;
      if (msg.method === "initialize") result = { userAgent: "unit-fixture", codexHome: dir, platformFamily: "unix", platformOs: "linux" };
      if (msg.method === "thread/loaded/list") result = { data: ["original-thread"] };
      if (msg.method === "thread/read") result = { thread: { id: "original-thread", status: { type: active ? "active" : "idle" } } };
      if (msg.method === "turn/start") { if (loseAfterTurn) { socket.destroy(); return; } result = { turn: { id: active ? "active-turn" : "new-turn", status: "inProgress" } }; }
      if (result) socket.write(`${JSON.stringify({ id: msg.id, result })}\n`);
      if (msg.method === "turn/start" && requestApproval) socket.write(`${JSON.stringify({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: "original-thread" } })}\n`);
    });
  });
  server.listen(socketPath); await once(server, "listening");
  t.after(async () => { for (const s of sockets) s.destroy(); await new Promise((done) => server.close(done)); });
  const cliPath = join(dir, "codex-unit-proxy.mjs");
  await writeFile(cliPath, `#!/usr/bin/env node\nimport net from 'node:net';\nif (process.argv.slice(2,5).join(' ') !== 'app-server proxy --sock') process.exit(2);\nconst s=net.connect(process.argv[5]);\nprocess.stdin.pipe(s);s.pipe(process.stdout);s.on('close',()=>process.exit(0));s.on('error',()=>process.exit(1));\n`, { mode: 0o700 });
  const host = await connectCodexHost({ cliPath, socketPath, timeoutMs: 1500, onHostRequest, onNotification });
  t.after(() => host.close());
  return { host, messages };
}

for (const active of [false, true]) test(`JSONL turn/start uses standalone toolOutput and inherited settings (${active ? "active" : "idle"} fixture)`, async (t) => {
  const f = await protocolFixture(t, { active });
  const delivered = await f.host.deliverReport("original-thread", report);
  assert.equal(delivered.state, "host_accepted");
  assert.equal(delivered.turnId, active ? "active-turn" : "new-turn");
  assert.deepEqual(f.messages.find((m) => m.method === "turn/start").params, { threadId: "original-thread", input: [], toolOutput: reportToolOutput(report) });
  assert.equal(f.messages.some((m) => m.method === "thread/resume" || m.method === "thread/start"), false);
});

test("JSONL connection loss after turn/start is explicitly uncertain", async (t) => {
  const f = await protocolFixture(t, { loseAfterTurn: true });
  await assert.rejects(f.host.deliverReport("original-thread", report), (err) => err instanceof CodexHostError && err.uncertain === true && err.code === "disconnected");
});

test("approval requests remain pending for the existing UI and are surfaced without an automatic decision", async (t) => {
  const notifications = [];
  const f = await protocolFixture(t, { requestApproval: true, onNotification: (n) => notifications.push(n) });
  await f.host.deliverReport("original-thread", report);
  await waitUntil(() => notifications.some((n) => n.method === "parallelsandbox/hostRequestRequired"));
  assert.equal(f.messages.some((m) => m.id === "approval-1"), false);
  assert.equal(f.host.pendingHostRequests()[0].method, "item/commandExecution/requestApproval");
  assert.equal(notifications.find((n) => n.method === "parallelsandbox/hostRequestRequired").params.method, "item/commandExecution/requestApproval");
});

test("an explicitly supplied host UI request handler can answer its own approval request", async (t) => {
  const handled = [];
  const f = await protocolFixture(t, { requestApproval: true, onHostRequest: async (request) => { handled.push(request); return { decision: "decline" }; } });
  await f.host.deliverReport("original-thread", report);
  await waitUntil(() => f.messages.some((m) => m.id === "approval-1"));
  assert.equal(handled[0].method, "item/commandExecution/requestApproval");
  assert.deepEqual(f.messages.find((m) => m.id === "approval-1"), { id: "approval-1", result: { decision: "decline" } });
  assert.deepEqual(f.host.pendingHostRequests(), []);
});
