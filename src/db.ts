// Shared SQLite data layer. Every process that touches the control center's
// state (the runner daemon, the MCP server, the extension's own reads) goes
// through this module rather than opening ad hoc connections, so the schema
// and the WAL/busy_timeout settings that make multi-process access safe stay
// in one place.
//
// Uses node's built-in `node:sqlite` (stable from Node 22.5+) — no native
// module to build/prebuild-fetch. This only runs under a plain `node`
// process (the runner daemon, the MCP server), never inside the VS Code
// extension host directly, since the host's bundled Electron/Node version
// is not guaranteed to have node:sqlite.
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export type AgentStatus = "running" | "idle" | "needsHuman" | "stopped";
export type DispatchState = "queued" | "sent";
export type DispatchKind = "user" | "intro" | "learnings" | "cruise";
export type FindingBy = "ai" | "wait" | "human";
export type FindingSev = "open" | "watch" | "done";

export interface Repo {
  id: string;
  repo: string;
  cwd: string;
  phase: string;
  prs: string;
  agent_status: AgentStatus;
  paused: 0 | 1;
  // Agent-authored self-introduction — what this repo is, stack, conventions,
  // current state — populated by an automatic 'intro' dispatch the first
  // time the repo is ever started, refreshable on demand after that. Empty
  // until then. This is what a controller reads instead of having to guess
  // from a repo's short id or dig through raw dispatch history.
  summary: string;
}

export interface Dispatch {
  id: string;
  repo_id: string;
  kind: DispatchKind;
  text: string;
  state: DispatchState;
  at: string;
  response: string;
  responded_at: string;
  session_id: string | null;
}

// A unified, cross-repo, time-sorted feed of "dispatch sent" / "response
// received" events — derived entirely from the dispatches table, not a
// separately-tracked log. Answers "is anything actually happening" across
// every repo at once, which no single repo's own dispatch queue or Watch
// panel shows on its own.
export interface LogEntry {
  when: string;
  repo: string;
  text: string;
}

export interface EscalationOption {
  id: string;
  label: string;
  rationale: string;
}

// 'permission': the SDK's canUseTool actually blocked a tool call — the
// classic case, generic Approve/Decline options.
// 'reply': the agent explicitly paused its own turn via the ask_human tool
// because it needs a real decision to continue (e.g. "commit and/or
// deploy?") — not a tool permission gate, but still not resolvable by
// queuing another dispatch: the agent is sitting there waiting on this
// specific answer, same as 'permission', just a different reason to be red.
export type EscalationKind = "permission" | "reply";

export interface Escalation {
  id: string;
  repo_id: string;
  kind: EscalationKind;
  text: string;
  asked_by: string;
  options: EscalationOption[];
  peer_note: string | null;
  answer: string | null;
  created_at: string;
}

export interface Finding {
  id: string;
  repo_id: string;
  text: string;
  phase: string;
  disposition: string;
  by: FindingBy;
  sev: FindingSev;
  answer: string;
  created_at: string;
  // Which requirement (see currentRequirementId()) this was logged under —
  // stamped automatically, never caller-supplied. This is what lets the
  // phase gates tell "a finding was logged for THIS requirement" apart from
  // "a finding exists somewhere in the DB's history", which old requirements
  // would otherwise satisfy for free.
  requirement_id: number;
  // Coordinator-set at add_finding time — a third state between a silent
  // FYI and a hard waitingOnHuman block: still decided autonomously (by
  // stays 'ai'), but surfaced in its own "please skim" queue rather than
  // buried in the general log.
  flag_for_review: 0 | 1;
  // Human-set ONLY, from the dashboard (no MCP tool sets this — same
  // "only a human can" pattern as the operator-approval gate) — a
  // pushback on a finding the coordinator already decided autonomously.
  // Any disputed finding for the current requirement blocks the
  // Plan -> Implement gate until resolved (see mcp.ts).
  disputed: 0 | 1;
}

export interface LogLine {
  id: number;
  repo_id: string;
  t: string;
  tag: string;
  text: string;
}

export interface Task {
  id: string;
  repo: string;
  task: string;
  start_h: number;
  dur_h: number;
  status: "done" | "active" | "blocking" | "todo";
  deps: string[];
  milestone: 0 | 1;
  // The task's own interface, specified up front — an OpenAPI spec, a DB
  // schema, a queue message format, a shared file/durable object shape,
  // etc. Enforced (non-empty, unless milestone or noContractNeeded) the
  // same way the "states a test" rule is: see upsert_task/upsert_tasks in
  // mcp.ts. '' for a task exempted via noContractNeeded (scaffold/pure
  // debt/refactor — nothing crossing a service boundary to specify).
  contract: string;
  // Ids of checklist_items (see ChecklistItem) this task addresses — the
  // Implement gate refuses to advance while any checklist item for this
  // requirement has zero tasks covering it (see set_requirement_phase in
  // mcp.ts). '' /[] is legal (not every task has to map to a checklist
  // bullet), but every checklist bullet must map to at least one task.
  covers: string[];
  // The evidence a task was actually marked done on — test output, a
  // commit SHA, a PR link, whatever was actually checked. Optional, not
  // enforced (upsert_task doesn't refuse a done task with this empty) —
  // this makes "trust but verify" auditable after the fact rather than
  // just relying on the coordinator's own summary of what it verified.
  doneEvidence: string;
  // Stamped on first insert from currentRequirementId(), preserved across
  // later upserts (a task keeps belonging to the requirement that created
  // it, even if the plan is still being amended). Optional on the input
  // shape passed to upsertTask() — callers never set this themselves.
  requirement_id?: number;
}

