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
import { Db, FindingBy } from "./db";
import { INTRO_PROMPT } from "./prompts";
import { runGithubDiscoveryAndUpsert, runLocalDiscoveryAndUpsert } from "./discover";
import { startAgent, stopAgent } from "./repoActions";

function parseArg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dbPath = parseArg("--db", `${process.env.HOME}/.control-center/control-center.db`);
const db = new Db(dbPath);

// The project-level addendum a coordinator session wrote after actually
// running this lifecycle once — kept as its own constant (not just inline
// in SERVER_INSTRUCTIONS) so it can be served verbatim by get_methodology.
// That matters because the MCP client hosting a coordinator session is free
// to truncate a long `instructions` string before it ever reaches the
// model — a tool call cannot be silently dropped the same way, so this is
// the addendum's actual guarantee of reaching the coordinator, not the
// embedded copy below.
const METHODOLOGY_TEXT = `A requirement moves through five phases: Critique → Plan → Implement → Closing →
Done. Each phase has a gate — a specific thing that must exist in the control
center's own state before advancing — not just "nothing left in the dispatch
queue." A phase indicator that advances on queue-empty/no-escalations alone is
reporting a false signal; these gates exist to prevent that.

As of this version, the phases below are no longer just guidance: set_requirement_phase,
upsert_task, and dispatch enforce their own gates server-side and refuse the call
with an explanatory error when a gate isn't met, rather than silently accepting a
premature transition. The descriptions here explain *why* each gate exists; the
tools themselves are what actually stop you.

Critique — the requirement is researched and understood before any repo work
starts. Record open questions and resolved ambiguities as add_finding against
'coordinator' — not only in chat — so they survive across sessions. Use
AskUserQuestion for anything only the requirement owner can decide (naming,
stack choices, scope boundaries). Gate (enforced): set_requirement_phase refuses
"plan" unless at least one add_finding has been logged for this requirement.

Plan — the implementation plan, with cross-repo dependencies, is captured in
the control center's task graph. Use upsert_task for every step, across every
repo involved. Every task's task text must state its own test requirement
alongside the work — e.g. "CRUD endpoints for todos — tests: pytest against
real Postgres hitting all 4 routes", not just "CRUD endpoints." Encode
cross-repo ordering via deps, not assumed sequencing. Gate (enforced):
upsert_task itself refuses to write a non-milestone task whose text doesn't
mention a test; set_requirement_phase refuses "implement" unless at least one
task has been written for this requirement.

Implement — code is implemented and individual steps are completed. Dispatch
each step with full context (contract, constraints, what done looks like) —
write it like a brief to a colleague who has no prior context. Mark a task
done in upsert_task only after reading the actual dispatch response and the
evidence it claims (test output, files, commits) — not on state: sent /
queue-empty alone. If an agent's own verification stood in for real infra
(e.g. SQLite instead of Postgres, mocks instead of a live API), that caveat
must be carried forward explicitly (e.g. via add_finding), not dropped when
the task flips to done — the server can check a status field, not whether the
evidence behind it is real. Gate (enforced): set_requirement_phase refuses
"closing" unless every task for this requirement has status "done".

Closing — an end-to-end test exercises the combined system, not each repo's
isolated suite. This step belongs to the coordinator (or a dedicated
integration task), not any single repo's agent — no one repo can validate a
cross-repo contract by itself. Advancing to Closing requires a passing
combined-system run, with its output attached as an add_finding. If the
environment cannot run it (missing infra, permissions, access), that blocker
is itself an open finding — Closing is not satisfied, regardless of how idle
the dispatch queues look. Gate (enforced): set_requirement_phase refuses
"done" unless at least one add_finding has been logged since Closing began.

Done — reachable only when (1) every task in Plan is done (server-checked
before Closing was reachable), and (2) a finding logged during Closing
documents the outcome (server-checked, though it cannot verify the finding's
content describes an actually-passing run — that part is still on you).
Gate (enforced): only reachable from "closing", one step at a time.

Complementary practices (session-side, not control-center primitives) — these
aren't control-center calls, but they feed the phases above and should run
alongside them: Critique/Plan benefit from plan-mode-style research before
touching any repo, but the output of that research must land in
add_finding/upsert_task, or it's lost the moment the session ends. Implement
should apply "trust but verify": an agent's summary of what it did is a
claim, not evidence — read the actual diff/test output before marking a task
done. None of the server-side gates above can verify THAT part — they check
that a finding or a done-flag exists, not that you told the truth in it.`;

