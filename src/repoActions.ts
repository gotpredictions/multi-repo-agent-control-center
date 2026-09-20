// Shared between server.ts's stdio protocol (the VS Code webview's start/
// stop buttons) and mcpServer.ts (a controller starting/stopping a repo
// directly) so the safety guard — refuse to start a repo with no local
// clone, queue the first summary pass — lives in exactly one place
// rather than two implementations that can quietly drift apart.
import { Db } from "./db";
import { INTRO_PROMPT } from "./prompts";

export function startAgent(db: Db, repoId: string): { ok: true } {
  const repo = db.getRepo(repoId);
  if (!repo) throw new Error(`no such repo: ${repoId}`);
  if (!repo.cwd) {
    throw new Error(
      `${repo.repo} has no local clone (cwd: '') — nothing runnable at a known path. Use add_repo with a real cwd, or discover_local_repos/discover_github_repos, before starting it.`
    );
  }
  if (!db.hasIntroDispatch(repoId)) {
    db.queueIntroDispatch(repoId, INTRO_PROMPT);
  }
  db.setRepoStatus(repoId, "idle");
  return { ok: true };
}

export function stopAgent(db: Db, repoId: string): { ok: true } {
  const repo = db.getRepo(repoId);
  if (!repo) throw new Error(`no such repo: ${repoId}`);
  db.setRepoStatus(repoId, "stopped");
  return { ok: true };
}
