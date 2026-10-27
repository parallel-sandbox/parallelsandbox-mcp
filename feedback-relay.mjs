// App feedback back to the original AI conversation, for any MCP host.
//
// One pipeline, one small delivery driver per host:
//   adapter  -> after sandbox_review, or a design tool's new version, writes a ticket (review, its box, owner agent)
//               and starts the relay. A design version (dsn_…) has no box: its feedback is bound, claimed and read
//               by reviewId and reportId alone.
//   host     -> tells which conversation owns the review:
//                 Codex: tools/call _meta.threadId (the adapter records it in the ticket)
//                 Claude Code, Cursor, Gemini CLI: their after-tool hook attaches its session id
//   relay    -> registers a feedback consumer per conversation, claims App reports, delivers:
//                 codex  : `codex queue --thread` into Codex's own follow-up queue
//                 hook   : a private mailbox the conversation's hook waits on (feedback-hook.mjs)
//               and acknowledges host acceptance only after the host took the follow-up.
//               A Claude Code follow-up no waiter is left to take (the conversation is closed or was stopped
//               by Claude Desktop) is reported to the App as host_inactive, so the person can resume it.
//               Each ticket binds on its own: one the server refuses never holds up the others.
//   adapter  -> when that conversation reads the report with sandbox_report, acknowledges `read`.
// One relay per machine and credential makes one long poll for all of its conversations (POST
// /v1/feedback-consumers/claim) and one heartbeat a minute for every live adapter that registered with it
// (POST /v1/agents/heartbeat). Until 10/27 it polled each conversation on its own, every 3 s for Claude Code: a Mac
// with 62 reviewed conversations in the last 7 days sent 1,200 requests a minute, 98% of its traffic, and used up the
// rate limit that every conversation on that machine shared. An older server without these routes still works:
// one 25-second poll per conversation, one heartbeat per adapter.
// Credentials stay in the adapter and relay environments; state files hold ids only.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
export const TICKET_LIFETIME_MS = 7 * 24 * 3600_000; // Reports and media are kept for 7 days.
export const HOOK_HOSTS = Object.freeze(["claude-code", "cursor", "gemini"]);
export const CAPABILITIES = Object.freeze({ codex: "codex/thread-queue", "claude-code": "claude-code/async-rewake", cursor: "cursor/stop-followup", gemini: "gemini-cli/after-agent" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const sha = (...parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export const defaultFeedbackDir = (env = process.env) => env.PSBX_FEEDBACK_DIR || join(homedir(), ".cache", "parallelsandbox", "feedback");
// A design version (sandbox_draft／sandbox_architecture／sandbox_schema, id dsn_…) belongs to the account and the
// conversation that drew it, not to a box, even when the tool was given a box id.
export const isDesignVersion = (reviewId) => typeof reviewId === "string" && reviewId.startsWith("dsn_");
// The box a review's feedback goes with: none for a design version.
export const reviewBox = (boxId, reviewId) => (isDesignVersion(reviewId) ? undefined : boxId);
// The sandbox_report arguments that read one report of this review.
export const reportArgs = ({ boxId, reviewId, reportId }) => (isDesignVersion(reviewId) ? { reportId } : { id: boxId, reportId });
export const ticketKey = (boxId, reviewId) => sha("ticket", reviewBox(boxId, reviewId) ?? "", reviewId).slice(0, 40);
export const sessionKey = (host, session) => sha("session", host, session).slice(0, 40);
export const credentialKey = (env, apiUrl, mcpUrl) => sha("cred", apiUrl, env.PARALLELSANDBOX_API_KEY ? sha(env.PARALLELSANDBOX_API_KEY) : `oauth:${mcpUrl}`).slice(0, 16);
const stamp = () => new Date().toISOString();

// ---------- private files ----------
export function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid())) throw new Error(`${path} must be a user-owned directory`);
  if (st.mode & 0o077) chmodSync(path, 0o700);
  return path;
}
export function readJson(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
}
export function writeJson(path, value) {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}
// Exactly one writer wins; used for "handed" markers.
export function createOnce(path, value) {
  try { writeFileSync(path, JSON.stringify(value), { mode: 0o600, flag: "wx" }); return true; }
  catch (err) { if (err.code === "EEXIST") return false; throw err; }
}
export const orNull = (fn) => { try { return fn(); } catch (err) { if (err.code === "ENOENT") return null; throw err; } };
const list = (dir) => orNull(() => readdirSync(dir)) || [];
// Ticket files only: writeJson's in-flight "<key>.json.<pid>.<rand>.tmp" files are skipped.
const ticketNames = (dir) => list(dir).filter((n) => n.endsWith(".json"));
// One unreadable ticket must never stop the others from being considered.
const ticketOrNull = (path) => { try { return readJson(path); } catch { return null; } };
export function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; } }
export const paths = (dir) => ({ dir, tickets: join(dir, "tickets"), attach: join(dir, "attach"), journal: join(dir, "journal"), mail: join(dir, "mail"), run: join(dir, "run"), presence: join(dir, "presence") });
export const presenceFile = (dir, agentId) => join(paths(dir).presence, `${sha("presence", agentId).slice(0, 40)}.json`);
// A relay writes this when it starts: an adapter hands its heartbeat only to a relay that sends it.
export const relayFeaturesFile = (dir, credKey) => join(paths(dir).run, `relay-${credKey}.features`);