const SERVER_INSTRUCTIONS = `Control center for coding-agent sessions running across multiple repos.

Before your first dispatch or upsert_task in a session, call get_methodology —
it returns the phase-by-phase gates verbatim, and survives even if this
instructions string itself gets truncated before reaching you.
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
This is enforced, not just advised: dispatch refuses to queue anything
while no requirement is in flight (get_requirement_phase returns phase:
null), so call set_requirement_phase({phase:'critique'}) before your
first real dispatch of a session. Once it holds up, write the plan as
real tasks via upsert_task rather than only describing it in a dispatch
or your own reply — a plan that only exists as prose is invisible to
anyone else looking at the dashboard, and gets stale the moment reality
diverges from what you said would happen. upsert_task itself refuses a
non-milestone task whose text doesn't state a test requirement. Update
the plan with upsert_task as it changes, not just once at the start.

Critique → plan → implement → closing → done is a requirement's own
lifecycle, not a repo's — a single requirement often spans several
repos at once, and a repo you're tracking will carry many different
requirements over its lifetime, one after another. That's why
set_requirement_phase/get_requirement_phase track ONE current
requirement, not a per-repo field: there is deliberately no dashboard
control for this and no other way to set it — only you, the
coordinator, ever should. See the full lifecycle addendum below for
what actually gates each phase; it is not "nothing left in the queue."
This is a single slot (one requirement in flight at a time as tracked
here, not a queue of many) — if you're picking up a new requirement,
set the phase back to 'critique' deliberately rather than assuming a
fresh start.

---
The following is a project-level addendum a coordinator session wrote
after actually running this lifecycle once, verbatim, because it
reflects what the gates need to mean in practice better than a
first-pass description would (call get_methodology for this same text
if it looks cut off below):

${METHODOLOGY_TEXT}
---

Nothing pushes a dispatch's result back to you when it lands — there is
no notification reaching a coordinator session today. Confirmed, not
just assumed: MCP's own server-initiated notification primitives don't
reach a client that's idle at a prompt or has ended its turn, only one
that's actively mid-turn or polls again later — this server has no way
around that, and neither does anything else in this environment. If you
dispatch and then end your turn, you will not hear about it finishing.
Either wait and poll (get_repo_status for one repo, list_recent_activity
for all of them at once) before ending your turn if the result actually
matters to what happens next, or say explicitly that you're not waiting
and how you intend to check back — don't let a dispatch quietly become
fire-and-forget by accident. get_cruise_control/set_cruise_control (also
a dashboard toggle) is the closest thing to automating that polling: on,
every dispatch result carries a reminder to check get_tasks and queue
the next unblocked task yourself — still not a real background loop,
since it only has an effect the next time you're actively calling a
tool anyway, but it keeps that reminder from depending on you
remembering it every single time.

Typical loop: get_methodology once per session if you haven't already →
get_requirement_phase to see where things actually stand → list_repos to
see what's tracked and its status → dispatch to hand a repo new work
(refused if requirement_phase is null) → list_recent_activity or
get_repo_status to see what's actually landed → list_open_escalations to
see what's blocked and needs you → resolve_escalation to unblock it →
set_requirement_phase once you believe the next phase's gate is met (the
call itself re-verifies and refuses with the specific reason if it
isn't). Repo ids are short slugs (list_repos shows them), not full repo
names.`;

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

const REQUIREMENT_PHASES = ["critique", "plan", "implement", "closing", "done"] as const;
const PHASE_ORDER: readonly string[] = REQUIREMENT_PHASES;

server.tool(
  "get_methodology",
  "Return the full requirement lifecycle methodology verbatim — the critique/plan/implement/closing/done gates that set_requirement_phase, upsert_task, and dispatch enforce server-side. Call this before your first dispatch or upsert_task in a session (or any time a gate rejects a call and you want the full reasoning behind it, not just that call's short error). This exists as its own tool specifically because a long `instructions` string can be truncated by the client before it reaches you — a tool call can't be silently dropped the same way.",
  {},
  async () => text({ methodology: METHODOLOGY_TEXT })
);

server.tool(
  "get_requirement_phase",
  "Read the current requirement's phase (critique/plan/implement/closing/done) and title, if set. This tracks ONE requirement at a time — not per-repo, not a queue of many. Returns phase: null if nothing has been set yet (e.g. a fresh control center, or between requirements) — dispatch will refuse to run until you call set_requirement_phase({phase:'critique'}). See get_methodology for what actually gates each phase transition.",
  {},
  async () =>
    text({
      phase: db.getMeta("requirement_phase"),
      title: db.getMeta("requirement_title"),
    })
);

