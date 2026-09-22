// Shared between server.ts's stdio protocol (the VS Code webview's start/
// stop buttons) and mcpServer.ts (a controller starting/stopping a repo
// directly) so the safety guard — refuse to start a repo with no local
// clone, queue the first summary pass — lives in exactly one place
// rather than two implementations that can quietly drift apart.
import { Db } from "./db";
import { INTRO_PROMPT, CRUISE_CONTROL_PROMPT } from "./prompts";

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

// Shared between the dashboard's cruise-control toggle (server.ts) and
// set_cruise_control (mcp.ts) for the same reason startAgent/stopAgent
// are — one place deciding what actually happens when the setting flips,
// not two implementations that can drift. Only queues the reminder on a
// real off -> on transition (not a redundant "turn it on" call, and not
// on turning it off) — a running agent hears about cruise control once
// per time it actually starts applying, not once per toggle click.
export function applyCruiseControl(db: Db, on: boolean): { ok: true; cruiseControl: boolean } {
  const wasOn = db.getMeta("cruise_control") === "on";
  db.setMeta("cruise_control", on ? "on" : "off");
  if (on && !wasOn) {
    for (const repo of db.listRepos()) {
      if (!repo.cwd) continue; // nothing to dispatch to — no local clone
      db.queueCruiseControlDispatch(repo.id, CRUISE_CONTROL_PROMPT);
    }
  }
  return { ok: true, cruiseControl: on };
}
