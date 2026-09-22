#!/usr/bin/env node
// The persistent daemon. Spawned once by the VS Code extension on activate
// (and kept alive independent of any single webview), or run standalone for
// debugging (`node out/server.js --storage-dir <dir>`). Owns:
//  - the agent loop: polls each repo for its next queued dispatch and runs
//    it through agentRunner.ts
//  - a tiny newline-delimited JSON protocol (see ipc.ts) over a Unix domain
//    socket, so the extension host (which can't safely assume node:sqlite
//    is available in its own Electron/Node runtime) never touches a DB
//    file directly — it always goes through this process.
//  - every "database" the control center knows about, keyed by an opaque
//    identifier (dbId) rather than a file path, opened lazily on first
//    reference. Two callers naming the same dbId share the same live Db
//    instance (and its onChange wiring); two different dbIds are fully
//    isolated, each in its own file.
//  - the MCP protocol endpoint itself (see mcp.ts), served over plain HTTP
//    on a loopback port — one shared listener for every coordinator
//    session, instead of spawning a fresh node process per session (that
//    was mcpServer.ts, now deleted). Which dbId a given HTTP request is
//    for travels as a `?dbId=` query param, threaded through via
//    AsyncLocalStorage for the duration of that one request.
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Db, FindingBy } from "./db";
import { runDispatch } from "./agentRunner";
import { INTRO_PROMPT } from "./prompts";
import { runGithubDiscoveryAndUpsert, runLocalDiscoveryAndUpsert } from "./discover";
import { startAgent, stopAgent, applyCruiseControl } from "./repoActions";
import { IpcServer, IpcRequest } from "./ipc";
import { createMcpServer } from "./mcp";

const POLL_MS = 2000;

function parseArg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const storageDir = parseArg("--storage-dir", `${process.env.HOME}/.control-center`);
// NOT derived from storageDir by default: a Unix domain socket path is
// bound by the OS's sockaddr_un limit (~104 bytes on macOS/BSD), unlike a
// regular file path — a long --storage-dir (the extension's globalStorage
// directory, for instance, at 127 bytes) would overflow it. os.tmpdir()
// stays short regardless of where the data itself lives.
const socketPath = parseArg("--socket", path.join(os.tmpdir(), "control-center-daemon.sock"));
fs.mkdirSync(storageDir, { recursive: true });

const DB_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// "default" keeps its historical filename (control-center.db) so an
// existing install's data is picked up unchanged with no migration step;
// every other id maps to <id>.db under the same directory. This mapping —
// not a path — is the only thing a caller (dashboard or MCP client) ever
// gets to name, which is what makes an MCP client naming the "wrong" file
// structurally impossible now: there is no path parameter left to get wrong.
function resolveDbPath(dbId: string): string {
  if (!DB_ID_RE.test(dbId)) throw new Error(`invalid database id "${dbId}" — must match ${DB_ID_RE}`);
  return path.join(storageDir, dbId === "default" ? "control-center.db" : `${dbId}.db`);
}

function listDatabases(): string[] {
  let files: string[];
  try {
    files = fs.readdirSync(storageDir);
  } catch {
    files = [];
  }
  const ids = new Set<string>();
  for (const f of files) {
    if (f === "control-center.db") ids.add("default");
    else if (f.endsWith(".db")) ids.add(f.slice(0, -".db".length));
  }
  for (const dbId of dbs.keys()) ids.add(dbId); // an id can exist (opened, not yet flushed to disk) before its file does
  return Array.from(ids).sort();
}

// Richer than listDatabases: opens each known dbId (lazily, same as any
// other reference to it — see getDbEntry) to read its own requirement
// phase/title and repo count, so a coordinator picking a database via the
// select_database MCP tool can tell them apart without switching into
// each one blind first.
function describeDatabases(): Array<{
  id: string;
  requirementPhase: string | null;
  requirementTitle: string | null;
  requirementSummary: string | null;
  repoCount: number;
}> {
  return listDatabases().map((id) => {
    const db = getDbEntry(id).entry.db;
    return {
      id,
      requirementPhase: db.getMeta("requirement_phase"),
      requirementTitle: db.getMeta("requirement_title"),
      requirementSummary: db.getMeta("requirement_summary"),
      repoCount: db.listRepos().length,
    };
  });
}

