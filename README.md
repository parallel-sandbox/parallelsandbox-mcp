# parallelsandbox-mcp

stdio adapter for the ParallelSandbox MCP server. It exposes the same tools as `https://mcp.parallelsandbox.com/mcp`
(`sandbox_*`, `logs_*`), signing in with OAuth, and implements `sandbox_sync` and `sandbox_pull`
locally: an agent can upload its working directory into a box without committing, and write files from the box back to
its machine. Version 0.4.0 and later opens the browser to sign in and allow the connection. No API key is needed.

## Use

```bash
npx -y parallelsandbox-mcp
```

Claude Code:

```bash
claude mcp add parallelsandbox -- npx -y parallelsandbox-mcp
```

Any other MCP client: run the command above as a stdio server.

The first connection starts immediately, then opens the browser for OAuth. Until sign-in finishes, the
`parallelsandbox_connect` tool returns the sign-in link. Afterwards the adapter announces its sandbox and log tools;
clients that do not reload tool lists need to reconnect once. Call `parallelsandbox_connect` again to check status or
retry a cancelled sign-in. Sign-in waits five minutes before a retry is needed.

The token file lives in `~/.parallelsandbox`, separately for each MCP endpoint, with mode 0600. Multiple conversations
share this sign-in and serialize refreshes with a file lock. A lost refresh response requires a new sign-in so a used
refresh token is never replayed. Existing `PARALLELSANDBOX_API_KEY` configurations continue to work.

If you never need `sandbox_sync` or `sandbox_pull`, skip this package and connect directly over HTTP, signing in with
OAuth (run `/mcp` in Claude Code afterwards; no key needed). Over plain HTTP those two tools return an error, because
they read and write files on your machine:

```bash
claude mcp add --transport http parallelsandbox https://mcp.parallelsandbox.com/mcp
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PARALLELSANDBOX_API_KEY` | unset | Optional existing API key; skips OAuth |
| `PARALLELSANDBOX_AUTH_DIR` | `~/.parallelsandbox` | OAuth token files and locks |
| `PARALLELSANDBOX_NO_BROWSER` | unset | Set to `1` to get the sign-in link without opening a browser |
| `PARALLELSANDBOX_MCP_URL` | `https://mcp.parallelsandbox.com/mcp` | MCP endpoint |
| `PARALLELSANDBOX_API_URL` | `https://api.parallelsandbox.com` | REST base used by `sandbox_sync` |
| `PSBX_TOOL_TIMEOUT_SEC` | `60` | The MCP host’s configured absolute tool deadline in seconds; used to declare a safe review wait (default 25 seconds, maximum 1800) |
| `PSBX_ADAPTER_SILENCE_MS` | `75000` | How long a call's connection may stay silent before the adapter gives up on it (see Timeouts) |
| `PSBX_FEEDBACK_HOST` | unset | Development feedback bridge: `claude-code` or `codex`; ordinary MCP connections remain unchanged |
| `PSBX_CODEX_CLI` | host `codex` process | Absolute `codex` executable used for `codex queue` feedback delivery (and for an explicitly paired App Server) |
| `PSBX_FEEDBACK_DIR` | `~/.cache/parallelsandbox/feedback` | Feedback tickets, mailboxes and relay state |
| `PSBX_HOOK_HOLD_SEC` | `1200` | How long Cursor's and Gemini CLI's end-of-turn hook waits right after a review is requested |
| `PSBX_CODEX_HOST_SOCKET` | unset | Absolute path to that existing App Server's private control socket; Desktop IPC is unsupported |
| `PSBX_CODEX_FEEDBACK_DIR` | `~/.cache/parallelsandbox/codex-feedback` | Private binding tickets shared by the Codex hook and adapter |

When using a dev endpoint, set both `PARALLELSANDBOX_MCP_URL` and `PARALLELSANDBOX_API_URL` to its dev addresses.

## sandbox_sync

`{"id": "<box id>", "localPath": "/abs/path/to/repo", "dest": "repo"}` syncs `localPath` into `/work/<dest>` on the box.
Pass an absolute path: a relative one resolves against this adapter's working directory (where your MCP client started
it), which is not necessarily the agent's. In a git working tree it takes the tracked files plus the untracked files `.gitignore` does not
exclude, asks the box which of them differ from what is already in `dest`, and uploads only those, so syncing after an edit
sends just that edit. A file changed inside the box counts as different and gets the local version back. Outside git it
uploads the whole directory, excluding `node_modules`, `.git`, `dist`, `build`, `coverage`, `.venv` and similar. Files
deleted locally stay in the box.

