#!/usr/bin/env node
// Install this command as a trusted PostToolUse hook. It binds metadata and exits;
// it never polls feedback, blocks Stop, opens a daemon, or starts a Codex turn.
import { pathToFileURL } from "node:url";
import { writeCodexHookBinding, defaultCodexStateDir } from "./codex-host.mjs";

export async function runCodexFeedbackHook(input, { stateDir = process.env.PSBX_CODEX_FEEDBACK_DIR || defaultCodexStateDir(), toolNames } = {}) {
  return writeCodexHookBinding(input, { stateDir, ...(toolNames ? { toolNames } : {}) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const options = {}, names = [];
    for (let i = 0; i < args.length; i += 2) {
      if (!args[i + 1]) throw new Error("Hook options require an explicit value");
      if (args[i] === "--state-dir" && !options.stateDir) options.stateDir = args[i + 1];
      else if (args[i] === "--tool-name") names.push(args[i + 1]);
      else throw new Error("Use --state-dir and optional exact --tool-name values");
    }
    if (names.length) options.toolNames = names;
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 4 * 1024 * 1024) throw new Error("PostToolUse input is too large");
    }
    await runCodexFeedbackHook(JSON.parse(input), options);
  } catch (err) {
    // A failed binding must not replace the user's actual review tool result.
    process.stderr.write(`[parallelsandbox] Codex feedback hook was not bound: ${err.message}\n`);
    process.exitCode = 1;
  }
}