server.tool(
  "set_requirement_phase",
  "Set the current requirement's phase. This is the ONLY way it changes — there is no dashboard control for it, deliberately, so it never reflects a click instead of the coordinator's own judgment that a phase's gate is actually satisfied. Phases advance one step at a time (critique → plan → implement → closing → done); each forward step is gated server-side (see get_methodology) and the call is REFUSED with an explanatory error, not silently accepted, if that phase's gate isn't met yet — do not call this because the dispatch queue emptied out or escalations cleared. Passing phase: 'critique' is always allowed and is how you start a new requirement (starting one after a previous one reached 'done'? set this back to 'critique' explicitly — it does not reset itself); doing so from any phase other than null/'critique' starts a fresh requirement scope, so findings/tasks logged for the previous requirement no longer count toward this one's gates.",
  {
    phase: z.enum(REQUIREMENT_PHASES),
    title: z.string().optional().describe("Short label for what requirement this is, for anyone else reading the control center's state. Omit to leave the existing title unchanged."),
  },
  async ({ phase, title }) => {
    const current = db.getMeta("requirement_phase");

    // Resetting to 'critique' is the one always-allowed move — it's the
    // explicit "starting a new requirement" escape hatch the methodology
    // calls for, and also the only legal first move from a fresh DB
    // (current === null). Re-affirming 'critique' while already there
    // (e.g. just to update the title) does NOT bump the requirement scope —
    // only an actual transition INTO critique from somewhere else does.
    if (phase === "critique") {
      if (current && current !== "critique") db.bumpRequirementId();
      db.setMeta("requirement_phase", "critique");
      if (title) db.setMeta("requirement_title", title);
      return text({ phase: "critique", title: db.getMeta("requirement_title"), requirementId: db.currentRequirementId() });
    }

    if (!current) {
      return text({
        error: `No requirement is in flight — call set_requirement_phase({phase:"critique"}) first. Jumping straight to "${phase}" is exactly the false signal these gates exist to prevent; see get_methodology.`,
      });
    }

    if (phase === current) {
      if (title) db.setMeta("requirement_title", title);
      return text({ phase: current, title: db.getMeta("requirement_title") });
    }

    const curIdx = PHASE_ORDER.indexOf(current);
    const targetIdx = PHASE_ORDER.indexOf(phase);
    if (targetIdx !== curIdx + 1) {
      return text({
        error: `Cannot go from "${current}" to "${phase}" — phases advance one step at a time (${PHASE_ORDER.join(" → ")}). Call get_methodology if it's unclear why.`,
      });
    }

    const reqId = db.currentRequirementId();

    if (phase === "plan") {
      const findingCount = db.countFindingsForRequirement(reqId);
      if (findingCount < 1) {
        return text({
          error: `Critique gate not met: no add_finding has been logged yet for this requirement. Record the open questions/ambiguities you resolved (repoId 'coordinator' works for cross-cutting ones) before advancing to Plan — see get_methodology.`,
        });
      }
    }

    if (phase === "implement") {
      const taskCount = db.tasksForRequirement(reqId).length;
      if (taskCount < 1) {
        return text({
          error: `Plan gate not met: no tasks exist yet for this requirement. Use upsert_task for every step across every repo involved before advancing to Implement — see get_methodology.`,
        });
      }
    }

    if (phase === "closing") {
      const tasks = db.tasksForRequirement(reqId);
      const notDone = tasks.filter((t) => t.status !== "done");
      if (tasks.length < 1 || notDone.length > 0) {
        return text({
          error: `Implement gate not met: ${notDone.length} of ${tasks.length} task(s) for this requirement are not "done" — ${
            notDone.map((t) => t.id).join(", ") || "(none yet)"
          }. Mark a task done only after reading real evidence for it (test output, files, commits), not on state:sent alone — see get_methodology.`,
        });
      }
    }

    if (phase === "done") {
      const since = db.getMeta("closing_entered_at") ?? "";
      const closingFindings = db.countFindingsForRequirement(reqId, since);
      if (closingFindings < 1) {
        return text({
          error: `Closing gate not met: no add_finding has been logged since Closing began. Attach the passing combined end-to-end run's output as an add_finding first — see get_methodology.`,
        });
      }
    }

    if (phase === "closing") db.markClosingEntered();

    db.setMeta("requirement_phase", phase);
    if (title) db.setMeta("requirement_title", title);
    return text({ phase: db.getMeta("requirement_phase"), title: db.getMeta("requirement_title") });
  }
);

