// Shared between server.ts (queues this automatically on first start) and
// mcp.ts (lets a coordinator explicitly request a fresh one) so the two
// never drift on what "introspect this repo" actually means.
export const INTRO_PROMPT =
  "Introduce this repository to whoever is coordinating work across many repos, without " +
  "assuming they've read it themselves. Cover: what it is and its role in the larger " +
  "system (check CLAUDE.md/AGENTS.md/README if present), its stack and structure, any " +
  "conventions a dispatch to this repo should respect, and its current git state (branch, " +
  "uncommitted changes, a few recent commits). A few tight paragraphs, not an essay. " +
  "Do not modify anything.";

// Queued automatically to every runnable repo whenever cruise control turns
// on (see repoActions.ts's applyCruiseControl, called from both the
// dashboard toggle and set_cruise_control) — a heads-up, not a task, so it
// asks for no response and doesn't block whatever's already queued behind
// it. Coordinator sessions get the equivalent framing from get_methodology's
// AUTONOMOUS_DECISION_GUIDANCE_CRUISE_ON, but a repo-level agent taking a
// direct dispatch has no reason to ever call get_methodology itself — this
// is the only way that context reaches it.
export const CRUISE_CONTROL_PROMPT =
  "Heads up: cruise control is now on for this session. The coordinator wants you to default to " +
  "deciding things yourself rather than stopping to ask — for anything you'd normally pause on, make " +
  "the call, keep going, and just mention what you decided and why in your next response back. Only " +
  "stop and ask directly if you're genuinely blocked (missing access, a destructive/irreversible " +
  "action, or a choice the coordinator would clearly want to weigh in on themselves). This is just " +
  "context for how to handle whatever comes next — no action needed on this message itself.";

// Queued automatically to every runnable repo when a requirement reaches
// Done (see mcp.ts's set_requirement_phase) — the repo's very last action
// before its agent is stopped. Asks for the same three things the
// coordinator itself has to submit to reach Done in the first place (see
// SERVER_INSTRUCTIONS' Done section in mcp.ts), so both the coordinator's
// overall view and each repo's own perspective land in the Learnings tab.
export function learningsPrompt(requirementTitle: string): string {
  return (
    `The requirement${requirementTitle ? ` "${requirementTitle}"` : ""} is now Done, and this is the last ` +
    "thing to do before your agent stops. Report, specifically about the work YOU did on this repo for " +
    "this requirement (not a general repo status):\n\n" +
    "Lessons: what you learned doing this work — surprises, things that took longer than expected, " +
    "anything that would help someone doing similar work next time.\n\n" +
    "Decisions to record: choices you made that aren't obvious from the code alone, and why — the kind " +
    "of thing someone should know before changing this later.\n\n" +
    "Future improvements: what you'd do differently or fix next, if there were more time.\n\n" +
    "Answer under those three headings, in prose, as your final message. Do not modify anything."
  );
}