// ---------- host identity ----------
// Only host-supplied metadata picks the destination; tool arguments come from the model.
export function codexThreadId(meta, clientName) {
  if (!/^codex/i.test(clientName || "")) return "";
  const id = meta?.threadId;
  if (typeof id !== "string" || !UUID.test(id)) return "";
  const turn = meta?.["x-codex-turn-metadata"];
  if (turn && typeof turn === "object" && turn.thread_id && turn.thread_id !== id) return "";
  return id;
}

// The exact codex executable that launched this adapter (same version as the host).
export async function hostCodexCli({ env = process.env, pid = process.ppid, ps = psParent } = {}) {
  if (env.PSBX_CODEX_CLI) {
    if (!isAbsolute(env.PSBX_CODEX_CLI)) throw new Error("PSBX_CODEX_CLI must be absolute");
    return env.PSBX_CODEX_CLI;
  }
  for (let depth = 0; pid > 1 && depth < 8; depth++) {
    const parent = await ps(pid).catch(() => null);
    if (!parent) break;
    if (basename(parent.exe) === "codex" && isAbsolute(parent.exe)) return parent.exe;
    pid = parent.ppid;
  }
  return "";
}
export async function parentOf(pid) {
  return psParent(pid);
}
async function psParent(pid) {
  if (process.platform === "win32") return null;
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return { ppid: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]), exe: readlinkSync(`/proc/${pid}/exe`) };
  }
  const { stdout } = await run("ps", ["-o", "ppid=", "-o", "comm=", "-p", String(pid)]);
  const m = stdout.trim().match(/^(\d+)\s+(.+)$/);
  return m ? { ppid: Number(m[1]), exe: m[2].trim() } : null;
}

// The follow-up carries only a pointer: codex queue cannot attach images and hook output
// is plain text. The conversation reads the complete report through its own MCP connection.
export function followUpText(event) {
  if (isDesignVersion(event.reviewId)) return [
    `[ParallelSandbox] The person sent feedback in the ParallelSandbox app on design version ${event.reviewId}. Call the parallelsandbox sandbox_report tool with exactly ${JSON.stringify(reportArgs(event))} to read it, change what they asked, then call the same design tool again with the same topic for the next version.`,
    "This message was delivered automatically by ParallelSandbox; it contains no feedback content.",
  ].join("\n");
  return [
    `[ParallelSandbox] The person submitted feedback from the ParallelSandbox App for review ${event.reviewId} on box ${event.boxId}.`,
    `Call the parallelsandbox sandbox_report tool with exactly ${JSON.stringify(reportArgs(event))} to read the complete report (text, annotated images, recordings and timed transcripts), then handle it in this conversation.`,
    "This message was delivered automatically by ParallelSandbox; it contains no feedback content.",
  ].join("\n");
}

