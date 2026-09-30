import { request } from "node:http";
import { isAbsolute } from "node:path";

// This endpoint belongs to the supervisor that launched this native turn. The
// model never chooses the destination, session ID, consumer or generation.
export function sessionBridge(env = process.env) {
  if (!env.PSBX_SESSION_SOCKET) return null;
  const {PSBX_SESSION_SOCKET: socketPath, PSBX_SESSION_TOKEN: token,
    PSBX_SESSION_AGENT_ID: agentId, PSBX_SESSION_GENERATION: generation} = env;
  if (!isAbsolute(socketPath) || !/^[a-f0-9]{64}$/.test(token || "") ||
      !/^[A-Za-z0-9_-]{12,64}$/.test(agentId || "") || !/^[a-f0-9]{32}$/.test(generation || "")) {
    throw new Error("Invalid managed session connection");
  }
  return {agentId, bindReview: ({boxId, reviewId}) => sessionRequest(socketPath, token,
    "/review", {boxId, reviewId, generation}),
    reportRead: ({boxId, reportId}) => sessionRequest(socketPath, token,
      "/report-read", {boxId, reportId, generation})};
}

export function sessionRequest(socketPath, token, path, body = {}) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    // A recovered supervisor may reuse the same socket pathname. Do not reuse
    // an HTTP keep-alive connection to its former process or retry mutations.
    const req = request({socketPath, path, agent: false, method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json",
      "content-length": Buffer.byteLength(raw),
    }}, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (part) => { data += part; if (data.length > 1024 * 1024) req.destroy(new Error("Session response too large")); });
      res.on("end", () => {
        try {
          const result = JSON.parse(data);
          if (res.statusCode !== 200) throw new Error(result.error || `Session HTTP ${res.statusCode}`);
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error("Original session registration timed out")));
    req.on("error", reject);
    req.end(raw);
  });
}
