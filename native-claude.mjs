import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const provider = "claude-code";

const sessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Claude stateDir must be a private directory");
  }
  fs.chmodSync(directory, 0o700);
}

function userContent(prompt) {
  if (typeof prompt === "string") return prompt;
  const content = Array.isArray(prompt) ? prompt : prompt?.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new TypeError("Claude prompt must be text or nonempty content blocks");
  }
  return content.map((block) => {
    if (block?.type === "text" && typeof block.text === "string") {
      return { type: "text", text: block.text };
    }
    if (block?.type === "image") {
      const source = block.source ?? {
        type: "base64",
        media_type: block.mimeType,
        data: block.data,
      };
      if (source.type !== "base64" || !imageTypes.has(source.media_type) ||
          typeof source.data !== "string" || source.data.length === 0) {
        throw new TypeError("Claude images require complete base64 PNG/JPEG/GIF/WebP data");
      }
      return { type: "image", source: { ...source } };
    }
    throw new TypeError(`Unsupported Claude content block: ${block?.type ?? "missing"}`);
  });
}

/** Build a single native turn owned by the supervisor. Never attaches a second
 * writer to an existing interactive process. The supervisor waits for exit
 * before calling this again with the exact session ID emitted by native init. */
export function buildInvocation({
  cliPath = "claude",
  cwd,
  sessionId = "",
  prompt,
  mcp,
  stateDir,
  env = {},
}) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new TypeError("Claude cwd must be an absolute path");
  }
  if (typeof stateDir !== "string" || !path.isAbsolute(stateDir)) {
    throw new TypeError("Claude stateDir must be an absolute path");
  }
  if (sessionId && !sessionPattern.test(sessionId)) {
    throw new TypeError("Claude resume requires the exact native session UUID");
  }
  const content = userContent(prompt);
  privateDirectory(stateDir);
  const configDir = path.join(stateDir, "claude-config");
  privateDirectory(configDir);
  const args = ["--print", "--input-format", "stream-json",
    "--output-format", "stream-json", "--verbose", "--strict-mcp-config"];
  if (sessionId) args.push("--resume", sessionId);
  if (typeof env.PSBX_CLAUDE_MODEL === "string" && env.PSBX_CLAUDE_MODEL) {
    args.push("--model", env.PSBX_CLAUDE_MODEL);
  }
  if (env.PSBX_CLAUDE_ALLOWED_TOOLS) {
    const allowed = env.PSBX_CLAUDE_ALLOWED_TOOLS.split(",").map((tool) => tool.trim());
    if (!allowed.length || allowed.some((tool) => !/^(?:Read|Write|Edit|mcp__[a-zA-Z0-9_.-]+__[a-zA-Z0-9_.-]+)$/.test(tool))) {
      throw new TypeError("Claude allowed tools must be exact MCP names or Read/Write/Edit");
    }
    args.push("--allowedTools", ...allowed);
  }

  if (mcp) {
    if (typeof mcp.command !== "string" || !mcp.command ||
        !Array.isArray(mcp.args) || !mcp.args.every((arg) => typeof arg === "string")) {
      throw new TypeError("Claude MCP command and args must be explicit strings");
    }
    if (mcp.env && !Object.values(mcp.env).every((value) => typeof value === "string")) {
      throw new TypeError("Claude MCP env values must be strings");
    }
    const configPath = path.join(stateDir, "claude-mcp.json");
    const config = { mcpServers: { parallelsandbox: {
      command: mcp.command, args: [...mcp.args], ...(mcp.env ? { env: { ...mcp.env } } : {}),
    } } };
    // Exclusive replacement prevents following an existing symlink. The parent
    // is private and only the supervisor may build the next invocation.
    const nextPath = `${configPath}.${randomUUID()}.next`;
    fs.writeFileSync(nextPath, JSON.stringify(config), { mode: 0o600, flag: "wx" });
    fs.renameSync(nextPath, configPath);
    args.push("--mcp-config", configPath);
  }

  const input = { type: "user", message: { role: "user", content },
    parent_tool_use_id: null, session_id: sessionId };
  return {
    command: cliPath,
    args,
    cwd,
    // The supervisor already supplies the explicit runtime environment. Reading
    // the ambient shell again would reintroduce a removed legacy feedback owner.
    env: { ...env, CLAUDE_CONFIG_DIR: configDir },
    stdin: `${JSON.stringify(input)}\n`,
  };
}

/** Parse complete UTF-8 JSONL records from the native CLI, not model text. */
export function parseEvent(line) {
  let event;
  try { event = typeof line === "string" ? JSON.parse(line) : line; }
  catch { return null; }
  if (!event || typeof event !== "object") return null;
  // Subagent init and result records must not rebind or complete the parent.
  if (event.parent_tool_use_id) return null;
  if (event.type === "system" && event.subtype === "init" &&
      typeof event.session_id === "string" && sessionPattern.test(event.session_id)) {
    return { kind: "session", sessionId: event.session_id };
  }
  if (event.type === "assistant") {
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    const text = blocks.filter((block) => block?.type === "text")
      .map((block) => block.text).join("");
    return text ? { kind: "assistant", text } : null;
  }
  if (event.type === "result") {
    const ok = event.subtype === "success" && event.is_error === false;
    const permissionDenials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
    const error = Array.isArray(event.errors) && event.errors.length
      ? event.errors.map(String).join("\n")
      : event.result || event.subtype || "Claude turn failed";
    return ok ? { kind: "complete", ok: true, permissionDenials }
      : { kind: "complete", ok: false, error: String(error), permissionDenials };
  }
  return null;
}
