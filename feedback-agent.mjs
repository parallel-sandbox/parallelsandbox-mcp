#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { captureNativeProfile, nativeProviders, savePrivate, SessionHost } from "./session-host.mjs";
import { sessionRequest } from "./session-bridge.mjs";

function options(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || args[i + 1] === undefined) throw new Error("Options require --name value");
    out[args[i].slice(2)] = args[i + 1];
  }
  return out;
}
const here = dirname(fileURLToPath(import.meta.url));
const [command, ...args] = process.argv.slice(2);
try {
  const opts = options(args);
  if (command === "serve") {
    const config = JSON.parse(readFileSync(opts.config, "utf8"));
    const host = new SessionHost(config);
    await host.start();
    const stop = () => host.stop().then(() => process.exit(0));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  } else if (command === "start") {
    if (!nativeProviders.includes(opts.provider)) throw new Error("--provider must be claude-code, codex or gemini");
    if (!opts.prompt && !opts["prompt-file"]) throw new Error("--prompt or --prompt-file is required");
    if (!opts.cli || !isAbsolute(opts.cli)) throw new Error("--cli requires the absolute path of the native CLI");
    accessSync(opts.cli, constants.X_OK);
    const cwd = resolve(opts.cwd || process.cwd());
    const stateDir = resolve(opts["state-dir"] || join(homedir(), ".parallelsandbox", "sessions", randomBytes(12).toString("hex")));
    if (existsSync(join(stateDir, "config.json"))) throw new Error("Session already exists; use send with its exact --session path");
    mkdirSync(stateDir, {recursive: true, mode: 0o700});
    chmodSync(stateDir, 0o700);
    const config = {provider: opts.provider, cliPath: opts.cli, cwd, stateDir,
      nativeProfile: captureNativeProfile(opts.provider),
      socketPath: join(stateDir, "host.sock"), token: randomBytes(32).toString("hex"),
      agentId: randomBytes(12).toString("base64url"), adapterPath: join(here, "index.mjs"),
      apiUrl: process.env.PARALLELSANDBOX_API_URL || "https://api.parallelsandbox.com",
      mcpUrl: process.env.PARALLELSANDBOX_MCP_URL || "https://mcp.parallelsandbox.com/mcp"};
    savePrivate(join(stateDir, "config.json"), config);
    const log = openSync(join(stateDir, "host.log"), "a", 0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve", "--config", join(stateDir, "config.json")], {
      cwd, env: process.env, detached: true, stdio: ["ignore", log, log],
    });
    child.unref();
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await sessionRequest(config.socketPath, config.token, "/status"); ready = true; break; }
      catch { await delay(100); }
    }
    if (!ready) throw new Error(`Native supervisor did not start; inspect ${join(stateDir, "host.log")}`);
    const prompt = opts["prompt-file"] ? readFileSync(opts["prompt-file"], "utf8") : opts.prompt;
    const result = await sessionRequest(config.socketPath, config.token, "/send", {prompt});
    console.log(JSON.stringify({session: stateDir, provider: opts.provider, pid: child.pid, ...result}));
  } else if (command === "recover") {
    if (!opts.session) throw new Error("The exact --session directory is required");
    const configFile = join(resolve(opts.session), "config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    let existing;
    try { existing = await sessionRequest(config.socketPath, config.token, "/status"); } catch {}
    if (existing) throw new Error(`The original supervisor is still available (pid ${existing.pid}); recovery did not start another owner`);
    const log = openSync(join(config.stateDir, "host.log"), "a", 0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve", "--config", configFile], {
      cwd: config.cwd, env: process.env, detached: true, stdio: ["ignore", log, log],
    });
    child.unref();
    let state;
    for (let i = 0; i < 100; i++) {
      try { state = await sessionRequest(config.socketPath, config.token, "/status"); }
      catch { await delay(100); }
      if (state) {
        if (state.pid !== child.pid) throw new Error("Recovery did not acquire this original session; another supervisor owns its socket");
        break;
      }
    }
    if (!state) throw new Error(`Recovery refused; inspect ${join(config.stateDir, "host.log")}`);
    console.log(JSON.stringify({recovered: true, session: config.stateDir, sessionId: state.sessionId, pid: state.pid}));
  } else if (["send", "status", "stop", "retry"].includes(command)) {
    if (!opts.session) throw new Error("The exact --session directory is required");
    const config = JSON.parse(readFileSync(join(resolve(opts.session), "config.json"), "utf8"));
    const body = command === "send" ? {prompt: opts["prompt-file"] ? readFileSync(opts["prompt-file"], "utf8") : opts.prompt} : command === "retry" ? {eventId: opts.event, messageId: opts.message} : {};
    console.log(JSON.stringify(await sessionRequest(config.socketPath, config.token, `/${command}`, body), null, 2));
  } else {
    throw new Error("Use start --provider <claude-code|codex|gemini> --cli <absolute-native-CLI> --cwd <project> --prompt <text>, or status/send/stop --session <exact directory>");
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
