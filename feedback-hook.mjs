// Host hook for App feedback (see feedback-relay.mjs). One script, three hosts:
//   claude-code  PostToolUse / SessionStart with asyncRewake: waits in the background and
//                wakes the idle conversation by exiting 2 with the follow-up on stderr.
//   cursor       afterMCPExecution attaches the review; stop returns {followup_message}.
//   gemini       AfterTool attaches the review; AfterAgent returns {decision:"block", reason}.
// Cursor and Gemini have no idle wake: their end-of-turn hook holds for a bounded time right
// after a review was requested, and otherwise hands over waiting feedback at the next turn end.
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { alive, attachReview, parentOf, defaultFeedbackDir, mailFor, orNull, paths, privateDir, readJson, sessionExpectsFeedback, sessionKey, takeMail, ticketKey } from "./feedback-relay.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// sandbox_review results are MCP content; the JSON payload may sit in text blocks, nested
// objects or a JSON string, depending on the host.
export function reviewFromResult(value, depth = 0) {
  if (depth > 6 || value == null) return "";
  if (typeof value === "string") {
    const s = value.trim();
    try { if (s.startsWith("{") || s.startsWith("[")) return reviewFromResult(JSON.parse(s), depth + 1); } catch { /* try the embedded object below */ }
    // Some hosts wrap tool text, e.g. Gemini CLI's <untrusted_context>…</untrusted_context>.
    const start = s.indexOf("{"), end = s.lastIndexOf("}");
    if (start < 0 || end <= start || (start === 0 && end === s.length - 1)) return "";
    try { return reviewFromResult(JSON.parse(s.slice(start, end + 1)), depth + 1); } catch { return ""; }
  }
  if (Array.isArray(value)) { for (const v of value) { const r = reviewFromResult(v, depth + 1); if (r) return r; } return ""; }
  if (typeof value === "object") {
    if (typeof value.reviewId === "string" && value.ok !== false && /^[A-Za-z0-9_-]{6,128}$/.test(value.reviewId)) return value.reviewId;
    for (const v of Object.values(value)) { const r = reviewFromResult(v, depth + 1); if (r) return r; }
  }
  return "";
}

const parseMaybe = (v) => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return v; } };

// Normalizes each host's hook input to {session, tool, input, result}.
export function hookInput(host, raw) {
  if (host === "cursor") return { session: raw.conversation_id, tool: raw.tool_name, input: parseMaybe(raw.tool_input), result: parseMaybe(raw.result_json), status: raw.status };
  return { session: raw.session_id, tool: raw.tool_name, input: parseMaybe(raw.tool_input), result: raw.tool_response ?? raw.tool_result, source: raw.source };
}

export function attachFromTool({ dir, host, input }) {
  if (!/sandbox_review$/.test(input.tool || "")) return false;
  const boxId = input.input?.id;
  const reviewId = reviewFromResult(input.result);
  if (typeof boxId !== "string" || !reviewId) return false;
  return attachReview({ dir, host, session: input.session, boxId, reviewId });
}

// A bounded end-of-turn hold only right after a review was attached and before any report came.
export function shouldHold({ dir, host, session, holdMs, now = Date.now() }) {
  const p = paths(dir);
  for (const name of orNull(() => readdirSync(p.attach)) || []) {
    const a = orNull(() => readJson(join(p.attach, name)));
    if (!a || a.host !== host || a.session !== session || now - a.at > holdMs) continue;
    if (a.delivered) continue;
    return true;
  }
  return false;
}

function markDelivered(dir, mail) {
  const p = paths(dir);
  const file = join(p.attach, `${ticketKey(mail.boxId, mail.reviewId)}.json`);
  const a = orNull(() => readJson(file));
  if (a && !a.delivered) writeFileSync(file, JSON.stringify({ ...a, delivered: Date.now() }), { mode: 0o600 });
}

// A waiter whose host process is gone must never take a follow-up it cannot hand over.
// Hooks may run under an intermediate shell, so the parent and grandparent are both checked.
export const hostGone = (ancestors) => ancestors.length > 0 && (process.ppid !== ancestors[0] || ancestors.some((pid) => !alive(pid)));

