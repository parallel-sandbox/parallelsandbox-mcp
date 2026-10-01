import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OAuthSession } from "./oauth.mjs";

const drivers = {
  "claude-code": () => import("./native-claude.mjs"),
  codex: () => import("./native-codex.mjs"),
  gemini: () => import("./native-gemini.mjs"),
};
export const nativeProviders = Object.keys(drivers);
const profileKeys = {
  "claude-code": ["PSBX_CLAUDE_MODEL", "PSBX_CLAUDE_ALLOWED_TOOLS", "PSBX_CLAUDE_BASE_URL"],
  codex: ["PSBX_CODEX_MODEL", "PSBX_CODEX_REASONING_EFFORT", "PSBX_CODEX_APPROVAL_POLICY", "PSBX_CODEX_SANDBOX_MODE", "PSBX_CODEX_ALLOWED_MCP_TOOLS"],
  gemini: ["PSBX_GEMINI_MODEL", "PSBX_GEMINI_APPROVAL_MODE", "PSBX_GEMINI_BASE_URL", "PSBX_GEMINI_TRUST_WORKSPACE",
    "PSBX_GEMINI_VERTEX_AI", "PSBX_GEMINI_PROJECT", "PSBX_GEMINI_LOCATION"],
};
const profileAliases = {
  PSBX_CLAUDE_BASE_URL: "ANTHROPIC_BASE_URL",
  PSBX_GEMINI_MODEL: "GEMINI_MODEL", PSBX_GEMINI_BASE_URL: "GOOGLE_GEMINI_BASE_URL",
  PSBX_GEMINI_TRUST_WORKSPACE: "GEMINI_CLI_TRUST_WORKSPACE", PSBX_GEMINI_VERTEX_AI: "GOOGLE_GENAI_USE_VERTEXAI",
  PSBX_GEMINI_PROJECT: "GOOGLE_CLOUD_PROJECT", PSBX_GEMINI_LOCATION: "GOOGLE_CLOUD_LOCATION",
};
const claudeDefaultTools = "mcp__parallelsandbox__sandbox_report,mcp__parallelsandbox__sandbox_review,mcp__parallelsandbox__sandbox_status";

// Capture only named, nonsecret native settings, including empty settings so a
// recovery shell cannot silently broaden permissions or change the model.
export function captureNativeProfile(provider, env = process.env) {
  if (!profileKeys[provider]) throw new Error("Unknown native provider");
  const profile = Object.fromEntries(profileKeys[provider].map((key) => [key,
    key === "PSBX_CLAUDE_ALLOWED_TOOLS" ? env[key] || claudeDefaultTools :
      key === "PSBX_CODEX_ALLOWED_MCP_TOOLS" ? env[key] ?? "sandbox_report,sandbox_review,sandbox_status" :
      env[key] ?? env[profileAliases[key]] ?? ""]));
  for (const [key, value] of Object.entries(profile)) {
    if (typeof value !== "string" || value.length > 4096) throw new Error("Native profile values must be explicit nonsecret strings");
    if (!key.endsWith("_BASE_URL") || !value) continue;
    let url;
    try { url = new URL(value); } catch { throw new Error("Native base URL must be an HTTP(S) endpoint without credentials, query or fragment"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Native base URL must be an HTTP(S) endpoint without credentials, query or fragment");
    }
  }
  return profile;
}

function validatedProfile(provider, profile) {
  if (!profile || Array.isArray(profile) || typeof profile !== "object" ||
      Object.keys(profile).some((key) => !profileKeys[provider].includes(key)) ||
      Object.values(profile).some((value) => typeof value !== "string" || value.length > 4096)) {
    throw new Error("Saved native profile must contain only explicit nonsecret model and permission settings");
  }
  return captureNativeProfile(provider, profile);
}
const stamp = () => new Date().toISOString();
const safeID = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(v);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };

function acquireOwner(directory) {
  const lock = join(directory, "owner.lock");
  const name = `${process.pid}.${randomBytes(16).toString("hex")}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      mkdirSync(lock, {mode: 0o700});
      const before = lstatSync(lock);
      writeFileSync(join(lock, name), "", {flag: "wx", mode: 0o600});
      const after = lstatSync(lock);
      if (before.ino !== after.ino || before.dev !== after.dev || readdirSync(lock).length !== 1) {
        try { unlinkSync(join(lock, name)); } catch {}
        continue;
      }
      return () => {
        try { unlinkSync(join(lock, name)); } catch (error) { if (error.code !== "ENOENT") throw error; }
        try { rmdirSync(lock); } catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; }
      };
    } catch (error) {
      if (!["EEXIST", "ENOENT"].includes(error.code)) throw error;
      try {
        const entries = readdirSync(lock);
        for (const entry of entries) {
          const match = /^([1-9][0-9]*)\.[a-f0-9]{32}$/.exec(entry);
          if (!match || alive(Number(match[1]))) throw new Error("The original supervisor already owns this native session");
          // Never unlink a new owner's file: each filename carries a unique nonce.
          try { unlinkSync(join(lock, entry)); } catch (e) { if (e.code !== "ENOENT") throw e; }
        }
        if (!entries.length && Date.now() - lstatSync(lock).mtimeMs < 30_000) throw new Error("The original supervisor is acquiring this native session");
        try { rmdirSync(lock); } catch (e) { if (!["ENOENT", "ENOTEMPTY"].includes(e.code)) throw e; }
      } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
  }
  throw new Error("Native session ownership changed during recovery; retry after checking its status");
}

export function savePrivate(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), {mode: 0o600});
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

export class SessionHost {
  constructor(config) {
    if (!drivers[config.provider]) throw new Error("Unknown native provider");
    this.config = config;
    this.dir = config.stateDir;
    mkdirSync(this.dir, {recursive: true, mode: 0o700});
    chmodSync(this.dir, 0o700);
    this.stateFile = join(this.dir, "state.json");
    this.state = existsSync(this.stateFile) ? JSON.parse(readFileSync(this.stateFile, "utf8")) : {
      provider: config.provider, cwd: config.cwd, agentId: config.agentId,
      sessionId: "", reviews: [], deliveries: {}, turns: [], createdAt: stamp(),
    };
    if (this.state.provider !== config.provider || this.state.cwd !== config.cwd || this.state.agentId !== config.agentId) {
      throw new Error("Session ownership does not match saved state");
    }
    this.apiUrl = config.apiUrl.replace(/\/+$/, "");
    this.headers = {"content-type": "application/json", "X-Psbx-Agent": config.agentId,
      "X-Psbx-Client": `parallelsandbox-agent/${config.provider}`};
    this.oauth = process.env.PARALLELSANDBOX_API_KEY ? null : new OAuthSession({mcpUrl: config.mcpUrl});
    if (!this.oauth) this.headers.Authorization = `Bearer ${process.env.PARALLELSANDBOX_API_KEY}`;
    this.controller = new AbortController();
    this.busy = false;
    this.child = null;
    this.generation = "";
    this.state.queue ||= [];
    this.queue = this.state.queue;
    this.activeDelivery = null;
    this.presenceTimer = null;
    this.presenceFlight = null;
  }

  persist() { this.state.updatedAt = stamp(); savePrivate(this.stateFile, this.state); }
  audit(event, detail = {}) {
    appendFileSync(join(this.dir, "events.jsonl"), JSON.stringify({at: stamp(), event, ...detail}) + "\n", {mode: 0o600});
  }
  async fetch(url, init) { return this.oauth ? this.oauth.fetch(url, init) : fetch(url, init); }
  async post(path, body, timeout = 35_000) {
    const res = await this.fetch(this.apiUrl + path, {method: "POST", headers: this.headers,
      body: JSON.stringify(body), signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeout)])});
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || `Feedback HTTP ${res.status}`);
    return result;
  }

  async presence(what) {
    try {
      const signal = what === "heartbeat"
        ? AbortSignal.any([this.controller.signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(2_000);
      const res = await this.fetch(`${this.apiUrl}/v1/agents/${this.config.agentId}/${what}`, {
        method: "POST", headers: this.headers,
        body: JSON.stringify(what === "heartbeat" ? {client: this.config.provider} : {}), signal,
      });
      return res.ok;
    } catch { return false; }
  }

  startPresence() {
    const heartbeat = () => {
      if (this.controller.signal.aborted || this.presenceFlight) return;
      this.presenceFlight = this.presence("heartbeat").finally(() => { this.presenceFlight = null; });
    };
    heartbeat();
    this.presenceTimer = setInterval(heartbeat, 60_000);
    this.presenceTimer.unref();
  }

  async start() {
    this.driver = await drivers[this.config.provider]();
    this.releaseOwner = acquireOwner(this.dir);
    try {
    // Constructor snapshots are not authoritative across concurrent recovery.
    if (existsSync(this.stateFile)) this.state = JSON.parse(readFileSync(this.stateFile, "utf8"));
    this.nativeProfile = validatedProfile(this.config.provider,
      this.state.nativeProfile || this.config.nativeProfile || captureNativeProfile(this.config.provider));
    this.state.nativeProfile = this.nativeProfile;
    this.state.queue ||= [];
    this.queue = this.state.queue;
    if (this.state.pid && this.state.status !== "stopped" && alive(this.state.pid)) throw new Error("The original supervisor is still running");
    const previousTurn = this.state.turns.findLast((v) => v.status === "running");
    if (previousTurn?.pid && alive(previousTurn.pid)) throw new Error("The original native writer is still running; wait for its exit before recovering");
    if (existsSync(this.config.socketPath)) {
      if (!lstatSync(this.config.socketPath).isSocket()) throw new Error("Session socket path is occupied by another file");
      unlinkSync(this.config.socketPath);
    }
    this.http = createServer((req, res) => this.route(req, res));
    await new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.config.socketPath, resolve);
    });
    chmodSync(this.config.socketPath, 0o600);
    for (const turn of this.state.turns.filter((v) => v.status === "running")) {
      const file = join(this.dir, `native-${turn.id}.jsonl`);
      const events = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => this.driver.parseEvent(line)).filter(Boolean) : [];
      const sessionIDs = [...new Set(events.filter((v) => v.kind === "session").map((v) => v.sessionId))];
      if (sessionIDs.length > 1 || (sessionIDs.length === 1 &&
          ((this.state.sessionId && this.state.sessionId !== sessionIDs[0]) || (turn.sessionId && turn.sessionId !== sessionIDs[0])))) {
        throw new Error("Interrupted native initialization conflicts with the original session identity");
      }
      if (!this.state.sessionId && sessionIDs.length === 1) {
        if (this.state.turns.filter((v) => v.status === "running").length !== 1) {
          throw new Error("Multiple interrupted native turns cannot select an original session");
        }
        this.state.sessionId = sessionIDs[0];
        turn.sessionId = sessionIDs[0];
        this.audit("native_init_reconciled", {turnId: turn.id, sessionId: sessionIDs[0]});
      }
      const sameSession = events.some((v) => v.kind === "session" && v.sessionId === this.state.sessionId) &&
        !events.some((v) => v.kind === "session" && v.sessionId !== this.state.sessionId);
      turn.status = sameSession && events.some((v) => v.kind === "complete" && v.ok) ? "completed" : "uncertain";
      const complete = events.findLast((v) => v.kind === "complete");
      if (complete) turn.permissionDenials = complete.permissionDenials || [];
      turn.reconciledAt = stamp();
    }
    for (const message of this.queue.filter((v) => v.status === "running")) {
      const turn = this.state.turns.findLast((v) => v.id === message.turnId || v.messageId === message.id);
      // runTurn persists its identity before spawning; no turn means no send.
      message.status = !turn ? "queued" : turn.status === "completed" ? "completed" : "uncertain";
    }
    // Restarting a supervisor cannot imply that an interrupted native send never
    // happened. Preserve the uncertain delivery and require reconciliation.
    for (const record of Object.values(this.state.deliveries)) {
      if (["sending", "running"].includes(record.status)) {
        const events = existsSync(join(this.dir, `native-${record.turnId}.jsonl`)) ?
          readFileSync(join(this.dir, `native-${record.turnId}.jsonl`), "utf8").split("\n").filter(Boolean).map((line) => this.driver.parseEvent(line)).filter(Boolean) : [];
        const sameSession = events.some((v) => v.kind === "session" && v.sessionId === record.sessionId) &&
          !events.some((v) => v.kind === "session" && v.sessionId !== record.sessionId);
        record.status = sameSession && record.reportReadAt && events.some((v) => v.kind === "complete" && v.ok) ? "completed" : "uncertain";
      }
    }
    this.state.pid = process.pid;
    this.state.status = "idle";
    this.persist();
    this.audit("host_started", {provider: this.config.provider, sessionId: this.state.sessionId});
    this.startPresence();
    this.loop = this.consume().catch((error) => {
      if (!this.controller.signal.aborted) this.audit("consumer_stopped", {error: error.message});
    });
    } catch (error) {
      if (this.http?.listening) await new Promise((resolve) => this.http.close(resolve));
      this.releaseOwner(); this.releaseOwner = null; throw error;
    }
  }

  async route(req, res) {
    const respond = (status, value) => { res.writeHead(status, {"content-type": "application/json"}); res.end(JSON.stringify(value)); };
    try {
      const actual = Buffer.from(req.headers.authorization || "");
      const expected = Buffer.from(`Bearer ${this.config.token}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return respond(403, {error: "Unknown session connection"});
      let raw = "";
      for await (const part of req) {
        raw += part;
        if (Buffer.byteLength(raw) > 16 * 1024 * 1024) return respond(413, {error: "Session request too large"});
      }
      const body = JSON.parse(raw || "{}");
      if (req.method !== "POST") return respond(405, {error: "POST required"});
      if (req.url === "/status") return respond(200, this.state);
      if (req.url === "/stop") { respond(200, {stopping: true}); await this.stop(); return; }
      if (req.url === "/send") {
        if (typeof body.prompt !== "string" || !body.prompt.trim()) return respond(400, {error: "Prompt required"});
        if (!this.busy && this.unprovenNativeAttempt()) return respond(409, {error: "The original native writer started without a proven session ID; recover its native initialization before sending another turn"});
        const id = randomBytes(16).toString("hex");
        this.queue.push({id, prompt: body.prompt, status: "queued", acceptedAt: stamp()});
        this.persist();
        respond(200, {queued: true, id, sessionId: this.state.sessionId});
        return;
      }
      if (req.url === "/retry") {
        if (body.messageId) {
          const message = this.queue.find((v) => v.id === body.messageId);
          if (!message || !["uncertain", "failed"].includes(message.status) || this.busy) return respond(409, {error: "Only a failed or uncertain message in this idle native session can be retried"});
          if (this.unprovenNativeAttempt()) return respond(409, {error: "The original native writer started without a proven session ID; retry cannot open a replacement conversation"});
          message.status = "queued";
          message.retryRequestedAt = stamp();
          this.persist();
          return respond(200, {retryQueued: true, messageId: message.id, sessionId: this.state.sessionId});
        }
        const record = this.state.deliveries[body.eventId];
        if (!record || record.status !== "uncertain" || record.sessionId !== this.state.sessionId || this.busy) {
          return respond(409, {error: "Only an uncertain delivery in this idle original session can be retried"});
        }
        // This is an explicit retry in the original history, never an automatic
        // retransmission after an ambiguous transport failure.
        record.status = "retry_requested";
        record.retryRequestedAt = stamp();
        this.persist();
        this.audit("feedback_retry_requested", {eventId: record.eventId, sessionId: record.sessionId});
        return respond(200, {retryQueued: true, eventId: record.eventId, sessionId: record.sessionId});
      }
      if (req.url === "/review") {
        if (!this.busy || body.generation !== this.generation || !this.state.sessionId) return respond(409, {error: "Review does not belong to this native turn"});
        if (!safeID(body.boxId) || !safeID(body.reviewId)) return respond(400, {error: "Invalid review identity"});
        const consumerId = this.consumerId();
        await this.post("/v1/feedback-consumers", {consumerId, boxId: body.boxId, reviewId: body.reviewId,
          host: this.config.provider, capability: "native-session-resume-v1"});
        if (!this.state.reviews.some((v) => v.boxId === body.boxId && v.reviewId === body.reviewId)) {
          this.state.reviews.push({boxId: body.boxId, reviewId: body.reviewId, sessionId: this.state.sessionId, consumerId});
        }
        this.persist();
        this.audit("review_bound", {boxId: body.boxId, reviewId: body.reviewId, sessionId: this.state.sessionId});
        return respond(200, {registered: true, provider: this.config.provider, sessionId: this.state.sessionId});
      }
      if (req.url === "/report-read") {
        const record = this.activeDelivery;
        if (!this.busy || body.generation !== this.generation || !record ||
            body.boxId !== record.boxId || body.reportId !== record.reportId || record.sessionId !== this.state.sessionId) {
          return respond(409, {error: "Report does not belong to the active original feedback turn"});
        }
        record.reportReadAt = stamp();
        this.persist();
        this.audit("native_report_read", {eventId: record.eventId, reportId: record.reportId, sessionId: record.sessionId});
        return respond(200, {read: true});
      }
      respond(404, {error: "Unknown session operation"});
    } catch (error) { respond(500, {error: error.message}); }
  }

  consumerId() {
    return createHash("sha256").update(JSON.stringify([this.config.agentId, this.config.provider, this.state.sessionId, this.config.cwd])).digest("hex");
  }

  unprovenNativeAttempt() {
    return !this.state.sessionId && this.state.turns.some((turn) => Number.isSafeInteger(turn.pid) && turn.pid > 0);
  }

  async runTurn(prompt, delivery, message) {
    if (this.busy) throw new Error("The original native session already has a writer");
    if (this.unprovenNativeAttempt()) {
      if (message) { message.status = "uncertain"; this.persist(); }
      throw new Error("Cannot start another native writer without the original session ID");
    }
    if (delivery && (!this.state.sessionId || delivery.sessionId !== this.state.sessionId)) throw new Error("Feedback session mismatch");
    this.busy = true;
    this.activeDelivery = delivery || null;
    this.generation = randomBytes(16).toString("hex");
    const turnId = randomBytes(16).toString("hex");
    const turn = {id: turnId, sessionId: this.state.sessionId, startedAt: stamp(), status: "running", eventId: delivery?.eventId, messageId: message?.id};
    if (message) message.turnId = turnId;
    this.state.turns.push(turn);
    this.state.status = "running";
    if (delivery) { delivery.status = "sending"; delivery.turnId = turnId; }
    this.persist();
    const childEnv = {...process.env, ...this.nativeProfile, PSBX_SESSION_SOCKET: this.config.socketPath, PSBX_SESSION_TOKEN: this.config.token,
      PSBX_SESSION_AGENT_ID: this.config.agentId, PSBX_SESSION_GENERATION: this.generation};
    // This supervisor is the managed conversation's only feedback owner. A
    // legacy host opt-in in the launch shell must not reach its native MCP child.
    delete childEnv.PSBX_FEEDBACK_HOST;
    for (const [key, alias] of Object.entries(profileAliases)) {
      if (Object.hasOwn(this.nativeProfile, key)) childEnv[alias] = this.nativeProfile[key];
    }
    // There is one native process at a time. All native resume IDs come from its
    // initialization output; no latest-session lookup, fork or history reconstruction.
    let completed = false;
    let successful = false;
    let failure = "Native CLI exited without a completed turn";
    let invocation;
    try {
      invocation = await this.driver.buildInvocation({cliPath: this.config.cliPath, cwd: this.config.cwd,
        sessionId: this.state.sessionId, prompt, mcp: {command: process.execPath, args: [this.config.adapterPath],
          env: Object.fromEntries(Object.entries(childEnv).filter(([key]) => key.startsWith("PSBX_SESSION_") || key.startsWith("PARALLELSANDBOX_")))},
        stateDir: this.dir, env: childEnv});
      const outputFile = join(this.dir, `native-${turnId}.jsonl`);
      this.child = spawn(invocation.command, invocation.args, {cwd: this.config.cwd, env: invocation.env || childEnv, stdio: ["pipe", "pipe", "pipe"]});
      const child = this.child;
      turn.pid = child.pid;
      this.persist();
      const onLine = (line) => {
        appendFileSync(outputFile, line + "\n", {mode: 0o600});
        const event = this.driver.parseEvent(line);
        if (!event) return;
        if (event.kind === "session") {
          if (!safeID(event.sessionId)) throw new Error("Native CLI returned an invalid session ID");
          if (this.state.sessionId && this.state.sessionId !== event.sessionId) throw new Error("Native resume switched the original session");
          this.state.sessionId = event.sessionId;
          turn.sessionId = event.sessionId;
          if (delivery) delivery.status = "running";
          this.persist();
          this.audit("native_session", {turnId, sessionId: event.sessionId});
        } else if (event.kind === "assistant") {
          turn.output = (turn.output || "") + event.text;
          this.persist();
        } else if (event.kind === "complete") {
          completed = true;
          successful = event.ok === true;
          failure = event.error || failure;
          turn.permissionDenials = event.permissionDenials || [];
          this.persist();
        }
      };
      let parseFailure;
      const lines = createInterface({input: child.stdout});
      lines.on("line", (line) => {
        try { onLine(line); } catch (error) { parseFailure = error; child.kill("SIGTERM"); }
      });
      child.stderr.on("data", (part) => appendFileSync(join(this.dir, `native-${turnId}.stderr`), part, {mode: 0o600}));
      child.stdin.end(invocation.stdin ?? "");
      const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({code, signal})); });
      lines.close();
      if (parseFailure) throw parseFailure;
      if (!completed || !successful || exit.code !== 0) throw new Error(failure + ` (exit ${exit.code}, signal ${exit.signal || "none"})`);
      if (!this.state.sessionId || turn.sessionId !== this.state.sessionId) throw new Error("No proven original native session");
      if (delivery && !delivery.reportReadAt) throw new Error("Native turn finished without reading the complete feedback report");
      turn.status = "completed";
      turn.completedAt = stamp();
      if (delivery) delivery.status = "completed";
      this.audit("turn_completed", {turnId, sessionId: turn.sessionId, eventId: delivery?.eventId});
    } catch (error) {
      turn.status = "failed";
      turn.error = error.message;
      if (delivery) { delivery.status = "uncertain"; delivery.error = error.message; }
      this.audit("turn_failed", {turnId, sessionId: turn.sessionId, error: error.message});
    } finally {
      this.child = null;
      this.activeDelivery = null;
      this.busy = false;
      this.generation = "";
      this.state.status = this.controller.signal.aborted ? "stopped" : "idle";
      this.persist();
    }
    return turn;
  }

  async readReport(event) {
    this.remote ||= new Client({name: "parallelsandbox-feedback-host", version: "0.5.0"});
    if (!this.remoteConnected) {
      const transport = new StreamableHTTPClientTransport(new URL(this.config.mcpUrl), {
        requestInit: {headers: this.headers}, fetch: (url, init) => this.fetch(url, init),
      });
      await this.remote.connect(transport);
      this.remoteConnected = true;
    }
    const result = await this.remote.callTool({name: "sandbox_report", arguments: {id: event.boxId, reportId: event.reportId}}, undefined, {timeout: 60_000});
    if (result.isError || !result.content?.length) throw new Error("Complete feedback report could not be read");
    // Keep every returned block: annotated images, timed transcripts and recording
    // URLs accompany the text. The native model sees the complete durable report.
    return result;
  }

  async ack(event) {
    await this.post(`/v1/feedback-consumers/${this.consumerId()}/ack`, {
      eventId: event.eventId, reportId: event.reportId, leaseToken: event.leaseToken, state: "read",
    });
    const record = this.state.deliveries[event.eventId];
    record.status = "acknowledged";
    record.acknowledgedAt = stamp();
    this.persist();
    this.audit("feedback_acknowledged", {eventId: event.eventId, reportId: event.reportId, sessionId: record.sessionId});
  }

  async consume() {
    while (!this.controller.signal.aborted) {
      try {
        if (this.busy) { await delay(100, undefined, {signal: this.controller.signal}); continue; }
        const message = this.queue.find((v) => v.status === "queued");
        if (message) {
          message.status = "running";
          this.persist();
          const retry = message.retryRequestedAt ? "This is an explicit retry of the previous interrupted message. Check the original conversation and work already done, then continue without repeating completed actions.\n" : "";
          const turn = await this.runTurn(retry + message.prompt, undefined, message);
          message.status = turn.status;
          message.turnId = turn.id;
          this.persist();
          continue;
        }
        if (!this.state.reviews.length) { await delay(250, undefined, {signal: this.controller.signal}); continue; }
        const {events = []} = await this.post(`/v1/feedback-consumers/${this.consumerId()}/claim`, {waitSec: 2});
        for (const event of events) {
          const binding = this.state.reviews.find((v) => v.boxId === event.boxId && v.reviewId === event.reviewId);
          if (!binding || binding.sessionId !== this.state.sessionId || binding.consumerId !== this.consumerId()) throw new Error("Claimed feedback has no original session binding");
          let record = this.state.deliveries[event.eventId];
          if (record && (record.boxId !== event.boxId || record.reviewId !== event.reviewId || record.reportId !== event.reportId)) throw new Error("Feedback event identity changed");
          if (record?.status === "acknowledged") continue;
          if (record?.status === "completed") { await this.ack(event); continue; }
          if (record?.status === "uncertain") continue;
          const result = await this.readReport(event);
          record = {eventId: event.eventId, boxId: event.boxId, reviewId: event.reviewId, reportId: event.reportId,
            sessionId: binding.sessionId, status: "prepared", preparedAt: stamp(),
            retryRequestedAt: record?.retryRequestedAt,
            reportSHA256: createHash("sha256").update(JSON.stringify(result)).digest("hex")};
          this.state.deliveries[event.eventId] = record;
          savePrivate(join(this.dir, `report-${event.eventId}.json`), result);
          this.persist();
          // A notification carries identity, not a second copy of the report.
          // Duplicating text here lets a native model act without opening its
          // media, and can mistake the delivery event for the person's content.
          // The exact MCP read supplies all blocks in the provider's protocol.
          const retryNote = record.retryRequestedAt ? "This is an explicit retry after an interrupted delivery. Check the original history and work already done before continuing; do not repeat completed actions. " : "";
          const prompt = `${retryNote}A person submitted new feedback for this original conversation. First call the parallelsandbox sandbox_report tool with exactly ${JSON.stringify({id: event.boxId, reportId: event.reportId})}. The notification contains no feedback content. Read the tool's complete result, including all text, annotated images, recording metadata and timed transcripts, then handle the person's request in this same conversation. Do not substitute a report from earlier history. Acknowledgement requires this exact report tool call and a successful completed turn.`;
          const turn = await this.runTurn(prompt, record);
          if (turn.status === "completed") await this.ack(event);
        }
      } catch (error) {
        if (this.controller.signal.aborted) break;
        this.state.consumerError = error.message;
        this.persist();
        this.audit("consumer_retry", {error: error.message});
        await delay(1000, undefined, {signal: this.controller.signal}).catch(() => {});
      }
    }
  }

  async stop() {
    this.controller.abort();
    clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    this.child?.kill("SIGTERM");
    await this.loop;
    await this.presenceFlight;
    await this.presence("leave");
    await this.remote?.close().catch(() => {});
    if (this.http) await new Promise((resolve) => this.http.close(resolve));
    try { unlinkSync(this.config.socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    this.state.status = "stopped";
    this.persist();
    this.releaseOwner?.();
    this.releaseOwner = null;
  }
}