// ---------- adapter side ----------
export function createFeedbackRoute({ apiUrl, mcpUrl, agentId, authorizedFetch, headers, env = process.env, dir = defaultFeedbackDir(env), spawnRelay = spawnDetachedRelay, findCli = hostCodexCli, log = () => {}, pid = process.pid }) {
  const api = apiUrl.replace(/\/+$/, "");
  const p = paths(dir);
  const credKey = credentialKey(env, api, mcpUrl);
  let cliPromise;
  return {
    // This adapter's minute heartbeat goes through the machine's relay together with every other live adapter's.
    // Rewritten every minute (resume interval): the relay drops a file whose process is gone or that went quiet.
    // Returns whether the relay sends it; when it does not (an older relay), the adapter keeps its own heartbeat.
    async trackPresence({ client }) {
      privateDir(dir); privateDir(p.presence);
      writeJson(presenceFile(dir, agentId), { agentId, pid, client: client || "", apiUrl: api, mcpUrl, credKey, at: Date.now() });
      const relay = await spawnRelay({ dir, credKey, env, log });
      if (relay?.started) return true; // this package's relay
      const features = ticketOrNull(relayFeaturesFile(dir, credKey));
      return !!relay?.pid && features?.pid === relay.pid && features.presence === true;
    },
    dropPresence() {
      orNull(() => unlinkSync(presenceFile(dir, agentId)));
    },
    // Called after a successful sandbox_review or design version. Codex names its thread here; hook hosts attach later.
    async trackReview({ boxId, reviewId, clientName, meta }) {
      boxId = reviewBox(boxId, reviewId);
      privateDir(dir); privateDir(p.tickets);
      const file = join(p.tickets, `${ticketKey(boxId, reviewId)}.json`);
      // Only the agent that opened a review may bind its feedback (the server answers 403 to anyone else), and that
      // review's feedback belongs to the conversation that opened it. Another conversation, or this one after its
      // adapter restarted with a new agent id, resuming the same reviewId keeps the original ticket untouched:
      // rewriting it with this agent id would leave a ticket the server never binds.
      const prev = ticketOrNull(file);
      if (prev?.agentId && prev.agentId !== agentId && prev.boxId === boxId && prev.reviewId === reviewId && Date.now() < prev.expiresAt) {
        if (prev.credKey === credKey) await spawnRelay({ dir, credKey, env, log });
        log(`feedback: review ${reviewId}${boxId ? ` on box ${boxId}` : ""} was opened by another agent; its App feedback keeps returning to the conversation that opened it`);
        return { automatic: false, host: prev.codex ? "codex" : (prev.client || "unknown"), route: "original conversation", reason: "opened_by_another_agent",
          note: "This review was opened by another conversation, or by this one before its ParallelSandbox connection restarted. Its App feedback keeps returning to the conversation that opened it; if no follow-up arrives here, read a submitted report with sandbox_report." };
      }
      const ticket = { ...(boxId ? { boxId } : {}), reviewId, agentId, apiUrl: api, mcpUrl, credKey, client: clientName || "", createdAt: Date.now(), expiresAt: Date.now() + TICKET_LIFETIME_MS };
      const threadId = codexThreadId(meta, clientName);
      if (threadId) {
        cliPromise ||= findCli({ env });
        const cliPath = await cliPromise;
        if (cliPath) ticket.codex = { threadId, cliPath, codexHome: env.CODEX_HOME || "" };
      }
      writeJson(file, ticket);
      await spawnRelay({ dir, credKey, env, log });
      if (threadId && !ticket.codex) return { automatic: false, host: "codex", reason: "codex_cli_not_found", note: "Set PSBX_CODEX_CLI to this host's absolute codex executable." };
      if (ticket.codex) return { automatic: true, host: "codex", route: "codex queue", threadId };
      return { automatic: "when_hooks_installed", host: clientName || "unknown", route: "host hook" };
    },
    // The original conversation read this exact report: the App receipt becomes `read`. A design report is read without
    // a box id, and with one it is the same report.
    async onReportRead({ boxId, reportId }) {
      for (const name of list(p.journal)) {
        const path = join(p.journal, name);
        const j = orNull(() => readJson(path));
        // The conversation can read the report before the relay acknowledged acceptance.
        if (!j || (j.boxId && j.boxId !== boxId) || j.reportId !== reportId || !["mailed", "handed", "accepted"].includes(j.state)) continue;
        const res = await authorizedFetch(`${api}/v1/feedback-consumers/${encodeURIComponent(j.consumerId)}/ack`, { method: "POST", headers: { ...headers, "X-Psbx-Agent": j.agentId, "Content-Type": "application/json" }, body: JSON.stringify({ eventId: j.eventId, reportId, leaseToken: j.leaseToken, state: "read" }) });
        if (!res.ok) throw new Error(`read acknowledgement failed (${res.status})`);
        writeJson(path, { ...j, state: "read", readAt: Date.now() });
        return true;
      }
      return false;
    },
    // After a reboot or a crashed relay, any adapter start brings pending tickets back.
    async resumeRelay() {
      const pending = ticketNames(p.tickets).some((n) => { const t = ticketOrNull(join(p.tickets, n)); return t && t.credKey === credKey && Date.now() < t.expiresAt; });
      return pending ? spawnRelay({ dir, credKey, env, log }) : null;
    },
  };
}

export async function spawnDetachedRelay({ dir, credKey, env }) {
  const p = paths(dir);
  privateDir(p.run);
  const pid = Number(orNull(() => readFileSync(join(p.run, `relay-${credKey}.pid`), "utf8")) || 0);
  if (alive(pid)) return { running: true, pid, started: false };
  const out = openSync(join(p.run, `relay-${credKey}.log`), "a", 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "relay", "--dir", dir, "--cred", credKey], { detached: true, stdio: ["ignore", out, out], env });
  child.unref();
  closeSync(out);
  return { running: true, pid: child.pid, started: true };
}

// ---------- hook side: attach a review to the calling conversation ----------
export function attachReview({ dir = defaultFeedbackDir(), host, session, boxId, reviewId }) {
  if (!HOOK_HOSTS.includes(host) || typeof session !== "string" || !session || session.length > 256) return false;
  const p = paths(dir);
  const key = ticketKey(boxId, reviewId);
  const ticket = orNull(() => readJson(join(p.tickets, `${key}.json`)));
  if (!ticket || Date.now() > ticket.expiresAt || ticket.codex) return false;
  privateDir(p.attach);
  const file = join(p.attach, `${key}.json`);
  const prev = orNull(() => readJson(file));
  if (prev && (prev.host !== host || prev.session !== session)) return false; // A review belongs to one conversation.
  if (!prev) writeJson(file, { host, session, at: Date.now() });
  return true;
}

// Claude Code runs a turn's asyncRewake hook once: when one turn opens several reviews or design versions
// (a draft, then its architecture), only the first one's hook attaches (Claude Code 2.1.310). One stdio adapter
// serves one Claude Code conversation, so that conversation's waiter also attaches the other tickets its adapter
// (the same agentId) wrote. Other hosts may share an adapter between conversations and keep attaching per hook.
export function attachSiblings({ dir = defaultFeedbackDir(), host, session }) {
  if (host !== "claude-code") return 0;
  const p = paths(dir);
  const agents = new Set();
  for (const name of list(p.attach)) {
    const a = orNull(() => readJson(join(p.attach, name)));
    if (!a || a.host !== host || a.session !== session) continue;
    const t = orNull(() => readJson(join(p.tickets, name)));
    if (t?.agentId) agents.add(t.agentId);
  }
  let attached = 0;
  for (const name of list(p.tickets)) {
    if (agents.size === 0 || existsSync(join(p.attach, name))) continue;
    const t = orNull(() => readJson(join(p.tickets, name)));
    if (!t || t.codex || !agents.has(t.agentId) || Date.now() > t.expiresAt) continue;
    writeJson(join(p.attach, name), { host, session, at: Date.now() });
    attached++;
  }
  return attached;
}

