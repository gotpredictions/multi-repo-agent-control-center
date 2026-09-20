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
import { Db } from "./db";

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
  "List every repo the control center tracks, with its current agent status (running/idle/needsHuman/stopped), phase, and paused-queue flag.",
  {},
  async () => text(db.listRepos())
);

server.tool(
  "get_repo_status",
  "Full status for one repo: its metadata, its dispatch queue, and its open permission escalation if it's currently blocked (agent_status: needsHuman).",
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
    return text(db.queueDispatch(repoId, body));
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch((err) => {
  process.stderr.write(`control-center MCP server failed to start: ${err?.message ?? err}\n`);
  process.exit(1);
});
