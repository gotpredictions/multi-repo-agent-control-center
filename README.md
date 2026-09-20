# Multi-Repo Agent Control Center

Local VS Code extension: a live dashboard for coordinating coding-agent sessions across multiple
repos, replacing manual multi-terminal status checks.

Ad hoc local tooling — no release process, no CI, built incrementally as needed.

Design context: `ideas/multi-repo-agent-control-center.md` in the `.github-private` repo.

## Architecture

Three processes, one SQLite file as the shared bus (`~/.control-center/control-center.db` by
default):

- **`src/server.ts`** — the daemon. Spawned once by the extension on activate and kept running
  independent of any webview. Polls each repo for its next queued dispatch and runs it through the
  Claude Agent SDK (`src/agentRunner.ts`). Also serves a tiny newline-delimited JSON protocol over
  its own stdin/stdout for the extension host, since VS Code's Electron/Node runtime isn't
  guaranteed to have `node:sqlite` (Node ≥22.5 required — this all assumes a real Node on `PATH`).
- **`src/mcpServer.ts`** — the MCP gateway, spawned fresh per coordinator session by that session's
  `.mcp.json`. Thin and stateless beyond the DB (every tool call is a direct SQLite read/write) —
  it does not run the agent loop itself, so a coordinator dispatching through it works whether or
  not VS Code happens to be open at that moment (the dispatch just sits `queued` until the daemon
  is running to pick it up).
- **`src/extension.ts`** — the VS Code host. Renders `media/dashboard.html` in a webview, injecting
  a snapshot as `window.__CC_BOOTSTRAP__`; re-renders whenever the daemon reports a DB change.
  Webview actions (dispatch, resolve an escalation, answer a finding, pause/start/stop) post a
  message back to the extension, which relays it to the daemon.

**Three distinct channels, deliberately not interchangeable** (see the idea doc and this repo's
own design conversation for why):
- **Dispatches** — proactive, human-initiated: design adjustments, clarification requests. Queued,
  processed FIFO, one at a time per repo.
- **Escalations (the red dot)** — reactive, agent-initiated, genuinely blocking. Two kinds:
  `permission` (the SDK's `canUseTool` actually blocked a tool call) and `reply` (the agent called
  the `ask_human` tool to pause its own turn for a decision it can't make alone — e.g. "commit
  and/or deploy?"). Neither is answerable by queuing another dispatch — the daemon's dispatch loop
  skips any repo whose `agent_status` is `needsHuman` until its escalation is resolved.
- **Findings** — a durable log, not a live channel. Decisions an agent made autonomously along the
  way, or items it surfaced that are waiting on a human. Answering one here only records the
  decision; relaying it back to the agent is a separate, later dispatch.

## Known limitations (v1, ad hoc)

- The webview does a full HTML re-render on every DB change rather than patching state in place —
  transient UI (an open menu, an open dispatch drawer) resets on each update.
- "Dispatch now" vs "queue" both land as an ordinary FIFO-queued dispatch; there's no queue-jump.
- Editing an already-queued dispatch's text lands as a new queued dispatch, not an in-place edit.
- "Chat about this" on an escalation just opens the free-text answer box — there's no real
  sub-conversation thread.
- `agentRunner.ts`'s calls into `@anthropic-ai/claude-agent-sdk` are written against its documented
  `query()`/custom-tool shape, not verified against a real end-to-end SDK run yet. Errors there
  surface as `warn` log lines against the repo and the daemon's own stderr, not a silent hang.

## Dev

```
npm install
npm run compile
```

Then `F5` in VS Code to launch an Extension Development Host, and run
**"Agent Control Center: Open Dashboard"** from the command palette.

Repos start `stopped` (seeded that way deliberately — nothing runs real Agent SDK sessions against
real repos until you explicitly start one from the dot menu). Queue a dispatch, start the agent,
and watch the Watch panel.

### Registering the MCP server with a coordinator session

Add to that session's `.mcp.json`:

```json
{
  "mcpServers": {
    "control-center": {
      "command": "node",
      "args": ["/Users/evso/code/multi-repo-agent-control-center/out/mcpServer.js"]
    }
  }
}
```

(Add `--db <path>` if you're not using the default `~/.control-center/control-center.db`.)