async function waitForMail({ dir, host, session, until, by, ancestors = [] }) {
  for (;;) {
    if (hostGone(ancestors)) return null;
    for (const entry of mailFor({ dir, host, session })) {
      if (takeMail(entry, by)) { markDelivered(dir, entry.mail); return entry.mail; }
    }
    if (Date.now() >= until) return null;
    await sleep(Math.min(1000, until - Date.now()));
  }
}

// The hook's parent and, when there is one, its grandparent (the host behind `sh -c`).
export async function hostAncestors(ps = parentOf) {
  const chain = [];
  let pid = process.ppid;
  for (let i = 0; i < 2 && pid > 1; i++) {
    chain.push(pid);
    pid = (await ps(pid).catch(() => null))?.ppid ?? 0;
  }
  return chain;
}

// Cursor runs Claude Code hooks from ~/.claude/settings.json by default (without asyncRewake), and other
// clients may import them. The Claude route acts only inside the Claude Code conversation that runs it.
export function isClaudeCodeHook(raw, env = process.env) {
  if (raw.conversation_id !== undefined || raw.cursor_version !== undefined) return false;
  if (env.CLAUDE_CODE_SESSION_ID) return env.CLAUDE_CODE_SESSION_ID === raw.session_id;
  return env.CLAUDECODE === "1" && !Object.keys(env).some((k) => k.startsWith("CURSOR_"))
    && typeof raw.transcript_path === "string" && basename(raw.transcript_path) === `${raw.session_id}.jsonl`;
}

export async function runHook({ host, raw, dir = defaultFeedbackDir(), env = process.env, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) }) {
  if (host === "claude-code" && !isClaudeCodeHook(raw, env)) return 0;
  const input = hookInput(host, raw);
  if (typeof input.session !== "string" || !input.session) return 0;
  const event = raw.hook_event_name || "";
  const holdMs = Number(env.PSBX_HOOK_HOLD_SEC || 1200) * 1000;
  if (input.tool) attachFromTool({ dir, host, input });

  if (host === "claude-code") {
    // One background waiter per conversation; the next one starts at the next review/report call.
    if (!sessionExpectsFeedback({ dir, host, session: input.session })) return 0;
    const run = privateDir(paths(dir).run);
    const lock = join(run, `waiter-${sessionKey(host, input.session)}.pid`);
    const holder = Number(orNull(() => readFileSync(lock, "utf8")) || 0);
    if (holder && holder !== process.pid && alive(holder)) return 0;
    writeFileSync(lock, String(process.pid), { mode: 0o600 });
    try {
      const mail = await waitForMail({ dir, host, session: input.session, until: Date.now() + 7 * 24 * 3600_000, by: `claude:${process.pid}`, ancestors: await hostAncestors() });
      if (!mail) return 0;
      err(mail.text + "\n");
      return 2; // asyncRewake: wakes the idle conversation, or queues behind the running turn.
    } finally { if (Number(orNull(() => readFileSync(lock, "utf8"))) === process.pid) orNull(() => unlinkSync(lock)); }
  }

  const endOfTurn = (host === "cursor" && event === "stop") || (host === "gemini" && event === "AfterAgent");
  if (!endOfTurn) { out("{}"); return 0; }
  if (host === "cursor" && input.status && input.status !== "completed") { out("{}"); return 0; }
  const hold = shouldHold({ dir, host, session: input.session, holdMs });
  const mail = await waitForMail({ dir, host, session: input.session, until: Date.now() + (hold ? holdMs : 0) + 1, by: `${host}:${process.pid}`, ancestors: hold ? await hostAncestors() : [] });
  if (!mail) { out("{}"); return 0; }
  out(JSON.stringify(host === "cursor" ? { followup_message: mail.text } : { decision: "block", reason: mail.text }));
  return 0;
}

export async function hookMain(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--host");
  const host = i >= 0 ? argv[i + 1] : "";
  if (!["claude-code", "cursor", "gemini"].includes(host)) { process.stderr.write("hook --host <claude-code|cursor|gemini>\n"); return 0; }
  let raw = {};
  try { raw = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* Never break the host over a malformed input. */ }
  try { return await runHook({ host, raw }); }
  catch (e) { process.stderr.write(`parallelsandbox hook: ${e?.message || e}\n`); if (host !== "claude-code") process.stdout.write("{}"); return 0; }
}
