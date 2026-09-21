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
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

type CanUseToolResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

// Supplying canUseTool at all makes the SDK route EVERY tool call through
// it, regardless of permissionMode — there is no "ask me only for the
// risky stuff, auto-approve the rest" for free. Without judgment here,
// "genuine escalation" became "escalate literally everything," which is
// not autonomous execution, it's an agent that can't take a single step
// unattended. This is where that judgment actually lives: auto-approve
// safe/routine work, escalate only what's actually worth a human's
// attention (outside the repo, or a short list of clearly destructive
// bash patterns) — not exhaustive, but the common real cases.
const ALWAYS_SAFE_TOOLS = new Set(["Read", "Glob", "Grep", "TodoWrite", "WebFetch", "WebSearch", "NotebookEdit"]);

// path.resolve doesn't follow symlinks — on macOS, repo.cwd is
// typically stored as /tmp/... or /Users/... while a tool call's actual
// file_path can come back resolved through a symlinked ancestor
// (/private/tmp/...), making a plain string comparison fail for a file
// that's genuinely inside the repo. Walk up to the nearest existing
// ancestor and realpath THAT (the target file itself may not exist yet
// — Write is often creating it) before comparing.
function realpathClosestExisting(p: string): string {
  let cur = p;
  for (;;) {
    try {
      return fs.realpathSync(cur);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return cur;
      cur = parent;
    }
  }
}

function isWithinCwd(filePath: unknown, cwd: string): boolean {
  if (typeof filePath !== "string" || !filePath) return false;
  const resolvedInput = path.resolve(cwd, filePath);
  const realCwd = realpathClosestExisting(path.resolve(cwd));
  const realInputAncestor = realpathClosestExisting(resolvedInput);
  const root = realCwd + path.sep;
  return realInputAncestor === realCwd || realInputAncestor.startsWith(root);
}

// System scratch space is already effectively unrestricted for these agents:
// Bash is auto-approved below whenever it doesn't match the danger patterns,
// and a plain `cat > /tmp/x` or `echo ... > /tmp/x` sails through that gate
// today — a repo-scoped Write/Edit to the exact same path was the one path
// that still escalated, purely because Write/Edit went through isWithinCwd
// and Bash didn't go through it at all. That's an inconsistency, not an
// extra safety layer: a scratch file in the OS temp dir can't touch this
// machine's other repos or anything outside it either way, so gate it the
// same way Bash already effectively is. os.tmpdir() (not a hardcoded /tmp)
// so this also covers macOS's real default (/var/folders/.../T/...), which
// Node's own tmp helpers resolve to instead of /tmp on most systems.
const TMP_ROOTS = [os.tmpdir(), "/tmp"].map((p) => realpathClosestExisting(path.resolve(p)));

function isWithinTmp(filePath: unknown): boolean {
  if (typeof filePath !== "string" || !filePath) return false;
  const resolvedInput = path.resolve(filePath);
  const realInputAncestor = realpathClosestExisting(resolvedInput);
  return TMP_ROOTS.some((root) => realInputAncestor === root || realInputAncestor.startsWith(root + path.sep));
}

// query() defaults to the Agent SDK's own bundled native binary
// (@anthropic-ai/claude-agent-sdk-<platform>, ~200MB per platform, all 8
// pulled in as optionalDependencies) unless pathToClaudeCodeExecutable is
// set. That bundled copy still needs its own auth (an API key) separate
// from whatever the user already logged into — bundling it buys nothing
// for someone who, by construction, already has Claude Code installed and
// authenticated to run this tool's own coordinator in the first place.
// Prefer whatever `claude` is already on PATH: same binary already
// authenticated, and it means this extension doesn't need to ship (or
// correctly target-match) a multi-hundred-MB native binary per platform
// at all. Falls back to the bundled one (this returns null, leaving
// pathToClaudeCodeExecutable unset) if nothing is found on PATH — a
// system without Claude Code installed at all is an unusual case for a
// tool whose whole purpose is coordinating Claude Code work, but it
// shouldn't hard-fail over it.
let cachedClaudeExecutable: string | null | undefined;

