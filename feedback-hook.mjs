// Host hook for App feedback (see feedback-relay.mjs). One script, three hosts:
//   claude-code  PostToolUse / SessionStart with asyncRewake: waits in the background and
//                wakes the idle conversation by exiting 2 with the follow-up on stderr.
//                `claude -p "<prompt>"` runs the same hook in the foreground instead: the tool
//                result waits for it, so there only a fresh review waits for the person.
//   cursor       afterMCPExecution attaches the review; stop returns {followup_message}.
//   gemini       AfterTool attaches the review; AfterAgent returns {decision:"block", reason}.
// Cursor and Gemini have no idle wake: their end-of-turn hook holds for a bounded time right
// after a review was requested, and otherwise hands over waiting feedback at the next turn end.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { alive, attachReview, attachSiblings, parentOf, defaultFeedbackDir, isDesignVersion, mailFor, orNull, paths, privateDir, readJson, sessionExpectsFeedback, takeMail, ticketKey, waiterPidFile } from "./feedback-relay.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REVIEW_TOOL = /sandbox_(review|draft|architecture|schema)$/;

// sandbox_review results are MCP content; the JSON payload may sit in text blocks, nested
// objects or a JSON string, depending on the host.
function reviewPayload(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (typeof value === "string") {
    const s = value.trim();
    try { if (s.startsWith("{") || s.startsWith("[")) return reviewPayload(JSON.parse(s), depth + 1); } catch { /* try the embedded object below */ }
    // Some hosts wrap tool text, e.g. Gemini CLI's <untrusted_context>…</untrusted_context>.
    const start = s.indexOf("{"), end = s.lastIndexOf("}");
    if (start < 0 || end <= start || (start === 0 && end === s.length - 1)) return null;
    try { return reviewPayload(JSON.parse(s.slice(start, end + 1)), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) { for (const v of value) { const r = reviewPayload(v, depth + 1); if (r) return r; } return null; }
  if (typeof value === "object") {
    if (typeof value.reviewId === "string" && value.ok !== false && /^[A-Za-z0-9_-]{6,128}$/.test(value.reviewId)) return value;
    for (const v of Object.values(value)) { const r = reviewPayload(v, depth + 1); if (r) return r; }
  }
  return null;
}

export const reviewFromResult = (value) => reviewPayload(value)?.reviewId || "";

// A review result that already carries the report (outcome "report") or ended the round leaves nothing to wait for.
export function reviewAwaitsPerson(value) {
  const r = reviewPayload(value);
  return !!r && (r.outcome === undefined || r.outcome === "timed_out" || r.outcome === "wait_cancelled");
}

const parseMaybe = (v) => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return v; } };

// Normalizes each host's hook input to {session, tool, input, result}.
export function hookInput(host, raw) {
  if (host === "cursor") return { session: raw.conversation_id, tool: raw.tool_name, input: parseMaybe(raw.tool_input), result: parseMaybe(raw.result_json), status: raw.status };
  return { session: raw.session_id, tool: raw.tool_name, input: parseMaybe(raw.tool_input), result: raw.tool_response ?? raw.tool_result, source: raw.source };
}

// A design version needs no box id; a review card is keyed by the box it was opened on.
export function attachFromTool({ dir, host, input }) {
  if (!REVIEW_TOOL.test(input.tool || "")) return false;
  const reviewId = reviewFromResult(input.result);
  const boxId = isDesignVersion(reviewId) ? undefined : input.input?.id;
  if (!reviewId || (!isDesignVersion(reviewId) && typeof boxId !== "string")) return false;
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
    attachSiblings({ dir, host, session });
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

// Print mode with a text prompt (`claude -p "…"`) runs asyncRewake hooks in the foreground; stream-json
// input (the desktop app, SDKs) and the interactive CLI run them in the background.
export function foregroundHookArgs(args) {
  if (!args.some((a) => a === "-p" || a === "--print")) return false;
  return !args.some((a, i) => a === "--input-format=stream-json" || (a === "--input-format" && args[i + 1] === "stream-json"));
}

async function commandArgs(pid) {
  if (process.platform === "win32") return [];
  if (process.platform === "linux") return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  const { stdout } = await promisify(execFile)("ps", ["-ww", "-o", "command=", "-p", String(pid)]);
  return stdout.trim().split(/\s+/);
}

// Claude Code names its own pid in CLAUDE_PID; older versions are found among the hook's ancestors
// (npx and a shell may sit in between).
export async function hostRunsHookInForeground({ env = process.env, argsOf = commandArgs, ps = parentOf } = {}) {
  const pids = [];
  if (Number(env.CLAUDE_PID) > 1) pids.push(Number(env.CLAUDE_PID));
  else for (let pid = process.ppid, i = 0; i < 5 && pid > 1; i++) { pids.push(pid); pid = (await ps(pid).catch(() => null))?.ppid ?? 0; }
  for (const pid of pids) if (foregroundHookArgs(await argsOf(pid).catch(() => []))) return true;
  return false;
}

// Cursor runs Claude Code hooks from ~/.claude/settings.json by default (without asyncRewake), and other
// clients may import them. The Claude route acts only inside the Claude Code conversation that runs it.
export function isClaudeCodeHook(raw, env = process.env) {
  if (raw.conversation_id !== undefined || raw.cursor_version !== undefined) return false;
  if (env.CLAUDE_CODE_SESSION_ID) return env.CLAUDE_CODE_SESSION_ID === raw.session_id;
  return env.CLAUDECODE === "1" && !Object.keys(env).some((k) => k.startsWith("CURSOR_"))
    && typeof raw.transcript_path === "string" && basename(raw.transcript_path) === `${raw.session_id}.jsonl`;
}

export async function runHook({ host, raw, dir = defaultFeedbackDir(), env = process.env, foreground = hostRunsHookInForeground, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) }) {
  if (host === "claude-code" && !isClaudeCodeHook(raw, env)) return 0;
  const input = hookInput(host, raw);
  if (typeof input.session !== "string" || !input.session) return 0;
  const event = raw.hook_event_name || "";
  const holdMs = Number(env.PSBX_HOOK_HOLD_SEC || 1200) * 1000;
  if (input.tool) attachFromTool({ dir, host, input });
  attachSiblings({ dir, host, session: input.session });

  if (host === "claude-code") {
    // One background waiter per conversation; the next one starts at the next review/report call.
    if (!sessionExpectsFeedback({ dir, host, session: input.session })) return 0;
    // In the foreground only a review still open for the person waits. Waiting after sandbox_report, at
    // SessionStart or after a review that returned its report would hold that report from the conversation
    // until the next one came: hand over a follow-up already waiting and return.
    const opened = REVIEW_TOOL.test(input.tool || "") && reviewAwaitsPerson(input.result);
    const waitMs = opened || !(await foreground({ env })) ? 7 * 24 * 3600_000 : 0;
    privateDir(paths(dir).run);
    const lock = waiterPidFile(dir, host, input.session);
    const holder = Number(orNull(() => readFileSync(lock, "utf8")) || 0);
    if (holder && holder !== process.pid && alive(holder)) return 0;
    writeFileSync(lock, String(process.pid), { mode: 0o600 });
    try {
      const mail = await waitForMail({ dir, host, session: input.session, until: Date.now() + waitMs, by: `claude:${process.pid}`, ancestors: await hostAncestors() });
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
