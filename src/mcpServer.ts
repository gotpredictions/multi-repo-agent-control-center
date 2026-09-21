#!/usr/bin/env node
// MCP gateway for coordinator sessions (e.g. the .github-private session
// dispatching this initiative's work) to reach repo agents that are now
// SDK-managed background processes, not ListAgents/SendMessage-discoverable
// terminal sessions (SDK sessions run --bare-equivalent, no inbox socket).
//
// Deliberately thin and stateless beyond the DB: every tool call is a
// direct SQLite read/write against the same file the server.ts daemon and
// the extension read. It does NOT hold any ClaudeSDKClient itself and does
// NOT run the agent loop — that's server.ts's job, running continuously
// regardless of whether a coordinator is currently connected. This process
// is spawned fresh per coordinator session (per that session's .mcp.json),
// which is fine precisely because it carries no session-lifetime state of
// its own.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { Db } from "./db";
import { INTRO_PROMPT } from "./prompts";
import { runGithubDiscoveryAndUpsert, runLocalDiscoveryAndUpsert } from "./discover";
import { startAgent, stopAgent } from "./repoActions";

function parseArg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dbPath = parseArg("--db", `${process.env.HOME}/.control-center/control-center.db`);
const db = new Db(dbPath);

const SERVER_INSTRUCTIONS = `Control center for coding-agent sessions running across multiple repos.
Three channels exist here, and they are not interchangeable:

- dispatch: proactive, your idea — a design adjustment, a clarification
  request, a new task. Queued, run FIFO, one at a time per repo. Use this
  for almost everything.
- resolve_escalation: reactive, the agent's idea — it is genuinely
  blocked right now (agent_status: needsHuman) on either a permission gate
  or a direct question it asked to continue its turn. dispatch will NOT
  reach a blocked repo: queued dispatches are not run while a repo is
  needsHuman. Check list_open_escalations first if you're unsure why a
  repo isn't picking up work.
- answer_finding / add_finding: a durable log, not a live channel.
  Answering a finding only records your decision — it does not notify
  the agent. Follow up with dispatch to actually hand a decision back.

Repos start (and stay) stopped until something starts them — a dispatch
queued against a stopped repo just sits there, unread, until it is. If
you know a repo needs to actually pick up work now, call start_agent on
it yourself rather than assuming dispatch alone is enough or waiting for
a human to click Start in the dashboard.

You don't have to wait for the user to run a scan to make a repo known.
If you already know a repo exists — you just created it, or you're
certain of its name and (if it has one yet) local path — call add_repo
directly instead of asking for discover_local_repos/discover_github_repos
to be run. Those two are for bulk/unknown sync; add_repo is for the one
repo you already know about right now.

If list_repos looks incomplete or stale in bulk — several repos you know
exist aren't there, or ones that should have a local clone by now still
show cwd: '' — call discover_local_repos (fast, no network, finds what's
already cloned) or discover_github_repos (needs \`gh\`, also finds repos
that exist remotely but aren't cloned yet) to resync, rather than
assuming this tool's picture is current. It only tracks what it's been
told about; nothing here watches GitHub or the filesystem on its own.

Before dispatching to a repo you don't already know, check list_repos'
summary field first — it's an agent-authored self-introduction (what the
repo is, its stack, its conventions, current git state), populated
automatically the first time a repo is started. Empty summary usually
means the repo has never been started, not that it has nothing to say;
call refresh_repo_summary to get one without waiting on other work.

Before dispatching real implementation work, critique the requirement
first — is it actually sound, does it conflict with what a repo's
summary says about its current state, is anything ambiguous enough to
ask about (ask_human, or a finding if it's not blocking) — rather than
dispatching straight to implementation and finding out the hard way.
Once it holds up, write the plan as real tasks via upsert_task rather
than only describing it in a dispatch or your own reply — a plan that
only exists as prose is invisible to anyone else looking at the
dashboard, and gets stale the moment reality diverges from what you
said would happen. Update it with upsert_task as the plan itself
changes, not just once at the start.

Critique → plan → implement → close → done is a requirement's own
lifecycle, not a repo's — a single requirement often spans several
repos at once, and a repo you're tracking will carry many different
requirements over its lifetime, one after another. There's deliberately
no per-repo "stage" field to set: that would only be right for the one
requirement currently in flight there, and wrong the moment a second
one starts or the first one finishes. The plan's own progress already
has real, granular tracking — each task's status in upsert_task/
get_tasks (todo/active/blocking/done) — so "is the plan done" is never
a single field either, it's "are its tasks done." If you want a durable
record of a requirement moving between these stages, log it with
add_finding (scoped to the relevant repo, or 'coordinator' for
something cross-cutting) rather than reaching for a status field that
doesn't exist.

Typical loop: list_repos to see what's tracked and its status → dispatch
to hand a repo new work → list_open_escalations to see what's actually
blocked and needs you → resolve_escalation to unblock it. Repo ids are
short slugs (list_repos shows them), not full repo names.`;

