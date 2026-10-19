import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attachReview, codexThreadId, createFeedbackRoute, followUpText, hostCodexCli, mailFor, paths, readJson, runRelay, takeMail, ticketKey, writeJson } from "./feedback-relay.mjs";
import { foregroundHookArgs, hookInput, hostAncestors, hostGone, hostRunsHookInForeground, isClaudeCodeHook, reviewAwaitsPerson, reviewFromResult, runHook } from "./feedback-hook.mjs";
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

// `claude -p "<prompt>"` 會把 asyncRewake 掛勾放在前景跑：工具結果要等掛勾結束。10/19 讀完 sandbox_report 後掛勾等下一則回饋，
// 那份回報卡了 42 分鐘沒交給 AI。前景只有剛交件、還在等人的那次會等；sandbox_report 與 SessionStart 只交出已到的回饋就走。
test("claude -p runs the hook in the foreground: only an open review waits, sandbox_report returns at once", async () => {
  assert.equal(foregroundHookArgs(["claude", "--model", "x", "-p", "do", "it", "--output-format", "stream-json"]), true);
  assert.equal(foregroundHookArgs(["claude", "--print", "--input-format", "stream-json", "--output-format", "stream-json"]), false, "SDK and native supervisor");
  assert.equal(foregroundHookArgs(["claude", "-p", "--input-format=stream-json"]), false);
  assert.equal(foregroundHookArgs(["claude", "--output-format", "stream-json", "--input-format", "stream-json", "--resume=x"]), false, "desktop app");
  assert.equal(foregroundHookArgs(["claude"]), false, "interactive CLI");
  const args = { 42: ["claude", "-p", "hi"], 7: ["sh", "-c", "npx"], 8: ["claude", "-p", "hi"] };
  const argsOf = async (pid) => args[pid] || [];
  assert.equal(await hostRunsHookInForeground({ env: { CLAUDE_PID: "42" }, argsOf }), true);
  assert.equal(await hostRunsHookInForeground({ env: { CLAUDE_PID: "7" }, argsOf }), false);
  const parents = { [process.ppid]: 7, 7: 8, 8: 1 };
  assert.equal(await hostRunsHookInForeground({ env: {}, argsOf: async (pid) => (pid === process.ppid ? ["npm", "exec"] : args[pid] || []), ps: async (pid) => ({ ppid: parents[pid] ?? 1 }) }), true, "older Claude Code without CLAUDE_PID");

  const REV = "068966a4b7d5ef6dc057";
  const open = { content: [{ type: "text", text: JSON.stringify({ reviewId: REV, status: "waiting", waitSec: 0 }) }] };
  assert.equal(reviewAwaitsPerson(open), true);
  assert.equal(reviewAwaitsPerson({ content: [{ type: "text", text: JSON.stringify({ reviewId: REV, outcome: "timed_out" }) }] }), true);
  assert.equal(reviewAwaitsPerson({ content: [{ type: "text", text: JSON.stringify({ reviewId: REV, outcome: "report", reportId: RID }) }] }), false);
  assert.equal(reviewAwaitsPerson({ content: [{ type: "text", text: JSON.stringify({ reviewId: REV, outcome: "done" }) }] }), false);

  const env = { CLAUDE_CODE_SESSION_ID: "s1" };
  const fg = async () => true;
  const report = { hook_event_name: "PostToolUse", session_id: "s1", tool_name: "mcp__parallelsandbox__sandbox_report", tool_input: { id: "box1", reportId: RID }, tool_response: [{ type: "text", text: "{}" }] };
  // 回報已讀、信箱沒有下一則：馬上回來，不等。
  let dir = await mailed("claude-code", "s1");
  assert.equal(await runHook({ host: "claude-code", dir, env, foreground: fg, raw: { hook_event_name: "SessionStart", session_id: "s1" }, err: () => {} }), 2);
  let started = Date.now();
  assert.equal(await runHook({ host: "claude-code", dir, env, foreground: fg, raw: report }), 0);
  assert.equal(await runHook({ host: "claude-code", dir, env, foreground: fg, raw: { hook_event_name: "SessionStart", session_id: "s1", source: "resume" } }), 0);
  assert.ok(Date.now() - started < 1500, "sandbox_report and SessionStart never wait in the foreground");
  // 已經到的下一則照樣交出去。
  dir = await mailed("claude-code", "s1");
  let err = "";
  assert.equal(await runHook({ host: "claude-code", dir, env, foreground: fg, raw: report, err: (s) => { err = s; } }), 2);
  assert.match(err, /sandbox_report/);
  // 剛交件、還在等人：前景照樣等到回報進來。
  dir = await mailed("claude-code", "s1");
  const review = { hook_event_name: "PostToolUse", session_id: "s1", tool_name: "mcp__parallelsandbox__sandbox_review", tool_input: { id: "box1" }, tool_response: open.content };
  assert.equal(await runHook({ host: "claude-code", dir, env, foreground: fg, raw: review, err: () => {} }), 2);
  // 交件結果已經帶回報：不再等下一則。
  dir = await mailed("claude-code", "s1");
  assert.equal(await runHook({ host: "claude-code", dir, env, foreground: fg, raw: { hook_event_name: "SessionStart", session_id: "s1" }, err: () => {} }), 2);
  started = Date.now();
  const answered = { ...review, tool_response: [{ type: "text", text: JSON.stringify({ reviewId: REV, outcome: "report", reportId: RID }) }] };
  assert.equal(await runHook({ host: "claude-code", dir, env, foreground: fg, raw: answered }), 0);
  assert.ok(Date.now() - started < 1500);
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
  assert.match(note.usage, /ask them now, in this conversation, whether you may run this once: .*install claude-code/);
  assert.match(reviewInstallNote("claude-code", { id: "b1", reviewId: "r1" }, { home, env }), /sandbox_review with \{"id":"b1","reviewId":"r1","waitSec":0\}/);
  const designNote = reviewInstallNote("claude-code", { id: "b1", reviewId: "dsn_abc" }, { home, env });
  assert.doesNotMatch(designNote, /call sandbox_review with/, "a design version cannot be re-registered through sandbox_review");
  assert.match(designNote, /read it with sandbox_report\. Versions you draw after the install return here on their own\./);
  install("claude-code", { home, env, command: "psbx" });
  assert.ok(existsSync(join(home, "cfg", "settings.json")), "CLAUDE_CONFIG_DIR is honored");
  assert.equal(hooksInstalled("claude-code", { home, env }), true);
  assert.equal(installNote("claude-code", { home, env }), null);
  assert.equal(installNote("gemini-cli-mcp-client", { home, env }).host, "gemini");
  assert.match(setupInstructions({ home, env }), /Gemini CLI: .*install gemini/);
  assert.match(reviewInstallNote("gemini-cli-mcp-client", { id: "b1", reviewId: "r1" }, { home, env }), /not routed automatically in this run/);
  assert.match(reviewInstallNote("gemini-cli-mcp-client", { id: "b1", reviewId: "dsn_abc" }, { home, env }), /Versions drawn after Gemini CLI restarts return here on their own\./);
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

// 草稿、架構圖、Schema 的每一版跟交件一樣回原對話：各家掛勾都要認得這三個工具，舊版裝的掛勾要被當成沒裝、提示重裝。
test("design tools route feedback like sandbox_review, and older hook installs ask to be reinstalled", () => {
  const home = tmp();
  const env = { CLAUDE_CONFIG_DIR: join(home, "cfg") };
  for (const host of ["claude-code", "gemini"]) {
    const matcher = Object.values(hostConfig(host, { home, env }).add).flat().map((e) => e.matcher).filter(Boolean)[0];
    for (const tool of ["sandbox_review", "sandbox_draft", "sandbox_architecture", "sandbox_schema"]) {
      assert.match(`mcp__parallelsandbox__${tool}`, new RegExp(matcher), `${host} matcher covers ${tool}`);
    }
  }
  install("claude-code", { home, env, command: "psbx" });
  assert.equal(hooksInstalled("claude-code", { home, env }), true);
  const file = join(home, "cfg", "settings.json");
  const old = readFileSync(file, "utf8").replace("sandbox_(review|report|draft|architecture|schema)", "sandbox_(review|report)");
  writeFileSync(file, old);
  assert.equal(hooksInstalled("claude-code", { home, env }), false, "an install from before the design tools is not current");
  install("claude-code", { home, env, command: "psbx" });
  assert.equal(hooksInstalled("claude-code", { home, env }), true);
});

test("a drawn design version attaches the conversation the same way a review does", async () => {
  const { attachFromTool } = await import("./feedback-hook.mjs");
  const dir = tmp();
  await route(dir).trackReview({ boxId: "box-1", reviewId: "dsn_abc123", clientName: "cursor-vscode" });
  const result = { content: [{ type: "text", text: JSON.stringify({ ok: true, id: "box-1", reviewId: "dsn_abc123", designId: "dsn_abc123", version: 2 }) }] };
  assert.ok(attachFromTool({ dir, host: "cursor", input: { session: "s1", tool: "mcp__parallelsandbox__sandbox_draft", input: { id: "box-1" }, result } }));
  assert.equal(attachFromTool({ dir, host: "cursor", input: { session: "s1", tool: "mcp__parallelsandbox__sandbox_status", input: { id: "box-1" }, result } }), false);
});

// ---------- one review that cannot be bound never holds up the others ----------
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await pause(5); }
}
// Three hook-host reviews, each attached to its own conversation S1..S3.
async function threeReviews(dir) {
  const reviews = ["rev1", "rev2", "rev3"];
  for (const [i, r] of reviews.entries()) {
    await route(dir).trackReview({ boxId: "box1", reviewId: r, clientName: "claude-code" });
    attachReview({ dir, host: "claude-code", session: `S${i + 1}`, boxId: "box1", reviewId: r });
  }
  return reviews;
}
const reportFor = (r) => ({ boxId: "box1", reviewId: r, reportId: `${r}-report` });
const mailedTo = (dir, i) => mailFor({ dir, host: "claude-code", session: `S${i + 1}` }).length;

