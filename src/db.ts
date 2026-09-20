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
}

export interface Dispatch {
  id: string;
  repo_id: string;
  text: string;
  state: DispatchState;
  at: string;
  response: string;
  session_id: string | null;
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
}

export interface Snapshot {
  repos: (Repo & { dispatches: Dispatch[]; escalation: Escalation | null })[];
  findings: Finding[];
  tasks: Task[];
  logs: Record<string, LogLine[]>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  cwd TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT '',
  prs TEXT NOT NULL DEFAULT '',
  agent_status TEXT NOT NULL DEFAULT 'stopped',
  paused INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dispatches (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  text TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  at TEXT NOT NULL DEFAULT '',
  response TEXT NOT NULL DEFAULT '',
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
  created_at TEXT NOT NULL
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
  milestone INTEGER NOT NULL DEFAULT 0
);
`;

function clock(): string {
  const d = new Date();
  const pad = (n: number) => (n < 10 ? "0" : "") + n;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
  }

  onChange(cb: () => void) {
    this.onChangeCb = cb;
  }

  private changed() {
    if (this.onChangeCb) this.onChangeCb();
  }

  // ---- repos ----

  upsertRepo(r: Omit<Repo, "paused"> & { paused?: boolean }) {
    this.conn
      .prepare(
        `INSERT INTO repos (id, repo, cwd, phase, prs, agent_status, paused)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET repo=excluded.repo, cwd=excluded.cwd,
           phase=excluded.phase, prs=excluded.prs`
      )
      .run(r.id, r.repo, r.cwd, r.phase, r.prs, r.agent_status, r.paused ? 1 : 0);
    this.changed();
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
        `INSERT INTO dispatches (id, repo_id, text, state, at, response, session_id, seq)
         VALUES (?, ?, ?, 'queued', '', '', NULL, ?)`
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
    this.conn.prepare(`UPDATE dispatches SET response = ? WHERE id = ?`).run(response, id);
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
    disposition: string
  ): Finding {
    const id = `f-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.conn
      .prepare(
        `INSERT INTO findings (id, repo_id, text, phase, disposition, by, sev, answer, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', ?)`
      )
      .run(id, repoId, text, phase, disposition, by, sev, clock());
    this.changed();
    return this.getFinding(id)!;
  }

  getFinding(id: string): Finding | undefined {
    return this.conn.prepare(`SELECT * FROM findings WHERE id = ?`).get(id) as unknown as
      | Finding
      | undefined;
  }

  listFindings(): Finding[] {
    return this.conn.prepare(`SELECT * FROM findings ORDER BY created_at`).all() as unknown as Finding[];
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
    this.conn
      .prepare(
        `INSERT INTO tasks (id, repo, task, start_h, dur_h, status, deps_json, milestone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET repo=excluded.repo, task=excluded.task,
           start_h=excluded.start_h, dur_h=excluded.dur_h, status=excluded.status,
           deps_json=excluded.deps_json, milestone=excluded.milestone`
      )
      .run(t.id, t.repo, t.task, t.start_h, t.dur_h, t.status, JSON.stringify(t.deps), t.milestone);
    this.changed();
  }

  listTasks(): Task[] {
    const rows = this.conn.prepare(`SELECT * FROM tasks ORDER BY start_h, rowid`).all() as any[];
    return rows.map((r) => ({ ...r, deps: JSON.parse(r.deps_json) }));
  }

  // ---- snapshot for the webview ----

  snapshot(): Snapshot {
    const repos = this.listRepos().map((r) => ({
      ...r,
      dispatches: this.listDispatches(r.id),
      escalation: this.openEscalationForRepo(r.id),
    }));
    const logs: Record<string, LogLine[]> = {};
    for (const r of repos) logs[r.id] = this.recentLogs(r.id);
    return {
      repos,
      findings: this.listFindings(),
      tasks: this.listTasks(),
      logs,
    };
  }

  close() {
    this.conn.close();
  }
}