const server = new McpServer(
  {
    name: "multi-repo-agent-control-center",
    version: "0.0.1",
  },
  { instructions: SERVER_INSTRUCTIONS }
);

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

server.tool(
  "list_repos",
  "List every repo the control center tracks, with its current agent status (running/idle/needsHuman/stopped), phase, paused-queue flag, and its summary — an agent-authored self-introduction (what the repo is, stack, conventions, current git state), populated automatically the first time the repo is started. summary is '' if the repo has never been started; call refresh_repo_summary to get one without waiting, or to refresh a stale one.",
  {},
  async () => text(db.listRepos())
);

server.tool(
  "get_repo_status",
  "Full status for one repo: its metadata (including summary — see list_repos), its dispatch queue, and its open escalation if it's currently blocked (agent_status: needsHuman).",
  { repoId: z.string().describe("The repo's short id, e.g. 'disp' for github-app-dispatcher — see list_repos.") },
  async ({ repoId }) => {
    const repo = db.getRepo(repoId);
    if (!repo) return text({ error: `no such repo: ${repoId}` });
    return text({
      ...repo,
      dispatches: db.listDispatches(repoId),
      escalation: db.openEscalationForRepo(repoId),
      recentLogs: db.recentLogs(repoId, 15),
    });
  }
);

server.tool(
  "discover_github_repos",
  "Resync the tracked repo list against real GitHub state (via `gh`, not a token this tool manages itself) and check which ones have a local clone this machine can actually run against. Adds newly-found repos (including ones that exist on GitHub but aren't cloned locally yet — flagged via cwd: '', not hidden), updates cwd for ones that are now locally cloned, and never blanks a repo's existing cwd just because this pass didn't find it (it may have looked in the wrong place). Needs `gh` installed and network access; see discover_local_repos for a network-free alternative that only finds what's already checked out. This only tells you a repo EXISTS and is runnable — it does not know what a repo does; that's what summary (see list_repos) is for, and it only populates once a repo with a real cwd is started.",
  {
    owner: z.string().optional().describe("GitHub org or user to list repos for. Omit to reuse whatever was used last time."),
    codeRoot: z.string().optional().describe("Local directory to look for clones in (checked as <codeRoot>/<repo-name>). Omit to reuse whatever was used last time."),
  },
  async ({ owner, codeRoot }) => {
    const resolvedOwner = owner || db.getMeta("github_owner");
    const resolvedCodeRoot = codeRoot || db.getMeta("code_root");
    if (!resolvedOwner || !resolvedCodeRoot) {
      return text({ error: "owner and codeRoot are required the first time — no prior discovery run to reuse them from." });
    }
    try {
      return text(runGithubDiscoveryAndUpsert(db, resolvedOwner, resolvedCodeRoot));
    } catch (err: any) {
      return text({ error: `discovery failed: ${err?.message ?? err}` });
    }
  }
);

server.tool(
  "discover_local_repos",
  "Resync the tracked repo list against what's actually on disk: scans codeRoot for directories that are git repos and tracks each one, using its directory name as both id and repo name. No network, no `gh`, no auth — finds only what's already cloned, nothing that exists remotely but isn't checked out (use discover_github_repos for that). The simpler default when you just want 'whatever's already sitting next to this one.'",
  { codeRoot: z.string().optional().describe("Directory to scan for git repos. Omit to reuse whatever was used last time.") },
  async ({ codeRoot }) => {
    const resolvedCodeRoot = codeRoot || db.getMeta("code_root");
    if (!resolvedCodeRoot) {
      return text({ error: "codeRoot is required the first time — no prior discovery run to reuse it from." });
    }
    try {
      return text(runLocalDiscoveryAndUpsert(db, resolvedCodeRoot));
    } catch (err: any) {
      return text({ error: `discovery failed: ${err?.message ?? err}` });
    }
  }
);

