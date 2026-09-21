#!/usr/bin/env node
// The persistent daemon. Spawned once by the VS Code extension on activate
// (and kept alive independent of any single webview), or run standalone for
// debugging (`node out/server.js --db <path>`). Owns:
//  - the agent loop: polls each repo for its next queued dispatch and runs
//    it through agentRunner.ts
//  - a tiny newline-delimited JSON protocol over its own stdin/stdout, so
//    the extension host (which can't safely assume node:sqlite is
//    available in its own Electron/Node runtime) never touches the DB file
//    directly — it always goes through this process.
//
// The MCP server (mcpServer.ts) is deliberately a SEPARATE process, spawned
// fresh per coordinator session by that session's own .mcp.json — it reads
// and writes the same SQLite file directly (WAL + busy_timeout make that
// safe for this low-concurrency, mostly-local-writes case) rather than
// going through this daemon. This daemon is what actually turns a queued
// dispatch into a real Agent SDK run; the MCP server just enqueues rows.
import * as readline from "node:readline";
import { Db } from "./db";
import { runDispatch } from "./agentRunner";
import { INTRO_PROMPT } from "./prompts";
import { runGithubDiscoveryAndUpsert, runLocalDiscoveryAndUpsert } from "./discover";
import { startAgent, stopAgent } from "./repoActions";

const POLL_MS = 2000;

function parseArg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dbPath = parseArg("--db", `${process.env.HOME}/.control-center/control-center.db`);
const db = new Db(dbPath);
// No seed data of any kind — an empty repos table on first connect is the
// signal the extension uses to offer real discovery (see
// discoverGithubRepos/discoverLocalRepos below), not a hardcoded list.

const busy = new Set<string>();

// agent_status "running" is written once, at the start of runDispatch, and
// only ever cleared at the end of that SAME async call once a response is
// recorded (see agentRunner.ts). Nothing re-checks it against whether a
// process is actually alive — there's no heartbeat. `busy` above is this
// process's own bookkeeping of what IT is currently running, and it starts
// empty on every launch, by construction. So on a fresh start, any repo
// already showing "running" in the DB cannot be this process's doing — it's
// left over from a PREVIOUS incarnation that died mid-dispatch (a crash, a
// forced VS Code quit, the machine sleeping/losing power), not real,
// in-progress work. Left alone, that's a green dot with no process behind
// it, indefinitely — the dashboard's one always-trusted "something is
// happening" signal, silently lying. Reconcile it before the poll loop
// starts: the repo goes back to idle, and its one orphaned dispatch (by
// construction, at most one can be state:'sent' with no response per repo —
// dispatches run strictly one at a time) gets an explicit response saying
// so, instead of sitting in "awaiting reply" forever with no way to tell it
// was abandoned rather than just slow.
for (const repo of db.listRepos()) {
  if (repo.agent_status !== "running") continue;
  const orphaned = db.listDispatches(repo.id).find((d) => d.state === "sent" && !d.response);
  if (orphaned) {
    db.setDispatchResponse(
      orphaned.id,
      "(interrupted — the control center's daemon process was restarted while this dispatch was running, " +
        "before any result was recorded. Re-dispatch if this still needs doing.)"
    );
  }
  db.setRepoStatus(repo.id, "idle");
  db.appendLog(
    repo.id,
    "warn",
    "daemon restarted while this repo showed running — reset to idle" +
      (orphaned ? ` and marked its in-flight dispatch (${orphaned.id}) as interrupted` : "")
  );
}

// ---- stdio protocol for the extension host ----

type Req = { id: number; cmd: string; [k: string]: any };

function send(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let changePending = false;
function notifyChanged() {
  if (changePending) return;
  changePending = true;
  setImmediate(() => {
    changePending = false;
    send({ event: "update" });
  });
}
db.onChange(notifyChanged);

// Same-process writes (this daemon's own command handlers, agentRunner.ts
// via the tick loop below) fire db.onChange() directly. Writes from
// mcpServer.ts — a separate process, spawned fresh per coordinator
// session — don't; they land in the same file but this process has no
// callback for them, only a poll-able signal (see Db.dataVersion). Piggy-
// backing on the same interval the dispatch loop already runs on, rather
// than adding a second timer.
let lastDataVersion = db.dataVersion();

function tick() {
  const v = db.dataVersion();
  if (v !== lastDataVersion) {
    lastDataVersion = v;
    notifyChanged();
  }

  for (const repo of db.listRepos()) {
    if (busy.has(repo.id)) continue;
    if (repo.paused) continue;
    if (repo.agent_status === "stopped") continue;
    if (repo.agent_status === "needsHuman") continue; // blocked on a live escalation
    if (!repo.cwd) continue; // no local clone — nothing to run the SDK against
    const next = db.nextQueuedDispatch(repo.id);
    if (!next) continue;
    busy.add(repo.id);
    runDispatch(db, repo, next)
      .catch((err) => {
        db.appendLog(repo.id, "warn", `dispatch failed — ${err?.message ?? err}`);
      })
      .finally(() => {
        busy.delete(repo.id);
      });
  }
}
setInterval(tick, POLL_MS);

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req: Req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  try {
    const data = handle(req);
    send({ id: req.id, ok: true, data });
  } catch (err: any) {
    send({ id: req.id, ok: false, error: err?.message ?? String(err) });
  }
});

function handle(req: Req): unknown {
  switch (req.cmd) {
    case "snapshot":
      return db.snapshot();
    case "dispatch":
      return db.queueDispatch(req.repoId, req.text);
    case "resolveEscalation":
      db.resolveEscalation(req.escalationId, req.answer);
      return { ok: true };
    case "answerFinding":
      db.answerFinding(req.findingId, req.answer);
      return { ok: true };
    case "addFinding":
      return db.addFinding(req.repoId, req.text, req.phase ?? "", "human", "watch", "Triage — not yet assessed");
    case "togglePause": {
      const repo = db.getRepo(req.repoId);
      if (!repo) throw new Error("no such repo");
      db.setRepoPaused(req.repoId, !repo.paused);
      return { ok: true };
    }
    case "stopAgent":
      return stopAgent(db, req.repoId);
    case "startAgent":
      return startAgent(db, req.repoId);
    case "refreshRepoSummary":
      db.queueIntroDispatch(req.repoId, INTRO_PROMPT);
      return { ok: true };
    case "discoverGithubRepos": {
      const owner = req.owner || db.getMeta("github_owner");
      const codeRoot = req.codeRoot || db.getMeta("code_root");
      if (!owner || !codeRoot) throw new Error("owner and codeRoot are required");
      return runGithubDiscoveryAndUpsert(db, owner, codeRoot);
    }
    case "discoverLocalRepos": {
      const codeRoot = req.codeRoot || db.getMeta("code_root");
      if (!codeRoot) throw new Error("codeRoot is required");
      return runLocalDiscoveryAndUpsert(db, codeRoot);
    }
    default:
      throw new Error(`unknown cmd: ${req.cmd}`);
  }
}

send({ event: "ready" });

process.on("SIGTERM", () => {
  db.close();
  process.exit(0);
});