test("a review the server refuses to bind is set aside: the others bind and get their feedback, and it is logged and tried once", async () => {
  const dir = tmp();
  const reviews = await threeReviews(dir);
  // The ticket the relay meets second (readdir order) was rewritten by another agent, as resuming a review did before 0.5.6.
  const order = readdirSync(paths(dir).tickets);
  const badIndex = reviews.findIndex((r) => `${ticketKey("box1", r)}.json` === order[1]);
  const bad = reviews[badIndex];
  const badFile = join(paths(dir).tickets, order[1]);
  writeJson(badFile, { ...readJson(badFile), agentId: "agentB" });
  const be = backend(reviews.map(reportFor));
  const binds = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (new URL(url).pathname === "/v1/feedback-consumers") {
      binds.push(body.reviewId);
      if (init.headers["X-Psbx-Agent"] !== "agentA") return json(403, { error: "only this review's original agent can bind feedback" });
    }
    if (url.endsWith("/claim")) await pause(10);
    return be.fetchImpl(url, init);
  };
  const lines = [];
  const print = (...a) => lines.push(a.join(" "));

  // One pass still reports the refusal, but only after the other two reviews were bound and delivered.
  await assert.rejects(runRelay({ dir, credKey: credOf(dir), fetchImpl, once: true, print }), /original agent can bind/);
  reviews.forEach((r, i) => assert.equal(mailedTo(dir, i), r === bad ? 0 : 1, `${r} mailed`));

  // A running relay logs the refusal once and does not ask again on later rounds.
  binds.length = 0; lines.length = 0;
  const stop = new AbortController();
  const running = runRelay({ dir, credKey: credOf(dir), fetchImpl, scanMs: 5, signal: stop.signal, print });
  await pause(300);
  assert.equal(binds.filter((r) => r === bad).length, 1, "not requested again every round");
  const refused = lines.filter((l) => l.includes("cannot bind review"));
  assert.equal(refused.length, 1, lines.join("\n"));
  assert.ok(refused[0].includes(`review ${bad} on box box1 (ticket ${order[1].slice(0, -5)}`) && refused[0].includes("HTTP 403"), refused[0]);
  assert.ok(reviews.filter((r) => r !== bad).every((r) => lines.some((l) => l.includes(`bound review ${r} `))));

  // Putting the original agent back into the ticket file makes the relay try it again, and it binds.
  writeJson(badFile, { ...readJson(badFile), agentId: "agentA" });
  await until(() => mailedTo(dir, badIndex) === 1);
  stop.abort();
  await running;
  assert.equal(binds.filter((r) => r === bad).length, 2);
});