type DbEntry = { db: Db; busy: Set<string>; lastDataVersion: number };
const dbs = new Map<string, DbEntry>();

// agent_status "running" is written once, at the start of runDispatch, and
// only ever cleared at the end of that SAME async call once a response is
// recorded (see agentRunner.ts). Nothing re-checks it against whether a
// process is actually alive — there's no heartbeat. `busy` (per DbEntry) is
// this process's own bookkeeping of what IT is currently running, and it
// starts empty every time a given dbId is first opened. So the first time
// THIS process opens a dbId, any repo already showing "running" in that
// DB cannot be this process's doing — it's left over from a previous
// incarnation that died mid-dispatch (a crash, a forced VS Code quit, the
// machine sleeping/losing power), not real, in-progress work. Left alone,
// that's a green dot with no process behind it, indefinitely. Reconcile it
// right when a dbId is opened, not just once at daemon startup, since a
// dbId can now be opened lazily at any point in the daemon's lifetime.
function reconcileOrphans(db: Db) {
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
}

function getDbEntry(dbIdRaw: string | undefined): { dbId: string; entry: DbEntry } {
  const dbId = dbIdRaw || "default";
  let entry = dbs.get(dbId);
  if (!entry) {
    const db = new Db(resolveDbPath(dbId));
    // No seed data of any kind — an empty repos table on first connect is
    // the signal the extension/coordinator uses to offer real discovery
    // (see discoverGithubRepos/discoverLocalRepos below), not a hardcoded
    // list.
    reconcileOrphans(db);
    entry = { db, busy: new Set(), lastDataVersion: db.dataVersion() };
    db.onChange(() => notifyChanged(dbId));
    dbs.set(dbId, entry);
    // A brand-new dbId appearing is a whole-daemon fact (the set of
    // known databases changed), not something scoped to any one
    // dbId's own content — broadcasting it as a plain "update" tagged
    // with this dbId would get silently filtered out by every client
    // NOT currently looking at this dbId (see RunnerClient.onUpdate in
    // extension.ts), which is exactly the bug this fixes: a dbId
    // created by an MCP client (or the dashboard's own "add database"
    // button) previously never showed up in another window's dropdown
    // without a manual reload/restart. This event carries no dbId, so
    // it's never filtered — every connected client re-checks
    // listDatabases.
    ipc.broadcast({ event: "databasesChanged" });
  }
  return { dbId, entry };
}

// ---- socket protocol ----

const changePending = new Set<string>();
function notifyChanged(dbId: string) {
  if (changePending.has(dbId)) return;
  changePending.add(dbId);
  setImmediate(() => {
    changePending.delete(dbId);
    ipc.broadcast({ event: "update", dbId });
  });
}

