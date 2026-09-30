// A local bridge to an explicitly paired, already-running Codex App Server.
// The Desktop app's private stdio/IPC transport is not an App Server endpoint.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";

export const CODEX_REVIEW_TOOLS = Object.freeze(["mcp__parallelsandbox__sandbox_review", "mcp__parallelsandbox-mcp__sandbox_review"]);
export const CODEX_FEEDBACK_CAPABILITY = "codex/turn-start-tool-output";
export const defaultCodexStateDir = () => join(homedir(), ".cache", "parallelsandbox", "codex-feedback");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const reviewKey = ({ boxId, reviewId }) => hash(JSON.stringify([boxId, reviewId]));
const sleep = (ms, signal) => new Promise((done) => {
  if (signal?.aborted) return done();
  const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); done(); };
  const timer = setTimeout(finish, ms);
  signal?.addEventListener("abort", finish, { once: true });
});
const nonempty = (value, field) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a nonempty string`);
  return value;
};

export class CodexHostError extends Error {
  constructor(message, { code = "unsupported", uncertain = false } = {}) { super(message); this.name = "CodexHostError"; this.code = code; this.uncertain = uncertain; }
}

async function privateDirectory(path) {
  if (!isAbsolute(path)) throw new Error("Codex feedback stateDir must be absolute");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) throw new Error("Codex feedback directory must be user-owned with mode 0700");
}

export async function readPrivateJson(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await file.stat();
    if (!st.isFile() || (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) throw new Error("Codex feedback file must be user-owned with mode 0600");
    if (st.size > 256 * 1024) throw new Error("Codex feedback file is too large");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}

async function writePrivateJson(path, value) {
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  try { await rename(temp, path); } catch (err) { await unlink(temp).catch(() => {}); throw err; }
}

function resultPayload(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  for (const item of result?.content ?? []) {
    if (item.type !== "text") continue;
    try { const value = JSON.parse(item.text); if (value && typeof value === "object" && value.reviewId) return value; } catch { /* Other text remains tool output. */ }
  }
  return null;
}

// Hook metadata is supplied by the trusted PostToolUse command, never by tool arguments.
export function reviewHookBinding(input, ticket, toolNames = CODEX_REVIEW_TOOLS) {
  if (input?.hook_event_name !== "PostToolUse" || !toolNames.includes(input.tool_name)) return null;
  if (input.tool_response?._meta?.psbxCodexFeedback?.token !== ticket.token) return null;
  const payload = resultPayload(input.tool_response);
  if (input.tool_response?.isError || !payload || payload.ok === false) return null;
  if (input.tool_input?.id !== ticket.boxId || payload.reviewId !== ticket.reviewId) throw new Error("PostToolUse review does not match its binding ticket");
  if (payload.id !== undefined && payload.id !== ticket.boxId) throw new Error("PostToolUse box does not match its binding ticket");
  return { boxId: ticket.boxId, reviewId: ticket.reviewId, sessionId: nonempty(input.session_id, "PostToolUse session_id"), cwd: nonempty(input.cwd, "PostToolUse cwd"), token: ticket.token };
}

// Codex 0.159.2's non-experimental TurnToolOutput schema uses Responses content types.
// File/video/audio references and transcripts inside text JSON remain intact.
export function reportToolOutput(result) {
  if (result?.isError) throw new Error("sandbox_report did not prepare the complete human report");
  if (!Array.isArray(result?.content)) throw new Error("sandbox_report must return MCP content");
  const output = result.content.map((item) => {
    if (item.type === "text" && typeof item.text === "string") return { type: "input_text", text: item.text };
    if (item.type === "image" && /^image\/[a-z0-9.+-]+$/i.test(item.mimeType ?? "") && typeof item.data === "string") {
      const data = item.data.replace(/\s/g, "");
      if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || Buffer.from(data, "base64").toString("base64") !== data) throw new Error("sandbox_report image has invalid base64 data");
      return { type: "input_image", image_url: `data:${item.mimeType};base64,${data}` };
    }
    throw new Error(`Unsupported sandbox_report content type: ${item?.type ?? "missing"}`);
  });
  if (!output.length && result.structuredContent) output.push({ type: "input_text", text: JSON.stringify(result.structuredContent) });
  if (!output.length) throw new Error("sandbox_report returned no report content");
  return { name: "sandbox_report", namespace: "parallelsandbox", output };
}

export async function connectCodexHost({ cliPath, socketPath, signal, timeoutMs = 10_000, onHostRequest, onNotification } = {}) {
  if (!socketPath || !cliPath) throw new CodexHostError("An explicitly paired Codex App Server socket and CLI are required; the current Desktop stdio host is unsupported");
  if (!isAbsolute(socketPath) || !isAbsolute(cliPath)) throw new CodexHostError("Codex CLI and App Server socket paths must be absolute");
  if (resolve(socketPath) === join(homedir(), ".codex", "ipc", "ipc.sock")) throw new CodexHostError("The Desktop private IPC socket is not a supported Codex App Server endpoint");
  const socket = await lstat(socketPath).catch(() => null);
  const parent = await lstat(dirname(socketPath)).catch(() => null);
  if (!socket?.isSocket() || socket.isSymbolicLink() || !parent?.isDirectory() || (parent.mode & 0o077) || (process.getuid && (socket.uid !== process.getuid() || parent.uid !== process.getuid()))) throw new CodexHostError("The paired App Server socket must already exist in a user-owned private directory");
  const child = spawn(cliPath, ["app-server", "proxy", "--sock", socketPath], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map(), hostRequests = new Map();
  let nextId = 1, closed = false, closeReason = "Codex App Server connection closed";
  const close = (reason = closeReason) => {
    if (closed) return;
    closed = true; closeReason = reason;
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new CodexHostError(reason, { code: "disconnected", uncertain: call.method === "turn/start" })); }
    pending.clear(); child.stdin.destroy(); child.kill();
  };
  const send = (message) => { if (closed) throw new CodexHostError(closeReason, { code: "disconnected" }); child.stdin.write(`${JSON.stringify(message)}\n`); };
  const request = (method, params) => new Promise((accept, reject) => {
    if (closed || signal?.aborted) return reject(new CodexHostError(closeReason, { code: "disconnected" }));
    const id = nextId++;
    const timer = setTimeout(() => { close(`Codex App Server ${method} response timed out`); }, timeoutMs);
    pending.set(id, { accept, reject, timer, method });
    try { send({ id, method, params }); } catch (err) { clearTimeout(timer); pending.delete(id); reject(err); }
  });
  child.on("error", (err) => close(`Cannot connect to the paired Codex App Server: ${err.message}`));
  child.on("exit", () => close());
  child.stdin.on("error", () => close());
  child.stderr.on("data", () => {}); // Never print host stderr, which may contain auth or conversation data.
  const reader = createInterface({ input: child.stdout });
  reader.on("line", async (line) => {
    let message;
    try { message = JSON.parse(line); } catch { close("Invalid JSON from the paired Codex App Server"); return; }
    if (message.method) {
      if (message.id !== undefined) {
        // Approval/elicitation belongs to the existing host. Never grant it automatically.
        hostRequests.set(message.id, { requestId: message.id, method: message.method, threadId: message.params?.threadId });
        onNotification?.({ method: "parallelsandbox/hostRequestRequired", params: { requestId: message.id, method: message.method, threadId: message.params?.threadId } });
        if (onHostRequest) {
          try { const result = await onHostRequest(message); if (result !== undefined) { send({ id: message.id, result }); hostRequests.delete(message.id); onNotification?.({ method: "parallelsandbox/hostRequestHandled", params: { requestId: message.id } }); } }
          catch { onNotification?.({ method: "parallelsandbox/hostRequestRoutingFailed", params: { requestId: message.id, method: message.method } }); }
        }
      } else onNotification?.(message);
      return;
    }
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id); clearTimeout(call.timer);
    if (message.error) call.reject(new CodexHostError(`Codex App Server rejected ${call.method}: ${message.error.message ?? message.error.code}`, { code: "rejected" }));
    else call.accept(message.result);
  });
  const abort = () => close("Codex feedback bridge was cancelled");
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const info = await request("initialize", { clientInfo: { name: "parallelsandbox_feedback", title: "ParallelSandbox feedback bridge", version: "0.1.0" } });
    send({ method: "initialized", params: {} });
    return {
      info,
      isConnected() { return !closed; },
      pendingHostRequests() { return [...hostRequests.values()]; },
      async probeThread(threadId) {
        nonempty(threadId, "threadId");
        let cursor;
        const cursors = new Set();
        do {
          const loaded = await request("thread/loaded/list", { ...(cursor ? { cursor } : {}) });
          if (!Array.isArray(loaded?.data)) throw new CodexHostError("Invalid thread/loaded/list response");
          if (loaded.data.includes(threadId)) {
            const read = await request("thread/read", { threadId, includeTurns: false });
            if (read?.thread?.id !== threadId) throw new CodexHostError("The paired host returned a different thread");
            return { connected: true, threadLoaded: true, threadId, status: read.thread.status };
          }
          cursor = loaded.nextCursor;
          if (cursor && cursors.has(cursor)) throw new CodexHostError("The paired host repeated a thread-list cursor");
          cursors.add(cursor);
        } while (cursor);
        throw new CodexHostError("The original thread is not loaded in this paired App Server; no other runtime will be started", { code: "thread_not_loaded" });
      },
      async deliverReport(threadId, result) {
        const toolOutput = reportToolOutput(result);
        await this.probeThread(threadId);
        const response = await request("turn/start", { threadId, input: [], toolOutput });
        if (!response?.turn?.id) throw new CodexHostError("Codex did not confirm a turn identity; delivery outcome is unknown", { code: "unknown_result", uncertain: true });
        return { state: "host_accepted", threadId, turnId: response.turn.id };
      },
      close() { signal?.removeEventListener("abort", abort); reader.close(); close(); },
    };
  } catch (err) { signal?.removeEventListener("abort", abort); reader.close(); close(); throw err; }
}

// The host hook and adapter share only private binding tickets, not API credentials.
export async function writeCodexHookBinding(input, { stateDir = defaultCodexStateDir(), toolNames = CODEX_REVIEW_TOOLS } = {}) {
  if (input?.hook_event_name !== "PostToolUse" || !toolNames.includes(input.tool_name)) return { bound: false };
  const payload = resultPayload(input.tool_response);
  if (!payload?.reviewId || !input.tool_input?.id) return { bound: false };
  await privateDirectory(stateDir);
  const key = reviewKey({ boxId: input.tool_input.id, reviewId: payload.reviewId });
  const ticket = await readPrivateJson(join(stateDir, `${key}.ticket.json`)).catch((err) => { if (err.code === "ENOENT") return null; throw err; });
  if (!ticket) return { bound: false, reason: "no_adapter_ticket" };
  if (input.tool_response?._meta?.psbxCodexFeedback?.token !== ticket.token) return { bound: false, reason: "missing_or_mismatched_private_marker" };
  const binding = reviewHookBinding(input, ticket, toolNames);
  if (!binding) return { bound: false };
  await writePrivateJson(join(stateDir, `${key}.binding.json`), binding);
  return { bound: true, reviewId: binding.reviewId };
}

export function createCodexFeedback({ apiUrl, headers, authorizedFetch, callRemoteReport, cliPath, socketPath, stateDir = defaultCodexStateDir(), toolNames = CODEX_REVIEW_TOOLS, onState = () => {}, onHostRequest, connectHost = connectCodexHost, claimWaitSec = 25 } = {}) {
  const tickets = new Map(), consumers = new Map();
  let runner, scanPromise, host, hostPromise;
  const configured = Boolean(cliPath && socketPath);
  const state = { configured, supported: false, capabilityConfirmed: false, approvalRouting: onHostRequest ? "external_handler" : "unverified", running: false, reason: configured ? "awaiting_trusted_review_hook" : "current_desktop_stdio_unsupported" };
  const emit = (value) => { const changed = Object.keys(value).some((key) => state[key] !== value[key]); Object.assign(state, value); if (changed) onState({ ...state }); };
  const post = async (path, body, signal) => {
    const response = await authorizedFetch(`${apiUrl.replace(/\/+$/, "")}/v1/feedback-consumers${path}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    if (!response.ok) throw new Error(`Codex feedback request failed (${response.status})`);
    return response.status === 204 ? {} : response.json();
  };
  const getHost = async (signal) => {
    if (host && host.isConnected?.() !== false) return host;
    if (host) { host.close(); host = null; }
    if (!hostPromise) hostPromise = connectHost({ cliPath, socketPath, signal, onHostRequest, onNotification: (message) => {
      if (message.method === "parallelsandbox/hostRequestRequired") emit({ reason: "host_request_required", pendingHostRequest: message.params, threadId: message.params.threadId });
      if (message.method === "parallelsandbox/hostRequestRoutingFailed") emit({ reason: "host_request_routing_failed", requestMethod: message.params.method });
      if (message.method === "parallelsandbox/hostRequestHandled" && state.pendingHostRequest?.requestId === message.params.requestId) emit({ pendingHostRequest: null });
    } }).then((value) => (host = value)).finally(() => { hostPromise = null; });
    return hostPromise;
  };
  const journalPath = (consumerId, event) => join(stateDir, `${hash(JSON.stringify([consumerId, event.boxId, event.reviewId, event.reportId, event.eventId]))}.delivery.json`);
  const deliver = async (consumer, event, signal) => {
    const binding = consumer.bindings.get(reviewKey(event));
    if (!binding || !event.eventId || !event.reportId || !event.leaseToken) throw new Error("Feedback event does not match a trusted original-thread binding");
    const identity = { boxId: event.boxId, reviewId: event.reviewId, reportId: event.reportId, eventId: event.eventId, threadId: binding.sessionId };
    const path = journalPath(consumer.id, event);
    let journal = await readPrivateJson(path).catch((err) => { if (err.code === "ENOENT") return null; throw err; });
    if (journal && Object.keys(identity).some((key) => journal[key] !== identity[key])) throw new Error("Feedback delivery journal does not match the original thread and event");
    if (journal && journal.state !== "host_accepted") { emit({ reason: "host_delivery_uncertain", reportId: event.reportId }); await sleep(2000, signal); return; }
    if (!journal) {
      const result = await callRemoteReport({ id: event.boxId, reportId: event.reportId, signal });
      reportToolOutput(result); // Fail before opening a turn if media preparation/format is incomplete.
      const currentHost = await getHost(signal);
      await currentHost.probeThread(binding.sessionId);
      await writePrivateJson(path, { ...identity, state: "sending" });
      try {
        journal = await currentHost.deliverReport(binding.sessionId, result);
        if (journal?.state !== "host_accepted" || !journal.turnId || (journal.threadId && journal.threadId !== binding.sessionId)) throw new CodexHostError("The paired host did not confirm this original thread; delivery outcome is unknown", { uncertain: true, code: "unknown_result" });
        journal = { ...journal, threadId: binding.sessionId };
      }
      catch (err) {
        if (!err.uncertain) await unlink(path);
        if (err.code === "disconnected") { host?.close(); host = null; }
        throw err;
      }
      // Persist acceptance before ACK; a failed ACK can never enqueue this report twice.
      await writePrivateJson(path, { ...journal, ...identity });
    }
    await post(`/${encodeURIComponent(consumer.id)}/ack`, { eventId: event.eventId, reportId: event.reportId, leaseToken: event.leaseToken, state: "host_accepted" }, signal);
    emit({ reason: "host_accepted", capabilityConfirmed: true, reportId: event.reportId, threadId: binding.sessionId, turnId: journal.turnId });
  };
  const consume = async (consumer, signal) => {
    while (!signal.aborted) {
      try {
        const response = await post(`/${encodeURIComponent(consumer.id)}/claim`, { waitSec: Math.max(0, Math.min(25, claimWaitSec)) }, signal);
        if (!Array.isArray(response.events) || response.events.length > 1) throw new Error("Invalid feedback claim response");
        for (const event of response.events) await deliver(consumer, event, signal);
        if (!response.events.length || claimWaitSec === 0) await sleep(1000, signal);
      } catch (err) { if (!signal.aborted) { emit({ reason: err.uncertain ? "host_delivery_uncertain" : "delivery_pending", error: err.message }); await sleep(2000, signal); } }
    }
  };
  const scan = async (signal) => {
    for (const [key, ticket] of tickets) {
      if (ticket.bound) continue;
      const binding = await readPrivateJson(join(stateDir, `${key}.binding.json`)).catch((err) => { if (err.code === "ENOENT") return null; throw err; });
      if (!binding) continue;
      if (binding.token !== ticket.token || binding.boxId !== ticket.boxId || binding.reviewId !== ticket.reviewId) throw new Error("Invalid Codex hook binding ticket");
      nonempty(binding.sessionId, "sessionId");
      const currentHost = await getHost(signal);
      await currentHost.probeThread(binding.sessionId);
      const consumerId = `codex_${hash(JSON.stringify([socketPath, binding.sessionId])).slice(0,40)}`;
      await post("", { consumerId, boxId: binding.boxId, reviewId: binding.reviewId, host: "codex", capability: CODEX_FEEDBACK_CAPABILITY }, signal);
      let consumer = consumers.get(consumerId);
      if (!consumer) { consumer = { id: consumerId, bindings: new Map() }; consumers.set(consumerId, consumer); }
      consumer.bindings.set(key, binding); ticket.bound = true;
      if (!consumer.promise) consumer.promise = consume(consumer, signal);
      emit({ reason: "paired_original_thread", supported: true, threadId: binding.sessionId });
    }
  };
  return {
    async trackReview({ boxId, reviewId }) {
      if (!configured) return { supported: false, reason: state.reason };
      nonempty(boxId, "boxId"); nonempty(reviewId, "reviewId");
      if (!headers?.["X-Psbx-Agent"]) throw new Error("Codex feedback tracking requires the actual adapter agent identity");
      await privateDirectory(stateDir);
      const key = reviewKey({ boxId, reviewId });
      if (!tickets.has(key)) { const ticket = { boxId, reviewId, token: randomBytes(24).toString("hex"), agentId: headers["X-Psbx-Agent"] }; await writePrivateJson(join(stateDir, `${key}.ticket.json`), ticket); tickets.set(key, ticket); }
      return { supported: state.supported, configured: true, awaitingHook: true, stateDir, hookMeta: { token: tickets.get(key).token } };
    },
    bindHook(input) { return writeCodexHookBinding(input, { stateDir, toolNames }); },
    start() {
      if (runner || !configured) return { ...state };
      runner = new AbortController(); emit({ running: true });
      for (const consumer of consumers.values()) consumer.promise = consume(consumer, runner.signal);
      scanPromise = (async () => { while (!runner.signal.aborted) { try { await scan(runner.signal); } catch (err) { if (!runner.signal.aborted) emit({ reason: "pairing_pending", error: err.message }); } await sleep(500, runner.signal); } })();
      return { ...state };
    },
    async stop() { const stopping = runner; stopping?.abort(); host?.close(); await scanPromise; await Promise.all([...consumers.values()].map((c) => c.promise)); for (const c of consumers.values()) c.promise = null; host = null; runner = null; emit({ running: false }); },
    status() { return { ...state }; },
  };
}