test("a server error on one review backs off and binds later, without holding up the others", async () => {
  const dir = tmp();
  for (const [r, s] of [["rev1", "S1"], ["rev2", "S2"]]) {
    await route(dir).trackReview({ boxId: "box1", reviewId: r, clientName: "claude-code" });
    attachReview({ dir, host: "claude-code", session: s, boxId: "box1", reviewId: r });
  }
  const be = backend([reportFor("rev1"), reportFor("rev2")]);
  const attempts = [], bindsOk = [];
  let failures = 2;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (new URL(url).pathname === "/v1/feedback-consumers") {
      if (body.reviewId === "rev1") { attempts.push(Date.now()); if (failures-- > 0) return json(503, { error: "unavailable" }); }
      bindsOk.push({ reviewId: body.reviewId, at: Date.now() });
    }
    if (url.endsWith("/claim")) await pause(10);
    return be.fetchImpl(url, init);
  };
  const lines = [];
  const stop = new AbortController();
  const running = runRelay({ dir, credKey: credOf(dir), fetchImpl, scanMs: 5, bindRetryMs: 60, bindRetryMaxMs: 1000, signal: stop.signal, print: (...a) => lines.push(a.join(" ")) });
  await until(() => mailedTo(dir, 0) === 1);
  stop.abort();
  await running;
  assert.equal(attempts.length, 3, "two failures, then success");
  assert.ok(attempts[1] - attempts[0] >= 60, `first retry waited ${attempts[1] - attempts[0]}ms`);
  assert.ok(attempts[2] - attempts[1] >= 120, `second retry doubled to ${attempts[2] - attempts[1]}ms`);
  assert.equal(mailedTo(dir, 1), 1, "the other review was delivered");
  assert.ok(bindsOk.find((b) => b.reviewId === "rev2").at <= attempts[1], "the other review did not wait for the retry");
  assert.equal(lines.filter((l) => l.includes("cannot bind review rev1")).length, 1, "the same error is logged once");
  assert.ok(lines.some((l) => l.includes("bound review rev1 ")));
});