// Same-process writes (this daemon's own command handlers, agentRunner.ts
// via the tick loop below) fire db.onChange() directly. Writes from a
// second daemon process — shouldn't normally happen (see ipc.ts's stale
// socket handling), but a dbId's file could in principle be touched by
// something outside this daemon entirely — aren't caught that way; piggy-
// backing dataVersion polling onto the same interval the dispatch loop
// already runs on covers that case too, same as before this file had more
// than one Db to watch.
function tickOne(dbId: string, entry: DbEntry) {
  const { db, busy } = entry;
  const v = db.dataVersion();
  if (v !== entry.lastDataVersion) {
    entry.lastDataVersion = v;
    notifyChanged(dbId);
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

setInterval(() => {
  for (const [dbId, entry] of dbs) tickOne(dbId, entry);
}, POLL_MS);

// ---- MCP HTTP endpoint ----
//
// A McpServer/StreamableHTTPServerTransport PAIR PER CLIENT SESSION, not
// one shared instance for the whole daemon — confirmed by hitting this
// directly: a single transport only ever completes one MCP "initialize"
// handshake, ever; a second client's own initialize on the same
// transport is rejected ("Server already initialized"). Sessions are
// still cheap in-process objects (a Map entry, not an OS process), so the
// resource win this redesign is actually after — no per-session node
// process — is unaffected; only the "one instance for everyone" shortcut
// was wrong. This is the SDK's own documented pattern for a stateful
// multi-session HTTP server (see its examples): route each request by its
// Mcp-Session-Id header to the session that already owns it, or spin up a
// fresh pair for what should be an initialize request with no header yet.
//
// Which dbId a brand-new session starts on is ambient (threaded through
// AsyncLocalStorage from the request's own `?dbId=` query param) — but
// that's only ever consulted once, to seed a session at the moment it's
// created. From then on, which dbId that session's tool calls operate on
// is its OWN mutable state (session.dbId below), switchable at runtime by
// that session calling the select_database tool — one MCP registration
// (one URL, one optional starting dbId) can serve any database over its
// lifetime, not just whichever id happened to be in the URL. Each session
// already gets its own private McpServer/transport pair (see the note
// below), so this state lives there too — no separate session-id map
// needed for it.
const dbIdStorage = new AsyncLocalStorage<string>();

// A McpServer/StreamableHTTPServerTransport PAIR PER CLIENT SESSION, not
// one shared instance for the whole daemon — confirmed by hitting this
// directly: a single transport only ever completes one MCP "initialize"
// handshake, ever; a second client's own initialize on the same
// transport is rejected ("Server already initialized"). Sessions are
// still cheap in-process objects (a Map entry, not an OS process), so the
// resource win this redesign is actually after — no per-session node
// process — is unaffected; only the "one instance for everyone" shortcut
// was wrong. This is the SDK's own documented pattern for a stateful
// multi-session HTTP server (see its examples): route each request by its
// Mcp-Session-Id header to the session that already owns it, or spin up a
// fresh pair for what should be an initialize request with no header yet.
type McpSession = { transport: StreamableHTTPServerTransport; dbId: string };
const mcpSessions = new Map<string, McpSession>();

async function handleMcpHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const sessionIdHeader = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
  let session = sessionId ? mcpSessions.get(sessionId) : undefined;
  if (!session) {
    const state: McpSession = { transport: null as any, dbId: dbIdStorage.getStore() || "default" };
    const mcpServerInstance = createMcpServer({
      getDb: () => getDbEntry(state.dbId).entry.db,
      getDbId: () => state.dbId,
      setDbId: (dbId) => {
        state.dbId = dbId;
      },
      describeDatabases,
    });
    state.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        mcpSessions.set(newSessionId, state);
      },
      onsessionclosed: (closedSessionId) => {
        mcpSessions.delete(closedSessionId);
      },
    });
    await mcpServerInstance.connect(state.transport);
    session = state;
  }
  await session.transport.handleRequest(req, res);
}

// 0 (the default) means "OS picks any free ephemeral port" — always
// succeeds, but a fresh port every daemon restart invalidates every
// already-registered .mcp.json, including across a plain reboot (nothing
// keeps a detached process alive across that). The extension asks for a
// specific port instead once it has one persisted in settings (see
// extension.ts's syncHttpPortSetting), so the common case is: pick once,
// reuse forever. A real conflict (something else now holds that port) is
// reported as an explicit error via getHttpPort rather than silently
// falling back to a different port, which would defeat the point —
// better to tell the user to change the setting than to keep silently
// moving the target.
const desiredHttpPort = Number(parseArg("--http-port", "0")) || 0;
let httpPort: number | null = null;
let httpPortError: string | null = null;
const httpServer = http.createServer((req, res) => {
  const dbId = new URL(req.url || "/", "http://localhost").searchParams.get("dbId") || "default";
  dbIdStorage.run(dbId, () => handleMcpHttpRequest(req, res)).catch((err) => {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? String(err) }));
    }
  });
});
httpServer.on("error", (err: any) => {
  httpPortError =
    err?.code === "EADDRINUSE"
      ? `Port ${desiredHttpPort} (Agent Control Center's configured daemon port) is already in use by something else on this machine. Change the "Agent Control Center: Daemon Port" setting to a free port and restart the runner.`
      : `MCP HTTP endpoint failed to start: ${err?.message ?? err}`;
  process.stderr.write(`${httpPortError}\n`);
});
httpServer.listen(desiredHttpPort, "127.0.0.1", () => {
  const addr = httpServer.address();
  httpPort = typeof addr === "object" && addr ? addr.port : null;
  process.stderr.write(`control-center MCP endpoint listening on http://127.0.0.1:${httpPort}/mcp\n`);
});

