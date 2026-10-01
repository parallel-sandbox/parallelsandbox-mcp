import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attachReview, codexThreadId, createFeedbackRoute, followUpText, hostCodexCli, mailFor, paths, readJson, runRelay, takeMail, ticketKey } from "./feedback-relay.mjs";
import { hookInput, hostAncestors, hostGone, isClaudeCodeHook, reviewFromResult, runHook } from "./feedback-hook.mjs";
import { hooksInstalled, hostConfig, hostFromClient, install, installNote, mergeHooks, reviewInstallNote, selfCommand, setupInstructions } from "./feedback-install.mjs";

const T = "01a0f429-b209-77a2-b784-f314221e0c91";
const RID = "11111111-2222-3333-4444-555555555555";
const tmp = () => mkdtempSync(join(tmpdir(), "psbx-fr-"));
const json = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), { status });
const route = (dir, over = {}) => createFeedbackRoute({ apiUrl: "https://api.test/", mcpUrl: "https://mcp.test/mcp", agentId: "agentA", headers: {}, env: { PARALLELSANDBOX_API_KEY: "k" }, dir,
  authorizedFetch: async () => json(200, {}), findCli: async () => "/abs/codex", spawnRelay: async () => ({ running: true }), ...over });
const credOf = (dir, box = "box1", review = "rev1") => readJson(join(paths(dir).tickets, `${ticketKey(box, review)}.json`)).credKey;

// A fake backend: one report waits on each bound review until acknowledged.
function backend(reports) {
  const calls = [], bound = new Map(), acked = new Map();
  let lease = 0;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body), path = new URL(url).pathname, agent = init.headers["X-Psbx-Agent"];
    calls.push({ path, body, agent });
    if (path === "/v1/feedback-consumers") { bound.set(body.reviewId, body.consumerId); return json(200, { ok: true }); }
    const consumer = decodeURIComponent(path.split("/")[3]);
    if (path.endsWith("/claim")) {
      const r = reports.find((x) => bound.get(x.reviewId) === consumer && !acked.has(x.reportId));
      return json(200, { events: r ? [{ eventId: `ev-${r.reportId}`, boxId: r.boxId, reviewId: r.reviewId, reportId: r.reportId, leaseToken: `l${++lease}` }] : [] });
    }
    if (path.endsWith("/ack")) { acked.set(body.reportId, body.state); return json(200, { ok: true }); }
    return json(404, {});
  };
  return { fetchImpl, calls, bound, acked };
}

test("thread comes only from Codex tools/call _meta", () => {
  assert.equal(codexThreadId({ threadId: T, "x-codex-turn-metadata": { thread_id: T } }, "codex-mcp-client"), T);
  assert.equal(codexThreadId({ threadId: T }, "claude-code"), "");
  assert.equal(codexThreadId({ threadId: "nope" }, "codex-mcp-client"), "");
  assert.equal(codexThreadId({ threadId: T, "x-codex-turn-metadata": { thread_id: "01a0f429-b209-77a2-b784-000000000000" } }, "codex-mcp-client"), "");
});

test("host CLI is the codex process that launched the adapter", async () => {
  const tree = { 10: { ppid: 9, exe: "npm" }, 9: { ppid: 8, exe: "/Applications/X.app/Contents/MacOS/codex" } };
  assert.equal(await hostCodexCli({ env: {}, pid: 10, ps: async (pid) => tree[pid] }), "/Applications/X.app/Contents/MacOS/codex");
  assert.equal(await hostCodexCli({ env: {}, pid: 10, ps: async () => null }), "");
});

test("Codex review: ticket names the thread, relay queues one follow-up and acknowledges it", async () => {
  const dir = tmp();
  const out = await route(dir).trackReview({ boxId: "box1", reviewId: "rev1", clientName: "codex-mcp-client", meta: { threadId: T } });
  assert.equal(out.automatic, true);
  const be = backend([{ boxId: "box1", reviewId: "rev1", reportId: RID }]);
  const queued = [];
  await runRelay({ dir, credKey: credOf(dir), fetchImpl: be.fetchImpl, once: true, queue: async (t, msg) => { queued.push({ t, msg }); return "q1"; } });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].t.threadId, T);
  assert.equal(queued[0].t.cliPath, "/abs/codex");
  assert.match(queued[0].msg, /exactly \{"id":"box1","reportId":"11111111-2222-3333-4444-555555555555"\}/);
  assert.equal(be.bound.get("rev1").slice(0, 3), "fr_");
  assert.equal(be.calls[0].body.host, "codex");
  assert.equal(be.acked.get(RID), "host_accepted");
  assert.ok(be.calls.every((c) => c.agent === "agentA"));
});

