# Codex feedback bridge: development integration

> The default Codex route is now `codex queue` (see README, "Feedback back to the original conversation"): it needs no socket, hook or
> pairing, and works for Codex Desktop conversations. This App Server bridge stays an explicit opt-in experiment.

This development integration ships in the package since 0.4.3; 0.4.2 and earlier do not include these bridge files. It targets an **already-running, explicitly paired official Codex App Server** that has the original thread loaded. The current Codex Desktop installation uses private stdio and has no documented control endpoint for this bridge, so it is currently unsupported.

The bridge's unit and protocol tests run in a real ParallelSandbox box. Real Codex idle/active turn delivery, the installed runtime's hook `_meta` passthrough, and approval routing back to its existing UI are **pending integration verification**. The protocol fixtures are not evidence of real model execution.

## Pair the adapter with its existing host

Use the actual absolute paths for the CLI and the official App Server socket that already serves the conversation. Give the adapter and hook the same private state directory:

```toml
[mcp_servers.parallelsandbox]
command = "/absolute/path/to/node"
args = ["/absolute/development-checkout/packages/parallelsandbox-mcp/index.mjs"]

[mcp_servers.parallelsandbox.env]
PSBX_FEEDBACK_HOST = "codex"
PSBX_CODEX_CLI = "/absolute/path/to/codex"
PSBX_CODEX_HOST_SOCKET = "/absolute/private/host/app-server-control.sock"
PSBX_CODEX_FEEDBACK_DIR = "/absolute/private/parallelsandbox-feedback"
```

The bridge connects using `codex app-server proxy --sock`, performs the official `initialize`/`initialized` handshake, and checks `thread/loaded/list` plus `thread/read`. The original thread must be loaded in this same paired host. Initial configuration is reported separately from verified host connectivity. A successful real `turn/start` response confirms the standalone tool-output capability.

## Install a trusted PostToolUse binding hook

The following shape uses the documented Codex `PostToolUse` command hook fields. Install it in a trusted project `.codex/hooks.json` or a plugin's `hooks/hooks.json`, then review and trust the exact definition in Codex's `/hooks` interface. Replace the script, Node executable and state-directory paths with their installed absolute paths:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "^(mcp__parallelsandbox__sandbox_review|mcp__parallelsandbox-mcp__sandbox_review)$",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/node /absolute/package/codex-host-hook.mjs --state-dir /absolute/private/parallelsandbox-feedback",
            "timeout": 10,
            "statusMessage": "Binding ParallelSandbox review feedback"
          }
        ]
      }
    ]
  }
}
```

These tool names cover the `parallelsandbox` and `parallelsandbox-mcp` MCP server names. For a differently named MCP server, use its exact canonical hook tool name in the matcher and append `--tool-name mcp__your_server__sandbox_review` to the command. This standard hook-script path needs no additional adapter option: the script verifies the private marker and ticket before writing the binding that the adapter scans.

The hook uses Codex's `session_id`, which identifies the parent session for subagent hooks. It accepts a binding only when the tool name, box, review and private result marker match the adapter's owner-only ticket. It writes a mode-0600 binding and exits. The adapter's environment and a hook's parent environment can differ; the explicit `--state-dir` keeps them aligned.

Official hook documentation describes `tool_response` as the MCP call result. This version requires its `_meta.psbxCodexFeedback.token` to survive unchanged. That passthrough has not yet been observed in a real installed-host hook run. When the marker is absent or changed, the hook leaves the review unbound.

## Adapter integration contract

```js
const feedback = createCodexFeedback({
  apiUrl, headers, authorizedFetch,
  callRemoteReport: ({ id, reportId, signal }) => callCompleteReport(id, reportId, signal),
  cliPath, socketPath, stateDir,
  onState,
});
feedback.start();

// After a successful sandbox_review, before returning its result to the host:
const tracked = await feedback.trackReview({ boxId, reviewId });
if (tracked.hookMeta) {
  result._meta = { ...result._meta, psbxCodexFeedback: tracked.hookMeta };
}
```

`headers` contains the actual adapter's `X-Psbx-Agent`; `callRemoteReport` returns the complete `sandbox_report` MCP result, including inline frames and the text JSON containing files, recording URLs and transcripts. `stop()` ends the bridge's local background tasks. `status()` distinguishes configuration, verified pairing, and a confirmed host acceptance. The hook and adapter keep API credentials out of binding tickets.

After a trusted binding, the adapter registers a feedback consumer scoped to the review. A single original-thread consumer can register multiple boxes and rounds. Its background claim loop runs independently of model generation, so the model can finish its turn normally. The adapter process and paired host must remain available for automatic delivery.

The bridge maps MCP text and image content to the official standalone `toolOutput` schema and sends:

```json
{
  "method": "turn/start",
  "params": {
    "threadId": "original-thread-id",
    "input": [],
    "toolOutput": {
      "name": "sandbox_report",
      "namespace": "parallelsandbox",
      "output": [{ "type": "input_text", "text": "complete report JSON" }]
    }
  }
}
```

Official App Server behavior starts generation when idle and queues standalone tool output when a regular turn is active. The existing thread's model, working directory and permission settings are retained.

A confirmed host response is recorded before the consumer's `host_accepted` ACK. An ACK retry reuses that record without submitting another turn. A disconnect after sending leaves the result uncertain and pending for reconciliation. Journals are scoped by consumer, box, review, report and opaque event identity. Host acceptance means the tool output was accepted or queued; it does not mean the model has processed it.

Approval or elicitation requests are surfaced through `onState` as `host_request_required`. An integration can supply `onHostRequest` to route them through its actual existing UI. Routing by the original UI has not been verified in this release; workflows requiring such requests remain limited until that host integration is demonstrated.

Official references: [App Server](https://learn.chatgpt.com/docs/app-server), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [plugin lifecycle hooks](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks).