function resolveClaudeExecutable(): string | null {
  if (cachedClaudeExecutable !== undefined) return cachedClaudeExecutable;
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        cachedClaudeExecutable = candidate;
        // Logged to stderr (piped to the extension's Output channel by
        // extension.ts's RunnerClient), once, not per-dispatch — this is a
        // daemon-wide fact, not a per-repo event.
        console.error(`[agentRunner] using system claude on PATH: ${candidate}`);
        return candidate;
      } catch {
        // not here — keep looking
      }
    }
  }
  cachedClaudeExecutable = null;
  console.error(
    "[agentRunner] no claude executable found on PATH — falling back to the Agent SDK's own bundled binary, which needs its own separate auth."
  );
  return null;
}

// Denies (well, escalates) obviously catastrophic patterns rather than
// trying to allowlist "safe" commands — an allowlist would just
// recreate the same friction this fix exists to remove. Not exhaustive;
// a genuinely adversarial agent could work around this. It's a floor
// against accidents, not a sandbox.
const DANGEROUS_BASH = /\brm\s+-rf\s+(\/|~)(?!\S)|\bgit\s+push\s+.*--force\b|\bsudo\b|:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/;

function looksDangerous(command: unknown): boolean {
  return typeof command === "string" && DANGEROUS_BASH.test(command);
}

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
      if (ALWAYS_SAFE_TOOLS.has(toolName)) {
        return { behavior: "allow", updatedInput: input };
      }
      // The SDK routes calls to our OWN control-center MCP tools (namespaced
      // mcp__control-center__*, e.g. ask_human) through this same gate — so
      // without this, calling ask_human triggered a bogus generic permission
      // escalation ("Allow mcp__control-center__ask_human?") BEFORE the tool
      // handler ever ran to open the real, meaningful reply escalation with
      // the agent's actual question. That left the human clicking through a
      // content-free prompt first, then the real one — confirmed live: the
      // first prompt's placeholder had nothing to show because there was no
      // real question yet, just the raw tool-call args. ask_human's handler
      // (below) already does its own, correct openAndAwait — gating the call
      // itself here adds a redundant prompt, not a second layer of safety.
      if (toolName.startsWith("mcp__control-center__")) {
        return { behavior: "allow", updatedInput: input };
      }
      if (
        (toolName === "Write" || toolName === "Edit") &&
        (isWithinCwd(input.file_path, repo.cwd) || isWithinTmp(input.file_path))
      ) {
        return { behavior: "allow", updatedInput: input };
      }
      if (toolName === "Bash" && !looksDangerous(input.command)) {
        return { behavior: "allow", updatedInput: input };
      }

      // Everything else actually escalates: a Write/Edit outside the
      // repo's own cwd, a Bash command matching the danger patterns, or
      // any tool this list doesn't already know is routine. Logged in full
      // (not truncated) so the Output channel actually has what the
      // escalation is about, not just a 120-char fragment.
      db.appendLog(repo.id, "ask", `permission needed — ${toolName}(${JSON.stringify(input, null, 2)})`);
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
        db.appendLog(repo.id, "ask", args.question);
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

    const claudeExecutable = resolveClaudeExecutable();
    const stream = query({
      prompt: text + ASK_HUMAN_INSTRUCTION,
      options: {
        cwd: repo.cwd,
        canUseTool,
        permissionMode: "default",
        mcpServers: { "control-center": controlCenterTools },
        ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
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
            // Skip control-center's own tools (ask_human) here — their
            // handler already logs a clean, untruncated "[ask]" line with
            // the actual question right after this would've fired. Logging
            // both meant the human saw this generic echo first, truncated
            // to 100 chars mid-sentence, with no way to tell it was about
            // to be followed by the real, full question.
            if (!String(b.name).startsWith("mcp__control-center__")) {
              db.appendLog(repo.id, "bash", `${b.name}(${JSON.stringify(b.input ?? {}).slice(0, 100)})`);
            }
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
