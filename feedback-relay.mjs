// App feedback back to the original AI conversation, for any MCP host.
//
// One pipeline, one small delivery driver per host:
//   adapter  -> after sandbox_review writes a ticket (box, review, owner agent) and starts the relay
//   host     -> tells which conversation owns the review:
//                 Codex: tools/call _meta.threadId (the adapter records it in the ticket)
//                 Claude Code, Cursor, Gemini CLI: their after-tool hook attaches its session id
//   relay    -> registers a feedback consumer per conversation, claims App reports, delivers:
//                 codex  : `codex queue --thread` into Codex's own follow-up queue
//                 hook   : a private mailbox the conversation's hook waits on (feedback-hook.mjs)
//               and acknowledges host acceptance only after the host took the follow-up.
//   adapter  -> when that conversation reads the report with sandbox_report, acknowledges `read`.
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
export const ticketKey = (boxId, reviewId) => sha("ticket", boxId, reviewId).slice(0, 40);
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
export function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; } }
export const paths = (dir) => ({ dir, tickets: join(dir, "tickets"), attach: join(dir, "attach"), journal: join(dir, "journal"), mail: join(dir, "mail"), run: join(dir, "run") });

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
  return [
    `[ParallelSandbox] The person submitted feedback from the ParallelSandbox App for review ${event.reviewId} on box ${event.boxId}.`,
    `Call the parallelsandbox sandbox_report tool with exactly ${JSON.stringify({ id: event.boxId, reportId: event.reportId })} to read the complete report (text, annotated images, recordings and timed transcripts), then handle it in this conversation.`,
    "This message was delivered automatically by ParallelSandbox; it contains no feedback content.",
  ].join("\n");
}

