import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discoverOAuthServerInfo, exchangeAuthorization, refreshAuthorization, registerClient, startAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";

export class LoginRequired extends Error {
  constructor() { super("Sign in to ParallelSandbox to connect. Call parallelsandbox_connect for the sign-in link."); }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code !== "ESRCH"; }
}

function openBrowser(url) {
  if (process.env.PARALLELSANDBOX_NO_BROWSER) return;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {}); // The link is also available to the MCP client.
  child.unref();
}

function connectionPage(language, connected) {
  const locale = /^ja(?:-|,|;|$)/i.test(language) ? "ja" : /^zh(?:-|,|;|$)/i.test(language) ? "zh-Hant" : "en";
  const messages = {
    "zh-Hant": connected ? ["已連線", "關閉此頁，回到剛剛的 AI 對話繼續。"] : ["尚未連線", "回到剛剛的 AI 對話，請 AI 重新連線。"],
    ja: connected ? ["接続しました", "このページを閉じて、元の AI の会話に戻ってください。"] : ["接続できませんでした", "元の AI の会話に戻って、再接続を依頼してください。"],
    en: connected ? ["Connected", "Close this page and return to your original AI conversation to continue."] : ["Connection failed", "Return to your original AI conversation and ask it to reconnect."],
  };
  const [title, message] = messages[locale];
  return `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — ParallelSandbox</title><style>body{margin:0;background:#f7f7f3;color:#151713;font:16px/1.65 system-ui,sans-serif}main{max-width:36rem;margin:20vh auto;padding:24px}h1{font-size:32px;line-height:1.2}p{color:#4a4e45}</style><main><p>ParallelSandbox</p><h1>${title}</h1><p>${message}</p></main></html>`;
}

// A directory lock is shared by every adapter for this endpoint. Never steal a live
// owner's lock, even when the computer has slept through the refresh or sign-in.
async function locked(path, work, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  const owner = join(path, String(process.pid));
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
      const identity = statSync(path);
      writeFileSync(owner, "", { flag: "wx", mode: 0o600 });
      const current = statSync(path);
      if (identity.ino !== current.ino || identity.dev !== current.dev || readdirSync(path).length !== 1) {
        unlinkSync(owner);
        continue;
      }
      break;
    } catch (err) {
      if (!["EEXIST", "ENOENT"].includes(err.code)) throw err;
      try {
        const entries = readdirSync(path);
        for (const entry of entries) {
          if (/^[1-9][0-9]*$/.test(entry) && !alive(Number(entry))) {
            try { unlinkSync(join(path, entry)); } catch (e) { if (e.code !== "ENOENT") throw e; }
          }
        }
        // rmdir only removes an empty directory; it cannot delete a new owner's file.
        if (entries.length || Date.now() - statSync(path).mtimeMs > 5_000) {
          try { rmdirSync(path); } catch (e) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(e.code)) throw e; }
        }
      } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (Date.now() >= deadline) throw new Error("Another ParallelSandbox adapter is signing in or refreshing. Try again shortly.");
      await delay(100);
    }
  }
  try { return await work(); }
  finally {
    unlinkSync(owner);
    rmdirSync(path);
  }
}

export class OAuthSession {
  constructor({ mcpUrl, directory = process.env.PARALLELSANDBOX_AUTH_DIR || join(homedir(), ".parallelsandbox"), log = () => {}, open = openBrowser }) {
    this.mcpUrl = new URL(mcpUrl).href;
    this.directory = directory;
    this.log = log;
    this.open = open;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const name = createHash("sha256").update(this.mcpUrl).digest("hex").slice(0, 32);
    this.file = join(directory, `oauth-${name}.json`);
    this.lock = `${this.file}.lock`;
    this.login = null;
  }

  read() {
    try {
      const state = JSON.parse(readFileSync(this.file, "utf8"));
      if (state.mcpUrl !== this.mcpUrl) throw new Error("The saved ParallelSandbox sign-in belongs to another endpoint.");
      return state;
    } catch (err) {
      if (err.code === "ENOENT") return { mcpUrl: this.mcpUrl };
      throw err;
    }
  }

