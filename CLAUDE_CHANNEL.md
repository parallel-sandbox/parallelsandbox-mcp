# Claude Code native feedback channel

> Claude Code feedback delivery now uses an `asyncRewake` hook (README, "Feedback back to the original conversation";
> `npx -y parallelsandbox-mcp install claude-code`). This channel experiment is unchanged and not needed for it.

This development integration does not currently support automatic Claude feedback routing. Its isolated protocol tests pass; authenticated native idle wake-up and native queue isolation across `/clear` or `/resume` have not been verified. The current adapter therefore refuses feedback binding and polling, including after a successful channel activation challenge. Saved reports remain readable with `sandbox_report`. The integration does not open another conversation, run a headless `--resume`, or keep an AI tool call waiting to imitate a wake-up.

During Claude's channels research preview, installing an MCP server or plugin alone does not activate inbound events. ParallelSandbox is a custom channel and requires explicit startup opt-in and Claude's development-channel confirmation:

```sh
claude --dangerously-load-development-channels server:parallelsandbox-channel
```

For an existing session, pass its exact UUID with `--resume` when restarting with that explicit opt-in. Do not use `--continue`, `--fork-session`, or `--bg` to choose the feedback destination. No global Claude configuration is changed by this package. Do not configure a second ordinary ParallelSandbox MCP server (or the plugin) in the same session.

Since 0.7.5 the published plugin (`.claude-plugin/`, `.mcp.json`) no longer opts into this channel: it starts the pinned npm release as an ordinary adapter, so feedback uses the `asyncRewake` hook route. To try the channel, run a local checkout (with its dependencies installed) as a separate stdio server with `PSBX_FEEDBACK_HOST=claude-code`, for example `claude mcp add parallelsandbox-channel --env PSBX_FEEDBACK_HOST=claude-code -- node /path/to/parallelsandbox-mcp/index.mjs`, and start Claude with `--dangerously-load-development-channels server:parallelsandbox-channel`. Ordinary adapter installations do not opt into the channel automatically.

Claude Code introduced channels in 2.1.80. Availability is controlled by Claude authentication and research-preview rollout. Team/Enterprise administrators must explicitly permit channels. The currently inspected 2.1.114 client requires claude.ai authentication; current official documentation also supports a Console API key on newer clients. Bedrock, Google Cloud Agent Platform, and Foundry are outside the documented support. A model proxy is not evidence that the channel authentication gate is satisfied.

The first native event carries a random activation challenge. Answering it with `parallelsandbox_channel_ready` only proves event reception; the result explicitly says `sessionRouting:false`. A live MCP process can survive `/clear` or a conversation switch, so neither that process identity nor the challenge proves the original conversation owns a later queued event.

A future trusted host integration must attest the immutable review/session binding and a native queue scoped to that session, then return the identical session proof before each dispatch and ACK. A boolean claim or a command lifecycle hook checked only before enqueueing is insufficient: it cannot establish where an already queued event will run after a context switch. The current index supplies no such integration, so it performs no feedback bind/claim/dispatch. No lifecycle hooks are added to disguise this limitation. The injected session guards in tests are isolated protocol fixtures, not evidence that Claude's native queue is isolated.

If that native contract is verified and implemented later, feedback events will expose only the report id and either the box id (a `sandbox_review` card) or the design id (a design version, which has no box). Claude would read the full report with `sandbox_report`, then call `parallelsandbox_feedback_ack` to acknowledge reading it. That receipt would not mark the requested work complete.

Claude's documented native behavior queues events while busy and can start an idle open session's next turn in the same terminal. This does not prove delivery remains in the original conversation across context switches. Even a future guarded route would require the original session and its live MCP process to remain open. If the MCP process restarts, its random agent/consumer identity changes; an immutable existing review binding would not transfer to that new connection merely because the person resumed the same Claude UUID. This version does not automatically rebind, reopen a closed terminal, or deliver feedback to a different conversation.

Permission prompts and AI questions stay in Claude Code. There is no permission-relay capability, and no guessed latest-session or working-directory fallback.

Official references: [channels](https://code.claude.com/docs/en/channels), [channel protocol](https://code.claude.com/docs/en/channels-reference), [plugin layout](https://code.claude.com/docs/en/plugins-reference).