test("hook host: nothing is registered until the conversation's hook attaches", async () => {
  const dir = tmp();
  const out = await route(dir).trackReview({ boxId: "box1", reviewId: "rev1", clientName: "claude-code" });
  assert.equal(out.automatic, "when_hooks_installed");
  const be = backend([{ boxId: "box1", reviewId: "rev1", reportId: RID }]);
  await runRelay({ dir, credKey: credOf(dir), fetchImpl: be.fetchImpl, once: true });
  assert.equal(be.calls.length, 0);
});

test("hook host: attached review is mailed, taken once, then acknowledged", async () => {
  const dir = tmp();
  await route(dir).trackReview({ boxId: "box1", reviewId: "rev1", clientName: "claude-code" });
  assert.equal(attachReview({ dir, host: "claude-code", session: "S1", boxId: "box1", reviewId: "rev1" }), true);
  assert.equal(attachReview({ dir, host: "claude-code", session: "S2", boxId: "box1", reviewId: "rev1" }), false, "one review, one conversation");
  const be = backend([{ boxId: "box1", reviewId: "rev1", reportId: RID }]);
  await runRelay({ dir, credKey: credOf(dir), fetchImpl: be.fetchImpl, once: true });
  assert.equal(be.calls[0].body.host, "claude-code");
  assert.equal(be.acked.size, 0, "not accepted before the conversation takes it");
  assert.equal(mailFor({ dir, host: "claude-code", session: "S2" }).length, 0);
  const [entry] = mailFor({ dir, host: "claude-code", session: "S1" });
  assert.match(entry.mail.text, /sandbox_report tool/);
  assert.equal(takeMail(entry, "w1"), true);
  assert.equal(takeMail(entry, "w2"), false);
  await runRelay({ dir, credKey: credOf(dir), fetchImpl: be.fetchImpl, once: true });
  assert.equal(be.acked.get(RID), "host_accepted");
});

test("a failed acknowledgement never queues the same Codex report twice", async () => {
  const dir = tmp();
  await route(dir).trackReview({ boxId: "box1", reviewId: "rev1", clientName: "codex-mcp-client", meta: { threadId: T } });
  const be = backend([{ boxId: "box1", reviewId: "rev1", reportId: RID }]);
  let fail = true, queued = 0;
  const fetchImpl = (url, init) => url.endsWith("/ack") && fail ? json(500, { error: "boom" }) : be.fetchImpl(url, init);
  await assert.rejects(runRelay({ dir, credKey: credOf(dir), fetchImpl, once: true, queue: async () => { queued++; return "q"; } }));
  fail = false;
  await runRelay({ dir, credKey: credOf(dir), fetchImpl, once: true, queue: async () => { queued++; return "q"; } });
  assert.equal(queued, 1);
  assert.equal(be.acked.get(RID), "host_accepted");
});

test("reading the exact report acknowledges read with the consumer owner", async () => {
  const dir = tmp();
  await route(dir).trackReview({ boxId: "box1", reviewId: "rev1", clientName: "codex-mcp-client", meta: { threadId: T } });
  const be = backend([{ boxId: "box1", reviewId: "rev1", reportId: RID }]);
  await runRelay({ dir, credKey: credOf(dir), fetchImpl: be.fetchImpl, once: true, queue: async () => "q" });
  const acks = [];
  const reader = route(dir, { agentId: "agentB", authorizedFetch: async (url, init) => { acks.push({ body: JSON.parse(init.body), agent: init.headers["X-Psbx-Agent"] }); return json(200, {}); } });
  assert.equal(await reader.onReportRead({ boxId: "box1", reportId: "other" }), false);
  assert.equal(await reader.onReportRead({ boxId: "box1", reportId: RID }), true);
  assert.deepEqual([acks[0].body.state, acks[0].agent], ["read", "agentA"]);
  assert.equal(await reader.onReportRead({ boxId: "box1", reportId: RID }), false);
});

test("a report read before the relay acknowledged acceptance still becomes read", async () => {
  const dir = tmp();
  await route(dir).trackReview({ boxId: "box1", reviewId: "rev1", clientName: "claude-code" });
  attachReview({ dir, host: "claude-code", session: "S1", boxId: "box1", reviewId: "rev1" });
  const be = backend([{ boxId: "box1", reviewId: "rev1", reportId: RID }]);
  await runRelay({ dir, credKey: credOf(dir), fetchImpl: be.fetchImpl, once: true });
  takeMail(mailFor({ dir, host: "claude-code", session: "S1" })[0], "w");
  const acks = [];
  await route(dir, { authorizedFetch: async (url, init) => { acks.push(JSON.parse(init.body).state); return json(200, {}); } }).onReportRead({ boxId: "box1", reportId: RID });
  assert.deepEqual(acks, ["read"]);
  await runRelay({ dir, credKey: credOf(dir), fetchImpl: be.fetchImpl, once: true });
  assert.equal(be.acked.get(RID), "read", "a re-claimed read report is acknowledged read, never downgraded");
});

