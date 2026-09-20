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

**No hardcoded repo list.** The tracked repo set starts empty and only ever grows through something
that actually happened — never a bundled fixture (see `src/discover.ts`):
- **Sibling scan** (`discoverLocalRepos` / MCP `discover_local_repos`) — no network, no `gh`, no
  auth. Scans a directory for git repos and tracks whatever it finds.
- **GitHub discovery** (`discoverGithubRepos` / MCP `discover_github_repos`) — asks the
  already-authenticated `gh` CLI what exists for an owner, cross-references against local clones,
  and surfaces repos that exist remotely but aren't cloned yet (`cwd: ''`, flagged not hidden).

Either, both, or neither — both upsert onto an existing row by repo name, so re-running never
duplicates, and neither blanks a real `cwd` just because that particular pass didn't find it.
`startAgent` refuses a repo with `cwd: ''` rather than running the SDK against a bogus path.

**Repo self-introduction, not a hand-maintained description either.** The first time a repo is
started, a synthetic `intro` dispatch queue-jumps ahead of anything else queued and asks the agent
to describe the repo itself (stack, conventions, current git state — see `src/prompts.ts`); the
result lands in `repos.summary`, surfaced by `list_repos`/`get_repo_status`. Refreshable on demand
via `refresh_repo_summary`. Verified end-to-end against a real repo — the summary correctly flagged
one as half-bootstrapped template scaffolding before any real dispatch hit that surprise.

## Known limitations (v1, ad hoc)

- The webview does a full HTML re-render on every DB change rather than patching state in place —
  transient UI (an open menu, an open dispatch drawer) resets on each update.
- "Dispatch now" vs "queue" both land as an ordinary FIFO-queued dispatch; there's no queue-jump
  (the `intro` dispatch is the one deliberate exception — see above).
- Editing an already-queued dispatch's text lands as a new queued dispatch, not an in-place edit.
- "Chat about this" on an escalation just opens the free-text answer box — there's no real
  sub-conversation thread.
- GitHub discovery's "capabilities" are shallow on purpose (exists + locally runnable, plus
  archived/private/description) — it does not try to infer stack or purpose; that's `summary`'s job
  once a repo is actually started.

## Dev

```
npm install
npm run compile
```

Then `F5` in VS Code to launch an Extension Development Host, and run
**"Agent Control Center: Open Dashboard"** from the command palette. With nothing tracked yet,
you'll be asked how to populate it (sibling scan, GitHub discovery, or skip) — nothing runs
without you choosing it.

Discovered repos start `stopped` (deliberately — nothing runs real Agent SDK sessions against real
repos until you explicitly start one from the dot menu, which also queues that repo's first
`summary` pass). Queue a dispatch, start the agent, and watch the Watch panel.

### Registering the MCP server with a coordinator session

```bash
claude mcp add --scope user control-center -- node /Users/evso/code/multi-repo-agent-control-center/out/mcpServer.js
```

`--scope user` makes it available from any project/session on this machine, not just one repo —
appropriate here since a "coordinator" isn't tied to any single repo. Verify with `claude mcp list`
(should show `control-center — ✔ Connected`). Registering doesn't reach sessions already
running — MCP servers load at session start, not hot-reloaded into one already open, so an
existing session needs to be restarted before it'll see this tool.

(Hand-editing `~/.claude.json`'s `mcpServers` key directly works too, in principle, but it's Claude
Code's own live state file — rewritten by every running session for history/settings/etc. —
so `claude mcp add` is the safer path, not just the more convenient one.)

(Add `--db <path>` if you're not using the default `~/.control-center/control-center.db`.)