server.tool(
  "refresh_repo_summary",
  "Queue a fresh self-introspection pass for a repo (see list_repos' summary field) — it jumps ahead of anything else queued and runs next, before other dispatches. Use this when a repo's summary is stale (real changes have landed since it was written) or missing (never started).",
  { repoId: z.string().describe("The repo's short id — see list_repos.") },
  async ({ repoId }) => {
    const repo = db.getRepo(repoId);
    if (!repo) return text({ error: `no such repo: ${repoId}` });
    return text(db.queueIntroDispatch(repoId, INTRO_PROMPT));
  }
);

server.tool(
  "dispatch",
  "Send a proactive message to a repo's agent — a design adjustment, a clarification request, a new task. This is NOT for answering a live permission escalation (use resolve_escalation for that) and is NOT itself a live interrupt: it's queued and the repo's agent picks it up when free. Write it the way you'd brief a person: context, the task, constraints, what done looks like.",
  {
    repoId: z.string().describe("The repo's short id — see list_repos."),
    text: z.string().describe("The full dispatch prompt."),
  },
  async ({ repoId, text: body }) => {
    const repo = db.getRepo(repoId);
    if (!repo) return text({ error: `no such repo: ${repoId}` });
    if (repo.agent_status === "needsHuman") {
      const esc = db.openEscalationForRepo(repoId);
      return text({
        error: `${repo.repo} is blocked on a live escalation (kind: ${esc?.kind ?? "unknown"}) — this dispatch has been queued, but it will NOT run until that's resolved. Call resolve_escalation on escalation ${esc?.id ?? "?"} first.`,
        queued: db.queueDispatch(repoId, body),
      });
    }
    if (repo.agent_status === "stopped") {
      return text({
        error: `${repo.repo} is stopped — this dispatch has been queued, but nothing will pick it up until its agent is started. Call start_agent on ${repoId} to actually run it.`,
        queued: db.queueDispatch(repoId, body),
      });
    }
    return text(db.queueDispatch(repoId, body));
  }
);

server.tool(
  "add_repo",
  "Register a single repo you already know about — you just created it, or you're certain of its name and path — without running a full discovery scan. If cwd is omitted, or given but not actually a git repo there, the repo is still tracked (cwd: '', not runnable yet) rather than rejected; call this again once it has a real local clone, or use discover_local_repos/discover_github_repos.",
  {
    repo: z.string().describe("The repo's real name, e.g. 'e2e-tests'."),
    cwd: z.string().optional().describe("Local path to the clone, if one exists yet."),
    phase: z.string().optional().describe("Free-text phase/role label, shown in the dashboard."),
  },
  async ({ repo, cwd, phase }) => {
    const id = db.findRepoIdByName(repo) ?? repo;
    const existing = db.getRepo(id);
    let resolvedCwd = existing?.cwd || "";
    let warning: string | null = null;
    if (cwd) {
      if (fs.existsSync(path.join(cwd, ".git"))) {
        resolvedCwd = cwd;
      } else {
        warning = `${cwd} doesn't look like a git repo (no .git found) — tracked with cwd: '' instead.`;
      }
    }
    db.upsertRepo({
      id,
      repo,
      cwd: resolvedCwd,
      phase: phase || existing?.phase || (resolvedCwd ? "" : "Added — not cloned locally"),
      prs: existing?.prs || "—",
      agent_status: existing?.agent_status || "stopped",
    });
    return text({ ...db.getRepo(id), warning });
  }
);

server.tool(
  "start_agent",
  "Start a repo's agent so it actually begins picking up its queued dispatches — a stopped repo's queue just sits there untouched. Also queues that repo's first self-introduction pass if it hasn't had one (see list_repos' summary field). Fails if the repo has no local clone (cwd: '') — use add_repo with a real cwd, or discover_local_repos/discover_github_repos, first.",
  { repoId: z.string().describe("The repo's short id — see list_repos.") },
  async ({ repoId }) => {
    try {
      return text(startAgent(db, repoId));
    } catch (err: any) {
      return text({ error: err?.message ?? String(err) });
    }
  }
);

