// First-run seed: the real repo list and the real gantt history from
// .github-private's control-center.md, so the dashboard opens showing the
// actual initiative instead of an empty table. Deliberately does NOT seed
// fake dispatches/escalations/findings — those are live interaction records
// this system hasn't actually produced yet, unlike the repo list and task
// history, which are real, known facts as of 2026-09-20.
import { Db, Task } from "./db";

const CODE_ROOT = "/Users/evso/code";

const REPOS: { id: string; repo: string; phase: string; prs: string }[] = [
  { id: "tmpl", repo: "worker-module-template", phase: "Phase 1", prs: "#1–#3 merged" },
  { id: "cms", repo: "capability-management-service", phase: "Phase 1", prs: "#1–#5 merged" },
  { id: "disp", repo: "github-app-dispatcher", phase: "Phase 1", prs: "#6–#8 open" },
  { id: "chk", repo: "checklist-service", phase: "Phase 1 · 2a", prs: "#1–#6 merged" },
  { id: "token", repo: "github-app-token-service", phase: "Existing service", prs: "#1 merged" },
  { id: "pr", repo: "pr-checks-service", phase: "Phase 2 · 2b", prs: "#1–#4 merged" },
  { id: "sec", repo: "security-compliance-service", phase: "Phase 2", prs: "—" },
  { id: "road", repo: "roadmap-service", phase: "Phase 2", prs: "—" },
  { id: "supp", repo: "support-service", phase: "Stress-test 2c", prs: "#1 merged" },
  { id: "e2e", repo: "e2e-tests", phase: "Rollout A", prs: "—" },
  { id: "app", repo: "signed-off-app", phase: "Docs redistribution", prs: "—" },
  { id: "alert", repo: "native-ops-alerting", phase: "Phase 1 risk note", prs: "—" },
  { id: "portal", repo: "portal-service", phase: "Front door", prs: "#1–#2 merged" },
  { id: "ops", repo: "ops-console", phase: "Internal-only, not scoped", prs: "—" },
  { id: "ui", repo: "ui-components", phase: "Not on critical path", prs: "—" },
];

const TASKS: Task[] = [
  { id: "tmpl", repo: "worker-module-template", task: "Bootstrap template", start_h: 0, dur_h: 3, status: "done", deps: [], milestone: 0 },
  { id: "cms", repo: "capability-mgmt-service", task: "Tenant RPC + paid-tier gating", start_h: 0, dur_h: 4, status: "done", deps: [], milestone: 0 },
  { id: "disp", repo: "github-app-dispatcher", task: "Webhook receipt + routing", start_h: 4, dur_h: 3, status: "done", deps: ["tmpl", "cms"], milestone: 0 },
  { id: "chk", repo: "checklist-service", task: "checkGate wiring (2a)", start_h: 4, dur_h: 3, status: "done", deps: ["tmpl"], milestone: 0 },
  { id: "local", repo: "multi-worker", task: "wrangler dev test, zero mocks", start_h: 7, dur_h: 2, status: "done", deps: ["disp", "chk"], milestone: 0 },
  { id: "pr", repo: "pr-checks-service", task: "Release-note requirement (2b)", start_h: 9, dur_h: 3, status: "done", deps: ["cms"], milestone: 0 },
  { id: "portal", repo: "portal-service", task: "External OAuth slice for 2c", start_h: 9, dur_h: 4, status: "done", deps: ["tmpl"], milestone: 0 },
  { id: "prrt", repo: "github-app-dispatcher", task: "Wire pr-checks routing — #6", start_h: 12, dur_h: 2, status: "active", deps: ["pr"], milestone: 0 },
  { id: "docs", repo: "signed-off-app", task: "dev-docs redistribution", start_h: 12, dur_h: 4, status: "active", deps: ["disp"], milestone: 0 },
  { id: "alert", repo: "native-ops-alerting", task: "Plan-mapping failure alert", start_h: 12, dur_h: 3, status: "blocking", deps: ["disp"], milestone: 0 },
  { id: "supp", repo: "support-service", task: "Ticket intake via portal (2c)", start_h: 13, dur_h: 3, status: "done", deps: ["portal"], milestone: 0 },
  { id: "prod", repo: "github-app-dispatcher", task: "checkProductAccess refix — #8", start_h: 15, dur_h: 2, status: "blocking", deps: ["cms"], milestone: 0 },
  { id: "e2e", repo: "e2e-tests", task: "Bootstrap suite — 2a/2b/2c", start_h: 15, dur_h: 4, status: "active", deps: ["local"], milestone: 0 },
  { id: "ra", repo: "rollout", task: "Phase A — wrangler testing", start_h: 19, dur_h: 5, status: "active", deps: ["e2e"], milestone: 0 },
  { id: "rb", repo: "rollout", task: "Phase B — CF account + staging org", start_h: 24, dur_h: 4, status: "blocking", deps: ["ra"], milestone: 0 },
  { id: "wire", repo: "dispatcher + checklist", task: "Deploy to scratch hostname", start_h: 28, dur_h: 3, status: "todo", deps: ["rb"], milestone: 0 },
  { id: "rc", repo: "signed-off-app", task: "Phase C — cutover", start_h: 31, dur_h: 4, status: "todo", deps: ["wire"], milestone: 0 },
  { id: "gate", repo: "—", task: "Phase 1 sign-off gate", start_h: 35, dur_h: 0, status: "todo", deps: ["rc"], milestone: 1 },
  { id: "p2s", repo: "security-compliance-svc", task: "dependabot-alert-gate", start_h: 35, dur_h: 4, status: "todo", deps: ["gate"], milestone: 0 },
  { id: "p2r", repo: "roadmap-service", task: "public-ideas-board", start_h: 39, dur_h: 4, status: "todo", deps: ["p2s"], milestone: 0 },
];

export function seedIfEmpty(db: Db) {
  if (db.listRepos().length > 0) return;
  for (const r of REPOS) {
    db.upsertRepo({
      id: r.id,
      repo: r.repo,
      cwd: `${CODE_ROOT}/${r.repo}`,
      phase: r.phase,
      prs: r.prs,
      agent_status: "stopped",
    });
  }
  for (const t of TASKS) db.upsertTask(t);
}