// One bullet per discrete item pulled out of the requirement during
// Critique (see set_requirement_phase's checklist param) — the thing a
// task's `covers` field points at. Existence of a mapping is a purely
// structural check: it catches a requirement item nobody ever wrote a
// task for, not a task that nominally covers a bullet but implements it
// shallowly (that class of gap is Closing's job, via the end-to-end
// finding). Shown read-only in the dashboard's Requirements tab, before
// Plan — `ambiguous` items are badged there specifically, so a human
// knows to expect a waitingOnHuman finding resolving each one before
// Plan completes (see mcp.ts's set_requirement_phase).
export interface ChecklistItem {
  id: string;
  requirement_id: number;
  text: string;
  ambiguous: 0 | 1;
  created_at: string;
}

export type PullRequestStatus = "open" | "merged" | "closed";

export interface PullRequest {
  repo_id: string;
  number: number;
  url: string;
  status: PullRequestStatus;
  updated_at: string;
}

// One row per submitter per requirement — the coordinator's own
// structured submission (repo_id: 'coordinator', lessons/decisions/
// future_improvements populated, text left '') required by
// set_requirement_phase's "done" gate, plus one per repo whose agent
// answered the automatic final "learnings" dispatch queued as part of
// that same transition (text holds its free-form reply; the three
// structured columns are left '' since a dispatch response isn't a
// validated tool call the way the coordinator's own submission is).
export interface Learning {
  id: string;
  requirement_id: number;
  requirement_title: string;
  repo_id: string;
  repo_label: string;
  lessons: string;
  decisions: string;
  future_improvements: string;
  text: string;
  created_at: string;
}

// Configurable, not a fixed 5-field shape — see doc_categories below. A
// category's actual text lives in meta as `plan_doc_<id>`, keyed by this
// row's own id, so renaming a category's label never orphans its text and
// removing one doesn't touch any other category's storage.
export interface DocCategory {
  id: string;
  label: string;
  seq: number;
}

export type PlanDocs = Record<string, string>;

export interface Snapshot {
  repos: (Repo & { dispatches: Dispatch[]; escalation: Escalation | null; pullRequests: PullRequest[] })[];
  findings: Finding[];
  tasks: Task[];
  checklist: ChecklistItem[];
  logs: Record<string, LogLine[]>;
  log: LogEntry[];
  learnings: Learning[];
  requirementPhase: string | null;
  requirementTitle: string | null;
  cruiseControl: boolean;
  docCategories: DocCategory[];
  planDocs: PlanDocs;
  operatorGateEnabled: boolean;
  operatorGatePending: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  cwd TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT '',
  prs TEXT NOT NULL DEFAULT '',
  agent_status TEXT NOT NULL DEFAULT 'stopped',
  paused INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS dispatches (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  kind TEXT NOT NULL DEFAULT 'user',
  text TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  at TEXT NOT NULL DEFAULT '',
  response TEXT NOT NULL DEFAULT '',
  responded_at TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  kind TEXT NOT NULL DEFAULT 'permission',
  text TEXT NOT NULL,
  asked_by TEXT NOT NULL DEFAULT '',
  options_json TEXT NOT NULL DEFAULT '[]',
  peer_note TEXT,
  answer TEXT,
  created_at TEXT NOT NULL
);

-- repo_id here is deliberately NOT a foreign key: findings can be logged
-- against 'coordinator' or any free-text label for cross-cutting items that
-- aren't a specific tracked repo, matching how the Findings tab's "repo"
-- field has always worked (a label, not a lookup).
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  text TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT '',
  disposition TEXT NOT NULL DEFAULT '',
  by TEXT NOT NULL DEFAULT 'ai',
  sev TEXT NOT NULL DEFAULT 'open',
  answer TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  flag_for_review INTEGER NOT NULL DEFAULT 0,
  disputed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  t TEXT NOT NULL,
  tag TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  task TEXT NOT NULL,
  start_h REAL NOT NULL,
  dur_h REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  deps_json TEXT NOT NULL DEFAULT '[]',
  milestone INTEGER NOT NULL DEFAULT 0,
  contract TEXT NOT NULL DEFAULT '',
  covers_json TEXT NOT NULL DEFAULT '[]',
  done_evidence TEXT NOT NULL DEFAULT ''
);