server.tool(
  "get_cruise_control",
  "Read whether cruise control is on. When on, every successful dispatch's result includes a reminder to keep driving the plan yourself (check get_tasks, dispatch the next unblocked task) instead of stopping after one step. This is a plain operational toggle — settable from the dashboard (a button in the header) or here, either side, unlike set_requirement_phase which is deliberately coordinator-only.",
  {},
  async () => text({ cruiseControl: db.getMeta("cruise_control") === "on" })
);

server.tool(
  "set_cruise_control",
  "Turn cruise control on or off. On: every dispatch result carries a reminder to keep going — check get_tasks yourself and queue the next unblocked task(s) without being asked, until the plan is done or something needs a human. This cannot make the control center itself wake you up later — MCP has no way to push a result back into an idle session, so the reminder only has an effect the next time you're actively calling dispatch anyway. Off is the default; turn it back off once you'd rather drive one step at a time yourself.",
  { on: z.boolean() },
  async ({ on }) => {
    db.setMeta("cruise_control", on ? "on" : "off");
    return text({ cruiseControl: on });
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
  "Send a proactive message to a repo's agent — a design adjustment, a clarification request, a new task. This is NOT for answering a live permission escalation (use resolve_escalation for that) and is NOT itself a live interrupt: it's queued and the repo's agent picks it up when free. Write it the way you'd brief a person: context, the task, constraints, what done looks like. This call returns as soon as the dispatch is QUEUED, not when it's done — the real work can take minutes. Nothing pushes the result back to you; check for it yourself later via get_repo_status(repoId) (its dispatches array, state: 'sent' with a non-empty response) or list_recent_activity (across every repo at once, 'responded' entries). REFUSED (nothing queued) while no requirement is in flight — call set_requirement_phase({phase:'critique'}) first; this is the enforced form of 'critique the requirement before dispatching real implementation work' from get_methodology.",
  {
    repoId: z.string().describe("The repo's short id — see list_repos."),
    text: z.string().describe("The full dispatch prompt."),
  },
  async ({ repoId, text: body }) => {
    const repo = db.getRepo(repoId);
    if (!repo) return text({ error: `no such repo: ${repoId}` });
    if (!db.getMeta("requirement_phase")) {
      return text({
        error: `No requirement is in flight — call set_requirement_phase({phase:"critique"}) before dispatching real work to ${repo.repo}. Nothing was queued. See get_methodology for why.`,
      });
    }
    // Cruise control (dashboard toggle, or set_cruise_control): when on,
    // every successful dispatch reminds the coordinator to keep driving
    // the plan itself rather than stopping after one step — this is the
    // ONLY mechanism available for that. MCP is pull-only from the
    // coordinator's side; there is no way for this server to wake an idle
    // session or push it a later result, so "check periodically" can only
    // ever mean "the coordinator, prompted here, chooses to check again
    // soon during its own active turn" — a repeated nudge on every
    // dispatch result, not a real background loop. See README.md's
    // "Cruise control" section for the full reasoning.
    const cruiseControlNote =
      db.getMeta("cruise_control") === "on"
        ? "Cruise control is ON: after this lands, call get_tasks yourself and dispatch() the next unblocked task(s) for this requirement (every dep already 'done', this task still 'todo') without waiting to be asked. Keep checking back (list_recent_activity or get_repo_status) rather than ending your turn, until every task is 'done' or something needs you — an open escalation, a finding logged with by:'wait', or a gate refusal from set_requirement_phase/upsert_task."
        : undefined;
    if (repo.agent_status === "needsHuman") {
      const esc = db.openEscalationForRepo(repoId);
      return text({
        error: `${repo.repo} is blocked on a live escalation (kind: ${esc?.kind ?? "unknown"}) — this dispatch has been queued, but it will NOT run until that's resolved. Call resolve_escalation on escalation ${esc?.id ?? "?"} first.`,
        queued: db.queueDispatch(repoId, body),
        ...(cruiseControlNote ? { cruiseControlNote } : {}),
      });
    }
    if (repo.agent_status === "stopped") {
      return text({
        error: `${repo.repo} is stopped — this dispatch has been queued, but nothing will pick it up until its agent is started. Call start_agent on ${repoId} to actually run it.`,
        queued: db.queueDispatch(repoId, body),
        ...(cruiseControlNote ? { cruiseControlNote } : {}),
      });
    }
    const queued = db.queueDispatch(repoId, body);
    return text(cruiseControlNote ? { ...queued, cruiseControlNote } : queued);
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
  "Log a new finding or scoping note against a repo (or 'coordinator' for cross-cutting items) — for the coordinator's own observations, not just agent-surfaced ones. Two shapes: an FYI record of a decision you already made yourself (the default — shows as 'by: AI', never counts toward the dashboard's 'waiting on a human' count), or something that genuinely can't proceed without a human's call (waitingOnHuman: true — shows an Answer… button, counts toward that count, answerable via answer_finding). Don't set waitingOnHuman for routine scope calls you're comfortable making autonomously — that used to be forced on every finding regardless, which made logged-and-already-decided items look unresolved.",
  {
    repoId: z.string(),
    text: z.string(),
    phase: z.string().optional(),
    waitingOnHuman: z
      .boolean()
      .optional()
      .describe(
        "true if this genuinely blocks on a human decision; false/omitted (the default) for an FYI record of something you decided yourself."
      ),
  },
  async ({ repoId, text: body, phase, waitingOnHuman }) => {
    const by: FindingBy = waitingOnHuman ? "wait" : "ai";
    const disposition = waitingOnHuman ? "Waiting on a human decision" : "Logged — decided autonomously";
    return text(db.addFinding(repoId, body, phase ?? "", by, "watch", disposition));
  }
);

server.tool(
  "get_tasks",
  "The rollout gantt: every task, its repo, hours estimate, status, and dependencies — the same data the dashboard renders as a gantt chart.",
  {},
  async () => text(db.listTasks())
);

server.tool(
  "list_recent_activity",
  "The uniform 'has anything happened' feed across every repo at once — one entry each time a dispatch is actually sent, another when its response lands. Nothing pushes this to you (there is no notification mechanism reaching a coordinator session today, only the dashboard's own local UI); this is what you poll after dispatching somewhere, instead of separately calling get_repo_status per repo to check. Most recent first.",
  { limit: z.number().optional().describe("Max entries to return. Defaults to 100.") },
  async ({ limit }) => text(db.listLogEntries(limit ?? 100))
);

server.tool(
  "upsert_task",
  "Create or update one task on the implementation plan (the gantt). Reusing an existing id updates that task in place rather than creating a duplicate — this is how a plan gets kept current as work actually progresses, not just written once and left stale. See get_tasks for the current scale/ids before adding dependents. ENFORCED: a non-milestone task's `task` text must itself state a test requirement (e.g. \"CRUD endpoints for todos — tests: pytest against real Postgres hitting all 4 routes\") — a task whose text doesn't mention a test is refused outright, not written with a warning. Pass milestone: true for a checkpoint with no work/test of its own. Also refused while no requirement is in flight (see get_methodology) — call set_requirement_phase({phase:'critique'}) first.",
  {
    id: z.string().describe("Stable id for this task. Reuse it on later calls to update rather than duplicate."),
    repo: z.string().describe("Repo name shown on the gantt (a display label, not checked against tracked repos)."),
    task: z.string().describe("Short description shown on the gantt bar. Must state its own test requirement (e.g. '... — tests: ...') unless milestone is true — see this tool's own description."),
    startH: z.number().describe("Start offset in hours from the plan's own zero point — not a calendar date. Check existing tasks (get_tasks) for the current scale before picking one."),
    durH: z.number().describe("Duration in hours. Use 0 for a milestone."),
    status: z.enum(["todo", "active", "blocking", "done"]).optional().describe("Defaults to 'todo'."),
    deps: z.array(z.string()).optional().describe("Ids of tasks this one depends on — drawn as dependency arrows on the gantt."),
    milestone: z.boolean().optional(),
  },
  async ({ id, repo, task, startH, durH, status, deps, milestone }) => {
    if (!db.getMeta("requirement_phase")) {
      return text({
        error: `No requirement is in flight — call set_requirement_phase({phase:"critique"}) before planning tasks. Nothing was written.`,
      });
    }
    if (!milestone && !/test/i.test(task)) {
      return text({
        error: `Plan gate: "${task}" doesn't state a test requirement. Every non-milestone task's text must state its own test alongside the work (e.g. "... — tests: pytest against real Postgres hitting all 4 routes"), not just describe the work — see get_methodology. Add one and retry, or pass milestone: true if this is a checkpoint with no work of its own. Nothing was written.`,
      });
    }
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