## sandbox_pull

`{"id": "<box id>", "path": "<path under /work>", "localPath": "/abs/path/on/your/machine"}` downloads a file or a
directory from the box. A file is written to `localPath`. A directory's contents are extracted straight into `localPath`,
the reverse of `sandbox_sync`: `path` `app/dist` with `localPath` `/abs/dist` gives `/abs/dist/index.html`, not
`/abs/dist/dist/index.html` (versions before 0.3.3 added that extra level). Pass `"extract": false` to keep the tar.gz
as one file instead; it holds the directory itself as its top entry. Relative paths resolve the same way as for
`sandbox_sync`. Only the local copy stays: the hand-off copy on ParallelSandbox's side is deleted after about a day.

## Which conversation is using a box

Ordinary MCP connections choose a random id when the adapter starts and send it as `X-Psbx-Agent` on every call. Registered native sessions keep one supervisor-owned id across all turns; the supervisor maintains its presence until it stops. After the first tool call
it reports to `/v1/agents/<id>/heartbeat` once a minute, and when its conversation closes (stdin ends, or SIGTERM, SIGINT
or SIGHUP) it reports `/v1/agents/<id>/leave`. The app uses this to tell a box the AI is still working in from one whose
conversation was closed without `sandbox_review` or `sandbox_stop`; a conversation killed outright (no leave) counts as
gone three minutes after its last heartbeat. Nothing else is sent: no prompt, no transcript.

## Timeouts

`sandbox_takeover` blocks until a person hands the box back, up to 30 minutes. `sandbox_review` immediately creates
the person's review card, then waits for their report or completion within the caller’s declared budget. The default adapter and unknown HTTP clients wait up to 25 seconds; explicitly supported clients can wait up to 30 minutes. An explicit `waitSec` is capped by that budget and the time spent preparing the review. The result includes the effective `waitSec` and `callerWaitMaxSec`. Its progress
includes the review ID and entry URL before the final result. Use `waitSec: 0` for an explicit handoff without waiting,
or resume a timed-out round with `reviewId` instead of creating another card with `what`. The adapter waits 31 minutes
for takeover and review, and 65 minutes for other calls (a foreground `sandbox_exec` runs at most 60 minutes).
Cancelling a client call also cancels its control connection; it does not delete the review or feedback.
The waiting-tool route lasts for that active call. Registered native sessions use the supervisor below to continue after a turn exits.

## Continue after the AI finishes

`parallelsandbox-agent` runs a persistent supervisor for a registered native Claude Code, Codex or Gemini CLI session.
The first prompt and every subsequent prompt use that provider's native conversation history. A review created in that
session registers its box and review with the same supervisor. After an App report is submitted, the supervisor claims
it, waits until the current native turn has exited, and resumes the exact saved native session UUID. The resumed AI
calls `sandbox_report` to receive text, images, recordings and timed transcripts through its native MCP connection.
Only a successful native turn with that report read can acknowledge delivery. The App receipt polls independently after
submission; “received” does not mean the requested change is complete.

```bash
npx -y --package parallelsandbox-mcp parallelsandbox-agent start \
  --provider claude-code --cli /absolute/path/to/claude --cwd /absolute/path/to/project \
  --prompt "Work on this project and use sandbox_review when it is ready to try."
```

Choose `codex` with its native Codex executable or `gemini` with its native Gemini executable in the same command.
The command returns the exact session directory. Use `send --session <directory> --prompt <text>` for later prompts,
`status --session <directory>` to read results, and `stop --session <directory>` to stop that supervisor. Provider
runtime credentials must be available: `ANTHROPIC_API_KEY`, `CODEX_API_KEY`/`OPENAI_API_KEY`, or `GEMINI_API_KEY` with a valid provider endpoint. The runner uses a private native configuration directory; global CLI OAuth sign-in is not automatically inherited. See [SESSION_FEEDBACK.md](SESSION_FEEDBACK.md) for configuration,
recovery and the permission profile.

Registration happens when the original session is started with this runner. The older experimental Claude Channel
and paired Codex App Server bridges remain separate opt-in integrations; they are not the delivery mechanism of the
registered native runner.

### Feedback back to the original conversation (Codex, Claude Code, Cursor, Gemini CLI)

