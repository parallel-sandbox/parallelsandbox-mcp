// Driver for an opt-in, supervisor-owned native Codex session. The supervisor
// serializes writers and persists the exact thread.started ID between processes.
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const provider = "codex";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toml = (value) => JSON.stringify(value);

function privateHome(stateDir) {
  if (typeof stateDir !== "string" || !isAbsolute(stateDir)) throw new Error("Managed Codex stateDir must be an absolute, dedicated session directory");
  if (resolve(stateDir) === join(homedir(), ".codex")) throw new Error("Managed Codex uses a dedicated stateDir, not the user's global Codex configuration");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const st = lstatSync(stateDir);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) throw new Error("Managed Codex stateDir must be user-owned with mode 0700");
  const marker = join(stateDir, ".psbx-native-codex");
  if (existsSync(join(stateDir, "config.toml")) && !existsSync(marker)) throw new Error("Managed Codex stateDir already contains an unowned configuration");
  if (!existsSync(marker)) writeFileSync(marker, "managed-native-codex-v1\n", { flag: "wx", mode: 0o600 });
  else {
    const owner = lstatSync(marker);
    if (!owner.isFile() || owner.isSymbolicLink() || (owner.mode & 0o077) || readFileSync(marker, "utf8") !== "managed-native-codex-v1\n") throw new Error("Invalid managed Codex state ownership marker");
  }
}

function writeConfig(stateDir, mcp, env) {
  const lines = [];
  if (env.PSBX_CODEX_MODEL) lines.push(`model = ${toml(env.PSBX_CODEX_MODEL)}`);
  if (env.PSBX_CODEX_REASONING_EFFORT) lines.push(`model_reasoning_effort = ${toml(env.PSBX_CODEX_REASONING_EFFORT)}`);
  if (env.PSBX_CODEX_APPROVAL_POLICY) lines.push(`approval_policy = ${toml(env.PSBX_CODEX_APPROVAL_POLICY)}`);
  if (env.PSBX_CODEX_SANDBOX_MODE) lines.push(`sandbox_mode = ${toml(env.PSBX_CODEX_SANDBOX_MODE)}`);
  if (mcp) {
    if (typeof mcp.command !== "string" || !mcp.command || !Array.isArray(mcp.args) || mcp.args.some((arg) => typeof arg !== "string")) throw new Error("Managed Codex MCP command and args must be explicit strings");
    const entries = Object.entries(mcp.env ?? {});
    if (entries.some(([, value]) => typeof value !== "string")) throw new Error("Managed Codex MCP env values must be strings");
    lines.push("", "[mcp_servers.parallelsandbox]", `command = ${toml(mcp.command)}`, `args = ${toml(mcp.args)}`, `env = { ${entries.map(([key, value]) => `${toml(key)} = ${toml(value)}`).join(", ")} }`);
    // Headless exec cannot answer an MCP approval prompt. Pre-authorize only
    // the registered runner's explicit handoff tools, never the whole server.
    const allowed = (env.PSBX_CODEX_ALLOWED_MCP_TOOLS ?? "sandbox_report,sandbox_review,sandbox_status")
      .split(",").map((tool) => tool.trim()).filter(Boolean);
    if (allowed.some((tool) => !/^[a-zA-Z0-9_.-]+$/.test(tool))) throw new Error("Codex allowed MCP tools must be exact tool names");
    for (const tool of new Set(allowed)) {
      lines.push("", `[mcp_servers.parallelsandbox.tools.${toml(tool)}]`, 'approval_mode = "approve"');
    }
  }
  const path = join(stateDir, "config.toml"), temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, `${lines.join("\n")}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temp, path); } catch (err) { try { unlinkSync(temp); } catch { /* The original error is authoritative. */ } throw err; }
}

export function buildInvocation({ cliPath, cwd, sessionId = "", prompt, mcp, stateDir, env = {} } = {}) {
  if (typeof cliPath !== "string" || !isAbsolute(cliPath) || typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("Managed Codex CLI and cwd must be absolute paths");
  if (sessionId && !uuid.test(sessionId)) throw new Error("Managed Codex resume requires the exact native session UUID");
  const text = typeof prompt === "string" ? prompt : prompt?.text;
  const images = typeof prompt === "string" ? [] : prompt?.images ?? [];
  if (typeof text !== "string" || !text.trim()) throw new Error("Managed Codex requires the complete prompt text");
  if (!Array.isArray(images) || images.some((path) => typeof path !== "string" || !isAbsolute(path))) throw new Error("Managed Codex report images must be absolute local paths");
  privateHome(stateDir);
  writeConfig(stateDir, mcp, env);
  const args = ["exec", "--json", "--skip-git-repo-check", "-C", cwd];
  if (sessionId) args.push("resume", sessionId);
  for (const path of images) args.push("--image", path);
  args.push("-");
  // CODEX_API_KEY is the documented authentication variable for non-interactive
  // exec. The supervisor supplies it only to this native child process.
  const childEnv = { ...env, CODEX_HOME: stateDir };
  if (!childEnv.CODEX_API_KEY && childEnv.OPENAI_API_KEY) childEnv.CODEX_API_KEY = childEnv.OPENAI_API_KEY;
  return { command: cliPath, args, env: childEnv, stdin: text };
}

export function parseEvent(line) {
  let event;
  try { event = typeof line === "string" ? JSON.parse(line) : line; } catch { return null; }
  if (!event || typeof event !== "object") return null;
  if (event.type === "thread.started" && uuid.test(event.thread_id ?? "")) return { kind: "session", sessionId: event.thread_id };
  if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") return { kind: "assistant", text: event.item.text };
  if (event.type === "turn.completed") return { kind: "complete", ok: true };
  if (event.type === "turn.failed") return { kind: "complete", ok: false, error: event.error?.message ?? "Native Codex turn failed" };
  // Reconnection/error notifications can precede a successful completion.
  // The supervisor also checks the native process exit code, including failures
  // before JSONL initialization, instead of treating transient messages as done.
  return null;
}