-- One row per discrete item pulled out of the requirement during Critique
-- (see set_requirement_phase's checklist param in mcp.ts) — see
-- ChecklistItem's own comment for what this is for.
CREATE TABLE IF NOT EXISTS checklist_items (
  id TEXT PRIMARY KEY,
  requirement_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  ambiguous INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- small key/value settings store — e.g. the GitHub owner and local code
-- root that repo discovery was last run with, so re-running it doesn't
-- need to be re-asked every time.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The configurable list of Plan → Docs categories (see DocCategory) — a
-- database, not a hardcoded 5-field shape, so a coordinator can add one
-- (e.g. a project that needs a category this seed list doesn't cover)
-- without a code change. Seeded on first migrate() with today's defaults;
-- an existing category's own doc TEXT still lives in meta as
-- plan_doc_<id>, not in this table.
CREATE TABLE IF NOT EXISTS doc_categories (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  seq INTEGER NOT NULL
);

-- Auto-tracked only (see agentRunner.ts) — populated from the Agent SDK's
-- own structured detection of a Bash tool call's git/gh activity, never
-- from a scan of what's actually on GitHub, so a PR that already existed
-- before this tool tracked the repo (or was opened by something other
-- than a dispatch) never appears here. Keyed by (repo_id, number) so a
-- later status change (opened → merged/closed) updates the same row
-- instead of appending a duplicate.
CREATE TABLE IF NOT EXISTS pull_requests (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  number INTEGER NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, number)
);

-- repo_id here is deliberately NOT a foreign key, same reasoning as
-- findings: 'coordinator' is a free-text label for the coordinator's own
-- structured submission, not a lookup against repos(id).
CREATE TABLE IF NOT EXISTS learnings (
  id TEXT PRIMARY KEY,
  requirement_id INTEGER NOT NULL,
  requirement_title TEXT NOT NULL DEFAULT '',
  repo_id TEXT NOT NULL,
  repo_label TEXT NOT NULL,
  lessons TEXT NOT NULL DEFAULT '',
  decisions TEXT NOT NULL DEFAULT '',
  future_improvements TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`;

function clock(): string {
  const d = new Date();
  const pad = (n: number) => (n < 10 ? "0" : "") + n;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// clock()'s HH:MM:SS is intentionally date-less — it's for narrow display
// columns (the Log tab, dispatch rows) that only ever show a same-day
// value, and string-sorting it only needs to hold up within one day (see
// listLogEntries' own comment). That assumption breaks for a real
// gate check: countFindingsForRequirement's Done gate compares a
// finding's created_at against closing_entered_at with `>=`, and if
// Closing was entered late one day and the finding logged just after
// midnight, "00:05:00" >= "23:50:00" is false — a real requirement
// spanning a day boundary would be incorrectly told no finding was
// logged since Closing began. Neither created_at (findings) nor
// closing_entered_at is ever displayed in the dashboard, so widening
// their format has no UI impact — this is used for exactly those two,
// not clock()'s existing display call sites.
function sortableClock(): string {
  return new Date().toISOString();
}

export class Db {
  private conn: DatabaseSync;
  private onChangeCb: (() => void) | null = null;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.conn = new DatabaseSync(dbPath);
    this.conn.exec("PRAGMA journal_mode = WAL;");
    this.conn.exec("PRAGMA busy_timeout = 3000;");
    this.conn.exec(SCHEMA);
    this.migrate();
  }

  // CREATE TABLE IF NOT EXISTS only helps a brand-new database file —
  // it's a no-op against an existing one from an earlier version of this
  // schema, so every column added after a table's first release needs an
  // explicit ALTER TABLE here too, or an existing DB just breaks on the
  // first query that touches the new column (exactly what happened:
  // 'no such column: d.responded_at' against a DB created before that
  // column existed). Additive only — this doesn't handle renames or
  // drops, which this schema hasn't needed yet.
  private migrate() {
    const ensureColumn = (table: string, column: string, definition: string) => {
      const cols = this.conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) {
        this.conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    };
    ensureColumn("dispatches", "kind", "TEXT NOT NULL DEFAULT 'user'");
    ensureColumn("dispatches", "responded_at", "TEXT NOT NULL DEFAULT ''");
    ensureColumn("escalations", "kind", "TEXT NOT NULL DEFAULT 'permission'");
    ensureColumn("repos", "summary", "TEXT NOT NULL DEFAULT ''");
    // Requirement-lifecycle scoping (see currentRequirementId()): every
    // finding/task belongs to whichever requirement was current when it was
    // written. Pre-existing rows from before this column existed default to
    // requirement 1, which matches currentRequirementId()'s own default —
    // so a DB written by an older server version keeps working exactly as
    // if requirement 1 had been explicit all along.
    ensureColumn("findings", "requirement_id", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn("tasks", "requirement_id", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn("tasks", "contract", "TEXT NOT NULL DEFAULT ''");
    ensureColumn("tasks", "covers_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("tasks", "done_evidence", "TEXT NOT NULL DEFAULT ''");
    ensureColumn("findings", "flag_for_review", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("findings", "disputed", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("checklist_items", "ambiguous", "INTEGER NOT NULL DEFAULT 0");

    // Seeded once, on whichever migrate() call first sees an empty table
    // (a brand-new database, or an existing one from before doc_categories
    // existed at all — CREATE TABLE IF NOT EXISTS above only creates the
    // empty table for it, doesn't seed rows). Never re-seeds an existing,
    // possibly-edited list — this only fires when the table is genuinely
    // empty. Ids match the meta keys (plan_doc_schema etc.) already written
    // by earlier versions of this tool, so an existing database's
    // already-submitted doc text is picked back up under the same category,
    // not orphaned.
    const docCategoryCount = (this.conn.prepare(`SELECT COUNT(*) AS n FROM doc_categories`).get() as { n: number })
      .n;
    if (docCategoryCount === 0) {
      const insertCategory = this.conn.prepare(`INSERT INTO doc_categories (id, label, seq) VALUES (?, ?, ?)`);
      // Ids match the plan_doc_<id> meta keys earlier versions of this
      // tool already wrote (e.g. plan_doc_file_structures, not
      // plan_doc_fileStructures) — see this block's own comment above.
      const seeded: Array<[string, string]> = [
        ["schema", "Schema"],
        ["apis", "APIs"],
        ["messages", "Messages"],
        ["file_structures", "File Structures"],
        ["sequence", "Sequence"],
        ["others", "Others"],
      ];
      seeded.forEach(([id, label], i) => insertCategory.run(id, label, i));
    }
  }

  onChange(cb: () => void) {
    this.onChangeCb = cb;
  }

  private changed() {
    if (this.onChangeCb) this.onChangeCb();
  }

  // ---- repos ----

  upsertRepo(r: Omit<Repo, "paused" | "summary"> & { paused?: boolean }) {
    this.conn
      .prepare(
        `INSERT INTO repos (id, repo, cwd, phase, prs, agent_status, paused, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, '')
         ON CONFLICT(id) DO UPDATE SET repo=excluded.repo, cwd=excluded.cwd,
           phase=excluded.phase, prs=excluded.prs`
      )
      .run(r.id, r.repo, r.cwd, r.phase, r.prs, r.agent_status, r.paused ? 1 : 0);
    this.changed();
  }

  setRepoSummary(id: string, summary: string) {
    this.conn.prepare(`UPDATE repos SET summary = ? WHERE id = ?`).run(summary, id);
    this.changed();
  }

  // Called only from agentRunner.ts, itself only in response to the Agent
  // SDK's own structured gitOperation.pr detection on a Bash tool result
  // (see BashOutput in the SDK's types) — i.e. only for a PR the repo's
  // OWN dispatched agent actually created or changed the state of via a
  // command it ran, never a scan of what's on GitHub, so a stray
  // pre-existing PR (opened by a human, or before this tool tracked the
  // repo at all) never shows up here. Keyed by (repo_id, number): a later
  // status change (opened → merged/closed) updates the same row in place
  // rather than appending a second one for the same PR.
  upsertPullRequest(repoId: string, number: number, url: string, status: PullRequestStatus) {
    this.conn
      .prepare(
        `INSERT INTO pull_requests (repo_id, number, url, status, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(repo_id, number) DO UPDATE SET url=excluded.url, status=excluded.status, updated_at=excluded.updated_at`
      )
      .run(repoId, number, url, status, sortableClock());
    this.changed();
  }

  listPullRequests(repoId: string): PullRequest[] {
    return this.conn
      .prepare(`SELECT * FROM pull_requests WHERE repo_id = ? ORDER BY number`)
      .all(repoId) as unknown as PullRequest[];
  }

  listRepos(): Repo[] {
    return this.conn.prepare(`SELECT * FROM repos ORDER BY rowid`).all() as unknown as Repo[];
  }

  getRepo(id: string): Repo | undefined {
    return this.conn.prepare(`SELECT * FROM repos WHERE id = ?`).get(id) as unknown as
      | Repo
      | undefined;
  }

  setRepoStatus(id: string, status: AgentStatus) {
    this.conn.prepare(`UPDATE repos SET agent_status = ? WHERE id = ?`).run(status, id);
    this.changed();
  }

  setRepoPaused(id: string, paused: boolean) {
    this.conn.prepare(`UPDATE repos SET paused = ? WHERE id = ?`).run(paused ? 1 : 0, id);
    this.changed();
  }

  // ---- dispatches (proactive human -> agent: design adjustments, clarification requests) ----

  queueDispatch(repoId: string, text: string): Dispatch {
    const id = `${repoId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const seq = (
      this.conn.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM dispatches WHERE repo_id = ?`).get(repoId) as {
        n: number;
      }
    ).n;
    this.conn
      .prepare(
        `INSERT INTO dispatches (id, repo_id, kind, text, state, at, response, responded_at, session_id, seq)
         VALUES (?, ?, 'user', ?, 'queued', '', '', '', NULL, ?)`
      )
      .run(id, repoId, text, seq);
    this.changed();
    return this.getDispatch(id)!;
  }

  // Queue-jumps ahead of anything already queued (even work queued while
  // the repo was stopped) — the introspection pass is meant to run before
  // any real work, not whenever it happens to reach the front naturally.
  queueIntroDispatch(repoId: string, text: string): Dispatch {
    const id = `${repoId}-intro-${Date.now()}`;
    const seq = (
      this.conn.prepare(`SELECT COALESCE(MIN(seq), 1) - 1 AS n FROM dispatches WHERE repo_id = ?`).get(repoId) as {
        n: number;
      }
    ).n;
    this.conn
      .prepare(
        `INSERT INTO dispatches (id, repo_id, kind, text, state, at, response, responded_at, session_id, seq)
         VALUES (?, ?, 'intro', ?, 'queued', '', '', '', NULL, ?)`
      )
      .run(id, repoId, text, seq);
    this.changed();
    return this.getDispatch(id)!;
  }

  hasIntroDispatch(repoId: string): boolean {
    const row = this.conn
      .prepare(`SELECT 1 AS x FROM dispatches WHERE repo_id = ? AND kind = 'intro' LIMIT 1`)
      .get(repoId);
    return !!row;
  }

  // Same queue-jump reasoning as queueIntroDispatch: this is meant to run
  // as the repo's very next action once the requirement reaches Done, not
  // wherever it happens to land behind whatever's already queued.
  queueLearningsDispatch(repoId: string, text: string): Dispatch {
    const id = `${repoId}-learnings-${Date.now()}`;
    const seq = (
      this.conn.prepare(`SELECT COALESCE(MIN(seq), 1) - 1 AS n FROM dispatches WHERE repo_id = ?`).get(repoId) as {
        n: number;
      }
    ).n;
    this.conn
      .prepare(
        `INSERT INTO dispatches (id, repo_id, kind, text, state, at, response, responded_at, session_id, seq)
         VALUES (?, ?, 'learnings', ?, 'queued', '', '', '', NULL, ?)`
      )
      .run(id, repoId, text, seq);
    this.changed();
    return this.getDispatch(id)!;
  }

  // Same queue-jump reasoning as queueIntroDispatch — this is context for
  // how to handle whatever's next, so it should land before anything
  // already sitting in the queue, not behind it.
  queueCruiseControlDispatch(repoId: string, text: string): Dispatch {
    const id = `${repoId}-cruise-${Date.now()}`;
    const seq = (
      this.conn.prepare(`SELECT COALESCE(MIN(seq), 1) - 1 AS n FROM dispatches WHERE repo_id = ?`).get(repoId) as {
        n: number;
      }
    ).n;
    this.conn
      .prepare(
        `INSERT INTO dispatches (id, repo_id, kind, text, state, at, response, responded_at, session_id, seq)
         VALUES (?, ?, 'cruise', ?, 'queued', '', '', '', NULL, ?)`
      )
      .run(id, repoId, text, seq);
    this.changed();
    return this.getDispatch(id)!;
  }

  getDispatch(id: string): Dispatch | undefined {
    return this.conn.prepare(`SELECT * FROM dispatches WHERE id = ?`).get(id) as unknown as
      | Dispatch
      | undefined;
  }

  listDispatches(repoId: string): Dispatch[] {
    return this.conn
      .prepare(`SELECT * FROM dispatches WHERE repo_id = ? ORDER BY seq`)
      .all(repoId) as unknown as Dispatch[];
  }

  // Next queued dispatch for a repo that isn't paused, or null.
  nextQueuedDispatch(repoId: string): Dispatch | null {
    const repo = this.getRepo(repoId);
    if (!repo || repo.paused) return null;
    const row = this.conn
      .prepare(`SELECT * FROM dispatches WHERE repo_id = ? AND state = 'queued' ORDER BY seq LIMIT 1`)
      .get(repoId) as unknown as Dispatch | undefined;
    return row ?? null;
  }

  markDispatchSent(id: string, sessionId: string | null) {
    this.conn
      .prepare(`UPDATE dispatches SET state = 'sent', at = ?, session_id = ? WHERE id = ?`)
      .run(clock(), sessionId, id);
    this.changed();
  }

  setDispatchResponse(id: string, response: string) {
    this.conn
      .prepare(`UPDATE dispatches SET response = ?, responded_at = ? WHERE id = ?`)
      .run(response, clock(), id);
    this.changed();
  }

  // ---- escalations (permission gates ONLY — the agent is actually blocked) ----

  openEscalation(
    repoId: string,
    kind: EscalationKind,
    text: string,
    askedBy: string,
    options: EscalationOption[],
    peerNote: string | null
  ): Escalation {
    const id = `${repoId}-esc-${Date.now()}`;
    this.conn
      .prepare(
        `INSERT INTO escalations (id, repo_id, kind, text, asked_by, options_json, peer_note, answer, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(id, repoId, kind, text, askedBy, JSON.stringify(options), peerNote, clock());
    this.setRepoStatus(repoId, "needsHuman");
    this.changed();
    return this.getEscalation(id)!;
  }

  getEscalation(id: string): Escalation | undefined {
    const row = this.conn.prepare(`SELECT * FROM escalations WHERE id = ?`).get(id) as any;
    if (!row) return undefined;
    return { ...row, options: JSON.parse(row.options_json) };
  }

  // The one open (unanswered) escalation for a repo, if any.
  openEscalationForRepo(repoId: string): Escalation | null {
    const row = this.conn
      .prepare(`SELECT * FROM escalations WHERE repo_id = ? AND answer IS NULL ORDER BY created_at DESC LIMIT 1`)
      .get(repoId) as any;
    if (!row) return null;
    return { ...row, options: JSON.parse(row.options_json) };
  }

  resolveEscalation(id: string, answer: string) {
    const esc = this.getEscalation(id);
    if (!esc) throw new Error(`no such escalation: ${id}`);
    this.conn.prepare(`UPDATE escalations SET answer = ? WHERE id = ?`).run(answer, id);
    this.setRepoStatus(esc.repo_id, "running");
    this.changed();
  }

  // ---- findings (durable log: AI decisions made along the way, or items surfaced for a human) ----

  addFinding(
    repoId: string,
    text: string,
    phase: string,
    by: FindingBy,
    sev: FindingSev,
    disposition: string,
    flagForReview = false
  ): Finding {
    const id = `f-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const requirementId = this.currentRequirementId();
    this.conn
      .prepare(
        `INSERT INTO findings (id, repo_id, text, phase, disposition, by, sev, answer, created_at, requirement_id, flag_for_review)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`
      )
      .run(id, repoId, text, phase, disposition, by, sev, sortableClock(), requirementId, flagForReview ? 1 : 0);
    this.changed();
    return this.getFinding(id)!;
  }

  getFinding(id: string): Finding | undefined {
    return this.conn.prepare(`SELECT * FROM findings WHERE id = ?`).get(id) as unknown as
      | Finding
      | undefined;
  }

  listFindings(filter?: { hasAnswer?: boolean; since?: string }): Finding[] {
    const clauses: string[] = [];
    const params: any[] = [];
    if (filter?.hasAnswer === true) clauses.push(`answer != ''`);
    if (filter?.hasAnswer === false) clauses.push(`answer = ''`);
    if (filter?.since) {
      clauses.push(`created_at >= ?`);
      params.push(filter.since);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.conn.prepare(`SELECT * FROM findings ${where} ORDER BY created_at`).all(...params) as unknown as Finding[];
  }

  // Dashboard-only (see extension.ts/server.ts) — a human pushing back on
  // a finding the coordinator already decided autonomously. Toggling,
  // not a one-way flag: a human can also un-dispute once satisfied.
  setFindingDisputed(id: string, disputed: boolean) {
    this.conn.prepare(`UPDATE findings SET disputed = ? WHERE id = ?`).run(disputed ? 1 : 0, id);
    this.changed();
  }

  countDisputedFindingsForRequirement(requirementId: number): number {
    const row = this.conn
      .prepare(`SELECT COUNT(*) AS n FROM findings WHERE requirement_id = ? AND disputed = 1`)
      .get(requirementId) as { n: number };
    return row.n;
  }

  countWaitingOnHumanFindingsForRequirement(requirementId: number): number {
    const row = this.conn
      .prepare(`SELECT COUNT(*) AS n FROM findings WHERE requirement_id = ? AND by = 'wait'`)
      .get(requirementId) as { n: number };
    return row.n;
  }

  addLearning(input: Omit<Learning, "id" | "created_at">): Learning {
    const id = `l-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const created_at = sortableClock();
    this.conn
      .prepare(
        `INSERT INTO learnings (id, requirement_id, requirement_title, repo_id, repo_label, lessons, decisions, future_improvements, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.requirement_id,
        input.requirement_title,
        input.repo_id,
        input.repo_label,
        input.lessons,
        input.decisions,
        input.future_improvements,
        input.text,
        created_at
      );
    this.changed();
    return { id, created_at, ...input };
  }

  // Newest first — a Learnings tab reads top-to-bottom as a log of
  // requirements as they closed out, not a plan to scroll to the bottom of.
  listLearnings(): Learning[] {
    return this.conn.prepare(`SELECT * FROM learnings ORDER BY created_at DESC`).all() as unknown as Learning[];
  }

  // A human answering a "waiting on human" finding. This only records the
  // decision in the log — it does NOT relay it to the agent. Relaying is a
  // separate, later dispatch (see the disposition text this sets).
  answerFinding(id: string, answer: string) {
    this.conn
      .prepare(
        `UPDATE findings SET answer = ?, by = 'human', sev = 'watch', disposition = 'Answered — dispatch pending' WHERE id = ?`
      )
      .run(answer, id);
    this.changed();
  }

  // ---- logs (per-repo, tagged — the Watch panel's structured message stream) ----

  appendLog(repoId: string, tag: string, text: string) {
    this.conn
      .prepare(`INSERT INTO logs (repo_id, t, tag, text) VALUES (?, ?, ?, ?)`)
      .run(repoId, clock(), tag, text);
    this.changed();
  }

  recentLogs(repoId: string, limit = 40): LogLine[] {
    const rows = this.conn
      .prepare(`SELECT * FROM logs WHERE repo_id = ? ORDER BY id DESC LIMIT ?`)
      .all(repoId, limit) as unknown as LogLine[];
    return rows.reverse();
  }

  // ---- tasks (the gantt — regenerated from these rows, never hand-edited) ----

  upsertTask(t: Task) {
    // requirement_id is deliberately NOT in the ON CONFLICT...UPDATE clause:
    // a task keeps belonging to whichever requirement first created it, even
    // as later upserts amend its status/deps — only the initial INSERT arm
    // stamps it, from the requirement that's current *right now*.
    this.conn
      .prepare(
        `INSERT INTO tasks (id, repo, task, start_h, dur_h, status, deps_json, milestone, contract, covers_json, done_evidence, requirement_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET repo=excluded.repo, task=excluded.task,
           start_h=excluded.start_h, dur_h=excluded.dur_h, status=excluded.status,
           deps_json=excluded.deps_json, milestone=excluded.milestone, contract=excluded.contract,
           covers_json=excluded.covers_json, done_evidence=excluded.done_evidence`
      )
      .run(
        t.id,
        t.repo,
        t.task,
        t.start_h,
        t.dur_h,
        t.status,
        JSON.stringify(t.deps),
        t.milestone,
        t.contract ?? "",
        JSON.stringify(t.covers ?? []),
        t.doneEvidence ?? "",
        this.currentRequirementId()
      );
    this.changed();
  }

  listTasks(): Task[] {
    const rows = this.conn.prepare(`SELECT * FROM tasks ORDER BY start_h, rowid`).all() as any[];
    return rows.map((r) => ({ ...r, deps: JSON.parse(r.deps_json), covers: JSON.parse(r.covers_json), doneEvidence: r.done_evidence }));
  }

  // Only this requirement's own tasks — used by the phase gates so a new
  // requirement can't coast to "implement"/"closing" on a previous
  // requirement's already-done task graph.
  tasksForRequirement(requirementId: number): Task[] {
    const rows = this.conn
      .prepare(`SELECT * FROM tasks WHERE requirement_id = ? ORDER BY start_h, rowid`)
      .all(requirementId) as any[];
    return rows.map((r) => ({ ...r, deps: JSON.parse(r.deps_json), covers: JSON.parse(r.covers_json), doneEvidence: r.done_evidence }));
  }

  addChecklistItems(requirementId: number, items: Array<{ text: string; ambiguous?: boolean }>): ChecklistItem[] {
    const created_at = sortableClock();
    const insert = this.conn.prepare(
      `INSERT INTO checklist_items (id, requirement_id, text, ambiguous, created_at) VALUES (?, ?, ?, ?, ?)`
    );
    const rows: ChecklistItem[] = items.map((item, i) => {
      const id = `c-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`;
      const ambiguous: 0 | 1 = item.ambiguous ? 1 : 0;
      insert.run(id, requirementId, item.text, ambiguous, created_at);
      return { id, requirement_id: requirementId, text: item.text, ambiguous, created_at };
    });
    this.changed();
    return rows;
  }

  checklistForRequirement(requirementId: number): ChecklistItem[] {
    return this.conn
      .prepare(`SELECT * FROM checklist_items WHERE requirement_id = ? ORDER BY rowid`)
      .all(requirementId) as unknown as ChecklistItem[];
  }

  // ---- Plan → Docs categories (configurable, see DocCategory) ----

  listDocCategories(): DocCategory[] {
    return this.conn.prepare(`SELECT * FROM doc_categories ORDER BY seq`).all() as unknown as DocCategory[];
  }

  addDocCategory(label: string): DocCategory {
    const base =
      label
        .trim()
        .replace(/[^a-zA-Z0-9]+/g, " ")
        .trim()
        .split(" ")
        .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
        .join("") || "category";
    const existingIds = new Set(this.listDocCategories().map((c) => c.id));
    let id = base;
    let n = 2;
    while (existingIds.has(id)) {
      id = `${base}${n}`;
      n++;
    }
    const seq = (
      this.conn.prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM doc_categories`).get() as { n: number }
    ).n;
    this.conn.prepare(`INSERT INTO doc_categories (id, label, seq) VALUES (?, ?, ?)`).run(id, label.trim(), seq);
    this.changed();
    return { id, label: label.trim(), seq };
  }

  // The category's own already-submitted doc text (meta's plan_doc_<id>)
  // is deliberately left in place — removing the category just takes it
  // out of the configured list and Implement's gate, not a data wipe; a
  // re-added category under the same id would see its old text again.
  removeDocCategory(id: string) {
    this.conn.prepare(`DELETE FROM doc_categories WHERE id = ?`).run(id);
    this.changed();
  }

  getPlanDocs(): PlanDocs {
    const out: PlanDocs = {};
    for (const c of this.listDocCategories()) out[c.id] = this.getMeta(`plan_doc_${c.id}`) || "";
    return out;
  }

  setPlanDoc(categoryId: string, text: string) {
    this.setMeta(`plan_doc_${categoryId}`, text);
  }

  // A unified "is anything happening" feed: one entry when a dispatch is
  // actually sent, another when its response lands — derived from the
  // dispatches table already written by markDispatchSent/setDispatchResponse,
  // not a separate thing that has to be kept in sync with it.
  listLogEntries(limit = 100): LogEntry[] {
    const rows = this.conn
      .prepare(
        `SELECT d.at, d.responded_at, d.text, d.response, r.repo AS repo_name
         FROM dispatches d JOIN repos r ON r.id = d.repo_id
         WHERE d.at != '' OR d.responded_at != ''`
      )
      .all() as any[];

    const entries: LogEntry[] = [];
    for (const row of rows) {
      if (row.at) {
        entries.push({
          when: row.at,
          repo: row.repo_name,
          text: `dispatched — ${String(row.text).split("\n")[0].slice(0, 100)}`,
        });
      }
      if (row.responded_at) {
        entries.push({
          when: row.responded_at,
          repo: row.repo_name,
          text: `responded — ${String(row.response).split("\n")[0].slice(0, 100)}`,
        });
      }
    }
    // Same HH:MM:SS-only convention as clock() elsewhere in this file
    // (see its own comment) — string-sortable within a day, and this
    // whole system doesn't track dates beyond that yet.
    entries.sort((a, b) => a.when.localeCompare(b.when));
    return entries.slice(-limit).reverse();
  }

  // ---- snapshot for the webview ----

  snapshot(): Snapshot {
    const repos = this.listRepos().map((r) => ({
      ...r,
      dispatches: this.listDispatches(r.id),
      escalation: this.openEscalationForRepo(r.id),
      pullRequests: this.listPullRequests(r.id),
    }));
    const logs: Record<string, LogLine[]> = {};
    for (const r of repos) logs[r.id] = this.recentLogs(r.id);
    return {
      repos,
      findings: this.listFindings(),
      tasks: this.listTasks(),
      checklist: this.checklistForRequirement(this.currentRequirementId()),
      logs,
      log: this.listLogEntries(),
      learnings: this.listLearnings(),
      requirementPhase: this.getMeta("requirement_phase"),
      requirementTitle: this.getMeta("requirement_title"),
      cruiseControl: this.getMeta("cruise_control") === "on",
      docCategories: this.listDocCategories(),
      planDocs: this.getPlanDocs(),
      operatorGateEnabled: this.getMeta("operator_gate_enabled") === "on",
      operatorGatePending: this.getMeta("operator_gate_pending") === "on",
    };
  }

  // ---- meta / discovery support ----

  getMeta(key: string): string | null {
    const row = this.conn.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string) {
    this.conn
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  // ---- requirement lifecycle scoping ----
  //
  // set_requirement_phase's gates need to tell "evidence logged for THIS
  // requirement" apart from "evidence exists somewhere in the DB's history"
  // — otherwise a brand-new requirement coasts through every gate for free
  // on a previous, unrelated requirement's leftover findings/tasks. This id
  // is the scoping key that fixes that; it is bumped only when explicitly
  // starting a fresh requirement (see set_requirement_phase in mcpServer.ts),
  // never on every critique-phase re-entry.

  currentRequirementId(): number {
    const v = this.getMeta("requirement_id");
    if (v) return parseInt(v, 10);
    this.setMeta("requirement_id", "1");
    return 1;
  }

  bumpRequirementId(): number {
    const next = this.currentRequirementId() + 1;
    this.setMeta("requirement_id", String(next));
    return next;
  }

  // Marks "now" as the moment this requirement entered Closing — the Done
  // gate requires a finding logged at or after this point (the passing
  // combined end-to-end run), not just any finding from earlier in the
  // requirement's life.
  markClosingEntered() {
    this.setMeta("closing_entered_at", sortableClock());
  }

  countFindingsForRequirement(requirementId: number, sinceClock?: string): number {
    const row = sinceClock
      ? (this.conn
          .prepare(`SELECT COUNT(*) AS n FROM findings WHERE requirement_id = ? AND created_at >= ?`)
          .get(requirementId, sinceClock) as { n: number })
      : (this.conn.prepare(`SELECT COUNT(*) AS n FROM findings WHERE requirement_id = ?`).get(requirementId) as {
          n: number;
        });
    return row.n;
  }

  // Repos are keyed by a short id, but discovery only knows the real repo
  // name — this is how re-running discovery updates an existing row
  // (whichever id it was seeded/discovered under) instead of creating a
  // second one for the same repo.
  findRepoIdByName(repoName: string): string | null {
    const row = this.conn.prepare(`SELECT id FROM repos WHERE repo = ?`).get(repoName) as
      | { id: string }
      | undefined;
    return row?.id ?? null;
  }

  // Changes whenever ANY connection commits a write to this database file
  // — including a different process (mcpServer.ts, spawned separately per
  // coordinator session, writes through its own Db instance, so this
  // process's own onChange() never fires for that). This is how the
  // daemon detects those writes: poll this, not a same-process-only
  // callback, for anything that has to reflect writes from outside this
  // process.
  dataVersion(): number {
    const row = this.conn.prepare(`PRAGMA data_version`).get() as { data_version: number };
    return row.data_version;
  }

  close() {
    this.conn.close();
  }
}
