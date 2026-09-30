// Native Gemini CLI boundary for a session owned by the local supervisor.
// Registration, queues, writer exclusion, and receipts belong to the supervisor.
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";

export const provider = "gemini";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requirePath = (value, field) => {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${field} must be an absolute path`);
  return value;
};

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) {
    throw new Error("Gemini session directory must be user-owned with mode 0700");
  }
}

async function privateJson(path, value) {
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  try { await rename(temp, path); } catch (err) { await unlink(temp).catch(() => {}); throw err; }
}

export async function buildInvocation({ cliPath, cwd, sessionId = "", prompt, mcp, stateDir, env = {} }) {
  requirePath(cliPath, "cliPath");
  requirePath(cwd, "cwd");
  requirePath(stateDir, "stateDir");
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Gemini prompt must be a nonempty string");
  if (typeof sessionId !== "string" || (sessionId && !UUID.test(sessionId))) throw new Error("Gemini resume requires the exact native session UUID");
  if (!mcp || typeof mcp.command !== "string" || !mcp.command || !Array.isArray(mcp.args) || mcp.args.some(x => typeof x !== "string")) {
    throw new Error("A managed MCP command and argument array are required");
  }
  if (mcp.env && Object.entries(mcp.env).some(([key, value]) => !key || typeof value !== "string")) throw new Error("MCP environment values must be strings");
  if (env.PSBX_GEMINI_APPROVAL_MODE && !["default", "auto_edit", "yolo", "plan"].includes(env.PSBX_GEMINI_APPROVAL_MODE)) throw new Error("Unknown Gemini approval mode");
  await privateDirectory(stateDir);
  const nativeHome = join(stateDir, "gemini-home");
  await privateDirectory(nativeHome);
  // The CLI resolves its user settings below GEMINI_CLI_HOME/.gemini. System
  // settings require root-owned ancestors and reject a private user directory.
  const userConfigDir = join(nativeHome, ".gemini");
  await privateDirectory(userConfigDir);
  const settingsPath = join(userConfigDir, "settings.json");
  const settings = {
    mcp: { allowed: ["parallelsandbox"] },
    mcpServers: { parallelsandbox: { command: mcp.command, args: mcp.args, env: mcp.env ?? {}, cwd, trust: true } },
  };
  // Auth is explicitly provisioned for this registered runner, never guessed
  // from another session or copied out of another client's credential store.
  if (env.GOOGLE_GENAI_USE_VERTEXAI === "true") settings.security = { auth: { selectedType: "vertex-ai" } };
  else if (env.GEMINI_API_KEY) settings.security = { auth: { selectedType: "gemini-api-key" } };
  await privateJson(settingsPath, settings);
  const args = ["--output-format", "stream-json", "--allowed-mcp-server-names", "parallelsandbox"];
  if (env.GEMINI_MODEL) args.push("--model", env.GEMINI_MODEL);
  if (env.PSBX_GEMINI_APPROVAL_MODE) {
    args.push("--approval-mode", env.PSBX_GEMINI_APPROVAL_MODE);
  }
  if (sessionId) args.push("--resume", sessionId);
  // A piped stdin invokes native headless mode. Keeping the complete prompt on
  // stdin avoids command-line size limits and does not truncate report JSON.
  args.push("--prompt", "");
  return {
    command: cliPath, args, cwd, stdin: prompt,
    env: { ...env, GEMINI_CLI_HOME: nativeHome },
  };
}

export function parseEvent(line) {
  let event;
  try { event = typeof line === "string" ? JSON.parse(line) : line; } catch { return null; }
  if (!event || typeof event !== "object") return null;
  if (event.type === "init") {
    if (!UUID.test(event.session_id ?? "")) throw new Error("Gemini emitted an invalid native session UUID");
    return { kind: "session", sessionId: event.session_id };
  }
  if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") return { kind: "assistant", text: event.content };
  if (event.type === "result") {
    if (event.status === "success") return { kind: "complete", ok: true };
    return { kind: "complete", ok: false, error: event.error?.message ?? "Gemini native turn did not succeed" };
  }
  return null;
}
