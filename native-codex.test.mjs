import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInvocation, parseEvent, provider } from "./native-codex.mjs";
const id = "01a0f388-76ad-7ae0-8ba1-5d2dea760bd1";
function state(t) { const root = join(tmpdir(), "cubelv-e2e"); mkdirSync(root, { recursive: true }); const dir = mkdtempSync(join(root, "native-codex-unit-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }

test("native start has a private home and preserves complete stdin plus local image inputs", (t) => {
  const stateDir = state(t), text = JSON.stringify({ reportId: "r", transcript: "x".repeat(256000) });
  const invocation = buildInvocation({ cliPath: "/official/codex", cwd: "/work/project", stateDir, prompt: { text, images: ["/private/frame-1.png", "/private/frame-2.png"] }, env: { PATH: "/usr/bin", OPENAI_API_KEY: "unit-key", PSBX_CODEX_MODEL: "gpt-5.3-codex" }, mcp: { command: "/usr/bin/node", args: ["/package/index.mjs"], env: { PSBX_NATIVE_TOKEN: "private-unit-token", PSBX_AGENT_ID: "fixed-agent" } } });
  assert.equal(provider, "codex");
  assert.deepEqual(invocation.args, ["exec", "--json", "--skip-git-repo-check", "-C", "/work/project", "--image", "/private/frame-1.png", "--image", "/private/frame-2.png", "-"]);
  assert.equal(invocation.stdin, text);
  assert.equal(invocation.env.CODEX_HOME, stateDir);
  assert.equal(invocation.env.CODEX_API_KEY, "unit-key");
  assert.equal(invocation.args.some((arg) => arg.includes("private-unit-token") || arg.includes("unit-key")), false);
  const config = readFileSync(join(stateDir, "config.toml"), "utf8");
  assert.match(config, /\[mcp_servers.parallelsandbox\]/);
  assert.match(config, /\[mcp_servers.parallelsandbox.tools."sandbox_review"\]\napproval_mode = "approve"/);
  assert.doesNotMatch(config, /default_tools_approval_mode/);
  assert.match(config, /"PSBX_NATIVE_TOKEN" = "private-unit-token"/);
  assert.equal(statSync(join(stateDir, "config.toml")).mode & 0o777, 0o600);
});

test("headless MCP approvals use only the saved exact allowlist, including an empty grant", (t) => {
  const stateDir = state(t), mcp = { command: "/usr/bin/node", args: ["/package/index.mjs"] };
  const options = { cliPath: "/official/codex", cwd: "/work/project", stateDir, prompt: "review", mcp };
  buildInvocation({ ...options, env: { PSBX_CODEX_ALLOWED_MCP_TOOLS: "sandbox_report" } });
  let config = readFileSync(join(stateDir, "config.toml"), "utf8");
  assert.match(config, /tools."sandbox_report"/);
  assert.doesNotMatch(config, /sandbox_review/);
  buildInvocation({ ...options, env: { PSBX_CODEX_ALLOWED_MCP_TOOLS: "" } });
  config = readFileSync(join(stateDir, "config.toml"), "utf8");
  assert.doesNotMatch(config, /approval_mode/);
  assert.throws(() => buildInvocation({ ...options, env: { PSBX_CODEX_ALLOWED_MCP_TOOLS: "sandbox_report,*" } }), /exact tool names/);
});

test("resume targets only the exact native UUID and keeps the same managed state", (t) => {
  const stateDir = state(t);
  const invocation = buildInvocation({ cliPath: "/official/codex", cwd: "/work/project", stateDir, sessionId: id, prompt: "complete report", env: {} });
  assert.deepEqual(invocation.args, ["exec", "--json", "--skip-git-repo-check", "-C", "/work/project", "resume", id, "-"]);
  assert.equal(invocation.args.includes("--last"), false);
  assert.equal(invocation.args.includes("fork"), false);
  assert.throws(() => buildInvocation({ cliPath: "/official/codex", cwd: "/work/project", stateDir, sessionId: "latest", prompt: "feedback" }), /exact native session UUID/);
});

test("native JSONL event parser distinguishes initialization, assistant, completed and failed", () => {
  assert.deepEqual(parseEvent(JSON.stringify({ type: "thread.started", thread_id: id })), { kind: "session", sessionId: id });
  assert.deepEqual(parseEvent({ type: "item.completed", item: { type: "agent_message", text: "actual reply" } }), { kind: "assistant", text: "actual reply" });
  assert.deepEqual(parseEvent({ type: "turn.completed" }), { kind: "complete", ok: true });
  assert.deepEqual(parseEvent({ type: "turn.failed", error: { message: "model_not_found" } }), { kind: "complete", ok: false, error: "model_not_found" });
  assert.equal(parseEvent({ type: "error", message: "Reconnecting... 2/5" }), null);
  assert.equal(parseEvent("not-json"), null);
  assert.equal(parseEvent({ type: "thread.started", thread_id: "name-not-uuid" }), null);
});
