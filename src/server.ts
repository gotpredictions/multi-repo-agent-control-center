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
import { seedIfEmpty } from "./seed";
import { runDispatch } from "./agentRunner";

const POLL_MS = 2000;

function parseArg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dbPath = parseArg("--db", `${process.env.HOME}/.control-center/control-center.db`);
const db = new Db(dbPath);
seedIfEmpty(db);

const busy = new Set<string>();

function tick() {
  for (const repo of db.listRepos()) {
    if (busy.has(repo.id)) continue;
    if (repo.paused) continue;
    if (repo.agent_status === "stopped") continue;
    if (repo.agent_status === "needsHuman") continue; // blocked on a live escalation
    const next = db.nextQueuedDispatch(repo.id);
    if (!next) continue;
    busy.add(repo.id);
    runDispatch(db, repo, next.id, next.text)
      .catch((err) => {
        db.appendLog(repo.id, "warn", `dispatch failed — ${err?.message ?? err}`);
      })
      .finally(() => {
        busy.delete(repo.id);
      });
  }
}
setInterval(tick, POLL_MS);

// ---- stdio protocol for the extension host ----

type Req = { id: number; cmd: string; [k: string]: any };

function send(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let changePending = false;
db.onChange(() => {
  if (changePending) return;
  changePending = true;
  setImmediate(() => {
    changePending = false;
    send({ event: "update" });
  });
});

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
      db.setRepoStatus(req.repoId, "stopped");
      return { ok: true };
    case "startAgent":
      db.setRepoStatus(req.repoId, "idle");
      return { ok: true };
    default:
      throw new Error(`unknown cmd: ${req.cmd}`);
  }
}

send({ event: "ready" });

process.on("SIGTERM", () => {
  db.close();
  process.exit(0);
});