// ---------- adapter side ----------
export function createFeedbackRoute({ apiUrl, mcpUrl, agentId, authorizedFetch, headers, env = process.env, dir = defaultFeedbackDir(env), spawnRelay = spawnDetachedRelay, findCli = hostCodexCli, log = () => {} }) {
  const api = apiUrl.replace(/\/+$/, "");
  const p = paths(dir);
  const credKey = credentialKey(env, api, mcpUrl);
  let cliPromise;
  return {
    // Called after a successful sandbox_review. Codex names its thread here; hook hosts attach later.
    async trackReview({ boxId, reviewId, clientName, meta }) {
      privateDir(dir); privateDir(p.tickets);
      const ticket = { boxId, reviewId, agentId, apiUrl: api, mcpUrl, credKey, client: clientName || "", createdAt: Date.now(), expiresAt: Date.now() + TICKET_LIFETIME_MS };
      const threadId = codexThreadId(meta, clientName);
      if (threadId) {
        cliPromise ||= findCli({ env });
        const cliPath = await cliPromise;
        if (cliPath) ticket.codex = { threadId, cliPath, codexHome: env.CODEX_HOME || "" };
      }
      writeJson(join(p.tickets, `${ticketKey(boxId, reviewId)}.json`), ticket);
      await spawnRelay({ dir, credKey, env, log });
      if (threadId && !ticket.codex) return { automatic: false, host: "codex", reason: "codex_cli_not_found", note: "Set PSBX_CODEX_CLI to this host's absolute codex executable." };
      if (ticket.codex) return { automatic: true, host: "codex", route: "codex queue", threadId };
      return { automatic: "when_hooks_installed", host: clientName || "unknown", route: "host hook" };
    },
    // The original conversation read this exact report: the App receipt becomes `read`.
    async onReportRead({ boxId, reportId }) {
      for (const name of list(p.journal)) {
        const path = join(p.journal, name);
        const j = orNull(() => readJson(path));
        // The conversation can read the report before the relay acknowledged acceptance.
        if (!j || j.boxId !== boxId || j.reportId !== reportId || !["mailed", "handed", "accepted"].includes(j.state)) continue;
        const res = await authorizedFetch(`${api}/v1/feedback-consumers/${encodeURIComponent(j.consumerId)}/ack`, { method: "POST", headers: { ...headers, "X-Psbx-Agent": j.agentId, "Content-Type": "application/json" }, body: JSON.stringify({ eventId: j.eventId, reportId, leaseToken: j.leaseToken, state: "read" }) });
        if (!res.ok) throw new Error(`read acknowledgement failed (${res.status})`);
        writeJson(path, { ...j, state: "read", readAt: Date.now() });
        return true;
      }
      return false;
    },
    // After a reboot or a crashed relay, any adapter start brings pending tickets back.
    async resumeRelay() {
      const pending = list(p.tickets).some((n) => { const t = orNull(() => readJson(join(p.tickets, n))); return t && t.credKey === credKey && Date.now() < t.expiresAt; });
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

// ---------- relay ----------
const sleep = (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });

export async function runRelay({ dir, credKey, env = process.env, fetchImpl, queue = codexQueue, once = false, idleExitMs = 60_000, scanMs = 1000, claimWaitSec = 25 }) {
  const p = paths(dir);
  privateDir(p.run); privateDir(p.journal); privateDir(p.mail);
  const pidFile = join(p.run, `relay-${credKey}.pid`);
  const say = (...a) => console.log(stamp(), ...a);
  const owner = Number(orNull(() => readFileSync(pidFile, "utf8")) || 0);
  if (owner && owner !== process.pid && alive(owner)) { say("another relay owns", credKey); return; }
  writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  const controller = new AbortController();
  const loops = new Map(); // consumerId -> promise
  const bound = new Set(); // consumerId/ticket
  let fetcher = fetchImpl, lastWork = Date.now();
  try {
    const request = async (ticket, agentId, path, body) => {
      if (!fetcher) {
        if (env.PARALLELSANDBOX_API_KEY) fetcher = (url, init) => fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${env.PARALLELSANDBOX_API_KEY}` } });
        else { const { OAuthSession } = await import("./oauth.mjs"); const oauth = new OAuthSession({ mcpUrl: ticket.mcpUrl, open: () => {} }); fetcher = (url, init) => oauth.fetch(url, init); }
      }
      const res = await fetcher(`${ticket.apiUrl}/v1/feedback-consumers${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Psbx-Agent": agentId, "X-Psbx-Client": "parallelsandbox-feedback-relay" }, body: JSON.stringify(body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(40_000)]) });
      const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
      if (!res.ok) { const err = new Error(data.error || `HTTP ${res.status}`); err.status = res.status; throw err; }
      return data;
    };
    const targetOf = (ticket, key) => {
      if (ticket.codex) return { kind: "codex", host: "codex", id: ticket.codex.threadId, codex: ticket.codex };
      const a = orNull(() => readJson(join(p.attach, `${key}.json`)));
      return a ? { kind: "hook", host: a.host, id: a.session } : null;
    };
    const deliver = async (consumer, event) => {
      const jpath = join(p.journal, `${sha(consumer.id, event.eventId).slice(0, 40)}.json`);
      let j = orNull(() => readJson(jpath));
      if (j && (j.reportId !== event.reportId || j.boxId !== event.boxId)) throw new Error("delivery journal does not match its event");
      if (j?.state === "sending") { say("uncertain earlier codex queue attempt for", event.reportId, "- not repeating"); return; }
      if (!j) {
        j = { consumerId: consumer.id, agentId: consumer.agentId, host: consumer.target.host, target: consumer.target.id, eventId: event.eventId, boxId: event.boxId, reviewId: event.reviewId, reportId: event.reportId, leaseToken: event.leaseToken, state: "sending" };
        writeJson(jpath, j);
        if (consumer.target.kind === "codex") {
          try { j.queuedId = await queue({ ...consumer.target.codex, threadId: consumer.target.id }, followUpText(event)); }
          catch (err) { if (!err.uncertain) unlinkSync(jpath); throw err; }
          j.state = "handed";
          say("queued report", event.reportId, "as", j.queuedId, "for codex thread", consumer.target.id);
        } else {
          const box = privateDir(join(p.mail, sessionKey(consumer.target.host, consumer.target.id)));
          writeJson(join(box, `${event.eventId}.json`), { eventId: event.eventId, boxId: event.boxId, reviewId: event.reviewId, reportId: event.reportId, text: followUpText(event), at: Date.now() });
          j.state = "mailed";
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
    // Mailed events are acknowledged as soon as their conversation takes them.
    const ackHanded = async (consumer) => {
      for (const name of list(p.journal)) {
        const jpath = join(p.journal, name);
        const j = orNull(() => readJson(jpath));
        if (!j || j.consumerId !== consumer.id || j.state !== "mailed") continue;
        if (!existsSync(join(p.mail, sessionKey(j.host, j.target), `${j.eventId}.handed`))) continue;
        try {
          await request(consumer.ticket, consumer.agentId, `/${encodeURIComponent(consumer.id)}/ack`, { eventId: j.eventId, reportId: j.reportId, leaseToken: j.leaseToken, state: "host_accepted" });
          writeJson(jpath, { ...j, state: "accepted", acceptedAt: Date.now() });
          say("acknowledged", j.reportId, "accepted");
        } catch (err) { if (err.status !== 409) throw err; } // Lease expired: the next claim renews it.
      }
    };
    const consume = async (consumer) => {
      let backoff = 1000;
      while (!controller.signal.aborted) {
        try {
          await ackHanded(consumer);
          const { events = [] } = await request(consumer.ticket, consumer.agentId, `/${encodeURIComponent(consumer.id)}/claim`, { waitSec: once ? 0 : (consumer.target.kind === "hook" ? Math.min(claimWaitSec, 3) : claimWaitSec) });
          for (const event of events) { lastWork = Date.now(); await deliver(consumer, event); }
          await ackHanded(consumer);
          backoff = 1000;
          if (once) return;
        } catch (err) {
          if (controller.signal.aborted) return;
          if (err.status === 404 || err.status === 403) { say("consumer is gone:", consumer.id, err.message); return; }
          say("delivery pending:", err.message);
          if (once) throw err;
          await sleep(backoff, controller.signal); backoff = Math.min(backoff * 2, 60_000);
        }
      }
    };
    const scan = async () => {
      let active = 0;
      for (const name of list(p.tickets)) {
        const key = name.replace(/\.json$/, "");
        const ticket = orNull(() => readJson(join(p.tickets, name)));
        if (!ticket || ticket.credKey !== credKey) continue;
        if (Date.now() > ticket.expiresAt) { orNull(() => unlinkSync(join(p.tickets, name))); orNull(() => unlinkSync(join(p.attach, name))); continue; }
        active++;
        const target = targetOf(ticket, key);
        if (!target) continue;
        const consumerId = `fr_${sha("consumer", ticket.agentId, target.host, target.id).slice(0, 40)}`;
        const bindKey = `${consumerId}/${key}`;
        if (!bound.has(bindKey)) {
          await request(ticket, ticket.agentId, "", { consumerId, boxId: ticket.boxId, reviewId: ticket.reviewId, host: target.host, capability: CAPABILITIES[target.host] });
          bound.add(bindKey);
          lastWork = Date.now();
          say("bound review", ticket.reviewId, "to", target.host, target.id);
        }
        if (!loops.has(consumerId)) {
          const consumer = { id: consumerId, agentId: ticket.agentId, ticket, target };
          const loop = consume(consumer).finally(() => loops.delete(consumerId));
          loops.set(consumerId, loop);
          if (once) await loop;
        }
      }
      return active;
    };
    say("relay started", credKey);
    while (!controller.signal.aborted) {
      if (!existsSync(dir)) { say("state directory removed; relay exits"); break; }
      let active = 0;
      try { active = await scan(); } catch (err) { say("scan:", err.message); if (once) throw err; }
      if (once) break;
      if (!active && !loops.size && Date.now() - lastWork > idleExitMs) { say("no pending reviews; relay exits"); break; }
      await sleep(scanMs);
    }
  } finally {
    controller.abort();
    await Promise.allSettled([...loops.values()]);
    if (Number(orNull(() => readFileSync(pidFile, "utf8"))) === process.pid) orNull(() => unlinkSync(pidFile));
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
