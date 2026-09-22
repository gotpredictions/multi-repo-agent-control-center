// The MCP protocol endpoint itself — built once by the daemon (server.ts)
// and served over one shared HTTP listener for every coordinator session,
// instead of being spawned as its own process per session (that was
// mcpServer.ts, now deleted). Every tool handler below reads/writes the
// same in-process Db map server.ts already owns, via the single `getDb`
// dependency — no IPC round trip, no second SQLite connection.
//
// Which database a given call sees is NOT a parameter any tool takes.
// It's ambient: server.ts's HTTP listener pulls `dbId` off the request's
// `?dbId=` query param and threads it through via AsyncLocalStorage for
// the duration of that one request, so `getDb()` (no args) always resolves
// to the right one, and two sessions with different dbIds served
// concurrently by the same daemon never see each other's data.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { Db, FindingBy } from "./db";
import { INTRO_PROMPT, learningsPrompt } from "./prompts";
import { runGithubDiscoveryAndUpsert, runLocalDiscoveryAndUpsert } from "./discover";
import { startAgent, stopAgent, applyCruiseControl } from "./repoActions";

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
stack choices, scope boundaries). Completing Critique also means writing a
real summary of what this requirement/feature actually IS (not just its
title) — this is what shows up in the dashboard and in list_databases/
select_database, so a human glancing at a list of databases (or a future
session picking one blind) can tell what each one was actually used for,
instead of an opaque id and a one-line title. It also means breaking the
requirement into a checklist — one entry per discrete item pulled out of the
source requirement (e.g. a spec doc's own bullet points), marking any item
that has more than one reasonable reading as ambiguous: true. This is what
Plan's own gate checks every task against later: a structural,
purely-existence check (a task maps to it) — it doesn't catch a checklist
item a task claims to cover but implements shallowly, only one nobody ever
wrote a task for at all. Every ambiguous item needs its own add_finding
({waitingOnHuman: true}) logging the interpretation you picked and why —
"front of frontends" (a real example: a literal-but-weaker reading vs.
genuine multi-repo micro-frontends were both plausible from the same
sentence, and that divergence itself was the signal it needed a human, not
a quiet FYI) is exactly the class of case this exists to catch, structurally,
rather than relying on you to notice in hindsight that something was
contentious.

{{AUTONOMOUS_DECISION_GUIDANCE}}

Gate (enforced): set_requirement_phase refuses "plan" unless at least
one add_finding has been logged for this requirement, summary and checklist
are both given on that same call, AND every ambiguous checklist item is
covered by at least one waitingOnHuman finding (checked as a count, not a
verified per-item link).

Plan — the implementation plan, with cross-repo dependencies, is captured in
the control center's task graph. Use upsert_task (or upsert_tasks for many at
once) for every step, across every repo involved, and set covers on a task to
the checklist item id(s) it addresses (see get_requirement_phase's checklist).
Every task's task text must state its own test requirement alongside the
work — e.g. "CRUD endpoints for todos — tests: pytest against real Postgres
hitting all 4 routes", not just "CRUD endpoints." A task must ALSO specify
its own contract up front — an OpenAPI spec, a DB schema, a queue message
format, a shared file/durable object's shape, whatever actually defines the
interface — rather than leaving an implementer to guess at another repo's
wire shape or reconcile mismatched assumptions after the fact; the one
exception is a repo-scaffold or pure debt/refactor task that doesn't cross a
service boundary or change an interface another repo depends on, which can
pass noContractNeeded: true instead. Encode cross-repo ordering via deps, not
assumed sequencing. Completing Plan (advancing to Implement) ALSO requires a
docs entry on that same set_requirement_phase call for every category
list_doc_categories currently returns — the inter-repo/component contracts
for this requirement as a whole, in markdown (mermaid fenced code blocks
render as real diagrams in the dashboard's Plan → Docs view; the seeded
'sequence' category is specifically for a fenced mermaid sequenceDiagram
block of this requirement's cross-repo call flow). Pass "None or Not Applicable" as
text for any category that genuinely doesn't apply; none can be left out.
The category list itself is configurable per database (add_doc_category/
remove_doc_category), seeded by default with schema/apis/messages/
file_structures/sequence/others — call list_doc_categories rather than
assuming that default list, since a database may have had categories
added or removed. Gate (enforced): upsert_task/upsert_tasks refuse to write
a non-milestone, non-exempt task whose text doesn't mention a test, or whose
contract is empty (unless noContractNeeded); set_requirement_phase refuses
"implement" unless at least one task exists, every checklist item has at
least one task covering it, and every configured doc category has an entry.
If an operator has separately turned on the (off-by-default) approval gate
for this requirement, satisfying all of that still doesn't start Implement
automatically — see Implement below.

Implement — code is implemented and individual steps are completed. If the
optional operator-approval gate is on for this requirement (off by default;
only a human can turn it on or off, from the dashboard — no MCP tool does
this), then even after every Plan gate above is satisfied,
set_requirement_phase({phase:'implement'}) does NOT move the phase — it's
held (get_requirement_phase's operatorGatePending: true) until a human
clicks Approve in the dashboard, and dispatch is refused in the meantime.
Retrying the same call just reports the hold; nothing further is needed from
the coordinator's side until it's approved. Dispatch
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
Reaching Done also requires your own lessons/decisionsToRecord/
futureImprovements on that same set_requirement_phase call — your overall
view of how the requirement went, not a repo-level detail. Once it succeeds,
the requirement is genuinely finished, not paused: every runnable repo
automatically gets one final dispatch asking it for the same three things
about the work IT did, and every repo's agent is stopped once that lands (or
immediately, for a repo with no local clone to run it against). All of it —
your submission and every repo's own — lands in the Learnings tab (also
reachable via list_learnings), so starting a new requirement afterward means
calling set_requirement_phase({phase:'critique'}) and starting repos again
deliberately, not assuming anything is still running.
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

// Spliced into METHODOLOGY_TEXT's {{AUTONOMOUS_DECISION_GUIDANCE}} — which
// variant, decided by cruise control's live state (see methodologyText),
// since it's the one existing per-requirement signal for how much a human
// is actively supervising this session right now. The operator-approval
// gate deliberately does NOT factor in here: it's a checkpoint before
// Implement starts, not a substitute for judgment about what to log
// during Critique/Plan, so the same criteria apply whether or not it's on.
const AUTONOMOUS_DECISION_GUIDANCE_CRUISE_ON = `Cruise control is on for this requirement: default to deciding autonomously and logging an FYI finding (add_finding with waitingOnHuman omitted/false, by:'ai') for anything you're comfortable calling yourself — that's the default, not the exception. Reserve waitingOnHuman for a genuine blocker.`;

const AUTONOMOUS_DECISION_GUIDANCE_CRITERIA = `Cruise control is off for this requirement — lean toward logging waitingOnHuman rather than defaulting to a quiet FYI. First: if the requirement already states the answer, there's nothing to decide at all — just follow it, don't log anything either way. Past that, escalate to waitingOnHuman: true (instead of an autonomous FYI) when ANY of these hold:
- The requirement owner would care about the answer, not just the mechanism — naming, stack choices, scope boundaries, repo count/topology.
- It's hard to reverse or expensive to redo — e.g. single-repo vs. multi-repo micro-frontends, where undoing the choice later means re-splitting repos and CI, not editing a file.
- Disagreement between reasonable people is likely — if a plausible different reader of the same sentence could land on a different interpretation than the one you're about to pick, that divergence IS the signal, not a quiet FYI.
flagForReview: true on an otherwise-autonomous finding is the middle ground when none of these quite rise to a hard block, but it's still worth a human skimming before it hardens into a lot of downstream work.`;

function methodologyText(cruiseControlOn: boolean): string {
  const guidance = cruiseControlOn ? AUTONOMOUS_DECISION_GUIDANCE_CRUISE_ON : AUTONOMOUS_DECISION_GUIDANCE_CRITERIA;
  return METHODOLOGY_TEXT.replace("{{AUTONOMOUS_DECISION_GUIDANCE}}", guidance);
}

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

${methodologyText(false)}
---
Note: the paragraph above reflects cruise control being OFF, fixed at server
startup — this whole instructions string is static and can't reflect a
later toggle. call get_methodology any time for the live version instead
(it reads this requirement's actual current cruise-control state).

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

This server may be tracking more than one database — an opaque id, never
a file path, each one a fully separate set of repos/tasks/findings/
requirement state. Whichever id your registration URL was given (if any)
is just this session's STARTING point, not a permanent assignment: call
list_databases anytime to see every id known (each with its own
requirement phase/title and repo count, so you can tell them apart
without switching blind) and select_database to switch which one every
subsequent call in this session operates on. Naming an id that doesn't
exist yet creates it, empty.

Typical loop: get_methodology once per session if you haven't already →
list_databases if you're not sure which database you're pointed at or
need to switch → get_requirement_phase to see where things actually stand
→ list_repos to see what's tracked and its status → dispatch to hand a
repo new work (refused if requirement_phase is null) → list_recent_activity
or get_repo_status to see what's actually landed → list_open_escalations
to see what's blocked and needs you → resolve_escalation to unblock it →
set_requirement_phase once you believe the next phase's gate is met (the
call itself re-verifies and refuses with the specific reason if it
isn't). Repo ids are short slugs (list_repos shows them), not full repo
names.`;

const REQUIREMENT_PHASES = ["critique", "plan", "implement", "closing", "done"] as const;
const PHASE_ORDER: readonly string[] = REQUIREMENT_PHASES;

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

export interface DatabaseDescription {
  id: string;
  requirementPhase: string | null;
  requirementTitle: string | null;
  requirementSummary: string | null;
  repoCount: number;
}

export interface McpServerDeps {
  getDb: () => Db;
  // This session's currently-selected dbId — set once at session start
  // from the registration URL's ?dbId= (if any, else "default"),
  // switchable at runtime by this session calling select_database. One
  // MCP registration can serve any database over its lifetime this way,
  // not just whichever id happened to be in the URL.
  getDbId: () => string;
  setDbId: (dbId: string) => void;
  describeDatabases: () => DatabaseDescription[];
}

export function createMcpServer(deps: McpServerDeps): McpServer {
  const db = deps.getDb;

  const server = new McpServer(
    {
      name: "multi-repo-agent-control-center",
      version: "0.0.1",
    },
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.tool(
    "list_repos",
    "List every repo the control center tracks, with its current agent status (running/idle/needsHuman/stopped), phase, paused-queue flag, and its summary — an agent-authored self-introduction (what the repo is, stack, conventions, current git state), populated automatically the first time the repo is started. summary is '' if the repo has never been started; call refresh_repo_summary to get one without waiting, or to refresh a stale one.",
    {},
    async () => text(db().listRepos())
  );

  server.tool(
    "get_repo_status",
    "Full status for one repo: its metadata (including summary — see list_repos), its dispatch queue, and its open escalation if it's currently blocked (agent_status: needsHuman).",
    { repoId: z.string().describe("The repo's short id, e.g. 'disp' for github-app-dispatcher — see list_repos.") },
    async ({ repoId }) => {
      const repo = db().getRepo(repoId);
      if (!repo) return text({ error: `no such repo: ${repoId}` });
      return text({
        ...repo,
        dispatches: db().listDispatches(repoId),
        escalation: db().openEscalationForRepo(repoId),
        recentLogs: db().recentLogs(repoId, 15),
      });
    }
  );

  server.tool(
    "get_methodology",
    "Return the full requirement lifecycle methodology — the critique/plan/implement/closing/done gates that set_requirement_phase, upsert_task, and dispatch enforce server-side, plus the live autonomous-decision guidance for exactly this requirement (it depends on cruise control's current on/off state — see the Critique section, unlike the static instructions string this server was registered with, which can't reflect a later toggle). Call this before your first dispatch or upsert_task in a session, again after cruise control changes, or any time a gate rejects a call and you want the full reasoning behind it.",
    {},
    async () => text({ methodology: methodologyText(db().getMeta("cruise_control") === "on") })
  );

  server.tool(
    "list_databases",
    "List every database this daemon currently knows about, with each one's requirement phase/title/summary and repo count — enough to tell, at a glance, which one you actually want (and what it was actually used for) without switching into each to check. summary is null until that database's requirement completes Critique (see get_methodology). Use with select_database.",
    {},
    async () => text({ databases: deps.describeDatabases(), current: deps.getDbId() })
  );

  server.tool(
    "select_database",
    "Switch which database this session's tool calls operate on, for the rest of this session — an opaque id, never a file path (the daemon resolves it to a file itself). Lets one MCP registration serve any database instead of being fixed to whichever id (if any) was in the registration URL. If the id doesn't exist yet, it's created empty (same as a brand-new database would be). See list_databases for what's already known before picking one blind.",
    { dbId: z.string().describe("The database id to switch to, e.g. 'default' or a team/project label.") },
    async ({ dbId }) => {
      try {
        deps.setDbId(dbId);
        deps.getDb(); // touch it now so an invalid id (see the daemon's dbId pattern) surfaces here, not on the next unrelated call
        return text({ dbId, ok: true });
      } catch (err: any) {
        return text({ error: err?.message ?? String(err) });
      }
    }
  );

  server.tool(
    "get_requirement_phase",
    "Read the current requirement's phase (critique/plan/implement/closing/done), title, summary, and checklist, if set. This tracks ONE requirement at a time — not per-repo, not a queue of many. Returns phase: null if nothing has been set yet (e.g. a fresh control center, or between requirements) — dispatch will refuse to run until you call set_requirement_phase({phase:'critique'}). operatorGateEnabled/operatorGatePending reflect the optional, dashboard-only approval gate between Plan and Implement (see set_requirement_phase) — if pending is true, dispatch is refused until a human approves in the dashboard, regardless of what phase says. See get_methodology for what actually gates each phase transition.",
    {},
    async () => {
      const d = db();
      const reqId = d.currentRequirementId();
      return text({
        phase: d.getMeta("requirement_phase"),
        title: d.getMeta("requirement_title"),
        summary: d.getMeta("requirement_summary"),
        checklist: d.checklistForRequirement(reqId),
        operatorGateEnabled: d.getMeta("operator_gate_enabled") === "on",
        operatorGatePending: d.getMeta("operator_gate_pending") === "on",
      });
    }
  );

  server.tool(
    "set_requirement_phase",
    "Set the current requirement's phase. This is the ONLY way it changes — there is no dashboard control for it, deliberately, so it never reflects a click instead of the coordinator's own judgment that a phase's gate is actually satisfied. Phases advance one step at a time (critique → plan → implement → closing → done); each forward step is gated server-side (see get_methodology) and the call is REFUSED with an explanatory error, not silently accepted, if that phase's gate isn't met yet — do not call this because the dispatch queue emptied out or escalations cleared. Passing phase: 'critique' is always allowed and is how you start a new requirement (starting one after a previous one reached 'done'? set this back to 'critique' explicitly — it does not reset itself); doing so from any phase other than null/'critique' starts a fresh requirement scope, so findings/tasks logged for the previous requirement no longer count toward this one's gates. Advancing to 'plan' (i.e. completing Critique) requires summary AND checklist (see those params). Advancing to 'implement' (i.e. completing Plan) requires every checklist item to have at least one task covering it (see upsert_task's covers param) AND a docs entry for every configured Plan → Docs category (call list_doc_categories to see the current list — pass \"None or Not Applicable\" for any that genuinely don't apply). If an operator has enabled the (off-by-default, dashboard-only) approval gate for this requirement, satisfying all of that doesn't immediately move to Implement — it's held until a human clicks Approve in the dashboard; dispatch is refused in the meantime. Reaching 'done' requires lessons/decisionsToRecord/futureImprovements (your own, for the requirement as a whole — see those params) and, as a side effect of the transition succeeding: queues a final 'what did you learn' dispatch to every runnable repo (recorded in the Learnings tab once it answers) and stops every repo's agent — Done means the requirement is finished, not paused.",
    {
      phase: z.enum(REQUIREMENT_PHASES),
      title: z.string().optional().describe("Short label for what requirement this is, for anyone else reading the control center's state. Omit to leave the existing title unchanged."),
      summary: z.string().optional().describe("Required when advancing to 'plan': a real description of what this requirement/feature actually is — what it does, why, its scope — not just the title. Shown in the dashboard and returned by list_databases/select_database. Omit on later calls to leave it unchanged."),
      checklist: z
        .array(
          z.object({
            text: z.string(),
            ambiguous: z
              .boolean()
              .optional()
              .describe(
                "True if this line has more than one reasonable reading — not 'I'm not sure what to build' in general, just 'a plausible different reader could land on a different interpretation than the one I'm about to pick'. Every ambiguous item needs a waitingOnHuman finding logging the interpretation you picked (and why) before advancing to 'plan' — see get_methodology's Critique section for the actual criteria."
              ),
          })
        )
        .optional()
        .describe(
          "Required when advancing to 'plan': one entry per discrete item pulled out of the requirement — the things a task can later declare it covers (see upsert_task's covers param). Advancing to 'implement' is refused if any item here has zero tasks covering it. This is a purely structural check (a mapping exists), not a check that the task actually implements it well — that's still Closing's job."
        ),
      docs: z
        .array(z.object({ categoryId: z.string(), text: z.string() }))
        .optional()
        .describe(
          "Required when advancing to 'implement': one entry per category currently returned by list_doc_categories (categoryId must match a category's id), each in markdown — mermaid code blocks supported and rendered in the dashboard's Plan → Docs view, which the seeded 'sequence' category is meant for (a ```mermaid sequenceDiagram block). Pass \"None or Not Applicable\" as text for any category that genuinely doesn't apply to this requirement; a category with no entry at all (not even that) fails the gate. The list of categories itself is configurable — see add_doc_category/remove_doc_category — so call list_doc_categories first if you haven't already this session, rather than assuming the default six."
        ),
      lessons: z.string().optional().describe("Required when phase is 'done': what you (the coordinator) learned running this requirement end to end — surprises, things that took longer than expected, anything that'd help next time."),
      decisionsToRecord: z.string().optional().describe("Required when phase is 'done': coordinator-level choices made along the way that aren't obvious from the code/tasks alone, and why."),
      futureImprovements: z.string().optional().describe("Required when phase is 'done': what you'd do differently, or recommend doing next, given more time."),
    },
    async ({
      phase,
      title,
      summary,
      checklist,
      docs,
      lessons,
      decisionsToRecord,
      futureImprovements,
    }) => {
      const d = db();
      const current = d.getMeta("requirement_phase");

      // Resetting to 'critique' is the one always-allowed move — it's the
      // explicit "starting a new requirement" escape hatch the methodology
      // calls for, and also the only legal first move from a fresh DB
      // (current === null). Re-affirming 'critique' while already there
      // (e.g. just to update the title) does NOT bump the requirement scope —
      // only an actual transition INTO critique from somewhere else does.
      if (phase === "critique") {
        if (current && current !== "critique") d.bumpRequirementId();
        d.setMeta("requirement_phase", "critique");
        if (title) d.setMeta("requirement_title", title);
        if (summary) d.setMeta("requirement_summary", summary);
        return text({
          phase: "critique",
          title: d.getMeta("requirement_title"),
          summary: d.getMeta("requirement_summary"),
          requirementId: d.currentRequirementId(),
        });
      }

      if (!current) {
        return text({
          error: `No requirement is in flight — call set_requirement_phase({phase:"critique"}) first. Jumping straight to "${phase}" is exactly the false signal these gates exist to prevent; see get_methodology.`,
        });
      }

      if (phase === current) {
        if (title) d.setMeta("requirement_title", title);
        if (summary) d.setMeta("requirement_summary", summary);
        return text({ phase: current, title: d.getMeta("requirement_title"), summary: d.getMeta("requirement_summary") });
      }

      const curIdx = PHASE_ORDER.indexOf(current);
      const targetIdx = PHASE_ORDER.indexOf(phase);
      if (targetIdx !== curIdx + 1) {
        return text({
          error: `Cannot go from "${current}" to "${phase}" — phases advance one step at a time (${PHASE_ORDER.join(" → ")}). Call get_methodology if it's unclear why.`,
        });
      }

      const reqId = d.currentRequirementId();

      if (phase === "plan") {
        const findingCount = d.countFindingsForRequirement(reqId);
        if (findingCount < 1) {
          return text({
            error: `Critique gate not met: no add_finding has been logged yet for this requirement. Record the open questions/ambiguities you resolved (repoId 'coordinator' works for cross-cutting ones) before advancing to Plan — see get_methodology.`,
          });
        }
        // Required fresh on THIS call, not satisfied by a stale value left
        // over from a previous requirement in this same database — same
        // reasoning as the Done gate's lessons/decisions/future
        // improvements never falling back to an old value.
        if (!summary?.trim()) {
          return text({
            error: `Critique gate not met: no summary given. Completing Critique requires a real description of what this requirement/feature actually is — pass summary on this call. This is what shows up in the dashboard and list_databases/select_database so anyone (including a future session) can tell what this database was actually used for. Nothing was changed.`,
          });
        }
        const checklistItemsGiven = (checklist ?? []).filter((c) => c.text?.trim());
        if (checklistItemsGiven.length < 1) {
          return text({
            error: `Critique gate not met: no checklist given. Completing Critique requires breaking the requirement into discrete items (checklist: {text, ambiguous?}[]) — this is what Implement's gate checks every task against later (see upsert_task's covers param), so a requirement item nobody ever writes a task for gets caught structurally instead of silently shipping incomplete. Nothing was changed.`,
          });
        }
        // Ambiguous items need a waitingOnHuman finding logging the
        // interpretation picked — checked as a count, not a real per-item
        // link (findings aren't tied to specific checklist ids), so this
        // catches "you flagged 2 ambiguous items but logged 0 waitingOnHuman
        // findings", not "you resolved the WRONG ambiguous item".
        const ambiguousCount = checklistItemsGiven.filter((c) => c.ambiguous).length;
        if (ambiguousCount > 0) {
          const waitingCount = d.countWaitingOnHumanFindingsForRequirement(reqId);
          if (waitingCount < ambiguousCount) {
            return text({
              error: `Critique gate not met: ${ambiguousCount} checklist item(s) are marked ambiguous, but only ${waitingCount} waitingOnHuman finding(s) have been logged for this requirement. Log one add_finding({waitingOnHuman: true, ...}) per ambiguous item, recording the interpretation you picked and why, before advancing to Plan. Nothing was changed.`,
            });
          }
        }
      }

      if (phase === "implement") {
        // A retry while already held: don't re-demand the doc params again
        // (they're already persisted from the call that first got here) —
        // just report the same hold.
        if (d.getMeta("operator_gate_pending") === "on") {
          return text({
            phase: current,
            held: true,
            message: `Still held — implementation is pending operator approval in the dashboard. All Plan gates were already satisfied; nothing further is needed from you until a human approves.`,
          });
        }

        const taskCount = d.tasksForRequirement(reqId).length;
        if (taskCount < 1) {
          return text({
            error: `Plan gate not met: no tasks exist yet for this requirement. Use upsert_task for every step across every repo involved before advancing to Implement — see get_methodology.`,
          });
        }

        // A human disputing a finding you decided autonomously (dashboard-
        // only — see setFindingDisputed) blocks Implement until resolved.
        // Resolution means a human un-disputes it from the dashboard, not
        // an MCP call — same "only a human decides this" pattern as the
        // operator gate.
        const disputedCount = d.countDisputedFindingsForRequirement(reqId);
        if (disputedCount > 0) {
          return text({
            error: `Plan gate not met: ${disputedCount} finding(s) for this requirement are disputed (see list_findings' disputed field) — a human pushed back on a decision you made autonomously. Implementation is blocked until they're resolved (un-disputed) from the dashboard. Nothing was changed.`,
          });
        }

        // Checklist coverage — purely structural (a mapping exists), see
        // ChecklistItem's own comment for what this does and doesn't catch.
        const checklistItems = d.checklistForRequirement(reqId);
        const tasksForReq = d.tasksForRequirement(reqId);
        const coveredIds = new Set(tasksForReq.flatMap((t) => t.covers || []));
        const uncovered = checklistItems.filter((c) => !coveredIds.has(c.id));
        if (uncovered.length > 0) {
          return text({
            error: `Plan gate not met: ${uncovered.length} checklist item(s) have no task covering them — ${uncovered
              .map((c) => `"${c.text}" (id: ${c.id})`)
              .join("; ")}. Add a task whose covers includes that id (see upsert_task), or update an existing one to add it, before advancing to Implement — see get_methodology.`,
          });
        }

        // Contract documentation — required for every currently configured
        // category (see list_doc_categories/add_doc_category), but "None
        // or Not Applicable" is a legal value for any category that
        // genuinely doesn't apply.
        const categories = d.listDocCategories();
        const givenById = new Map((docs ?? []).map((e) => [e.categoryId, e.text]));
        const missingDocs = categories.filter((c) => !givenById.get(c.id)?.trim());
        if (missingDocs.length > 0) {
          return text({
            error: `Plan gate not met: missing contract documentation for ${missingDocs
              .map((c) => `${c.label} (categoryId: ${c.id})`)
              .join(", ")}. Provide a docs entry for every category from list_doc_categories on this call — pass "None or Not Applicable" as text for any that genuinely don't apply to this requirement. Nothing was changed.`,
          });
        }
        // Persisted now (not deferred until the transition actually
        // commits below) — this work shouldn't be lost if the operator
        // gate then holds the actual phase change pending approval.
        for (const c of categories) d.setPlanDoc(c.id, givenById.get(c.id)!);

        // The optional, dashboard-only approval gate: off by default (see
        // get_requirement_phase's operatorGateEnabled). When on, everything
        // above just succeeded, but the actual phase change is HELD —
        // only a human clicking Approve in the dashboard (not this call,
        // not any MCP tool) moves it to Implement. dispatch also checks
        // operator_gate_pending directly, so real work can't start either.
        if (d.getMeta("operator_gate_enabled") === "on") {
          d.setMeta("operator_gate_pending", "on");
          return text({
            phase: current,
            held: true,
            message: `All Plan gates are satisfied (tasks, checklist coverage, contract docs), but the operator-approval gate is enabled for this requirement — implementation is held until a human clicks Approve in the dashboard. Nothing else to do on your end.`,
          });
        }
      }

      if (phase === "closing") {
        const tasks = d.tasksForRequirement(reqId);
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
        const since = d.getMeta("closing_entered_at") ?? "";
        const closingFindings = d.countFindingsForRequirement(reqId, since);
        if (closingFindings < 1) {
          return text({
            error: `Closing gate not met: no add_finding has been logged since Closing began. Attach the passing combined end-to-end run's output as an add_finding first — see get_methodology.`,
          });
        }
        if (!lessons?.trim() || !decisionsToRecord?.trim() || !futureImprovements?.trim()) {
          return text({
            error: `Done gate not met: lessons, decisionsToRecord, and futureImprovements are all required to close out a requirement — this is what lands in the Learnings tab alongside each repo's own final report. Nothing was changed.`,
          });
        }
      }

      if (phase === "closing") d.markClosingEntered();

      d.setMeta("requirement_phase", phase);
      if (title) d.setMeta("requirement_title", title);
      if (summary) d.setMeta("requirement_summary", summary);
      if (phase === "plan" && checklist) {
        d.addChecklistItems(
          reqId,
          checklist.filter((c) => c.text?.trim())
        );
      }

      if (phase === "done") {
        const requirementTitle = d.getMeta("requirement_title") || "";
        d.addLearning({
          requirement_id: reqId,
          requirement_title: requirementTitle,
          repo_id: "coordinator",
          repo_label: "Coordinator",
          lessons: lessons!,
          decisions: decisionsToRecord!,
          future_improvements: futureImprovements!,
          text: "",
        });
        // One final "what did you learn" dispatch per runnable repo, then
        // every agent stops — Done means the requirement is finished, not
        // idle-and-waiting. A repo with no local clone can't run a
        // dispatch at all, so it's just stopped directly instead of
        // queuing something that would sit forever.
        for (const repo of d.listRepos()) {
          if (!repo.cwd) {
            if (repo.agent_status !== "stopped") d.setRepoStatus(repo.id, "stopped");
            continue;
          }
          d.queueLearningsDispatch(repo.id, learningsPrompt(requirementTitle));
          // Queuing alone doesn't make the daemon's dispatch loop pick it
          // up — that loop skips any repo whose agent_status is
          // "stopped" (see server.ts's tickOne). Ensure it's actually
          // running so this dispatch gets processed; agentRunner.ts sets
          // it back to "stopped" itself once this specific dispatch's
          // response lands (see its kind === "learnings" handling).
          if (repo.agent_status === "stopped") {
            try {
              startAgent(d, repo.id);
            } catch {
              // Shouldn't happen (cwd is checked above), but a repo that
              // can't actually start shouldn't block the rest of Done.
            }
          }
        }
      }

      return text({
        phase: d.getMeta("requirement_phase"),
        title: d.getMeta("requirement_title"),
        summary: d.getMeta("requirement_summary"),
      });
    }
  );

  server.tool(
    "list_doc_categories",
    "The current list of Plan → Docs categories, in display order — what set_requirement_phase's docs param needs one entry per category for before Implement's gate passes, and what the dashboard's Plan → Docs tab renders tabs for. Seeded by default with schema/apis/messages/file_structures/sequence/others (the 'sequence' category is meant for a mermaid sequenceDiagram block covering this requirement's cross-repo call flow), but configurable — see add_doc_category/remove_doc_category. Call this before your first set_requirement_phase({phase:'implement', docs:...}) rather than assuming the default six, since a database may have had categories added or removed.",
    {},
    async () => text(db().listDocCategories())
  );

  server.tool(
    "add_doc_category",
    "Add a new Plan → Docs category — for a contract shape this requirement/project needs that isn't covered by the existing list (list_doc_categories). Appended at the end of the display order. Returns the new category including its generated id (derived from label, deduplicated if it collides with an existing one) — use that id as docs[].categoryId on set_requirement_phase. Once added, it applies immediately: Implement's gate will require a docs entry for it on every future set_requirement_phase call for this database, not just this requirement.",
    { label: z.string().describe("Display label, e.g. 'Auth flow' or 'Rate limits'. Shown as the tab name in the dashboard's Plan → Docs view.") },
    async ({ label }) => text(db().addDocCategory(label))
  );

  server.tool(
    "remove_doc_category",
    "Remove a Plan → Docs category (by id, from list_doc_categories) — e.g. one added by mistake, or that turned out not to apply to this kind of project. Its previously-submitted doc text (if any) is kept in storage, not deleted, in case a category with the same id is re-added later; it just stops being required or shown while removed.",
    { id: z.string().describe("The category's id, from list_doc_categories.") },
    async ({ id }) => {
      db().removeDocCategory(id);
      return text({ ok: true });
    }
  );

  server.tool(
    "get_cruise_control",
    "Read whether cruise control is on. When on, every successful dispatch's result includes a reminder to keep driving the plan yourself (check get_tasks, dispatch the next unblocked task) instead of stopping after one step. This is a plain operational toggle — settable from the dashboard (a button in the header) or here, either side, unlike set_requirement_phase which is deliberately coordinator-only.",
    {},
    async () => text({ cruiseControl: db().getMeta("cruise_control") === "on" })
  );

  server.tool(
    "set_cruise_control",
    "Turn cruise control on or off. On: every dispatch result carries a reminder to keep going — check get_tasks yourself and queue the next unblocked task(s) without being asked, until the plan is done or something needs a human. Turning it on (from off) also queues a one-time heads-up dispatch to every runnable repo telling its agent to default to autonomous decisions too, ahead of whatever's already queued — most of the 'stop and ask' friction happens at the repo level, not here, so this is what actually cuts down on asks. This cannot make the control center itself wake you up later — MCP has no way to push a result back into an idle session, so the reminder only has an effect the next time you're actively calling dispatch anyway. Off is the default; turn it back off once you'd rather drive one step at a time yourself.",
    { on: z.boolean() },
    async ({ on }) => text(applyCruiseControl(db(), on))
  );

  server.tool(
    "discover_github_repos",
    "Resync the tracked repo list against real GitHub state (via `gh`, not a token this tool manages itself) and check which ones have a local clone this machine can actually run against. Adds newly-found repos (including ones that exist on GitHub but aren't cloned locally yet — flagged via cwd: '', not hidden), updates cwd for ones that are now locally cloned, and never blanks a repo's existing cwd just because this pass didn't find it (it may have looked in the wrong place). Needs `gh` installed and network access; see discover_local_repos for a network-free alternative that only finds what's already checked out. This only tells you a repo EXISTS and is runnable — it does not know what a repo does; that's what summary (see list_repos) is for, and it only populates once a repo with a real cwd is started.",
    {
      owner: z.string().optional().describe("GitHub org or user to list repos for. Omit to reuse whatever was used last time."),
      codeRoot: z.string().optional().describe("Local directory to look for clones in (checked as <codeRoot>/<repo-name>). Omit to reuse whatever was used last time."),
    },
    async ({ owner, codeRoot }) => {
      const d = db();
      const resolvedOwner = owner || d.getMeta("github_owner");
      const resolvedCodeRoot = codeRoot || d.getMeta("code_root");
      if (!resolvedOwner || !resolvedCodeRoot) {
        return text({ error: "owner and codeRoot are required the first time — no prior discovery run to reuse them from." });
      }
      try {
        return text(runGithubDiscoveryAndUpsert(d, resolvedOwner, resolvedCodeRoot));
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
      const d = db();
      const resolvedCodeRoot = codeRoot || d.getMeta("code_root");
      if (!resolvedCodeRoot) {
        return text({ error: "codeRoot is required the first time — no prior discovery run to reuse it from." });
      }
      try {
        return text(runLocalDiscoveryAndUpsert(d, resolvedCodeRoot));
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
      const d = db();
      const repo = d.getRepo(repoId);
      if (!repo) return text({ error: `no such repo: ${repoId}` });
      return text(d.queueIntroDispatch(repoId, INTRO_PROMPT));
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
      const d = db();
      const repo = d.getRepo(repoId);
      if (!repo) return text({ error: `no such repo: ${repoId}` });
      if (!d.getMeta("requirement_phase")) {
        return text({
          error: `No requirement is in flight — call set_requirement_phase({phase:"critique"}) before dispatching real work to ${repo.repo}. Nothing was queued. See get_methodology for why.`,
        });
      }
      // The optional operator-approval gate (off by default, dashboard-
      // only to turn on — see get_requirement_phase's operatorGateEnabled).
      // When on, a set_requirement_phase({phase:'implement'}) call that
      // would otherwise succeed is instead HELD (operator_gate_pending)
      // until a human clicks Approve in the dashboard — this is what
      // actually blocks real work from starting during that hold, since
      // phase alone (see the check just above) doesn't distinguish
      // "planning" from "approved to implement".
      if (d.getMeta("operator_gate_pending") === "on") {
        return text({
          error: `Blocked — implementation is held pending operator approval (see the dashboard). Nothing was dispatched. This isn't a mistake: someone enabled the operator-approval gate for this requirement, and set_requirement_phase({phase:'implement'}) is waiting on a human to approve before real work starts.`,
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
        d.getMeta("cruise_control") === "on"
          ? "Cruise control is ON: after this lands, call get_tasks yourself and dispatch() the next unblocked task(s) for this requirement (every dep already 'done', this task still 'todo') without waiting to be asked. Keep checking back (list_recent_activity or get_repo_status) rather than ending your turn, until every task is 'done' or something needs you — an open escalation, a finding logged with by:'wait', or a gate refusal from set_requirement_phase/upsert_task."
          : undefined;
      if (repo.agent_status === "needsHuman") {
        const esc = d.openEscalationForRepo(repoId);
        return text({
          error: `${repo.repo} is blocked on a live escalation (kind: ${esc?.kind ?? "unknown"}) — this dispatch has been queued, but it will NOT run until that's resolved. Call resolve_escalation on escalation ${esc?.id ?? "?"} first.`,
          queued: d.queueDispatch(repoId, body),
          ...(cruiseControlNote ? { cruiseControlNote } : {}),
        });
      }
      if (repo.agent_status === "stopped") {
        return text({
          error: `${repo.repo} is stopped — this dispatch has been queued, but nothing will pick it up until its agent is started. Call start_agent on ${repoId} to actually run it.`,
          queued: d.queueDispatch(repoId, body),
          ...(cruiseControlNote ? { cruiseControlNote } : {}),
        });
      }
      const queued = d.queueDispatch(repoId, body);
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
      const d = db();
      const id = d.findRepoIdByName(repo) ?? repo;
      const existing = d.getRepo(id);
      let resolvedCwd = existing?.cwd || "";
      let warning: string | null = null;
      if (cwd) {
        if (fs.existsSync(path.join(cwd, ".git"))) {
          resolvedCwd = cwd;
        } else {
          warning = `${cwd} doesn't look like a git repo (no .git found) — tracked with cwd: '' instead.`;
        }
      }
      d.upsertRepo({
        id,
        repo,
        cwd: resolvedCwd,
        phase: phase || existing?.phase || (resolvedCwd ? "" : "Added — not cloned locally"),
        prs: existing?.prs || "—",
        agent_status: existing?.agent_status || "stopped",
      });
      return text({ ...d.getRepo(id), warning });
    }
  );

  server.tool(
    "start_agent",
    "Start a repo's agent so it actually begins picking up its queued dispatches — a stopped repo's queue just sits there untouched. Also queues that repo's first self-introduction pass if it hasn't had one (see list_repos' summary field). Fails if the repo has no local clone (cwd: '') — use add_repo with a real cwd, or discover_local_repos/discover_github_repos, first.",
    { repoId: z.string().describe("The repo's short id — see list_repos.") },
    async ({ repoId }) => {
      try {
        return text(startAgent(db(), repoId));
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
        return text(stopAgent(db(), repoId));
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
      const d = db();
      const open = d
        .listRepos()
        .filter((r) => r.agent_status === "needsHuman")
        .map((r) => ({ repo: r, escalation: d.openEscalationForRepo(r.id) }));
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
      db().resolveEscalation(escalationId, answer);
      return text({ ok: true });
    }
  );

  server.tool(
    "list_findings",
    "The durable decision log: calls an agent made autonomously along the way, and items it's surfaced that are waiting on a human (by: 'wait'). This is a record, not a live channel — answering one here just logs the decision; relaying it back to the agent is a separate dispatch. flagForReview items are still autonomous decisions (by stays 'ai') but flagged for a human to skim without blocking on them. disputed (dashboard-only, no MCP tool sets it) means a human pushed back on an autonomous decision — any disputed finding for the current requirement blocks Plan -> Implement until resolved.",
    {
      hasAnswer: z.boolean().optional().describe("true for only findings with a recorded answer; false for only ones still unanswered. Omit for both."),
      since: z.string().optional().describe("Only findings created at or after this timestamp (same sortable ISO format created_at already uses). Use with polling — 'what's changed since I last checked' — instead of re-reading the whole log every time."),
    },
    async ({ hasAnswer, since }) => text(db().listFindings({ hasAnswer, since }))
  );

  server.tool(
    "list_learnings",
    "Post-mortem records from requirements that have reached Done — the coordinator's own required lessons/decisionsToRecord/futureImprovements submission (repo_id: 'coordinator'), plus each runnable repo's own final report from the automatic learnings dispatch queued as part of that same transition (repo_id: the repo, its reply in the text field). Same data the dashboard's Learnings tab shows, newest requirement first.",
    {},
    async () => text(db().listLearnings())
  );

  server.tool(
    "answer_finding",
    "Record a human decision against a logged finding that's waiting on one. Does not itself notify the agent — follow up with `dispatch` to actually hand the decision back.",
    { findingId: z.string(), answer: z.string() },
    async ({ findingId, answer }) => {
      db().answerFinding(findingId, answer);
      return text({ ok: true });
    }
  );

  server.tool(
    "add_finding",
    "Log a new finding or scoping note against a repo (or 'coordinator' for cross-cutting items) — for the coordinator's own observations, not just agent-surfaced ones. Three shapes: an FYI record of a decision you already made yourself (the default — shows as 'by: AI', never counts toward the dashboard's 'waiting on a human' count), the same but flagForReview: true (still autonomous, still non-blocking, but surfaced in its own 'please skim' queue — use this for the middle case: reasonable to decide yourself, but worth a human's eyes before it hardens into a lot of downstream work), or something that genuinely can't proceed without a human's call (waitingOnHuman: true — shows an Answer… button, counts toward that count, answerable via answer_finding, and is what Critique's ambiguous-checklist-item gate looks for). See get_methodology for the actual criteria on which of these to pick, which changes depending on whether cruise control is on.",
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
      flagForReview: z
        .boolean()
        .optional()
        .describe(
          "true for the middle case: you decided this yourself (still by:'ai', non-blocking, doesn't count toward 'waiting on a human'), but it's worth a human skimming before it hardens into a lot of downstream work. Ignored if waitingOnHuman is also true."
        ),
    },
    async ({ repoId, text: body, phase, waitingOnHuman, flagForReview }) => {
      const by: FindingBy = waitingOnHuman ? "wait" : "ai";
      const disposition = waitingOnHuman
        ? "Waiting on a human decision"
        : flagForReview
          ? "Logged — decided autonomously, flagged for review"
          : "Logged — decided autonomously";
      return text(db().addFinding(repoId, body, phase ?? "", by, "watch", disposition, !waitingOnHuman && !!flagForReview));
    }
  );

  server.tool(
    "get_tasks",
    "The rollout gantt: every task, its repo, hours estimate, status, and dependencies — the same data the dashboard renders as a gantt chart.",
    {},
    async () => text(db().listTasks())
  );

  server.tool(
    "list_recent_activity",
    "The uniform 'has anything happened' feed across every repo at once — one entry each time a dispatch is actually sent, another when its response lands. Nothing pushes this to you (there is no notification mechanism reaching a coordinator session today, only the dashboard's own local UI); this is what you poll after dispatching somewhere, instead of separately calling get_repo_status per repo to check. Most recent first.",
    { limit: z.number().optional().describe("Max entries to return. Defaults to 100.") },
    async ({ limit }) => text(db().listLogEntries(limit ?? 100))
  );

  server.tool(
    "upsert_task",
    "Create or update one task on the implementation plan (the gantt). Reusing an existing id updates that task in place rather than creating a duplicate — this is how a plan gets kept current as work actually progresses, not just written once and left stale. See get_tasks for the current scale/ids before adding dependents. ENFORCED: a non-milestone, non-exempt task's `task` text must itself state a test requirement (e.g. \"CRUD endpoints for todos — tests: pytest against real Postgres hitting all 4 routes\"), AND a non-empty `contract` must be given — its own interface, specified up front: an OpenAPI spec, a DB schema, a queue message format, a shared file/durable object shape, etc. Both are refused outright, not written with a warning, when missing. Pass milestone: true for a checkpoint with no work/test of its own (also exempts it from the contract requirement), or noContractNeeded: true for a scaffold or pure debt/refactor task that doesn't cross a service boundary or change an interface another repo depends on (still needs a test). Also refused while no requirement is in flight (see get_methodology) — call set_requirement_phase({phase:'critique'}) first.",
    {
      id: z.string().describe("Stable id for this task. Reuse it on later calls to update rather than duplicate."),
      repo: z.string().describe("Repo name shown on the gantt (a display label, not checked against tracked repos)."),
      task: z.string().describe("Short description shown on the gantt bar. Must state its own test requirement (e.g. '... — tests: ...') unless milestone is true — see this tool's own description."),
      startH: z.number().describe("Start offset in hours from the plan's own zero point — not a calendar date. Check existing tasks (get_tasks) for the current scale before picking one."),
      durH: z.number().describe("Duration in hours. Use 0 for a milestone."),
      status: z.enum(["todo", "active", "blocking", "done"]).optional().describe("Defaults to 'todo'."),
      deps: z.array(z.string()).optional().describe("Ids of tasks this one depends on — drawn as dependency arrows on the gantt."),
      milestone: z.boolean().optional(),
      contract: z
        .string()
        .optional()
        .describe(
          "This task's own interface, specified up front — an OpenAPI spec (inline or a path/URL to one), a DB schema, the message format a queue consumes, a shared file/durable object's shape, etc. Required unless milestone or noContractNeeded is true."
        ),
      noContractNeeded: z
        .boolean()
        .optional()
        .describe("True for a scaffold or pure debt/refactor task — nothing crossing a service boundary or changing an interface another repo depends on. Does not exempt it from the test requirement."),
      covers: z
        .array(z.string())
        .optional()
        .describe("Ids of checklist items (see get_requirement_phase's checklist, set via set_requirement_phase) this task addresses. Not required — but every checklist item needs at least one task covering it before Implement's gate will pass."),
      doneEvidence: z
        .string()
        .optional()
        .describe("The actual evidence this task was verified against — test output, a commit SHA, a PR link, etc. Not enforced, but this is what makes 'trust but verify' auditable later instead of relying on your own summary of what you checked. Shown in the dashboard's task-contract popup alongside the contract itself."),
    },
    async ({ id, repo, task, startH, durH, status, deps, milestone, contract, noContractNeeded, covers, doneEvidence }) => {
      const d = db();
      if (!d.getMeta("requirement_phase")) {
        return text({
          error: `No requirement is in flight — call set_requirement_phase({phase:"critique"}) before planning tasks. Nothing was written.`,
        });
      }
      if (!milestone && !/test/i.test(task)) {
        return text({
          error: `Plan gate: "${task}" doesn't state a test requirement. Every non-milestone task's text must state its own test alongside the work (e.g. "... — tests: pytest against real Postgres hitting all 4 routes"), not just describe the work — see get_methodology. Add one and retry, or pass milestone: true if this is a checkpoint with no work of its own. Nothing was written.`,
        });
      }
      if (!milestone && !noContractNeeded && !contract?.trim()) {
        return text({
          error: `Plan gate: "${task}" has no contract specified. A non-milestone task must specify its own interface up front — an OpenAPI spec, a DB schema, a queue message format, a shared file/durable object's shape, etc. — not leave it for the implementer to guess or reconcile later. Pass contract with it, or noContractNeeded: true if this is a scaffold or pure debt/refactor task that doesn't cross a service boundary. Nothing was written.`,
        });
      }
      d.upsertTask({
        id,
        repo,
        task,
        start_h: startH,
        dur_h: durH,
        status: status ?? "todo",
        deps: deps ?? [],
        milestone: milestone ? 1 : 0,
        contract: contract ?? "",
        covers: covers ?? [],
        doneEvidence: doneEvidence ?? "",
      });
      return text(d.listTasks().find((t) => t.id === id));
    }
  );

  const TASK_ITEM_SHAPE = {
    id: z.string().describe("Stable id for this task. Reuse an existing one (in this batch or already on the plan) to update it in place rather than duplicate."),
    repo: z.string().describe("Repo name shown on the gantt (a display label, not checked against tracked repos)."),
    task: z.string().describe("Short description shown on the gantt bar. Must state its own test requirement (e.g. '... — tests: ...') unless milestone is true."),
    startH: z.number().describe("Start offset in hours from the plan's own zero point — not a calendar date."),
    durH: z.number().describe("Duration in hours. Use 0 for a milestone."),
    status: z.enum(["todo", "active", "blocking", "done"]).optional().describe("Defaults to 'todo'."),
    deps: z.array(z.string()).optional().describe("Ids of tasks this one depends on — may reference another task in this same batch, or one already on the plan."),
    milestone: z.boolean().optional(),
    contract: z
      .string()
      .optional()
      .describe("This task's own interface, specified up front — an OpenAPI spec, a DB schema, a queue message format, a shared file/durable object's shape, etc. Required unless milestone or noContractNeeded is true."),
    noContractNeeded: z
      .boolean()
      .optional()
      .describe("True for a scaffold or pure debt/refactor task — nothing crossing a service boundary or changing an interface another repo depends on. Does not exempt it from the test requirement."),
    covers: z
      .array(z.string())
      .optional()
      .describe("Ids of checklist items this task addresses (see get_requirement_phase's checklist). Not required, but every checklist item needs at least one task covering it before Implement's gate will pass."),
    doneEvidence: z
      .string()
      .optional()
      .describe("The actual evidence this task was verified against — test output, a commit SHA, a PR link, etc. Not enforced. Shown in the dashboard's task-contract popup."),
  };

  server.tool(
    "upsert_tasks",
    "Bulk form of upsert_task: write many tasks in one call instead of one round trip per task — use this for writing a plan's initial task graph (see the Plan phase in get_methodology), not for a single status update. Same rules as upsert_task apply to EACH task (the test-requirement gate, the contract gate, refused while no requirement is in flight), but failures are per-task, not all-or-nothing: a task that fails its own gate is skipped, and so is every task in this batch that depends on it (directly or transitively) or on any other unresolvable id — a bad task doesn't silently corrupt the rest of the plan, but nothing that stood on top of it gets written half-supported either. The response lists every task with ok:true/false; check it, since a successful call can still contain individual failures.",
    { tasks: z.array(z.object(TASK_ITEM_SHAPE)).min(1).describe("One or more tasks, in any order — dependency order is resolved internally, not required from the caller.") },
    async ({ tasks }) => {
      const d = db();
      if (!d.getMeta("requirement_phase")) {
        return text({
          error: `No requirement is in flight — call set_requirement_phase({phase:"critique"}) before planning tasks. Nothing was written.`,
        });
      }

      const existingIds = new Set(d.listTasks().map((t) => t.id));
      const batchIds = new Set(tasks.map((t) => t.id));
      const errors = new Map<string, string>();

      // Pass 1: each task's own gates, independent of dependencies.
      for (const t of tasks) {
        if (!t.milestone && !/test/i.test(t.task)) {
          errors.set(
            t.id,
            `Plan gate: "${t.task}" doesn't state a test requirement. Every non-milestone task's text must state its own test alongside the work (e.g. "... — tests: pytest against real Postgres hitting all 4 routes") — see get_methodology.`
          );
          continue;
        }
        if (!t.milestone && !t.noContractNeeded && !t.contract?.trim()) {
          errors.set(
            t.id,
            `Plan gate: "${t.task}" has no contract specified. A non-milestone task must specify its own interface up front — an OpenAPI spec, a DB schema, a queue message format, a shared file/durable object's shape, etc. Pass contract with it, or noContractNeeded: true if this is a scaffold or pure debt/refactor task.`
          );
        }
      }

      // Pass 2: a dep pointing at neither an existing task nor another
      // entry in this batch can never resolve — fail it now so pass 3
      // cascades from it exactly like any other failure.
      for (const t of tasks) {
        if (errors.has(t.id)) continue;
        const badDep = (t.deps ?? []).find((dep) => !existingIds.has(dep) && !batchIds.has(dep));
        if (badDep) {
          errors.set(t.id, `Depends on "${badDep}", which isn't an existing task or part of this batch. Nothing was written for this task.`);
        }
      }

      // Pass 3: propagate failures through deps within this batch to a
      // fixed point — a task that depends (directly or transitively) on
      // one that failed is itself rejected, rather than written on top of
      // a plan step that never actually landed.
      let changed = true;
      while (changed) {
        changed = false;
        for (const t of tasks) {
          if (errors.has(t.id)) continue;
          const failedDep = (t.deps ?? []).find((dep) => errors.has(dep));
          if (failedDep) {
            errors.set(t.id, `Skipped — depends on "${failedDep}", which failed and was not written.`);
            changed = true;
          }
        }
      }

      const results = tasks.map((t) => {
        const error = errors.get(t.id);
        if (error) return { id: t.id, ok: false, error };
        d.upsertTask({
          id: t.id,
          repo: t.repo,
          task: t.task,
          start_h: t.startH,
          dur_h: t.durH,
          status: t.status ?? "todo",
          deps: t.deps ?? [],
          milestone: t.milestone ? 1 : 0,
          contract: t.contract ?? "",
          covers: t.covers ?? [],
          doneEvidence: t.doneEvidence ?? "",
        });
        return { id: t.id, ok: true, task: d.listTasks().find((x) => x.id === t.id) };
      });
      return text(results);
    }
  );

  return server;
}
