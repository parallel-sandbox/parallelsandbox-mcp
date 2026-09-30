import { randomBytes, timingSafeEqual } from "node:crypto";

export const CLAUDE_CHANNEL_CAPABILITIES = {
  experimental: { "claude/channel": {} },
};

// These instructions apply only to this opted-in channel, not to ordinary turns.
export const CLAUDE_CHANNEL_INSTRUCTIONS = "This development integration tests Claude Code native channel capability. For a channel activation event, call parallelsandbox_channel_ready with that event's nonce. The challenge proves native event reception only; it does not prove original-session routing. The current adapter does not automatically deliver human feedback without a trusted host integration that proves immutable review/session binding and session-scoped native queue delivery. A future guarded human feedback event contains only the box id and reportId: read them with sandbox_report, then call parallelsandbox_feedback_ack after reading the complete result. Receipt does not mean the requested work is finished. Permission prompts and questions stay in Claude Code.";

const READY = "parallelsandbox_channel_ready";
const ACK = "parallelsandbox_feedback_ack";
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const validId = (value) => typeof value === "string" && idPattern.test(value);
const result = (value, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
const key = (boxId, reportId) => JSON.stringify([boxId, reportId]);

function payloadOf(value) {
  if (!value || typeof value !== "object" || value.isError) return null;
  const structured = value.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) return structured;
  for (const item of value.content || []) {
    if (item?.type !== "text") continue;
    try {
      const parsed = JSON.parse(item.text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* Non-JSON content is not a successful report receipt. */ }
  }
  return null;
}

function onlyFields(args, fields) {
  return !!args && typeof args === "object" && !Array.isArray(args) && Object.keys(args).every((field) => fields.includes(field));
}

export function createClaudeChannel({ server, authorizedFetch, apiUrl, headers, consumerId, trustedSessionGuard }) {
  if (typeof server?.notification !== "function" || typeof authorizedFetch !== "function") throw new TypeError("Claude channel needs its MCP server and authorizedFetch.");
  if (typeof consumerId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(consumerId)) throw new TypeError("Invalid feedback consumer id.");
  const base = new URL(apiUrl);
  if (!["https:", "http:"].includes(base.protocol)) throw new TypeError("Invalid ParallelSandbox API URL.");
  const endpoint = base.href.replace(/\/+$/, "");
  const consumerPath = `/v1/feedback-consumers/${encodeURIComponent(consumerId)}`;
  const nonce = randomBytes(24).toString("base64url");
  const lifetime = new AbortController();
  const requests = new Set();
  const reviews = new Map();
  const pending = new Map();
  const sent = new Set();
  const read = new Set();
  const acknowledged = new Set();
  const foreground = new Set();
  let activated = false;
  let handshakeSent = false;
  let closed = false;
  let polling = null;
  // A live stdio process can survive /clear or /resume. Neither a client name,
  // lifecycle boolean nor the ready challenge proves which session owns its queue.
  // No current production integration supplies this guarded native capability.
  const hasSessionGuard = ["bindReview", "checkDispatch", "checkAck"].every((method) => typeof trustedSessionGuard?.[method] === "function");

  function sessionProof(value, review) {
    if (!value || value.boxId !== review.boxId || value.reviewId !== review.reviewId || !validId(value.sessionId) || !validId(value.bindingId) || value.queueScope?.kind !== "native-session" || value.queueScope.sessionId !== value.sessionId || !validId(value.queueScope.proofId)) {
      const error = new Error("A trusted immutable session binding and native queue scope proof are required.");
      error.guardRejected = true;
      throw error;
    }
    return Object.freeze({ boxId: value.boxId, reviewId: value.reviewId, sessionId: value.sessionId, bindingId: value.bindingId, queueScope: Object.freeze({ kind: "native-session", sessionId: value.sessionId, proofId: value.queueScope.proofId }) });
  }

  async function checkSession(review, method, reportId) {
    if (!hasSessionGuard || !review?.proof) throw new Error("Original native session guard is unavailable.");
    const checked = sessionProof(await trustedSessionGuard[method]({ boxId: review.boxId, reviewId: review.reviewId, reportId, proof: structuredClone(review.proof) }), review);
    if (JSON.stringify(checked) !== JSON.stringify(review.proof)) {
      const error = new Error("The original session or native queue scope changed; feedback remains pending.");
      error.guardRejected = true;
      throw error;
    }
  }

  const readyToolDefs = [
    { name: READY, description: "Confirm native channel event reception using its nonce. This only proves channel capability; current original-session routing is unsupported without a separately verified native session/queue guard.", inputSchema: { type: "object", required: ["nonce"], additionalProperties: false, properties: { nonce: { type: "string" } } }, annotations: { idempotentHint: true } },
    { name: ACK, description: "Acknowledge reading a human feedback report delivered to this original session. First read its complete sandbox_report result. This receipt does not mark the requested work finished.", inputSchema: { type: "object", required: ["id", "reportId"], additionalProperties: false, properties: { id: { type: "string" }, reportId: { type: "string" } } }, annotations: { idempotentHint: true } },
  ];

  async function post(path, body, timeoutMs = 10_000) {
    if (closed) throw new Error("Claude channel is closed.");
    const controller = new AbortController();
    requests.add(controller);
    const timer = setTimeout(() => controller.abort(new Error("Feedback request timed out.")), timeoutMs);
    timer.unref?.();
    try {
      const response = await authorizedFetch(`${endpoint}${path}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) {
        const error = new Error(`ParallelSandbox feedback request failed (HTTP ${response.status}).`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
      requests.delete(controller);
    }
  }

  function pause(ms) {
    if (closed) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); lifetime.signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      lifetime.signal.addEventListener("abort", done, { once: true });
    });
  }

  function log(error) {
    if (!closed) console.error("[parallelsandbox-mcp] Claude channel:", error?.message || String(error));
  }

  async function bind(review) {
    if (review.bound || review.blocked || closed) return;
    if (review.binding) return review.binding;
    review.binding = (async () => {
      try {
        if (!hasSessionGuard) throw new Error("Original native session guard is unavailable.");
        const proof = sessionProof(await trustedSessionGuard.bindReview({ boxId: review.boxId, reviewId: review.reviewId }), review);
        const receipt = await post("/v1/feedback-consumers", { consumerId, boxId: review.boxId, reviewId: review.reviewId, host: "claude-code", capability: "claude/channel" });
        if (receipt?.ok !== true || (receipt.consumerId !== undefined && receipt.consumerId !== consumerId)) throw new Error("Invalid feedback binding receipt.");
        review.proof = proof;
        review.bound = true;
      } catch (error) {
        if (error.guardRejected || (error.status >= 400 && error.status < 500)) review.blocked = true;
        throw error;
      } finally { review.binding = null; }
    })();
    return review.binding;
  }

  async function acceptEvents(data) {
    if (closed || !activated) return;
    if (!data || !Array.isArray(data.events)) throw new Error("Invalid feedback claim response.");
    for (const event of data.events) {
      if (!event || !validId(event.eventId) || !validId(event.reportId) || !validId(event.boxId) || !validId(event.reviewId) || typeof event.leaseToken !== "string" || !event.leaseToken || typeof event.leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(event.leaseExpiresAt))) throw new Error("Invalid feedback event.");
      const review = reviews.get(key(event.boxId, event.reviewId));
      if (!review?.bound) throw new Error("Feedback event does not belong to this consumer's bound review.");
      const reportKey = key(event.boxId, event.reportId);
      if (acknowledged.has(reportKey) || foreground.has(reportKey)) continue;
      const previous = pending.get(reportKey);
      if (previous && previous.eventId !== event.eventId) throw new Error("Feedback event identity changed.");
      // Renew the private lease without resending an event already queued by Claude.
      pending.set(reportKey, { ...event, acking: previous?.acking });
      if (sent.has(reportKey)) continue;
      await checkSession(review, "checkDispatch", event.reportId);
      await server.notification({ method: "notifications/claude/channel", params: { content: "Human feedback is available for the existing task. Read the report with sandbox_report and acknowledge receipt after reading it.", meta: { box_id: event.boxId, report_id: event.reportId } } });
      if (!closed) sent.add(reportKey);
      // A successful notification is only a transport write, never an ACK.
    }
  }

  function ensurePolling() {
    if (!hasSessionGuard || !activated || closed || polling || !reviews.size) return;
    polling = (async () => {
      while (!closed && activated) {
        let retry = false;
        for (const review of reviews.values()) {
          if (review.bound || review.blocked) continue;
          try { await bind(review); }
          catch (error) { log(error); retry = !review.blocked || retry; }
        }
        if (closed) break;
        if (![...reviews.values()].some((review) => review.bound)) {
          if (!retry) break;
          await pause(1_000);
          continue;
        }
        try {
          const data = await post(`${consumerPath}/claim`, { waitSec: 25 }, 30_000);
          await acceptEvents(data);
          if (!data.events.length) await pause(1_000);
        } catch (error) {
          if (closed) break;
          log(error);
          if (error.status >= 400 && error.status < 500) break;
          await pause(1_000);
        }
      }
    })().finally(() => { polling = null; });
  }

  async function startHandshake() {
    if (closed || handshakeSent) return false;
    handshakeSent = true;
    try {
      await server.notification({ method: "notifications/claude/channel", params: { content: "ParallelSandbox native channel activation check. Call parallelsandbox_channel_ready with the nonce in this event to confirm that this original session receives native channel events.", meta: { kind: "activation", nonce } } });
      return true;
    } catch (error) { handshakeSent = false; log(error); return false; }
  }

  async function onReviewResult(boxId, toolResult) {
    const data = payloadOf(toolResult);
    if (closed || !validId(boxId) || data?.ok !== true || !validId(data.reviewId)) return { bound: false };
    if (!hasSessionGuard) return { bound: false, reason: "original_session_guard_unavailable" };
    if (validId(data.reportId) && typeof data.fromHuman === "string" && data.fromHuman.trim() && !data.humanDeliveryError) foreground.add(key(boxId, data.reportId));
    const reviewKey = key(boxId, data.reviewId);
    let review = reviews.get(reviewKey);
    if (!review) { review = { boxId, reviewId: data.reviewId, bound: false, blocked: false, binding: null }; reviews.set(reviewKey, review); }
    if (!activated) return { bound: false, reason: "channel_not_activated" };
    review.blocked = false;
    try { await bind(review); ensurePolling(); return { bound: review.bound }; }
    catch (error) { log(error); ensurePolling(); return { bound: false, reason: error.message }; }
  }

  function onToolResult(name, args, toolResult) {
    if (closed || name !== "sandbox_report" || !validId(args?.id) || !validId(args?.reportId)) return;
    const data = payloadOf(toolResult);
    if (data?.ok === true && data.reportId === args.reportId && typeof data.fromHuman === "string" && data.fromHuman.trim() && !data.humanDeliveryError) read.add(key(args.id, args.reportId));
  }

  async function handleTool(name, args) {
    if (name !== READY && name !== ACK) return null;
    if (closed) return result({ ok: false, error: "This original channel connection is closed." }, true);
    if (name === READY) {
      const supplied = typeof args?.nonce === "string" ? Buffer.from(args.nonce) : Buffer.alloc(0);
      const expected = Buffer.from(nonce);
      if (!handshakeSent || !onlyFields(args, ["nonce"]) || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return result({ ok: false, error: "Use the nonce received through this session's native channel activation event." }, true);
      activated = true;
      ensurePolling();
      return result({ ok: true, activated: true, capability: "claude/channel", sessionRouting: false, note: "Native event reception is verified. It does not establish original-session routing; the current adapter has no verified native session/queue integration." });
    }
    if (!activated || !onlyFields(args, ["id", "reportId"]) || !validId(args?.id) || !validId(args?.reportId)) return result({ ok: false, error: "Use the exact box id and reportId from this original session's feedback event." }, true);
    const reportKey = key(args.id, args.reportId);
    if (acknowledged.has(reportKey)) return result({ ok: true, state: "read", alreadyAcknowledged: true, reportId: args.reportId });
    let event = pending.get(reportKey);
    if (!event || !read.has(reportKey)) return result({ ok: false, error: "Read this consumer's complete sandbox_report result before acknowledging receipt." }, true);
    if (event.acking) return event.acking;
    event.acking = (async () => {
      try {
        const review = reviews.get(key(event.boxId, event.reviewId));
        await checkSession(review, "checkAck", event.reportId);
        if (Date.parse(event.leaseExpiresAt) <= Date.now()) {
          await acceptEvents(await post(`${consumerPath}/claim`, { waitSec: 0 }));
          event = pending.get(reportKey);
          if (Date.parse(event.leaseExpiresAt) <= Date.now()) throw new Error("The feedback lease expired; retry receipt after this consumer renews it.");
        }
        await checkSession(review, "checkAck", event.reportId);
        const receipt = await post(`${consumerPath}/ack`, { eventId: event.eventId, reportId: event.reportId, leaseToken: event.leaseToken, state: "read" });
        if (receipt?.ok !== true) throw new Error("Invalid feedback acknowledgement receipt.");
        acknowledged.add(reportKey);
        pending.delete(reportKey);
        return result({ ok: true, state: "read", reportId: args.reportId });
      } catch (error) { log(error); return result({ ok: false, error: error.message }, true); }
      finally { const current = pending.get(reportKey); if (current) current.acking = null; }
    })();
    return event.acking;
  }

  async function shutdown() {
    if (closed) return;
    closed = true;
    activated = false;
    lifetime.abort();
    for (const request of requests) request.abort(new Error("Claude channel connection closed."));
    await polling;
    // Unacknowledged leases remain pending on the server; nothing is discarded.
    pending.clear(); sent.clear(); read.clear(); acknowledged.clear(); foreground.clear(); reviews.clear();
  }

  return { capabilities: CLAUDE_CHANNEL_CAPABILITIES, instructions: CLAUDE_CHANNEL_INSTRUCTIONS, readyToolDefs, handlesTool: (name) => name === READY || name === ACK, handleTool, startHandshake, onReviewResult, onToolResult, shutdown };
}