function handle(req: IpcRequest): unknown {
  // Whole-daemon operations that don't resolve to (or, for delete, must
  // outlive) a single already-open dbId.
  if (req.cmd === "listDatabases") return { databases: describeDatabases() };
  if (req.cmd === "getHttpPort") return { port: httpPort, error: httpPortError };
  if (req.cmd === "createDatabase") {
    // Lazily creates (idempotent if it already exists) — this exists so
    // the dashboard's own "add database" button can show a genuinely
    // empty state immediately, rather than the dbId only coming into
    // being whenever some MCP client first happens to reference it.
    const dbId = req.dbId as string;
    if (!dbId) throw new Error("dbId is required");
    getDbEntry(dbId); // resolveDbPath (inside) validates the id and throws on a bad one
    return { ok: true, dbId };
  }
  if (req.cmd === "deleteDatabase") {
    // No special-casing of "default" here — whether that's safe to wipe
    // is a policy call for the caller (the dashboard's resetAllData
    // command, which confirms with the user first), not this daemon's to
    // enforce; it has no way to know if a delete request was confirmed.
    const dbId = (req.dbId as string) || "default";
    const entry = dbs.get(dbId);
    if (entry) {
      entry.db.close();
      dbs.delete(dbId);
    }
    const dbPath = resolveDbPath(dbId);
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // fine if it didn't exist
      }
    }
    // Same reasoning as the new-dbId broadcast in getDbEntry: the set of
    // known databases just changed, which every connected client should
    // learn about regardless of which dbId it's currently looking at.
    ipc.broadcast({ event: "databasesChanged" });
    return { ok: true };
  }

  const { db } = getDbEntry(req.dbId).entry;

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
    // Deliberately NOT reachable from mcp.ts / any MCP tool — a human
    // pushing back on a finding the coordinator already decided
    // autonomously, same "only a human does this" pattern as the
    // operator gate. Toggling, not one-way: undisputing (on:false) is
    // how a dispute gets resolved.
    case "setFindingDisputed":
      db.setFindingDisputed(req.findingId, !!req.disputed);
      return { ok: true };
    case "addFinding":
      return db.addFinding(req.repoId, req.text, req.phase ?? "", "human", "watch", "Triage — not yet assessed");
    case "togglePause": {
      const repo = db.getRepo(req.repoId);
      if (!repo) throw new Error("no such repo");
      db.setRepoPaused(req.repoId, !repo.paused);
      return { ok: true };
    }
    case "setCruiseControl":
      return applyCruiseControl(db, !!req.on);
    // Deliberately NOT reachable from mcp.ts / any MCP tool — "only the
    // operator can select to proceed" means this daemon-side command is
    // only ever called from extension.ts, in response to an actual
    // dashboard button click, never from a coordinator session.
    case "setOperatorGate":
      db.setMeta("operator_gate_enabled", req.on ? "on" : "off");
      return { ok: true };
    case "approveImplement": {
      if (db.getMeta("operator_gate_pending") !== "on") {
        throw new Error("nothing is pending operator approval right now");
      }
      db.setMeta("operator_gate_pending", "off");
      db.setMeta("requirement_phase", "implement");
      return { ok: true };
    }
    case "stopAgent":
      return stopAgent(db, req.repoId);
    case "startAgent":
      return startAgent(db, req.repoId);
    case "refreshRepoSummary":
      return db.queueIntroDispatch(req.repoId, INTRO_PROMPT);
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

const ipc = new IpcServer(socketPath, handle);
process.stderr.write(`control-center daemon listening on ${socketPath}\n`);

process.on("SIGTERM", () => {
  for (const entry of dbs.values()) entry.db.close();
  ipc.close();
  httpServer.close();
  process.exit(0);
});
