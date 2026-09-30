# Registered native session feedback

One supervisor owns one native conversation. Claude Code, Codex and Gemini drivers start the provider's real CLI and
record its initialization UUID. Later turns use that exact UUID with the native resume command. Changing the project,
provider, identity or session UUID is rejected. No second native process writes to that session while a turn is active.

## Start and send

Supply native runtime credentials before starting: `ANTHROPIC_API_KEY` for Claude, `CODEX_API_KEY` (or
`OPENAI_API_KEY`, mapped to the native child) for Codex, and `GEMINI_API_KEY` with a valid Gemini provider endpoint
for Gemini. Keep values in your shell or credential manager, never in prompts. These are the authentication routes
used by the native integration tests.

Each runner uses a new private native configuration directory. Logging in to a different global CLI directory does
not establish authentication in this session. Existing subscription OAuth credentials are not silently copied there;
that authentication route requires an explicit session-local setup and separate verification. ParallelSandbox's own
OAuth sign-in or `PARALLELSANDBOX_API_KEY` authenticates its tools, separately from the AI provider.

```bash
parallelsandbox-agent start --provider codex --cli /absolute/path/to/codex \
  --cwd /absolute/path/to/project --prompt-file /absolute/path/to/request.txt
parallelsandbox-agent status --session /the/exact/returned/session-directory
parallelsandbox-agent send --session /the/exact/returned/session-directory --prompt "Continue with this change."
```

Use `claude-code` or `gemini` and that provider's absolute executable for the other drivers. The returned directory is
private, including the local control socket, native history, report contents and provider MCP configuration. Do not
copy it into a repository or share its configuration. Native CLI versions must support headless JSON output and exact
session resume.

The original AI calls `sandbox_review`. Its MCP adapter registers that exact review with the supervisor. The App can
submit after the AI's turn exits: the supervisor remains running, claims the durable report, and starts the next native
turn. If a turn is still running, the report waits until that native writer exits. Reports from a different review or
session are never redirected to the latest open conversation.

## Models and permissions

Choose native models through `PSBX_CLAUDE_MODEL`, `PSBX_CODEX_MODEL` and `GEMINI_MODEL`. Codex also accepts
`PSBX_CODEX_REASONING_EFFORT`, `PSBX_CODEX_APPROVAL_POLICY`, `PSBX_CODEX_SANDBOX_MODE` and
`PSBX_CODEX_ALLOWED_MCP_TOOLS`; Gemini accepts
`PSBX_GEMINI_APPROVAL_MODE`. The runner saves this explicit non-secret profile for recovery. Authentication secrets
remain runtime credentials and must be supplied again when recovering.

Gemini headless execution also requires a trusted workspace. Set `GEMINI_CLI_TRUST_WORKSPACE=true` (or
`PSBX_GEMINI_TRUST_WORKSPACE=true`) before starting only for the project you intend to trust. The runner saves this
explicit choice and restores the CLI's actual environment variable on recovery; it does not silently trust an untrusted
project. Native CLI trust configuration in this session's private directory is another explicit setup option.

Claude and Codex authorize the ParallelSandbox report, review and status tools for the registered handoff by default.
Codex writes per-tool approval grants because headless execution cannot answer an MCP approval prompt. Override
`PSBX_CODEX_ALLOWED_MCP_TOOLS` with exact comma-separated tool names, or an empty value to grant none; the saved
grant is reused on recovery. Other MCP tools keep their native permission rules. If the task requires editing in Claude,
grant the native tools in the session profile, for example
`PSBX_CLAUDE_ALLOWED_TOOLS=Read,Write,Edit,mcp__parallelsandbox__sandbox_report,mcp__parallelsandbox__sandbox_review,mcp__parallelsandbox__sandbox_status`.
The runner does not bypass provider permissions. Native permission denials appear in the session status; an acknowledged
report proves delivery and a completed native turn, rather than completion of every requested action.

## Recovery and receipts

`recover --session <exact-directory>` restarts a stopped supervisor with the same saved native UUID. It refuses an
existing owner or native writer. It reuses a proven completed turn when only its acknowledgement was interrupted.
An ambiguous interrupted send remains `uncertain`; it is not automatically repeated. Inspect native history and use
`retry --session <directory> --event <event-id>` or `--message <message-id>` to request an explicit continuation in the
same history. `stop --session <directory>` terminates the owned native process and supervisor.

App receipts distinguish queued, leased, accepted and read. The read acknowledgement requires the resumed native
session to call `sandbox_report` for that exact report and then finish successfully. A foreground MCP tool receipt
(`tool_delivered`) records preparation of its complete result, without asserting native session acknowledgement.
The submitted report's independent receipt capability remains usable for seven days even after its review link closes.

An ordinary MCP server cannot restart an arbitrary private client after it exits. Start the original conversation
through this registered runner to give feedback a persistent, identifiable executor. Existing native authentication,
workspace permissions and provider endpoint availability still apply.
