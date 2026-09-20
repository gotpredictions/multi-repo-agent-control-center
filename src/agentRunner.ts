// Drives one repo's agent via the Claude Agent SDK for a single dispatch.
//
// This is the piece with the most API-shape uncertainty in the whole build:
// it's written against the Agent SDK's documented `query()` shape (a prompt,
// an options bag with `cwd`/`canUseTool`/`permissionMode`, an async iterable
// of result messages) as of this writing, not against a locally verified
// type-check against the installed package's exact types. If the installed
// SDK's surface has drifted, this fails loudly into the repo's log lines and
// the runner's own stderr — not silently — so it's obvious to fix rather
// than a mystery hang.
//
// Two things open an escalation row, and only these two: canUseTool (the
// SDK's real permission gate — a tool call is actually blocked on our
// return value) and the ask_human custom tool below (the agent explicitly
// pausing its own turn for a decision it can't make alone, e.g. "commit
// and/or deploy?" — not a tool permission, but still not something a queued
// dispatch can answer, since the agent is sitting here waiting on THIS
// specific reply, in this same run). A dispatch never opens one, and an
// agent just asking something in passing text — without calling
// ask_human — is not treated as blocking; it's on the agent to actually
// signal that it can't continue, not on us to guess from prose.
import { Db, Repo, Dispatch, EscalationOption, EscalationKind } from "./db";
import { z } from "zod";

type CanUseToolResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

const ESCALATION_POLL_MS = 1000;
const ESCALATION_TIMEOUT_MS = 1000 * 60 * 60 * 12; // 12h — a human may be asleep, not gone.

async function waitForEscalationAnswer(
  db: Db,
  escalationId: string,
  signal: AbortSignal
): Promise<string> {
  const deadline = Date.now() + ESCALATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("aborted while waiting on a permission escalation");
    const esc = db.getEscalation(escalationId);
    if (esc && esc.answer !== null && esc.answer !== undefined) return esc.answer;
    await new Promise((r) => setTimeout(r, ESCALATION_POLL_MS));
  }
  throw new Error(`escalation ${escalationId} timed out unanswered after 12h`);
}

function genericOptionsFor(toolName: string): EscalationOption[] {
  return [
    { id: "approve", label: "Approve", rationale: `Allow ${toolName} to proceed with the requested input` },
    { id: "decline", label: "Decline", rationale: `Block this ${toolName} call` },
  ];
}

const ASK_HUMAN_INSTRUCTION =
  "\n\n---\nIf you reach a point where you genuinely cannot continue without the " +
  "human deciding something first — e.g. whether to commit, whether to deploy, " +
  "which of several real approaches to take — call the ask_human tool with your " +
  "question instead of just ending your turn and describing the choice in prose. " +
  "Only do this when you actually cannot proceed alone; if you're just reporting " +
  "finished work with nothing further required, end normally.";

export async function runDispatch(db: Db, repo: Repo, dispatch: Dispatch): Promise<void> {
  const dispatchId = dispatch.id;
  const text = dispatch.text;
  db.setRepoStatus(repo.id, "running");
  db.markDispatchSent(dispatchId, null);
  db.appendLog(
    repo.id,
    "info",
    `${dispatch.kind === "intro" ? "introspection " : ""}dispatch received — ${text.split("\n")[0].slice(0, 80)}`
  );

  const abortController = new AbortController();
  let finalText = "";

  try {
    // Imported dynamically so a missing/incompatible SDK install breaks only
    // the repo that was dispatched to, not the whole daemon at startup.
    const { query, tool, createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");

    const openAndAwait = async (
      kind: EscalationKind,
      escText: string,
      options: EscalationOption[]
    ): Promise<string> => {
      const esc = db.openEscalation(repo.id, kind, escText, repo.repo, options, null);
      const answer = await waitForEscalationAnswer(db, esc.id, abortController.signal);
      db.appendLog(repo.id, "you", answer);
      db.setRepoStatus(repo.id, "running");
      return answer;
    };

    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>
    ): Promise<CanUseToolResult> => {
      db.appendLog(repo.id, "ask", `permission needed — ${toolName}(${JSON.stringify(input).slice(0, 120)})`);
      const answer = await openAndAwait(
        "permission",
        `Allow ${toolName}?\n\n${JSON.stringify(input, null, 2)}`,
        genericOptionsFor(toolName)
      );
      if (answer === "Approve") {
        return { behavior: "allow", updatedInput: input };
      }
      // "Decline" or any free-text answer: deny, and hand the text back as
      // the reason so the agent can incorporate it (e.g. a narrower ask, or
      // context for why) rather than just stopping cold.
      return { behavior: "deny", message: answer };
    };

    const askHumanTool = tool(
      "ask_human",
      "Pause this turn and ask the human a direct question you genuinely need answered before you can continue — e.g. whether to commit, whether to deploy, which of several real approaches to take. This blocks until answered; the answer comes back as this tool's result so you can continue the same turn. Do not call this just to report progress or to ask something you could reasonably decide yourself.",
      {
        question: z.string().describe("The exact question to show the human."),
        options: z.array(z.string()).optional().describe("Short labels for the natural choices, if there are any (e.g. ['Commit only', 'Commit and deploy', 'Do neither']). Omit for a fully open question."),
      },
      async (args: { question: string; options?: string[] }) => {
        db.appendLog(repo.id, "ask", args.question.split("\n")[0].slice(0, 120));
        const opts: EscalationOption[] = (args.options ?? ["Yes", "No"]).map((label, i) => ({
          id: `opt-${i}`,
          label,
          rationale: "",
        }));
        const answer = await openAndAwait("reply", args.question, opts);
        return { content: [{ type: "text" as const, text: answer }] };
      }
    );
    const controlCenterTools = createSdkMcpServer({
      name: "control-center",
      version: "0.0.1",
      tools: [askHumanTool],
    });

    const stream = query({
      prompt: text + ASK_HUMAN_INSTRUCTION,
      options: {
        cwd: repo.cwd,
        canUseTool,
        permissionMode: "default",
        mcpServers: { "control-center": controlCenterTools },
      },
    } as any);

    for await (const message of stream as AsyncIterable<any>) {
      const type = message?.type;
      if (type === "assistant") {
        const blocks = message.message?.content ?? [];
        for (const b of blocks) {
          if (b.type === "text" && b.text) {
            finalText = b.text;
          } else if (b.type === "tool_use") {
            db.appendLog(repo.id, "bash", `${b.name}(${JSON.stringify(b.input ?? {}).slice(0, 100)})`);
          }
        }
      } else if (type === "result") {
        if (typeof message.result === "string") finalText = message.result;
        db.appendLog(repo.id, "out", "run complete");
      } else if (type === "system") {
        // init/session events — not worth a log line by default.
      }
    }
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    db.appendLog(repo.id, "warn", `runner error — ${msg}`);
    finalText = finalText || `(runner error: ${msg})`;
  } finally {
    abortController.abort();
  }

  db.setDispatchResponse(dispatchId, finalText);
  if (dispatch.kind === "intro" && finalText) {
    db.setRepoSummary(repo.id, finalText);
  }
  const repoNow = db.getRepo(repo.id);
  if (repoNow && repoNow.agent_status !== "needsHuman") {
    db.setRepoStatus(repo.id, "idle");
  }
}