test("an unreadable ticket file is skipped without stopping the other reviews", async () => {
  const dir = tmp();
  await route(dir).trackReview({ boxId: "box1", reviewId: "rev1", clientName: "claude-code" });
  attachReview({ dir, host: "claude-code", session: "S1", boxId: "box1", reviewId: "rev1" });
  writeFileSync(join(paths(dir).tickets, `${"0".repeat(40)}.json`), "{");
  const lines = [];
  await runRelay({ dir, credKey: credOf(dir), fetchImpl: backend([reportFor("rev1")]).fetchImpl, once: true, print: (...a) => lines.push(a.join(" ")) });
  assert.equal(mailedTo(dir, 0), 1);
  assert.ok(lines.some((l) => l.includes(`cannot read ticket ${"0".repeat(40)}`)));
  let spawned = 0;
  await route(dir, { spawnRelay: async () => { spawned++; return { running: true }; } }).resumeRelay();
  assert.equal(spawned, 1, "a restart still finds the pending review");
});

test("resuming another agent's review keeps its original ticket; the same agent or an expired ticket is rewritten", async () => {
  const dir = tmp();
  const file = join(paths(dir).tickets, `${ticketKey("box1", "rev1")}.json`);
  await route(dir).trackReview({ boxId: "box1", reviewId: "rev1", clientName: "codex-mcp-client", meta: { threadId: T } });
  const original = readJson(file);
  let spawned = 0;
  const other = route(dir, { agentId: "agentB", spawnRelay: async () => { spawned++; return { running: true }; } });
  const kept = await other.trackReview({ boxId: "box1", reviewId: "rev1", clientName: "codex-mcp-client", meta: { threadId: "01a0f429-b209-77a2-b784-f314221e0c92" } });
  assert.deepEqual(readJson(file), original, "agent, Codex thread and client stay the original's");
  assert.deepEqual([kept.automatic, kept.reason], [false, "opened_by_another_agent"]);
  assert.match(kept.note, /keeps returning to the conversation that opened it/);
  assert.equal(spawned, 1, "the relay is still kept running for the original ticket");

  await route(dir).trackReview({ boxId: "box1", reviewId: "rev1", clientName: "claude-code" });
  const same = readJson(file);
  assert.deepEqual([same.agentId, same.client, same.codex], ["agentA", "claude-code", undefined], "the same agent updates its ticket as before");

  writeJson(file, { ...same, expiresAt: Date.now() - 1 });
  const taken = await other.trackReview({ boxId: "box1", reviewId: "rev1", clientName: "claude-code" });
  assert.equal(readJson(file).agentId, "agentB", "an expired ticket no longer holds the route");
  assert.equal(taken.automatic, "when_hooks_installed");
});