test("hook input: review id is found in each host's result shape", () => {
  const payload = JSON.stringify({ ok: true, reviewId: "b9dceef8e5d99c4d2607", appURL: "x" });
  assert.equal(reviewFromResult([{ type: "text", text: payload }]), "b9dceef8e5d99c4d2607");
  assert.equal(reviewFromResult({ content: [{ type: "text", text: payload }] }), "b9dceef8e5d99c4d2607");
  assert.equal(reviewFromResult(JSON.stringify({ content: [{ type: "text", text: payload }] })), "b9dceef8e5d99c4d2607");
  assert.equal(reviewFromResult("not json"), "");
  assert.equal(reviewFromResult({ llmContent: [{ text: `<untrusted_context>\n${payload}\n</untrusted_context>` }] }), "b9dceef8e5d99c4d2607", "Gemini CLI wraps MCP text");
  const c = hookInput("cursor", { conversation_id: "c1", tool_name: "sandbox_review", tool_input: JSON.stringify({ id: "box1" }), result_json: JSON.stringify({ content: [{ type: "text", text: payload }] }) });
  assert.deepEqual([c.session, c.input.id, reviewFromResult(c.result)], ["c1", "box1", "b9dceef8e5d99c4d2607"]);
});

async function mailed(host, session) {
  const dir = tmp();
  await route(dir).trackReview({ boxId: "box1", reviewId: "rev1", clientName: host });
  attachReview({ dir, host, session, boxId: "box1", reviewId: "rev1" });
  await runRelay({ dir, credKey: credOf(dir), fetchImpl: backend([{ boxId: "box1", reviewId: "rev1", reportId: RID }]).fetchImpl, once: true });
  return dir;
}

test("Cursor stop hook returns the follow-up; Gemini AfterAgent blocks with it; Claude exits 2", async () => {
  let out = "";
  let dir = await mailed("cursor", "c1");
  assert.equal(await runHook({ host: "cursor", dir, raw: { hook_event_name: "stop", conversation_id: "c1", status: "completed" }, out: (s) => { out = s; } }), 0);
  assert.match(JSON.parse(out).followup_message, /sandbox_report/);
  dir = await mailed("gemini", "g1");
  await runHook({ host: "gemini", dir, raw: { hook_event_name: "AfterAgent", session_id: "g1" }, out: (s) => { out = s; } });
  assert.equal(JSON.parse(out).decision, "block");
  assert.match(JSON.parse(out).reason, /sandbox_report/);
  dir = await mailed("claude-code", "s1");
  let err = "";
  assert.equal(await runHook({ host: "claude-code", dir, env: { CLAUDE_CODE_SESSION_ID: "s1" }, raw: { hook_event_name: "SessionStart", session_id: "s1" }, err: (s) => { err = s; } }), 2);
  assert.match(err, /sandbox_report/);
});

test("end-of-turn hooks do not hold conversations that expect no feedback", async () => {
  const dir = tmp();
  let out = "";
  const started = Date.now();
  await runHook({ host: "cursor", dir, raw: { hook_event_name: "stop", conversation_id: "none", status: "completed" }, out: (s) => { out = s; } });
  assert.equal(out, "{}");
  assert.ok(Date.now() - started < 1500);
  assert.equal(await runHook({ host: "claude-code", dir, env: { CLAUDE_CODE_SESSION_ID: "none" }, raw: { hook_event_name: "SessionStart", session_id: "none" } }), 0);
});

test("a waiter whose host is gone takes nothing", async () => {
  const chain = await hostAncestors(async () => ({ ppid: 1 }));
  assert.deepEqual(chain, [process.ppid]);
  assert.equal(hostGone(chain), false);
  assert.equal(hostGone([process.ppid, 999999]), true, "dead grandparent host");
  assert.equal(hostGone([123456789]), true, "reparented hook");
});