// Pending follow-ups for one conversation, oldest first.
export function mailFor({ dir = defaultFeedbackDir(), host, session }) {
  const box = join(paths(dir).mail, sessionKey(host, session));
  return list(box).filter((n) => n.endsWith(".json")).map((n) => ({ path: join(box, n), handed: join(box, n.replace(/\.json$/, ".handed")), mail: orNull(() => readJson(join(box, n))) }))
    .filter((m) => m.mail && !existsSync(m.handed)).sort((a, b) => a.mail.at - b.mail.at);
}
// Take one follow-up; only one waiter can take it.
export function takeMail(entry, by) { return createOnce(entry.handed, { by, at: Date.now() }); }

// Does this conversation still expect App feedback (an attached, unexpired review)?
export function sessionExpectsFeedback({ dir = defaultFeedbackDir(), host, session }) {
  const p = paths(dir);
  return list(p.attach).some((n) => {
    const a = orNull(() => readJson(join(p.attach, n)));
    if (!a || a.host !== host || a.session !== session) return false;
    const t = orNull(() => readJson(join(p.tickets, n)));
    return t && Date.now() < t.expiresAt;
  });
}

// The Claude Code hook keeps one background waiter per conversation (feedback-hook.mjs), and it dies with
// that conversation's CLI: Claude Desktop stops idle sessions under memory pressure, and opening such a
// session does not start it again, only sending it a message does. A killed waiter can leave its pid file
// behind, so the pid must still be this package's hook for that host.
export const waiterPidFile = (dir, host, session) => join(paths(dir).run, `waiter-${sessionKey(host, session)}.pid`);
async function commandLine(pid) {
  if (process.platform === "linux") return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
  const { stdout } = await run("ps", ["-ww", "-o", "command=", "-p", String(pid)]);
  return stdout;
}
export async function waiterRunning({ dir = defaultFeedbackDir(), host, session, commandOf = commandLine }) {
  const pid = Number(orNull(() => readFileSync(waiterPidFile(dir, host, session), "utf8")) || 0);
  if (!alive(pid)) return false;
  if (process.platform === "win32") return true;
  return (await commandOf(pid).catch(() => "")).includes(`hook --host ${host}`);
}

// ---------- relay ----------
const sleep = (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });

// A ticket the server refuses to bind is set aside until its file changes; a failure that may pass
// (network, timeout, 401/408/425/429, 5xx) is retried after 30 s, doubling up to 10 minutes.
export const BIND_RETRY_MS = 30_000, BIND_RETRY_MAX_MS = 600_000;
const retryableStatus = (status) => !status || status >= 500 || [401, 408, 425, 429].includes(status);
// A conversation just woken by one follow-up starts its next waiter at its next sandbox_report call, so a
// waiter missing for a moment is normal; one still missing after this long means the conversation stopped.
export const HOST_GRACE_MS = 30_000;
// The server takes at most this many conversations in one claim; more are claimed in several requests at once.
export const CLAIM_BATCH_MAX = 200;
// The relay sends one heartbeat a minute for every live adapter on this machine (the server counts a
// conversation gone after 3 minutes without one). A presence file not rewritten for this long is dropped.
export const HEARTBEAT_MS = 60_000, PRESENCE_STALE_MS = 3 * 60_000;
// A Claude Code conversation that is not running is checked again at most this often (ps per live waiter).
const HOST_CHECK_MS = 5000;
// An older server answers the batch routes with 404 (no such route) or 405.
const missingRoute = (status) => status === 404 || status === 405;
const chunks = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

