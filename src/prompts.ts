// Shared between server.ts (queues this automatically on first start) and
// mcpServer.ts (lets a controller explicitly request a fresh one) so the
// two processes never drift on what "introspect this repo" actually means.
export const INTRO_PROMPT =
  "Introduce this repository to whoever is coordinating work across many repos, without " +
  "assuming they've read it themselves. Cover: what it is and its role in the larger " +
  "system (check CLAUDE.md/AGENTS.md/README if present), its stack and structure, any " +
  "conventions a dispatch to this repo should respect, and its current git state (branch, " +
  "uncommitted changes, a few recent commits). A few tight paragraphs, not an essay. " +
  "Do not modify anything.";