  write(state) {
    const temp = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(state), { flag: "wx", mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, this.file);
    } finally {
      try { unlinkSync(temp); } catch (err) { if (err.code !== "ENOENT") throw err; }
    }
  }

  status() {
    const state = this.read();
    return state.login?.pid && alive(state.login.pid) ? state.login.url : undefined;
  }

  hasTokens() {
    const state = this.read();
    return !!state.tokens?.access_token;
  }

  async oauthFetch(url, init = {}) {
    return fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  }

  tokenOptions(state) {
    return { metadata: state.server.authorizationServerMetadata, clientInformation: state.client, resource: new URL(this.mcpUrl), fetchFn: this.oauthFetch.bind(this) };
  }

  saveTokens(state, tokens) {
    state.tokens = tokens;
    state.expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;
    delete state.refreshing;
    delete state.login;
    this.write(state);
    return tokens.access_token;
  }

  async accessToken({ rejected, minValidityMs = 60_000 } = {}) {
    const cached = this.read();
    if (!cached.tokens) throw new LoginRequired();
    const usable = (state) => state.tokens && !state.refreshing && state.tokens.access_token !== rejected && state.expiresAt > Date.now() + minValidityMs;
    if (usable(cached)) return cached.tokens.access_token;
    return locked(this.lock, async () => {
      const state = this.read(); // Another process may already have rotated the token.
      if (usable(state)) return state.tokens.access_token;
      if (!state.tokens?.refresh_token || state.refreshing) throw new LoginRequired();
      // If the process dies or the response is lost after the server consumes the
      // refresh, a later process must sign in again instead of replaying that token.
      state.refreshing = true;
      this.write(state);
      try {
        const tokens = await refreshAuthorization(state.server.authorizationServerUrl, { ...this.tokenOptions(state), refreshToken: state.tokens.refresh_token });
        return this.saveTokens(state, tokens);
      } catch {
        delete state.tokens;
        delete state.refreshing;
        this.write(state);
        throw new LoginRequired();
      }
    });
  }

  async headers(headers, options) {
    const out = new Headers(headers);
    out.set("Authorization", `Bearer ${await this.accessToken(options)}`);
    return out;
  }

  async fetch(url, init = {}) {
    const token = await this.accessToken();
    const send = async (bearer) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${bearer}`);
      return fetch(url, { ...init, headers });
    };
    const response = await send(token);
    if (response.status !== 401) return response;
    await response.body?.cancel();
    return send(await this.accessToken({ rejected: token }));
  }

  async ensureLogin() {
    if (this.login) return this.login;
    this.login = locked(this.lock, async () => {
      const state = this.read();
      if (state.tokens && !state.refreshing) return;
      delete state.tokens;
      delete state.refreshing;
      delete state.login;
      state.server = await discoverOAuthServerInfo(this.mcpUrl, { fetchFn: this.oauthFetch.bind(this) });
      const metadata = state.server.authorizationServerMetadata;
      if (!metadata?.authorization_endpoint || !metadata?.token_endpoint || !metadata?.registration_endpoint) {
        throw new Error("ParallelSandbox OAuth discovery did not return the required endpoints.");
      }
      if (state.server.resourceMetadata?.resource && new URL(state.server.resourceMetadata.resource).href !== this.mcpUrl) {
        throw new Error("ParallelSandbox OAuth metadata names a different MCP endpoint.");
      }
      const expectedState = randomBytes(24).toString("base64url");
      let complete;
      let fail;
      let callbackResponse;
      let callbackLanguage;
      const callback = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
      // Attach a rejection handler before discovery/registration can yield.
      callback.catch(() => {});
      const listener = createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (url.pathname !== "/callback" || req.method !== "GET") return res.writeHead(404).end();
        if (url.searchParams.get("state") !== expectedState) return res.writeHead(400).end("Invalid sign-in state.");
        if (url.searchParams.has("error")) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(connectionPage(req.headers["accept-language"] || "", false));
          fail(new Error("ParallelSandbox sign-in was declined."));
        } else if (url.searchParams.get("code")) {
          callbackResponse = res;
          callbackLanguage = req.headers["accept-language"] || "";
          complete(url.searchParams.get("code"));
        } else res.writeHead(400).end("Missing authorization code.");
      });
      const listen = (port) => new Promise((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(port, "127.0.0.1", () => { listener.removeListener("error", reject); resolve(); });
      });
      let timer;
      try {
        try { await listen(state.port || 0); }
        catch (err) { if (err.code !== "EADDRINUSE") throw err; await listen(0); }
        const port = listener.address().port;
        const redirectUrl = `http://127.0.0.1:${port}/callback`;
        if (!state.client || state.port !== port) {
          state.client = await registerClient(state.server.authorizationServerUrl, {
            metadata, fetchFn: this.oauthFetch.bind(this),
            clientMetadata: { client_name: "ParallelSandbox local adapter", redirect_uris: [redirectUrl], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] },
          });
        }
        state.port = port;
        const { authorizationUrl, codeVerifier } = await startAuthorization(state.server.authorizationServerUrl, {
          metadata, clientInformation: state.client, redirectUrl, scope: "sandbox", state: expectedState, resource: new URL(this.mcpUrl),
        });
        state.login = { pid: process.pid, url: authorizationUrl.href };
        this.write(state);
        this.log("Sign in to ParallelSandbox:", authorizationUrl.href);
        timer = setTimeout(() => fail(new Error("ParallelSandbox sign-in timed out. Call parallelsandbox_connect to try again.")), 5 * 60_000);
        // Opening a browser may wait for its final page, which now waits for token exchange.
        Promise.resolve().then(() => this.open(authorizationUrl.href)).catch(fail);
        const authorizationCode = await callback;
        const tokens = await exchangeAuthorization(state.server.authorizationServerUrl, {
          ...this.tokenOptions(state), authorizationCode, codeVerifier, redirectUri: redirectUrl,
        });
        this.saveTokens(state, tokens);
        callbackResponse?.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(connectionPage(callbackLanguage, true));
      } catch (err) {
        if (callbackResponse && !callbackResponse.writableEnded) {
          callbackResponse.writeHead(500, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(connectionPage(callbackLanguage, false));
        }
        throw err;
      } finally {
        clearTimeout(timer);
        listener.close();
        listener.closeAllConnections();
        if (state.login) { delete state.login; this.write(state); }
      }
    }, 6 * 60_000).finally(() => { this.login = null; });
    return this.login;
  }
}
