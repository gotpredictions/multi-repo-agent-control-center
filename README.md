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
  is running to pick it up). It's a genuinely separate OS process from the daemon, with its own `Db`
  connection — the daemon's `db.onChange()` only fires for writes made through *its own* connection,
  so an MCP write (e.g. `add_finding`) doesn't trigger it directly. The daemon instead polls
  `PRAGMA data_version` (SQLite's own signal for "another connection committed a write") on the same
  interval as its dispatch loop, and treats a change there the same as a same-process one. Without
  this, an MCP-driven write landed in the DB fine but the webview just never found out — confirmed
  live, fixed by polling rather than assuming same-process events cover every writer.
- **`src/extension.ts`** — the VS Code host. Renders `media/dashboard.html` in a webview for the
  repo table/plan/findings/log tabs (injecting a snapshot as `window.__CC_BOOTSTRAP__`, then
  `postMessage`-ing updates into the still-loaded page rather than re-rendering the whole thing —
  see the note on that below). The per-repo tagged message stream and escalation-answering are
  deliberately *not* in the webview: each repo gets a real `vscode.OutputChannel` for its log, and
  a new escalation shows a native notification with an "Answer" action that opens
  `showQuickPick`/`showInputBox` — genuine VS Code UI, not a webview panel imitating one.

**No push notification reaches an MCP-connected coordinator session.** `dispatch` returns as soon
as the work is *queued*, not when it's done — real work can take minutes. The VS Code extension's
native notifications (escalations) only reach the human at the keyboard; a coordinator has no
equivalent today. It has to poll: `get_repo_status(repoId)` for one repo, or MCP's
`list_recent_activity` (wraps `db.listLogEntries()` — one entry per dispatch sent, another per
response landed, across every repo, most recent first) for "what's happened since I last looked."
Confirmed live: a coordinator dispatched to two repos, both finished, and the coordinator never
noticed until told to go check `list_recent_activity` — which is exactly why `dispatch`'s own tool
description and the server instructions now say this explicitly, not just this README.

**Three distinct channels, deliberately not interchangeable** (see the idea doc and this repo's
own design conversation for why):
- **Dispatches** — proactive, human-initiated: design adjustments, clarification requests. Queued,
  processed FIFO, one at a time per repo.
- **Escalations (the red dot)** — reactive, agent-initiated, genuinely blocking. Two kinds:
  `permission` (the SDK's `canUseTool` actually blocked a tool call) and `reply` (the agent called
  the `ask_human` tool to pause its own turn for a decision it can't make alone — e.g. "commit
  and/or deploy?"). Neither is answerable by queuing another dispatch — the daemon's dispatch loop
  skips any repo whose `agent_status` is `needsHuman` until its escalation is resolved. Answered via
  a native `showQuickPick` (options as `{label, detail}`, plus a "Type something…" free-text
  fallback via `showInputBox`) — not a webview panel.
- **Findings** — a durable log, not a live channel. Decisions an agent made autonomously along the
  way, or items it surfaced that are waiting on a human. Answering one here only records the
  decision; relaying it back to the agent is a separate, later dispatch. Also where a
  *requirement's* progress through critique → plan → implement → close → done belongs, if you want
  a durable record of it — see below for why that's not a repo-level field.

**No per-repo lifecycle field.** Critique → plan → implement → close → done is a real, useful
discipline (see the MCP server's own instructions for the full framing), but it describes a
*requirement's* progress, not a repo's — a requirement often spans several repos at once, and a
repo you're tracking carries many different requirements over its lifetime, one after another. An
earlier version of this added `repos.stage` for this and surfaced it in the Repos tab; that was a
real modeling mistake (confirmed confusing in practice), not just a display choice, and was removed
entirely rather than just hidden. The plan's own progress already has real, granular tracking —
each task's own status in `upsert_task`/`get_tasks` — so "is the plan done" was never going to be a
single field either.

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

- "Dispatch now" vs "queue" both land as an ordinary FIFO-queued dispatch; there's no queue-jump
  (the `intro` dispatch is the one deliberate exception — see above).
- Editing an already-queued dispatch's text lands as a new queued dispatch, not an in-place edit.
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
`summary` pass). Queue a dispatch, start the agent, and watch its output in the
"Control Center: &lt;repo&gt;" channel in the Output panel — a new permission or reply escalation
shows up as a VS Code notification with an "Answer" action.

### Registering the MCP server with a coordinator session

Two options — neither hand-types a path; both are computed from where this extension is actually
installed (`context.extensionUri`), which differs between an `F5` dev checkout and an installed
`.vsix`, so a path hardcoded in this README would only ever be right for one of them.

**Simpler: a `.mcp.json` file.** Run **"Agent Control Center: Create .mcp.json"** from the Command
Palette (or the walkthrough's button). Writes/merges a `control-center` entry into a `.mcp.json` at
a project root — plain, reviewable, committable, and auto-discovered by Claude Code for sessions
rooted there. No CLI invocation, no touching `~/.claude.json`.

**Alternative: the `claude mcp add` CLI**, for `~/.claude.json`-based registration instead of a
file in the repo:

```bash
claude mcp add --scope project control-center -- node <this-install's-out>/mcpServer.js --db <this-install's-db-path>
```

Run **"Agent Control Center: Copy MCP Registration Command"** to get the exact command for *this*
install on your clipboard rather than typing either path by hand. `--db` isn't optional here —
without it the server falls back to its own default (`~/.control-center/control-center.db`), a
different file from the one this install's daemon actually watches, and dispatches sent through it
would succeed but never be picked up by anything. `--scope project` registers it for sessions run
from the current project only; use `--scope user` instead for every project on this machine.

Either way, verify with `claude mcp list` (should show `control-center — ✔ Connected`).
Registering doesn't reach sessions already running — MCP servers load at session start, not
hot-reloaded into one already open, so an existing session needs to be restarted before it'll see
this tool.