test("installer merges hooks idempotently and keeps other settings", () => {
  const config = hostConfig("claude-code", { home: "/h" });
  const once = mergeHooks({ model: "x", hooks: { PostToolUse: [{ matcher: "Bash", hooks: [] }] } }, config);
  const twice = mergeHooks(once, config);
  assert.equal(twice.model, "x");
  assert.equal(twice.hooks.PostToolUse.length, 2);
  assert.equal(twice.hooks.PostToolUse[1].hooks[0].asyncRewake, true);
  assert.equal(mergeHooks({}, hostConfig("cursor", { home: "/h" })).version, 1);
  assert.equal(hostConfig("gemini", { home: "/h" }).add.AfterAgent[0].hooks[0].timeout, 1_800_000);
  assert.ok(!existsSync("/h"));
  assert.ok(readFileSync(new URL("./feedback-relay.mjs", import.meta.url), "utf8").includes("codex queue"));
  assert.equal(followUpText({ boxId: "b", reviewId: "r", reportId: "x" }).includes("leaseToken"), false);
  assert.ok(Array.isArray(readdirSync(tmpdir())));
});

test("usage note appears only for a hook host without hooks, and disappears after install", () => {
  assert.deepEqual(["codex-mcp-client", "claude-code", "cursor-vscode", "Cursor", "gemini-cli-mcp-client", "other"].map((n) => hostFromClient(n)), ["codex", "claude-code", "cursor", "cursor", "gemini", ""]);
  const home = tmp();
  const env = { CLAUDE_CONFIG_DIR: join(home, "cfg") };
  assert.equal(installNote("codex-mcp-client", { home, env }), null);
  assert.equal(installNote("unknown", { home, env }), null);
  const note = installNote("claude-code", { home, env });
  assert.match(note.usage, /Run this command once now: .*install claude-code/);
  assert.match(reviewInstallNote("claude-code", { id: "b1", reviewId: "r1" }, { home, env }), /sandbox_review with \{"id":"b1","reviewId":"r1","waitSec":0\}/);
  install("claude-code", { home, env, command: "psbx" });
  assert.ok(existsSync(join(home, "cfg", "settings.json")), "CLAUDE_CONFIG_DIR is honored");
  assert.equal(hooksInstalled("claude-code", { home, env }), true);
  assert.equal(installNote("claude-code", { home, env }), null);
  assert.equal(installNote("gemini-cli-mcp-client", { home, env }).host, "gemini");
  assert.match(setupInstructions({ home, env }), /Gemini CLI: .*install gemini/);
  assert.match(reviewInstallNote("gemini-cli-mcp-client", { id: "b1", reviewId: "r1" }, { home, env }), /not routed automatically in this run/);
  assert.doesNotMatch(setupInstructions({ home, env }), /Claude Code:/);
  install("gemini", { home, env, command: "psbx" });
  assert.equal(installNote("gemini-cli-mcp-client", { home, env }), null);
  install("cursor", { home, env, command: "psbx" });
  assert.equal(setupInstructions({ home, env }), "", "nothing to say once every client is set up");
  assert.equal(selfCommand("/u/.npm/_npx/abc/node_modules/parallelsandbox-mcp/index.mjs"), "npx -y parallelsandbox-mcp");
  assert.equal(selfCommand("/src/pkg/index.mjs", "/bin/node"), '"/bin/node" "/src/pkg/index.mjs"');
});

test("the Claude Code route never runs inside Cursor or another client that loads Claude hooks", async () => {
  const claude = { session_id: "s1", transcript_path: "/h/.claude/projects/p/s1.jsonl", hook_event_name: "PostToolUse" };
  assert.equal(isClaudeCodeHook(claude, { CLAUDE_CODE_SESSION_ID: "s1" }), true);
  assert.equal(isClaudeCodeHook(claude, { CLAUDE_CODE_SESSION_ID: "other" }), false, "inherited from a parent Claude session");
  assert.equal(isClaudeCodeHook(claude, { CLAUDECODE: "1" }), true, "older Claude Code");
  assert.equal(isClaudeCodeHook({ ...claude, conversation_id: "c1", cursor_version: "3.21" }, { CLAUDE_CODE_SESSION_ID: "s1" }), false, "Cursor");
  assert.equal(isClaudeCodeHook(claude, { CLAUDECODE: "1", CURSOR_TRACE_ID: "x" }), false);
  assert.equal(isClaudeCodeHook({ session_id: "t1", transcript_path: "/h/.codex/sessions/rollout-t1.jsonl" }, {}), false, "Codex");
  // Even with a mailed report waiting, a Claude-format hook under Cursor returns at once and takes nothing.
  const dir = await mailed("claude-code", "s1");
  const started = Date.now();
  assert.equal(await runHook({ host: "claude-code", dir, env: {}, raw: { ...claude, conversation_id: "c1" } }), 0);
  assert.ok(Date.now() - started < 500);
  assert.equal(mailFor({ dir, host: "claude-code", session: "s1" }).length, 1);
});