export async function runRelay({ dir, credKey, env = process.env, fetchImpl, queue = codexQueue, once = false, idleExitMs = 60_000, scanMs = 1000, claimWaitSec = 25, bindRetryMs = BIND_RETRY_MS, bindRetryMaxMs = BIND_RETRY_MAX_MS, hostGraceMs = HOST_GRACE_MS, heartbeatMs = HEARTBEAT_MS, waiting = waiterRunning, signal, print = console.log }) {
  const p = paths(dir);
  privateDir(p.run); privateDir(p.journal); privateDir(p.mail);
  const pidFile = join(p.run, `relay-${credKey}.pid`);
  const featuresFile = relayFeaturesFile(dir, credKey);
  const say = (...a) => print(stamp(), ...a);
  const owner = Number(orNull(() => readFileSync(pidFile, "utf8")) || 0);
  if (owner && owner !== process.pid && alive(owner)) { say("another relay owns", credKey); return; }
  writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  if (!once) writeJson(featuresFile, { pid: process.pid, presence: true, batchClaim: true });
  const controller = new AbortController();
  if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener("abort", () => controller.abort(), { once: true }); }
  const consumers = new Map(); // consumerId -> { id, agentId, ticket, target }: every conversation the one claim asks for
  const bound = new Set(); // consumerId/ticket
  const gone = new Set(); // consumers the server no longer has for their agent: never asked again by this relay
  const legacy = new Map(); // consumerId -> its own poll, only against a server without the batch claim
  // Tickets that could not be bound or read, by ticket key: { sig, message, retryAt, delay }.
  // retryAt is Infinity for a refusal: that ticket is tried again only after its file changes (sig).
  const setAside = new Map();
  let fetcher = fetchImpl, lastWork = Date.now(), batch = true, claimWake = null;
  try {
    const fetcherFor = async (mcpUrl) => {
      if (!fetcher) {
        if (env.PARALLELSANDBOX_API_KEY) fetcher = (url, init) => fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${env.PARALLELSANDBOX_API_KEY}` } });
        else { const { OAuthSession } = await import("./oauth.mjs"); const oauth = new OAuthSession({ mcpUrl, open: () => {} }); fetcher = (url, init) => oauth.fetch(url, init); }
      }
      return fetcher;
    };
    // One POST to the control API; `wake` cuts a long poll short when the set of conversations changed.
    const call = async ({ apiUrl, mcpUrl }, agentId, path, body, wake) => {
      const f = await fetcherFor(mcpUrl);
      const signals = [controller.signal, AbortSignal.timeout(40_000), ...(wake ? [wake] : [])];
      const res = await f(`${apiUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(agentId ? { "X-Psbx-Agent": agentId } : {}), "X-Psbx-Client": "parallelsandbox-feedback-relay" }, body: JSON.stringify(body), signal: AbortSignal.any(signals) });
      const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
      if (!res.ok) { const err = new Error(data.error || `HTTP ${res.status}`); err.status = res.status; throw err; }
      return data;
    };
    const request = (ticket, agentId, path, body) => call(ticket, agentId, `/v1/feedback-consumers${path}`, body);
    const targetOf = (ticket, key) => {
      if (ticket.codex) return { kind: "codex", host: "codex", id: ticket.codex.threadId, codex: ticket.codex };
      const a = ticketOrNull(join(p.attach, `${key}.json`));
      return a ? { kind: "hook", host: a.host, id: a.session } : null;
    };
    const deliver = async (consumer, event) => {
      const jpath = join(p.journal, `${sha(consumer.id, event.eventId).slice(0, 40)}.json`);
      let j = orNull(() => readJson(jpath));
      if (j && (j.reportId !== event.reportId || j.boxId !== event.boxId)) throw new Error("delivery journal does not match its event");
      if (j?.state === "sending") { say("uncertain earlier codex queue attempt for", event.reportId, "- not repeating"); return; }
      if (!j) {
        j = { consumerId: consumer.id, agentId: consumer.agentId, host: consumer.target.host, target: consumer.target.id, eventId: event.eventId, ...(event.boxId ? { boxId: event.boxId } : {}), reviewId: event.reviewId, reportId: event.reportId, leaseToken: event.leaseToken, state: "sending" };
        writeJson(jpath, j);
        if (consumer.target.kind === "codex") {
          try { j.queuedId = await queue({ ...consumer.target.codex, threadId: consumer.target.id }, followUpText(event)); }
          catch (err) { if (!err.uncertain) unlinkSync(jpath); throw err; }
          j.state = "handed";
          say("queued report", event.reportId, "as", j.queuedId, "for codex thread", consumer.target.id);
        } else {
          const box = privateDir(join(p.mail, sessionKey(consumer.target.host, consumer.target.id)));
          writeJson(join(box, `${event.eventId}.json`), { eventId: event.eventId, ...(event.boxId ? { boxId: event.boxId } : {}), reviewId: event.reviewId, reportId: event.reportId, text: followUpText(event), at: Date.now() });
          j.state = "mailed";
          j.mailedAt = Date.now();
          say("mailed report", event.reportId, "to", consumer.target.host, "session", consumer.target.id);
        }
      }
      j.leaseToken = event.leaseToken; // A re-claim hands out a new lease for the same event.
      if (j.state === "mailed" && existsSync(join(p.mail, sessionKey(consumer.target.host, consumer.target.id), `${event.eventId}.handed`))) j.state = "handed";
      writeJson(jpath, j);
      if (j.state === "handed" || j.state === "accepted" || j.state === "read") {
        await request(consumer.ticket, consumer.agentId, `/${encodeURIComponent(consumer.id)}/ack`, { eventId: event.eventId, reportId: event.reportId, leaseToken: event.leaseToken, state: j.state === "read" ? "read" : "host_accepted" });
        if (j.state === "handed") { j.state = "accepted"; writeJson(jpath, j); }
        say("acknowledged", event.reportId, j.state);
      }
    };
    // Claude Code takes a mailed follow-up only through a live waiter. While none runs, the conversation is not
    // running (closed, or stopped by Claude Desktop while idle) and the App asks the person to send it a message;
    // the follow-up stays mailed for the waiter that starts when the conversation runs again.
    let hostReports = true;
    const hostChecked = new Map(); // eventId -> last check, so a long-running relay runs ps at most every HOST_CHECK_MS
    const reportHost = async (consumer, j, jpath) => {
      if (!hostReports || consumer.target.host !== "claude-code" || Date.now() - (j.mailedAt || 0) < hostGraceMs) return;
      if (!once) { if (Date.now() - (hostChecked.get(j.eventId) || 0) < HOST_CHECK_MS) return; hostChecked.set(j.eventId, Date.now()); }
      const inactive = !(await waiting({ dir, host: j.host, session: j.target }));
      if (inactive === !!j.hostInactive) return;
      try {
        await request(consumer.ticket, consumer.agentId, `/${encodeURIComponent(consumer.id)}/ack`, { eventId: j.eventId, reportId: j.reportId, leaseToken: j.leaseToken, state: inactive ? "host_inactive" : "host_active" });
      } catch (err) {
        if (err.status === 400) { hostReports = false; say("this server does not take conversation status:", err.message); return; }
        if (err.status === 404 || err.status === 409) return; // Lease expired or taken: the next claim renews it.
        throw err;
      }
      const now = orNull(() => readJson(jpath));
      if (now?.state === "mailed") writeJson(jpath, { ...now, hostInactive: inactive });
      say("reported", j.reportId, inactive ? "conversation is not running" : "conversation is running again", j.host, j.target);
    };
    // Mailed follow-ups are acknowledged as soon as their conversation takes them, and a Claude Code conversation
    // that does not take one is reported. One pass over the journal for every conversation, from the scan loop:
    // local files only, and a request only when something changed (a failed one backs off per event).
    const retryAt = new Map(); // eventId -> { at, delay }
    const settle = async () => {
      let firstError = null;
      for (const name of list(p.journal)) {
        if (controller.signal.aborted) break;
        const jpath = join(p.journal, name);
        const j = orNull(() => readJson(jpath));
        if (!j || j.state !== "mailed") continue;
        const consumer = consumers.get(j.consumerId);
        if (!consumer) continue;
        const retry = retryAt.get(j.eventId);
        if (retry && Date.now() < retry.at) continue;
        try {
          if (existsSync(join(p.mail, sessionKey(j.host, j.target), `${j.eventId}.handed`))) {
            try {
              await request(consumer.ticket, consumer.agentId, `/${encodeURIComponent(consumer.id)}/ack`, { eventId: j.eventId, reportId: j.reportId, leaseToken: j.leaseToken, state: "host_accepted" });
              writeJson(jpath, { ...j, state: "accepted", acceptedAt: Date.now() });
              say("acknowledged", j.reportId, "accepted");
            } catch (err) { if (err.status !== 409) throw err; } // Lease expired: the next claim renews it.
          } else await reportHost(consumer, j, jpath);
          retryAt.delete(j.eventId);
        } catch (err) {
          if (controller.signal.aborted) break;
          const delay = retry ? Math.min(retry.delay * 2, 60_000) : 1000;
          retryAt.set(j.eventId, { at: Date.now() + delay, delay });
          say("delivery pending:", err.message);
          firstError ||= err;
        }
      }
      return firstError;
    };
    // One claim for every conversation of this relay (in chunks of CLAIM_BATCH_MAX, asked at the same time).
    // A chunk that brings events wakes the others, so the next round starts at once; a report the server leased
    // to a request cut short that way is claimed again when its lease runs out. Returns the events and the
    // first delivery error (logged here; a one-shot run reports it).
    const claimAll = async (wake) => {
      let events = 0, deliveryError = null;
      await Promise.all(chunks([...consumers.values()], CLAIM_BATCH_MAX).map(async (chunk) => {
        let data;
        try {
          data = await call(chunk[0].ticket, "", "/v1/feedback-consumers/claim", { consumers: chunk.map((c) => ({ consumerId: c.id, agentId: c.agentId })), waitSec: once ? 0 : claimWaitSec }, wake?.signal);
        } catch (err) {
          if (wake?.signal.aborted && !controller.signal.aborted) return;
          if (missingRoute(err.status)) { batch = false; return; }
          throw err;
        }
        for (const id of data.gone || []) {
          gone.add(id);
          if (consumers.delete(id)) say("consumer is gone:", id);
        }
        for (const event of data.events || []) {
          const consumer = consumers.get(event.consumerId);
          if (!consumer) continue;
          events++; lastWork = Date.now();
          try { await deliver(consumer, event); }
          catch (err) { if (controller.signal.aborted) return; say("delivery pending:", err.message); deliveryError ||= err; }
        }
        if (events) wake?.abort();
      }));
      return { events, deliveryError };
    };
    const claimLoop = async () => {
      let backoff = 1000;
      while (!controller.signal.aborted && batch) {
        const wake = new AbortController();
        claimWake = wake;
        const started = Date.now();
        try {
          const { events } = consumers.size ? await claimAll(wake) : { events: 0 };
          backoff = 1000;
          if (!batch) break;
          // Nothing to ask for, or a server that answered at once: wait a moment (a new conversation wakes it).
          if (!events && !wake.signal.aborted && Date.now() - started < 1000) await sleep(Math.max(scanMs, 1000), AbortSignal.any([controller.signal, wake.signal]));
        } catch (err) {
          if (controller.signal.aborted) return;
          say("delivery pending:", err.message);
          await sleep(backoff, controller.signal); backoff = Math.min(backoff * 2, 60_000);
        } finally { if (claimWake === wake) claimWake = null; }
      }
      if (!batch && !controller.signal.aborted) say("this server has no batch claim: one long poll per conversation");
    };
    // Against an older server: one long poll per conversation, the full claimWaitSec for every host (it was
    // 3 s for hook hosts so that follow-ups taken meanwhile were acknowledged quickly; settle does that now).
    const consume = async (consumer) => {
      let backoff = 1000;
      while (!controller.signal.aborted && consumers.has(consumer.id)) {
        try {
          const { events = [] } = await request(consumer.ticket, consumer.agentId, `/${encodeURIComponent(consumer.id)}/claim`, { waitSec: once ? 0 : claimWaitSec });
          for (const event of events) { lastWork = Date.now(); await deliver(consumer, event); }
          backoff = 1000;
          if (once) return;
        } catch (err) {
          if (controller.signal.aborted) return;
          if (err.status === 404 || err.status === 403) { say("consumer is gone:", consumer.id, err.message); gone.add(consumer.id); consumers.delete(consumer.id); return; }
          say("delivery pending:", err.message);
          if (once) throw err;
          await sleep(backoff, controller.signal); backoff = Math.min(backoff * 2, 60_000);
        }
      }
    };
    // Every live adapter of this credential on this machine, in one heartbeat a minute.
    const livePresences = () => {
      const out = [];
      for (const name of list(p.presence)) {
        if (!name.endsWith(".json")) continue;
        const path = join(p.presence, name);
        const a = ticketOrNull(path);
        if (!a || a.credKey !== credKey) continue;
        if (!alive(a.pid) || Date.now() - (a.at || 0) > PRESENCE_STALE_MS) { orNull(() => unlinkSync(path)); continue; }
        out.push(a);
      }
      return out;
    };
    const presenceLoop = async () => {
      let batchBeats = true, lastError = "";
      while (!controller.signal.aborted) {
        const live = livePresences();
        if (live.length) {
          try {
            if (batchBeats) {
              try {
                for (const chunk of chunks(live, CLAIM_BATCH_MAX)) await call(chunk[0], "", "/v1/agents/heartbeat", { agents: chunk.map((a) => ({ id: a.agentId, client: a.client || "" })) });
              } catch (err) {
                if (!missingRoute(err.status)) throw err;
                batchBeats = false;
                say("this server has no batch heartbeat: one per conversation");
              }
            }
            if (!batchBeats) for (const a of live) await call(a, a.agentId, `/v1/agents/${encodeURIComponent(a.agentId)}/heartbeat`, { client: a.client || "" });
            lastError = "";
          } catch (err) {
            if (controller.signal.aborted) return;
            if (err.message !== lastError) say("heartbeat failed:", err.message);
            lastError = err.message;
          }
        }
        await sleep(heartbeatMs, controller.signal);
      }
    };
    // Records one ticket that could not be read or bound. It is logged the first time, and again only when the
    // error or the ticket file changes; a refusal waits for the ticket file to change, anything else backs off.
    const setTicketAside = (key, sig, err, describe, retry = retryableStatus(err.status)) => {
      const prev = setAside.get(key);
      const delay = !retry ? 0 : prev && prev.sig === sig && prev.delay ? Math.min(prev.delay * 2, bindRetryMaxMs) : bindRetryMs;
      const message = `${err.message || err}${err.status ? ` (HTTP ${err.status})` : ""}`;
      if (!prev || prev.sig !== sig || prev.message !== message) {
        say(describe, message, retry ? `- retrying in ${delay < 1000 ? `${delay}ms` : `${Math.round(delay / 1000)}s`}; other reviews are not affected` : "- set aside until its ticket file changes; other reviews are not affected");
      }
      setAside.set(key, { sig, message, delay, retryAt: retry ? Date.now() + delay : Infinity });
    };
    // Every ticket is handled on its own: one that cannot be read or bound never holds up the others.
    // A ticket set aside still counts as active, like a ticket whose conversation has not attached yet:
    // every unexpired ticket keeps the relay up, matching resumeRelay, which would otherwise start a new relay
    // that tries the same ticket again a minute later. A conversation none of whose tickets is left (expired,
    // removed) is no longer asked for.
    const scan = async () => {
      let active = 0, firstError = null, changed = false;
      const seen = new Set(), wanted = new Set();
      for (const name of ticketNames(p.tickets)) {
        if (controller.signal.aborted) break;
        const key = name.slice(0, -".json".length), path = join(p.tickets, name);
        seen.add(key);
        const st = (() => { try { return lstatSync(path); } catch { return null; } })();
        if (!st) continue;
        let ticket;
        try { ticket = readJson(path); }
        catch (err) {
          if (err.code !== "ENOENT") setTicketAside(key, `file:${st.mtimeMs}:${st.size}`, err, `cannot read ticket ${key}:`, false);
          continue;
        }
        if (!ticket || ticket.credKey !== credKey) continue;
        if (Date.now() > ticket.expiresAt) { orNull(() => unlinkSync(path)); orNull(() => unlinkSync(join(p.attach, name))); setAside.delete(key); continue; }
        active++;
        const target = targetOf(ticket, key);
        if (!target) continue;
        const consumerId = `fr_${sha("consumer", ticket.agentId, target.host, target.id).slice(0, 40)}`;
        if (gone.has(consumerId)) continue;
        const bindKey = `${consumerId}/${key}`;
        if (!bound.has(bindKey)) {
          const sig = sha(JSON.stringify(ticket), target.host, target.id, st.mtimeMs);
          const prev = setAside.get(key);
          if (prev && prev.sig === sig && Date.now() < prev.retryAt) continue;
          try {
            await request(ticket, ticket.agentId, "", { consumerId, ...(ticket.boxId ? { boxId: ticket.boxId } : {}), reviewId: ticket.reviewId, host: target.host, capability: CAPABILITIES[target.host] });
          } catch (err) {
            if (controller.signal.aborted) break;
            setTicketAside(key, sig, err, `cannot bind review ${ticket.reviewId}${ticket.boxId ? ` on box ${ticket.boxId}` : ""} (ticket ${key}, agent ${ticket.agentId}, ${target.host} ${target.id}):`);
            firstError ||= err;
            continue;
          }
          setAside.delete(key);
          bound.add(bindKey);
          lastWork = Date.now();
          say("bound review", ticket.reviewId, "to", target.host, target.id);
        }
        wanted.add(consumerId);
        if (!consumers.has(consumerId)) { consumers.set(consumerId, { id: consumerId, agentId: ticket.agentId, ticket, target }); changed = true; }
      }
      for (const key of setAside.keys()) if (!seen.has(key)) setAside.delete(key);
      if (!controller.signal.aborted) for (const id of consumers.keys()) if (!wanted.has(id)) { consumers.delete(id); changed = true; }
      return { active, firstError, changed };
    };
    say("relay started", credKey);
    if (once) {
      // One pass (tests, diagnostics): bind, claim without waiting, deliver, settle; the first failure is reported
      // after every other ticket was handled.
      const errors = [(await scan()).firstError];
      try { errors.push((await claimAll(null)).deliveryError); } catch (err) { errors.push(err); }
      if (!batch) for (const c of [...consumers.values()]) { try { await consume(c); } catch (err) { errors.push(err); } }
      errors.push(await settle());
      const firstError = errors.find(Boolean);
      if (firstError) throw firstError;
      return;
    }
    const loops = [claimLoop(), presenceLoop()];
    while (!controller.signal.aborted) {
      if (!existsSync(dir)) { say("state directory removed; relay exits"); break; }
      let active = 0;
      try {
        const scanned = await scan();
        active = scanned.active;
        if (scanned.changed) claimWake?.abort(); // the long poll asks again with the new set of conversations
        if (!batch) for (const c of consumers.values()) if (!legacy.has(c.id)) legacy.set(c.id, consume(c).finally(() => legacy.delete(c.id)));
        await settle();
      } catch (err) { say("scan:", err.message); }
      if (!active && !consumers.size && !legacy.size && !livePresences().length && Date.now() - lastWork > idleExitMs) { say("no pending reviews or live conversations; relay exits"); break; }
      await sleep(scanMs, controller.signal);
    }
    controller.abort();
    await Promise.allSettled([...loops, ...legacy.values()]);
  } finally {
    controller.abort();
    await Promise.allSettled([...legacy.values()]);
    if (Number(orNull(() => readFileSync(pidFile, "utf8"))) === process.pid) {
      orNull(() => unlinkSync(pidFile));
      if (ticketOrNull(featuresFile)?.pid === process.pid) orNull(() => unlinkSync(featuresFile));
    }
  }
}