server.tool(
  "stop_agent",
  "Stop a repo's agent — it stops picking up new dispatches until started again. Does not cancel or interrupt anything already running.",
  { repoId: z.string().describe("The repo's short id — see list_repos.") },
  async ({ repoId }) => {
    try {
      return text(stopAgent(db, repoId));
    } catch (err: any) {
      return text({ error: err?.message ?? String(err) });
    }
  }
);

server.tool(
  "list_open_escalations",
  "List every repo currently blocked on a real permission escalation (agent_status: needsHuman) across the whole tracked set — the 'what needs me right now' view.",
  {},
  async () => {
    const open = db
      .listRepos()
      .filter((r) => r.agent_status === "needsHuman")
      .map((r) => ({ repo: r, escalation: db.openEscalationForRepo(r.id) }));
    return text(open);
  }
);

server.tool(
  "resolve_escalation",
  "Answer a repo's live permission escalation, unblocking its agent to resume immediately. Pick one of the escalation's own option labels verbatim when one fits (e.g. 'Approve', 'Decline'), or give free text for anything not covered — it's handed back to the agent as the reason for a denial/adjustment, not as a silent approval.",
  {
    escalationId: z.string(),
    answer: z.string().describe("One of the escalation's option labels, or free text."),
  },
  async ({ escalationId, answer }) => {
    db.resolveEscalation(escalationId, answer);
    return text({ ok: true });
  }
);

server.tool(
  "list_findings",
  "The durable decision log: calls an agent made autonomously along the way, and items it's surfaced that are waiting on a human (by: 'wait'). This is a record, not a live channel — answering one here just logs the decision; relaying it back to the agent is a separate dispatch.",
  {},
  async () => text(db.listFindings())
);

server.tool(
  "answer_finding",
  "Record a human decision against a logged finding that's waiting on one. Does not itself notify the agent — follow up with `dispatch` to actually hand the decision back.",
  { findingId: z.string(), answer: z.string() },
  async ({ findingId, answer }) => {
    db.answerFinding(findingId, answer);
    return text({ ok: true });
  }
);

server.tool(
  "add_finding",
  "Log a new finding or scoping note against a repo (or 'coordinator' for cross-cutting items) — for the coordinator's own observations, not just agent-surfaced ones.",
  { repoId: z.string(), text: z.string(), phase: z.string().optional() },
  async ({ repoId, text: body, phase }) => text(db.addFinding(repoId, body, phase ?? "", "human", "watch", "Triage — not yet assessed"))
);

server.tool(
  "get_tasks",
  "The rollout gantt: every task, its repo, hours estimate, status, and dependencies — the same data the dashboard renders as a gantt chart.",
  {},
  async () => text(db.listTasks())
);

server.tool(
  "upsert_task",
  "Create or update one task on the implementation plan (the gantt). Reusing an existing id updates that task in place rather than creating a duplicate — this is how a plan gets kept current as work actually progresses, not just written once and left stale. See get_tasks for the current scale/ids before adding dependents.",
  {
    id: z.string().describe("Stable id for this task. Reuse it on later calls to update rather than duplicate."),
    repo: z.string().describe("Repo name shown on the gantt (a display label, not checked against tracked repos)."),
    task: z.string().describe("Short description shown on the gantt bar."),
    startH: z.number().describe("Start offset in hours from the plan's own zero point — not a calendar date. Check existing tasks (get_tasks) for the current scale before picking one."),
    durH: z.number().describe("Duration in hours. Use 0 for a milestone."),
    status: z.enum(["todo", "active", "blocking", "done"]).optional().describe("Defaults to 'todo'."),
    deps: z.array(z.string()).optional().describe("Ids of tasks this one depends on — drawn as dependency arrows on the gantt."),
    milestone: z.boolean().optional(),
  },
  async ({ id, repo, task, startH, durH, status, deps, milestone }) => {
    db.upsertTask({
      id,
      repo,
      task,
      start_h: startH,
      dur_h: durH,
      status: status ?? "todo",
      deps: deps ?? [],
      milestone: milestone ? 1 : 0,
    });
    return text(db.listTasks().find((t) => t.id === id));
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch((err) => {
  process.stderr.write(`control-center MCP server failed to start: ${err?.message ?? err}\n`);
  process.exit(1);
});
