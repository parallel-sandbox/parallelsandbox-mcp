// Provider boundary unit tests. These do not establish a real model wakeup.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInvocation, parseEvent, provider } from "./native-gemini.mjs";

const id = "113b3072-aa41-41d1-8cf2-0926d6158a99";
const options = async () => {
  const artifacts = join(tmpdir(), "cubelv-e2e"); await mkdir(artifacts, { recursive: true });
  return {
  cliPath: "/usr/local/bin/gemini", cwd: "/work/project", stateDir: await mkdtemp(join(artifacts, "gemini-unit-")),
  prompt: "Human report\n" + "x".repeat(300_000), mcp: { command: "/usr/bin/node", args: ["/work/adapter/index.mjs"], env: { PSBX_SUPERVISOR_TOKEN: "unit-test-only" } },
  env: { PATH: "/usr/bin", GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_APPLICATION_CREDENTIALS: "/private/credentials.json", GEMINI_MODEL: "gemini-2.5-flash" },
}; };

test("first turn preserves the entire input, isolated config, and caller auth", async () => {
  const input = await options(), result = await buildInvocation(input);
  assert.equal(provider, "gemini");
  assert.equal(result.stdin, input.prompt);
  assert.equal(result.args.includes("--resume"), false);
  assert.deepEqual(result.args.slice(-2), ["--prompt", ""]);
  assert.equal(result.env.GOOGLE_APPLICATION_CREDENTIALS, input.env.GOOGLE_APPLICATION_CREDENTIALS);
  const settingsPath = join(result.env.GEMINI_CLI_HOME, ".gemini", "settings.json");
  assert.equal(result.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, undefined);
  const config = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(config.security.auth.selectedType, "vertex-ai");
  assert.deepEqual(config.mcp.allowed, ["parallelsandbox"]);
  assert.equal(config.mcpServers.parallelsandbox.env.PSBX_SUPERVISOR_TOKEN, "unit-test-only");
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
  assert.equal((await stat(result.env.GEMINI_CLI_HOME)).mode & 0o777, 0o700);
});

test("resume accepts only an explicit full native UUID", async () => {
  const input = await options(), result = await buildInvocation({ ...input, sessionId: id });
  assert.deepEqual(result.args.slice(-4), ["--resume", id, "--prompt", ""]);
  for (const sessionId of ["latest", "1", "113b3072", "different-conversation", 12]) await assert.rejects(buildInvocation({ ...input, sessionId }), /exact native session UUID/);
});

test("session state cannot be redirected through a symlink", async () => {
  const input = await options(), target = input.stateDir;
  const alias = target + "-link"; await symlink(target, alias);
  await assert.rejects(buildInvocation({ ...input, stateDir: alias }), /user-owned with mode 0700/);
});

test("trusted native init, final result, and failure are different events", () => {
  assert.deepEqual(parseEvent(JSON.stringify({ type: "init", session_id: id })), { kind: "session", sessionId: id });
  assert.deepEqual(parseEvent({ type: "message", role: "assistant", content: "reply", delta: true }), { kind: "assistant", text: "reply" });
  assert.equal(parseEvent({ type: "message", role: "user", content: "reply" }), null);
  assert.equal(parseEvent({ type: "error", severity: "warning", message: "retrying" }), null);
  assert.deepEqual(parseEvent({ type: "result", status: "success" }), { kind: "complete", ok: true });
  assert.deepEqual(parseEvent({ type: "result", status: "error", error: { message: "403 SERVICE_DISABLED" } }), { kind: "complete", ok: false, error: "403 SERVICE_DISABLED" });
  assert.throws(() => parseEvent({ type: "init", session_id: "latest" }), /invalid native session UUID/);
});
