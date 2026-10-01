// One-time onboarding: add ParallelSandbox's feedback hooks to a host's user settings.
// `parallelsandbox-mcp install <claude-code|cursor|gemini|codex>`; idempotent, keeps other settings.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MARK = "parallelsandbox-mcp hook";
const INDEX = join(dirname(fileURLToPath(import.meta.url)), "index.mjs");

// The command that runs this same package: npx for npx installs (its cache path is not stable),
// otherwise this exact checkout or global install.
export function selfCommand(index = INDEX, node = process.execPath) {
  return /[\\/]_npx[\\/]/.test(index) ? "npx -y parallelsandbox-mcp" : `"${node}" "${index}"`;
}
export const DEFAULT_COMMAND = selfCommand();

// MCP clientInfo names: codex-mcp-client, claude-code, cursor-vscode / Cursor, gemini-cli-mcp-client.
export function hostFromClient(name = "") {
  if (/^codex/i.test(name)) return "codex";
  if (/claude/i.test(name)) return "claude-code";
  if (/cursor/i.test(name)) return "cursor";
  if (/gemini/i.test(name)) return "gemini";
  return "";
}

const settingsFile = (host, { home = homedir(), env = process.env } = {}) =>
  host === "claude-code" ? join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "settings.json")
    : host === "cursor" ? join(home, ".cursor", "hooks.json")
      : host === "gemini" ? join(home, ".gemini", "settings.json") : "";

// Are this host's feedback hooks in its user settings?
export function hooksInstalled(host, opts = {}) {
  if (host === "codex") return true;
  const file = settingsFile(host, opts);
  if (!file || !existsSync(file)) return false;
  try { return readFileSync(file, "utf8").includes(`hook --host ${host}`); } catch { return false; }
}

export function hostConfig(host, { command = DEFAULT_COMMAND, home = homedir(), env = process.env } = {}) {
  const hook = (h) => `${command} hook --host ${h}`;
  if (host === "claude-code") return {
    file: settingsFile("claude-code", { home, env }),
    add: {
      PostToolUse: [{ matcher: "mcp__.*__sandbox_(review|report)", hooks: [{ type: "command", command: hook("claude-code"), asyncRewake: true, timeout: 604800 }] }],
      SessionStart: [{ hooks: [{ type: "command", command: hook("claude-code"), asyncRewake: true, timeout: 604800 }] }],
    },
  };
  if (host === "cursor") return {
    file: join(home, ".cursor", "hooks.json"), cursor: true,
    add: {
      afterMCPExecution: [{ command: hook("cursor"), timeout: 30 }],
      stop: [{ command: hook("cursor"), timeout: 1800, loop_limit: 20 }],
    },
  };
  if (host === "gemini") return {
    file: join(home, ".gemini", "settings.json"),
    add: {
      AfterTool: [{ matcher: "sandbox_review", hooks: [{ type: "command", command: hook("gemini"), timeout: 30_000 }] }],
      AfterAgent: [{ hooks: [{ type: "command", command: hook("gemini"), timeout: 1_800_000 }] }],
    },
  };
  return null;
}

const ours = (entry) => { const t = JSON.stringify(entry); return t.includes(MARK) || / hook --host (claude-code|cursor|gemini)\b/.test(t); };

// Pure merge: drops earlier ParallelSandbox entries, appends the current ones.
export function mergeHooks(settings, config) {
  const out = { ...(settings || {}) };
  if (config.cursor) out.version ??= 1;
  const hooks = { ...(out.hooks || {}) };
  for (const [event, entries] of Object.entries(config.add)) hooks[event] = [...(hooks[event] || []).filter((e) => !ours(e)), ...entries];
  out.hooks = hooks;
  return out;
}

export function install(host, opts = {}) {
  if (host === "codex") return { host, changed: false, note: "Codex needs no hooks: App feedback is queued into the original conversation with `codex queue`." };
  const config = hostConfig(host, opts);
  if (!config) throw new Error("install <claude-code|cursor|gemini|codex>");
  let current = {};
  if (existsSync(config.file)) current = JSON.parse(readFileSync(config.file, "utf8") || "{}");
  const next = mergeHooks(current, config);
  mkdirSync(dirname(config.file), { recursive: true });
  if (existsSync(config.file)) writeFileSync(`${config.file}.psbx-backup`, readFileSync(config.file));
  const temp = `${config.file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(next, null, 2) + "\n");
  renameSync(temp, config.file);
  return { host, changed: true, file: config.file, events: Object.keys(config.add) };
}

export function installMain(argv = process.argv.slice(2)) {
  const host = argv[1];
  const opt = (name) => { const i = argv.indexOf(`--${name}`); return i > 0 ? argv[i + 1] : undefined; };
  const result = install(host, { ...(opt("command") ? { command: opt("command") } : {}), ...(opt("home") ? { home: opt("home") } : {}) });
  console.log(JSON.stringify(result, null, 2));
  if (result.changed) console.log("Installed. ParallelSandbox reviews requested from now on return App feedback to the conversation that asked for them.");
  return 0;
}

// Usage note for the AI in a tool result when this host's hooks are missing.
export function installNote(clientName, opts = {}) {
  const host = hostFromClient(clientName);
  if (!host || host === "codex" || hooksInstalled(host, opts)) return null;
  const command = `${DEFAULT_COMMAND} install ${host}`;
  return {
    host, installed: false, command,
    usage: `ParallelSandbox setup step for this conversation (not done yet): App feedback returns to this conversation only after ParallelSandbox's ${host} hooks are installed. Run this command once now: ${command}\nIt only adds ParallelSandbox's hooks to the user settings and can be run again safely.`,
  };
}

// The same step for a review that already exists. Claude Code and Cursor reload hooks while running;
// Gemini CLI reads them only when it starts.
export function reviewInstallNote(clientName, { id, reviewId }, opts = {}) {
  const note = installNote(clientName, opts);
  if (!note) return null;
  if (note.host === "gemini") return `${note.usage}\nGemini CLI loads hooks when it starts, so feedback for this review is not routed automatically in this run: sandbox_status or sandbox_review for box ${id} hands a submitted report to you. Reviews requested after Gemini CLI restarts return automatically.`;
  return `${note.usage}\nThen call sandbox_review with ${JSON.stringify({ id, reviewId, waitSec: 0 })} once so this review's feedback returns here. Until then, read submitted reports with sandbox_report.`;
}

// Server instructions (system prompt level) for hosts whose hooks are missing on this machine.
export function setupInstructions(opts = {}) {
  const missing = ["claude-code", "cursor", "gemini"].filter((h) => !hooksInstalled(h, opts));
  if (!missing.length) return "";
  const names = { "claude-code": "Claude Code", cursor: "Cursor", gemini: "Gemini CLI" };
  return [
    "App feedback setup: when the person submits feedback in the ParallelSandbox App, it returns to the conversation that requested the review. Codex needs nothing. In the following clients it needs ParallelSandbox's hooks, installed once per machine by running the command for the client you are running in before your first sandbox_review:",
    ...missing.map((h) => `- ${names[h]}: ${DEFAULT_COMMAND} install ${h}`),
    "The command only adds ParallelSandbox's hooks to that client's user settings and can be run again safely. Claude Code and Cursor apply them to the running conversation; Gemini CLI applies them from its next start.",
  ].join("\n");
}