After `sandbox_review` succeeds, App feedback for that review returns to the same conversation that asked for it.
The adapter writes a ticket (box, review and the adapter's own agent id, no credentials) and starts one small local
relay per account. The relay registers a feedback consumer for that conversation, claims submitted reports and hands
the conversation a short follow-up telling it which report to read with `sandbox_report`; that read marks the App
receipt read. Each host only differs in how the follow-up enters the conversation:

| Host | Hooks | How the conversation receives it |
|---|---|---|
| Codex (Desktop, CLI, IDE) | none | The thread comes from Codex's tool-call metadata; the relay runs the host's own `codex queue --thread`. Idle threads start a turn; busy threads get it after the current turn. |
| Claude Code (CLI, desktop) | `install claude-code` | A background `asyncRewake` hook wakes the idle session; a busy session reads it after its current tool call. Reopening the session hands over anything that arrived while it was closed. |
| Cursor | `install cursor` | `afterMCPExecution` attaches the review; the `stop` hook returns it as `followup_message`. Not yet verified end to end with a real Cursor agent. |
| Gemini CLI | `install gemini` | `AfterTool` attaches the review; the `AfterAgent` hook returns it with `decision: "block"`. |

Nobody needs to set this up by hand. While a client's hooks are missing on the machine, the adapter's server
instructions tell the AI to ask the person, in the conversation, for consent to run the one command for its client
(`npx -y parallelsandbox-mcp install <client>`; it changes their user settings), and the `sandbox_review` result says when
a review is not yet routed back. Once the person agrees, the AI runs it before its first review (or runs it and requests
that review again with `reviewId` and `waitSec: 0`). Claude Code and Cursor apply hooks added this way to
the running conversation; Gemini CLI loads hooks when it starts, so there the first review is handed over by the next
`sandbox_status` or `sandbox_review` on that box and later sessions are automatic. `install` merges into the client's
user settings (Claude Code honours `CLAUDE_CONFIG_DIR`), keeps everything else and writes a `.psbx-backup` of the
previous file. Cursor also runs Claude Code's hooks by default; the Claude Code hook acts only inside the Claude Code
session that runs it (`CLAUDE_CODE_SESSION_ID`), so it never blocks or misroutes a Cursor conversation.

Cursor and Gemini CLI have no way to wake an idle conversation. Their end-of-turn hook waits up to 20 minutes
(`PSBX_HOOK_HOLD_SEC`) right after a review is requested, and otherwise delivers waiting feedback when that
conversation's next turn ends.

State lives in `~/.cache/parallelsandbox/feedback` (override with `PSBX_FEEDBACK_DIR`), mode 0600, for seven days.
A report is never handed to a different conversation, never queued twice, and a hook whose host process has exited
takes nothing. Set `PSBX_CODEX_CLI` only when the adapter cannot find its host `codex` process (for example on Windows).

To wait the full 30 minutes in Codex, set `tool_timeout_sec = 1920` for this MCP server and
`PSBX_TOOL_TIMEOUT_SEC = "1920"` in that server's adapter environment, then restart/reconnect the server using adapter
0.4.2 or later. Other hosts need an equivalent absolute tool timeout. Both settings are necessary: increasing
`waitSec` or the adapter setting alone cannot extend the host's deadline. Existing cached adapter processes keep
their old settings until restarted. This package does not change client configuration automatically.

`sandbox_report` reads an account-owned report by `id` and `reportId`, including its media URLs, timed transcripts
and annotated frames. It can replay a report that an earlier tool already returned, without claiming the box or
consuming other pending messages. Reports and media remain available for 7 days. A receipt records preparation of
the complete tool result, rather than the AI understanding or completing the requested change.

While a call runs, the server writes a "still running" line on its connection every 20 seconds (every 15 for
`sandbox_takeover`). The adapter forwards those as MCP progress notifications when the client asked for progress, so
a client that cancels calls after a stretch of silence (Claude Code does after 30 minutes) keeps waiting for a long build.
If the connection ends without the result, or carries nothing for `PSBX_ADAPTER_SILENCE_MS`, the adapter returns an
error right away instead of waiting out the timeout. Replay-safe tools (`sandbox_report`, `sandbox_list`, `sandbox_get`,
the `logs_*` tools and the like) are retried once first. For anything else the error says the call may have run or
even finished on the box: check `sandbox_status` (its `steps[]` lists what was run) before running it again.
`sandbox_status` can hand off pending human feedback once, so it is not automatically retried after a lost result;
use `sandbox_report` with the report ID from the app to recover that report.

## Source and issues

Source: https://github.com/parallel-sandbox/parallelsandbox-mcp. Report bugs there as issues, or from inside a session
with the `sandbox_feedback` tool. MIT licensed.
