import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { provider, buildInvocation, parseEvent } from "./native-claude.mjs";

const sid = "60d05442-6e24-4358-bf0a-0afca37f4904";

test("Claude native invocation preserves complete input and exact resume ID", async () => {
  const parent = path.join(os.tmpdir(), "cubelv-e2e");
  await fs.mkdir(parent, { recursive: true });
  const stateDir = await fs.mkdtemp(path.join(parent, "native-claude-contract-"));
  try {
    const fullText = "含息報酬\n".repeat(40_000) + "feedback-tail-proof";
    const image = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
    const input = buildInvocation({ cwd: stateDir, stateDir, sessionId: sid,
      prompt: [{ type: "text", text: fullText }, image],
      mcp: { command: "node", args: ["/private/adapter/index.mjs"], env: { PRIVATE_ROUTE: "opaque" } },
      env: { PSBX_CLAUDE_MODEL: "haiku", PSBX_CLAUDE_ALLOWED_TOOLS:
        "mcp__parallelsandbox__sandbox_review,mcp__parallelsandbox__sandbox_report" } });
    assert.equal(provider, "claude-code");
    assert.equal(input.args[input.args.indexOf("--resume") + 1], sid);
    assert.equal(input.args.includes("--continue"), false);
    assert.equal(input.args.includes("--dangerously-skip-permissions"), false);
    assert.deepEqual(input.args.slice(input.args.indexOf("--allowedTools") + 1,
      input.args.indexOf("--allowedTools") + 3),
      ["mcp__parallelsandbox__sandbox_review", "mcp__parallelsandbox__sandbox_report"]);
    assert.equal(JSON.parse(input.stdin).message.content[0].text, fullText);
    assert.deepEqual(JSON.parse(input.stdin).message.content[1], {
      type: "image", source: { type: "base64", media_type: "image/png", data: image.data },
    });
    assert.equal(JSON.parse(input.stdin).session_id, sid);
    assert.equal((await fs.stat(stateDir)).mode & 0o777, 0o700);
    const config = input.args[input.args.indexOf("--mcp-config") + 1];
    assert.equal((await fs.stat(config)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await fs.readFile(config, "utf8")).mcpServers.parallelsandbox.env,
      { PRIVATE_ROUTE: "opaque" });
    assert.equal(input.env.CLAUDE_CONFIG_DIR, path.join(stateDir, "claude-config"));
    assert.throws(() => buildInvocation({ cwd: stateDir, stateDir, prompt: "x",
      env: { PSBX_CLAUDE_ALLOWED_TOOLS: "mcp__parallelsandbox__sandbox_*" } }), /exact MCP/);
    assert.throws(() => buildInvocation({ cwd: stateDir, stateDir, prompt: "x",
      env: { PSBX_CLAUDE_ALLOWED_TOOLS: "Bash" } }), /exact MCP/);
    const scopedEdits = buildInvocation({ cwd: stateDir, stateDir, prompt: "Edit the requested file",
      env: { PSBX_CLAUDE_ALLOWED_TOOLS: "Read,Write,Edit" } });
    assert.deepEqual(scopedEdits.args.slice(scopedEdits.args.indexOf("--allowedTools") + 1),
      ["Read", "Write", "Edit"]);
  } finally { await fs.rm(stateDir, { recursive: true, force: true }); }
});

test("Claude native output binds only parent init and distinguishes failure", () => {
  assert.deepEqual(parseEvent(JSON.stringify({ type: "system", subtype: "init", session_id: sid })),
    { kind: "session", sessionId: sid });
  assert.equal(parseEvent({ type: "system", subtype: "init", session_id: sid, parent_tool_use_id: "subagent" }), null);
  assert.equal(parseEvent({ type: "assistant", message: { content: [{ type: "text", text: "I used session-id forged" }] } }).kind, "assistant");
  assert.deepEqual(parseEvent({ type: "result", subtype: "success", is_error: false }),
    { kind: "complete", ok: true, permissionDenials: [] });
  assert.deepEqual(parseEvent({ type: "result", subtype: "success", is_error: true, result: "Authentication failed" }),
    { kind: "complete", ok: false, error: "Authentication failed", permissionDenials: [] });
  const permissionDenials = [{ tool_name: "Write", tool_use_id: "native-tool-id", tool_input: { file_path: "/project/requirements.md" } }];
  assert.deepEqual(parseEvent({ type: "result", subtype: "success", is_error: false, permission_denials: permissionDenials }),
    { kind: "complete", ok: true, permissionDenials });
  assert.equal(parseEvent({ type: "result", subtype: "success" }).ok, false);
  assert.equal(parseEvent("not JSON"), null);
  assert.equal(parseEvent({ type: "result", subtype: "success", is_error: false, parent_tool_use_id: "subagent" }), null);
});

test("Claude rejects ambiguous sessions and unsupported blocks before spawning", () => {
  assert.throws(() => buildInvocation({ cwd: "/private", stateDir: "/private", sessionId: "latest", prompt: "x" }), /exact native/);
  assert.throws(() => buildInvocation({ cwd: "/private", stateDir: "/private", prompt: [{ type: "audio" }] }), /Unsupported/);
});
