// Two independent, optional ways to populate the tracked repo list — pick
// either, both, or neither:
//
// - discoverGithubRepos: asks `gh` (the already-authenticated CLI, not a
//   token this tool manages itself) what repos exist for an owner, then
//   checks which ones happen to have a local clone under codeRoot. Finds
//   repos that exist remotely but aren't cloned yet (flagged, not hidden).
//   Needs `gh` installed and logged in, and network access.
// - discoverLocalSiblings: no network, no `gh`, no auth — just scans
//   codeRoot for directories that are git repos. Finds only what's already
//   on disk, nothing remote-only. The simpler default when you just want
//   "whatever's already checked out."
//
// Both are deliberately shallow: "what exists, and is it runnable" is all
// either answers. "What can be done with it" — stack, conventions, current
// state — is the intro-dispatch/summary mechanism's job (agentRunner.ts /
// prompts.ts), and it only needs a real local cwd to run, which is exactly
// what these establish. Different questions, different mechanisms.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Db } from "./db";

export interface DiscoveredRepo {
  repo: string;
  description: string;
  archived: boolean;
  isPrivate: boolean;
  cwd: string; // '' if no local clone was found under codeRoot
}

interface GhRepoListEntry {
  name: string;
  description: string | null;
  isArchived: boolean;
  isPrivate: boolean;
}

export function discoverGithubRepos(owner: string, codeRoot: string): DiscoveredRepo[] {
  const raw = execFileSync(
    "gh",
    ["repo", "list", owner, "--limit", "300", "--json", "name,description,isArchived,isPrivate"],
    { encoding: "utf8" }
  );
  const list = JSON.parse(raw) as GhRepoListEntry[];
  return list
    .filter((r) => !r.isArchived)
    .map((r) => {
      const candidate = path.join(codeRoot, r.name);
      const isLocal = fs.existsSync(path.join(candidate, ".git"));
      return {
        repo: r.name,
        description: r.description || "",
        archived: r.isArchived,
        isPrivate: r.isPrivate,
        cwd: isLocal ? candidate : "",
      };
    });
}

export function discoverLocalSiblings(codeRoot: string): DiscoveredRepo[] {
  const entries = fs.readdirSync(codeRoot, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(codeRoot, e.name, ".git")))
    .map((e) => ({
      repo: e.name,
      description: "",
      archived: false,
      isPrivate: false, // unknown, not scanned — this mode never talks to GitHub
      cwd: path.join(codeRoot, e.name),
    }));
}

function upsertDiscovered(db: Db, found: DiscoveredRepo[]): { discovered: number; withLocalClone: number } {
  for (const r of found) {
    const id = db.findRepoIdByName(r.repo) ?? r.repo;
    db.upsertRepo({
      id,
      repo: r.repo,
      // Never clobber a real local clone that this pass just didn't find
      // (e.g. codeRoot pointed somewhere else) with an empty one —
      // only set cwd if this pass actually found something, or the repo
      // is new.
      cwd: r.cwd || db.getRepo(id)?.cwd || "",
      phase: r.cwd ? db.getRepo(id)?.phase || "Discovered" : "Discovered — not cloned locally",
      prs: db.getRepo(id)?.prs || "—",
      agent_status: "stopped",
    });
  }
  return { discovered: found.length, withLocalClone: found.filter((r) => r.cwd).length };
}

export function runGithubDiscoveryAndUpsert(
  db: Db,
  owner: string,
  codeRoot: string
): { discovered: number; withLocalClone: number } {
  db.setMeta("github_owner", owner);
  db.setMeta("code_root", codeRoot);
  return upsertDiscovered(db, discoverGithubRepos(owner, codeRoot));
}

export function runLocalDiscoveryAndUpsert(db: Db, codeRoot: string): { discovered: number; withLocalClone: number } {
  db.setMeta("code_root", codeRoot);
  return upsertDiscovered(db, discoverLocalSiblings(codeRoot));
}