export async function codexQueue(target, message) {
  accessSync(target.cliPath, constants.X_OK);
  const env = { ...process.env, ...(target.codexHome ? { CODEX_HOME: target.codexHome } : {}) };
  try {
    const { stdout } = await run(target.cliPath, ["queue", "--thread", target.threadId, "--message", message], { env, timeout: 60_000, maxBuffer: 1 << 20 });
    const m = stdout.match(/Queued message (\S+) for thread (\S+?)\.?\s*$/m);
    if (!m || m[2] !== target.threadId) { const err = new Error("codex queue did not confirm the original thread"); err.uncertain = true; throw err; }
    return m[1];
  } catch (err) {
    if (err.uncertain) throw err;
    const e = new Error(`codex queue failed: ${(err.stderr || err.message || "").toString().split("\n").filter((l) => l && !/ignoring|unrecognized|is ignored/i.test(l)).slice(-2).join(" ")}`);
    e.uncertain = err.killed === true; // A timed-out command may have written the queue row.
    throw e;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === "relay") {
  const opt = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : ""; };
  const dir = opt("dir"), cred = opt("cred");
  if (!isAbsolute(dir || "") || !/^[0-9a-f]{16}$/.test(cred || "")) { console.error("relay --dir <absolute> --cred <key>"); process.exit(2); }
  runRelay({ dir, credKey: cred }).then(() => process.exit(0), (err) => { console.error(stamp(), "relay stopped:", err?.message || err); process.exit(1); });
}
