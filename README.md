# parallelsandbox-mcp

stdio adapter for the ParallelSandbox MCP server. It exposes the same tools as `https://mcp.parallelsandbox.com/mcp`
(`sandbox_*`, `logs_*`), forwarding every call with your API key, and implements `sandbox_sync` and `sandbox_pull`
locally: an agent can upload its working directory into a box without committing, and write files from the box back to
its machine. Get an API key (`psbx_…`) in the app: https://app.parallelsandbox.com → Account → API keys.

## Use

```bash
PARALLELSANDBOX_API_KEY=psbx_... npx parallelsandbox-mcp
```

Claude Code:

```bash
claude mcp add parallelsandbox -e PARALLELSANDBOX_API_KEY=psbx_... -- npx -y parallelsandbox-mcp
```

Any other MCP client: run the command above as a stdio server.

If you never need `sandbox_sync` or `sandbox_pull`, you can skip this package and connect directly (over plain HTTP
those two tools return an error, because they read and write files on your machine):

```bash
claude mcp add --transport http parallelsandbox https://mcp.parallelsandbox.com/mcp --header "Authorization: Bearer psbx_..."
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PARALLELSANDBOX_API_KEY` | required | API key from the app |
| `PARALLELSANDBOX_MCP_URL` | `https://mcp.parallelsandbox.com/mcp` | MCP endpoint |
| `PARALLELSANDBOX_API_URL` | `https://api.parallelsandbox.com` | REST base used by `sandbox_sync` |
| `PSBX_ADAPTER_SILENCE_MS` | `75000` | How long a call's connection may stay silent before the adapter gives up on it (see Timeouts) |

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

Each time the adapter starts it picks a random id and sends it as `X-Psbx-Agent` on every call. After the first tool call
it reports to `/v1/agents/<id>/heartbeat` once a minute, and when its conversation closes (stdin ends, or SIGTERM, SIGINT
or SIGHUP) it reports `/v1/agents/<id>/leave`. The app uses this to tell a box the AI is still working in from one whose
conversation was closed without `sandbox_review` or `sandbox_stop`; a conversation killed outright (no leave) counts as
gone three minutes after its last heartbeat. Nothing else is sent: no prompt, no transcript.

## Timeouts

`sandbox_takeover` blocks until a person hands the box back, up to 30 minutes; the adapter waits 31 minutes for it and
65 minutes for other calls (a foreground `sandbox_exec` runs at most 60 minutes).

While a call runs, the server writes a "still running" line on its connection every 20 seconds (every 15 for
`sandbox_takeover`). The adapter forwards those as MCP progress notifications when the client asked for progress, so
a client that cancels calls after a stretch of silence (Claude Code does after 30 minutes) keeps waiting for a long build.
If the connection ends without the result, or carries nothing for `PSBX_ADAPTER_SILENCE_MS`, the adapter returns an
error right away instead of waiting out the timeout. Read-only tools (`sandbox_status`, `sandbox_list`, `sandbox_get`,
the `logs_*` tools and the like) are retried once first. For anything else the error says the call may have run or
even finished on the box: check `sandbox_status` (its `steps[]` lists what was run) before running it again.

## Source and issues

Source: https://github.com/parallel-sandbox/parallelsandbox-mcp. Report bugs there as issues, or from inside a session
with the `sandbox_feedback` tool. MIT licensed.
