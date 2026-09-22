import * as vscode from "vscode";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { IpcClient } from "./ipc";

// The extension host never touches SQLite directly — its own Electron/Node
// runtime isn't guaranteed to have node:sqlite. Everything goes through the
// server.ts daemon over its socket (see ipc.ts). The daemon is shared
// across every VS Code window (its socket path lives under globalStorage,
// which is per-user-per-extension, not per-workspace) and across every MCP
// client too — this class either connects to an already-running daemon or,
// if none is listening yet, spawns one and becomes its owner (tracked via
// spawnedProc, only set in that case) so restart/reset commands can still
// kill it outright.
class RunnerClient {
  private ipc: IpcClient | null = null;
  private spawnedProc: cp.ChildProcess | null = null;
  private updateListeners: Array<() => void> = [];
  dbId: string;
  readonly ready: Promise<void>;

  constructor(
    private nodeBin: string,
    private serverScript: string,
    private storageDir: string,
    private socketPath: string,
    dbId: string,
    private out: vscode.OutputChannel,
    private httpPort: number
  ) {
    this.dbId = dbId;
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    try {
      this.ipc = await IpcClient.connect(this.socketPath, { retries: 1, delayMs: 0 });
    } catch {
      // Nothing listening yet (first window this session, or a previous
      // daemon crashed leaving a stale socket file) — spawn one and wait
      // for it to actually come up, retrying the connect to ride out its
      // startup instead of racing it.
      fs.mkdirSync(this.storageDir, { recursive: true });
      const args = [this.serverScript, "--storage-dir", this.storageDir, "--socket", this.socketPath];
      // 0 (unset) lets the daemon fall back to its own default (an
      // OS-picked ephemeral port) — see syncHttpPortSetting for how this
      // gets populated with a real, persisted value after the first run.
      if (this.httpPort) args.push("--http-port", String(this.httpPort));
      this.spawnedProc = cp.spawn(this.nodeBin, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
      this.spawnedProc.stdout?.on("data", (d) => this.out.append(`[daemon] ${d}`));
      this.spawnedProc.stderr?.on("data", (d) => this.out.append(`[daemon] ${d}`));
      this.spawnedProc.on("exit", (code) => this.out.appendLine(`[daemon] exited (${code})`));
      // Detached so the daemon outlives this window closing (other windows,
      // and MCP clients, may still depend on it) — unref so it doesn't
      // itself keep the extension host's event loop alive.
      this.spawnedProc.unref();
      this.ipc = await IpcClient.connect(this.socketPath);
    }
    this.ipc.onUpdate((event) => {
      // Only "update" (a specific dbId's content changed) is filtered by
      // dbId — any other event type (e.g. "databasesChanged", which
      // carries no dbId at all) always propagates, since it's a
      // whole-daemon fact this window needs regardless of which database
      // it's currently showing.
      if (event.event === "update" && event.dbId && event.dbId !== this.dbId) return;
      for (const l of this.updateListeners) l();
    });
  }

  onUpdate(cb: () => void) {
    this.updateListeners.push(cb);
  }

  async call(cmd: string, params: Record<string, any> = {}): Promise<any> {
    await this.ready;
    return this.ipc!.call(cmd, { dbId: this.dbId, ...params });
  }

  dispose() {
    // Only actually kills the daemon process if THIS client is the one
    // that spawned it; if it was already running (another window got
    // there first), disposing just drops this window's own connection —
    // the daemon and any other window/MCP client using it are unaffected.
    if (this.spawnedProc) this.spawnedProc.kill("SIGTERM");
    this.ipc?.dispose();
  }
}

// Reshapes the daemon's snapshot (db.ts's Snapshot type) into exactly the
// shape media/dashboard.html's mock data already used, so the webview needed
// almost no restructuring — just reading window.__CC_BOOTSTRAP__ instead of
// its hardcoded arrays. Escalation detail (questions/options) and the raw
// per-repo tagged logs are deliberately NOT included here anymore — the
// escalation-answering UI and the log stream both moved to native VS Code
// UI (QuickPick/InputBox and per-repo OutputChannels — see
// notifyNewEscalations/tailLogsToOutputChannels), so the webview no longer
// needs that data at all. The red status dot still reflects agent_status,
// which is included.
// Confirmed via live bisection, not guesswork: embedding this session's full
// dispatch history (~18 dispatches, one repo's alone ~20K chars) in the
// initial webview payload reliably crashed the dashboard on load — verified
// by removing repos' dispatches one at a time and watching it start working
// again once the total dropped low enough, then re-adding them one at a
// time until it broke again. No content anomaly was found in the data that
// broke it (checked for the classic script-tag-breaking Unicode gotchas,
// stray <script> sequences, control characters — none present); it's
// genuinely about total payload size, most plausibly at the VS Code/
// Electron webview-host level (a large inline <script> blob taking long
// enough to load that a second render pass — see syncFromDaemon's own
// synchronous-claim fix — could still land badly), not a bug in this
// codebase's own JS logic, which is why the code-level fixes made getting
// to this diagnosis didn't resolve it on their own.
//
// This caps individual text fields rather than the total payload or
// dispatch count — simpler, and sufficient for what's actually been
// observed to trigger this. It does NOT cap unbounded growth from an
// ever-increasing NUMBER of dispatches/findings/log lines over a very
// long-running session; if that recurs, the real fix is windowing (embed
// only the N most recent in full) with on-demand fetch for older ones, not
// a bigger per-item cap.
const MAX_EMBED_TEXT_CHARS = 4000;
function truncateForEmbed(s: string | null | undefined): string {
  if (!s) return s ?? "";
  if (s.length <= MAX_EMBED_TEXT_CHARS) return s;
  const omitted = s.length - MAX_EMBED_TEXT_CHARS;
  return s.slice(0, MAX_EMBED_TEXT_CHARS) + `\n\n[… ${omitted} more characters omitted to keep the dashboard payload a safe size]`;
}

function toBootstrap(snapshot: any, databases: any[], currentDbId: string) {
  const repos = snapshot.repos.map((r: any) => ({
    id: r.id,
    repo: r.repo,
    phase: r.phase,
    prs: r.prs,
    pullRequests: (r.pullRequests ?? []).map((p: any) => ({ number: p.number, url: p.url, status: p.status })),
    agent: r.agent_status,
    paused: !!r.paused,
    dispatches: r.dispatches.map((d: any) => ({
      id: d.id,
      text: truncateForEmbed(d.text),
      state: d.state,
      at: d.at,
      response: truncateForEmbed(d.response),
    })),
  }));

  const repoNameById: Record<string, string> = {};
  for (const r of snapshot.repos) repoNameById[r.id] = r.repo;

  const items = snapshot.findings.map((f: any) => ({
    id: f.id,
    repo: repoNameById[f.repo_id] || f.repo_id,
    text: truncateForEmbed(f.text),
    phase: f.phase,
    disposition: f.disposition,
    by: f.by,
    sev: f.sev,
    answer: f.answer,
    flagForReview: !!f.flag_for_review,
    disputed: !!f.disputed,
  }));

  const tasks = snapshot.tasks.map((t: any) => ({
    id: t.id,
    repo: t.repo,
    task: t.task,
    start: t.start_h,
    dur: t.dur_h,
    status: t.status,
    deps: t.deps,
    milestone: !!t.milestone,
    contract: truncateForEmbed(t.contract),
    doneEvidence: truncateForEmbed(t.doneEvidence),
  }));

  const log = (snapshot.log || []).map((e: any) => ({ when: e.when, repo: e.repo, text: truncateForEmbed(e.text) }));

  const learnings = (snapshot.learnings || []).map((l: any) => ({
    id: l.id,
    requirementTitle: l.requirement_title,
    repo: l.repo_label,
    lessons: truncateForEmbed(l.lessons),
    decisions: truncateForEmbed(l.decisions),
    futureImprovements: truncateForEmbed(l.future_improvements),
    text: truncateForEmbed(l.text),
    createdAt: l.created_at,
  }));

  // The full checklist, shown read-only in the dashboard's Requirements
  // tab (see ChecklistItem's own comment for why it's coordinator-written,
  // not dashboard-editable).
  const checklist = (snapshot.checklist || []).map((c: any) => ({
    id: c.id,
    text: truncateForEmbed(c.text),
    ambiguous: !!c.ambiguous,
  }));

  return {
    repos,
    items,
    tasks,
    checklist,
    log,
    learnings,
    requirementPhase: snapshot.requirementPhase || null,
    requirementTitle: snapshot.requirementTitle || null,
    cruiseControl: !!snapshot.cruiseControl,
    docCategories: (snapshot.docCategories || []).map((c: any) => ({ id: c.id, label: c.label })),
    planDocs: snapshot.planDocs || {},
    operatorGateEnabled: !!snapshot.operatorGateEnabled,
    operatorGatePending: !!snapshot.operatorGatePending,
    databases,
    currentDbId,
  };
}

export function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel("Agent Control Center");
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, "media");
  const serverScript = path.join(context.extensionUri.fsPath, "out", "server.js");
  const storageDir = context.globalStorageUri.fsPath;
  // NOT under storageDir: a Unix domain socket path is bound by the OS's
  // sockaddr_un limit (~104 bytes on macOS/BSD, ~108 on Linux) — unlike a
  // regular file path, which has no such limit. globalStorage's own path
  // (…/Code/User/globalStorage/<extension id>/) is long enough on its own
  // (127 bytes here) that appending even "daemon.sock" overflows it,
  // which fails with a distinctly unhelpful EINVAL from listen()/connect()
  // — confirmed live, not hypothetical. os.tmpdir() is short and, on
  // macOS/Linux, already scoped per OS user, so a fixed name under it is
  // safe without needing to derive one from the (long) storage path.
  const socketPath = path.join(os.tmpdir(), `control-center-${os.userInfo().username}.sock`);
  // Which database this window's dashboard shows/controls — persisted per
  // machine (globalState, not workspace state, since the daemon and its
  // socket are themselves global) so reopening the dashboard doesn't reset
  // it back to "default". An MCP client never sees or sets this directly;
  // it names its own dbId independently, in its own registration URL.
  const SELECTED_DB_KEY = "selectedDbId";
  let selectedDbId: string = context.globalState.get(SELECTED_DB_KEY, "default");
  // The daemon itself hosts the MCP protocol endpoint now (see server.ts's
  // HTTP listener + mcp.ts) — no process to spawn per session, so
  // registration is just a URL, fetched fresh each time (not cached) since
  // the port is only known once the daemon's HTTP listener is actually up,
  // and a stale cached port would be exactly the kind of mismatch this
  // whole redesign has been eliminating.
  async function mcpRegisterUrl(): Promise<string> {
    const { port } = await runner.call("getHttpPort", {});
    if (!port) throw new Error("the control center daemon's MCP endpoint isn't listening yet — try again in a moment.");
    return `http://127.0.0.1:${port}/mcp?dbId=${encodeURIComponent(selectedDbId)}`;
  }
  out.appendLine(`Daemon socket: ${socketPath}`);

  // Shown once per install of this extension (globalState survives
  // updates but not uninstall/reinstall) — not added to any user- or
  // project-level config on your behalf; this just opens the walkthrough
  // that tells you how, if you want it.
  const WALKTHROUGH_SHOWN_KEY = "walkthroughShown";
  if (!context.globalState.get(WALKTHROUGH_SHOWN_KEY)) {
    context.globalState.update(WALKTHROUGH_SHOWN_KEY, true);
    vscode.commands.executeCommand("workbench.action.openWalkthrough", `${context.extension.id}#gettingStarted`, false);
  }

  let panel: vscode.WebviewPanel | undefined;
  // A live dispatch appends a log line per tool call, each of which fires
  // db.onChange — without this, that meant a full webview.html
  // replacement (the whole page torn down and rebuilt) potentially dozens
  // of times during one dispatch: visible flicker, lost scroll position,
  // any open menu/drawer reset, the dashboard effectively unusable while
  // something was actually running. Only the FIRST render sets .html; every
  // update after that posts fresh data into the page still-loaded there,
  // and dashboard.html's Component merges it into state in place.
  let panelInitialized = false;

  // One real VS Code OutputChannel per repo for its tagged message stream
  // (tool calls, results) — replacing the webview's old "Watch panel"
  // mockup with the actual thing it was imitating. Created lazily so
  // repos that never produce output don't clutter the Output dropdown.
  const repoChannels = new Map<string, vscode.OutputChannel>();
  // logs.id is an autoincrementing integer (db.ts) — tracks the highest
  // one already written to each channel so a poll only appends genuinely
  // new lines, not the whole recent-log window every time.
  const lastLogId = new Map<string, number>();

  function getRepoChannel(repoId: string, repoName: string): vscode.OutputChannel {
    let ch = repoChannels.get(repoId);
    if (!ch) {
      ch = vscode.window.createOutputChannel(`Control Center: ${repoName}`);
      repoChannels.set(repoId, ch);
    }
    return ch;
  }

  function tailLogsToOutputChannels(snapshot: any) {
    for (const repo of snapshot.repos) {
      const lines: any[] = snapshot.logs?.[repo.id] || [];
      const since = lastLogId.get(repo.id) ?? 0;
      const fresh = lines.filter((l) => l.id > since);
      if (!fresh.length) continue;
      const ch = getRepoChannel(repo.id, repo.repo);
      for (const l of fresh) {
        ch.appendLine(`${l.t}  [${l.tag}]  ${l.text}`);
        lastLogId.set(repo.id, Math.max(lastLogId.get(repo.id) ?? 0, l.id));
      }
    }
  }

  // A permission gate or an ask_human reply-pause both land here (see
  // agentRunner.ts) — notify once per escalation id (not once per poll,
  // which would re-notify on every single DB change while the same
  // escalation sits unanswered) with an action that opens the real
  // answer flow.
  const notifiedEscalations = new Set<string>();

  function notifyNewEscalations(snapshot: any) {
    for (const repo of snapshot.repos) {
      const esc = repo.escalation;
      if (!esc || repo.agent_status !== "needsHuman") continue;
      if (notifiedEscalations.has(esc.id)) continue;
      notifiedEscalations.add(esc.id);
      const kindLabel = esc.kind === "reply" ? "needs a decision" : "needs a permission decision";
      const summary = String(esc.text).split("\n")[0].slice(0, 100);
      vscode.window.showWarningMessage(`${repo.repo} ${kindLabel}: ${summary}`, "Answer").then((choice) => {
        if (choice === "Answer") answerEscalation(repo.id, esc);
      });
    }
  }

  // The native replacement for the webview's old escalation-answering
  // panel: showQuickPick's {label, detail} is exactly the
  // option-plus-rationale shape the agent already produces (see
  // agentRunner.ts's genericOptionsFor / the ask_human tool), and
  // showInputBox covers the free-text fallback. This IS the actual
  // decision — picking here calls resolve_escalation directly, not a
  // side channel pretending to.
  async function answerEscalation(repoId: string, esc: any) {
    type Item = vscode.QuickPickItem & { isTypeSomething?: boolean };
    const items: Item[] = (esc.options || []).map((o: any) => ({
      label: o.label,
      detail: o.rationale || undefined,
    }));
    items.push({
      label: "$(edit) Type something…",
      detail: "Answer with something not covered above",
      isTypeSomething: true,
    });

    const fullText = String(esc.text);
    const firstLine = fullText.split("\n")[0];
    // showQuickPick's placeHolder is one truncated line — fine for a short
    // ask_human question, not for a permission escalation's text ("Allow
    // <tool>?\n\n<pretty JSON args>") or a longer question, both of which
    // that placeholder was silently cutting down to nothing useful (a human
    // had to answer Approve/Decline with no legible basis for the call).
    // A modal dialog's `detail` actually wraps and scrolls, so show the
    // full text there first whenever the placeholder alone wouldn't cover
    // it — skipped for the common short one-line case to avoid an extra
    // click on every trivial escalation.
    if (fullText.length > firstLine.length || firstLine.length > 200) {
      const proceed = await vscode.window.showInformationMessage(
        (esc.kind === "reply" ? "Question from " : "Permission requested by ") + (esc.asked_by || repoId),
        { modal: true, detail: fullText },
        "Answer…"
      );
      if (proceed !== "Answer…") return;
    }

    const picked = await vscode.window.showQuickPick(items, {
      title:
        (esc.kind === "reply" ? "Awaiting reply" : "Permission required") +
        (esc.asked_by ? ` — requested by ${esc.asked_by}` : ""),
      placeHolder: firstLine.slice(0, 200),
      ignoreFocusOut: true,
    });
    if (!picked) return;

    let answer: string | undefined = picked.label;
    if (picked.isTypeSomething) {
      answer = await vscode.window.showInputBox({ prompt: "Your answer", ignoreFocusOut: true });
    }
    if (!answer) return;
    try {
      await runner.call("resolveEscalation", { escalationId: esc.id, answer });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to send answer: ${err?.message ?? err}`);
    }
  }

  // One status bar item per non-Done database, up to this many — beyond
  // that, "Switch Database…" behind the chevron (moreStatusBarItem/
  // quickMenu below) is how the rest stay reachable. A Done requirement's
  // database is the one you'd go looking for on purpose, not something
  // that should compete for a permanent, always-visible click target.
  const MAX_DB_STATUS_ITEMS = 3;
  const dbStatusBarItems: vscode.StatusBarItem[] = [];
  for (let i = 0; i < MAX_DB_STATUS_ITEMS; i++) {
    dbStatusBarItems.push(vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 103 - i));
  }

  // Called from syncFromDaemon (below) with the same `databases` it just
  // fetched — no extra daemon round trip just to keep these current.
  // Recomputed on every daemon update (dispatch sent/responded, a
  // set_requirement_phase landing, etc.), not just at activation, so a
  // requirement reaching Done drops its button here the moment that
  // actually happens rather than on next reload.
  function refreshDbStatusBarItems(databases: any[]) {
    const active = (databases || []).filter((d) => d.requirementPhase !== "done");
    if (active.length === 0) {
      // Nothing to distinguish between — fall back to one plain item that
      // just opens the dashboard on whatever's currently selected, same
      // as before per-database items existed at all.
      const item = dbStatusBarItems[0];
      item.text = "$(circuit-board) Control Center";
      item.tooltip = "Open Agent Control Center dashboard";
      item.command = "multiRepoAgentControlCenter.openDashboard";
      item.show();
      for (let i = 1; i < dbStatusBarItems.length; i++) dbStatusBarItems[i].hide();
      return;
    }
    const shown = active.slice(0, MAX_DB_STATUS_ITEMS);
    shown.forEach((d, i) => {
      const item = dbStatusBarItems[i];
      const bits: string[] = [];
      if (d.requirementTitle) bits.push(d.requirementTitle);
      bits.push(d.requirementPhase ? `(${d.requirementPhase})` : "(no requirement set)");
      bits.push(d.repoCount === 1 ? "1 repo" : `${d.repoCount} repos`);
      item.text = (d.id === selectedDbId ? "$(circuit-board) $(check) " : "$(circuit-board) ") + d.id;
      item.tooltip = `${d.id} — ${bits.join(" · ")}\n${d.requirementSummary || "No summary yet — set on completing Critique."}\n\nClick to open the dashboard focused on this database.`;
      item.command = { title: "Open", command: "multiRepoAgentControlCenter.openDashboardForDb", arguments: [d.id] };
      item.show();
    });
    for (let i = shown.length; i < dbStatusBarItems.length; i++) dbStatusBarItems[i].hide();
  }

  async function openDashboardForDb(dbId: string): Promise<void> {
    if (dbId !== selectedDbId) await switchDatabase(dbId);
    await vscode.commands.executeCommand("multiRepoAgentControlCenter.openDashboard");
  }

  async function syncFromDaemon() {
    // Claiming "I'm the first render" has to happen synchronously, before
    // the first await below — not after, which is where it lived until a
    // real, confirmed bug: r.onUpdate fires on every db.onChange, which
    // happens very often (each dispatch's tool-call log line is its own
    // write), so two overlapping syncFromDaemon() calls were a real
    // occurrence, not a hypothetical. Both would reach `await
    // runner.call("snapshot")`, and whichever's response happened to land
    // second would still see panelInitialized === false — the flag hadn't
    // been set yet, because the call that should have set it was itself
    // still awaiting. Both then set panel.webview.html, and with
    // retainContextWhenHidden the webview didn't cleanly replace on the
    // second assignment — it ended up with two full copies of every
    // <script> tag (react.js, react-dom.js, support.js) loaded into the
    // same document, confirmed directly via document.querySelectorAll
    // ('script[src]') during live debugging. That's what was crashing the
    // dashboard: two independent boot passes racing over the same shared
    // runtime state. Checking and setting the flag in the same synchronous
    // step, before any await, closes the window entirely — a second
    // overlapping call now sees isFirstRender === false immediately, no
    // race possible regardless of how the two calls interleave afterward.
    //
    // Gated on `panel` existing too, not just `!panelInitialized` — a real
    // bug otherwise: pickDatabaseThenOpenDashboard calls switchDatabase()
    // (which calls this) BEFORE openDashboard has created the panel at
    // all, so that call would see panel === undefined, hit `if (!panel)
    // return` below, but had ALREADY claimed the first-render flag on its
    // way there. openDashboard's own syncFromDaemon() call right after
    // creating the panel then found panelInitialized already true and
    // took the postMessage branch instead of ever assigning
    // panel.webview.html — a permanently blank panel, confirmed live (the
    // window showed the panel opening but never rendering anything).
    const isFirstRender = !!panel && !panelInitialized;
    if (isFirstRender) panelInitialized = true;
    await runner.ready;
    const [snapshot, { databases }] = await Promise.all([runner.call("snapshot"), runner.call("listDatabases")]);
    tailLogsToOutputChannels(snapshot);
    notifyNewEscalations(snapshot);
    refreshDbStatusBarItems(databases);
    if (!panel) return;
    const bootstrap = toBootstrap(snapshot, databases, selectedDbId);
    if (isFirstRender) {
      out.appendLine(`[extension] assigning panel.webview.html now, t=${Date.now()}`);
      panel.webview.html = renderDashboardHtml(panel.webview, mediaRoot, bootstrap);
    } else {
      panel.webview.postMessage({ type: "snapshot", data: bootstrap });
    }
  }

  // Shared by the "Reset All Data" command and the dashboard's own
  // inline delete button next to the database dropdown — same
  // confirmation, same daemon call, same resync, regardless of which UI
  // surface triggered it.
  async function confirmAndDeleteDatabase(): Promise<void> {
    const dbId = selectedDbId;
    const confirm = await vscode.window.showWarningMessage(
      `Delete all tracked repos, dispatches, escalations, findings, and the plan for database "${dbId}"? This cannot be undone.`,
      { modal: true },
      "Delete Everything"
    );
    if (confirm !== "Delete Everything") return;
    // Deleting is a single daemon-side call (it owns every Db instance,
    // keyed by dbId) rather than this extension host unlinking files
    // itself — that only worked when there was exactly one process and
    // one file to reason about.
    await runner.call("deleteDatabase", {});
    await syncFromDaemon();
    vscode.window.showInformationMessage(`Agent Control Center data cleared for "${dbId}".`);
  }

  // Shared by the dashboard's own database dropdown (switchDatabase webview
  // message) and the status bar's "pick a database" flow below — same
  // state update, same resync, regardless of which UI surface triggered it.
  async function switchDatabase(dbId: string): Promise<void> {
    selectedDbId = dbId;
    await context.globalState.update(SELECTED_DB_KEY, dbId);
    runner.dbId = dbId;
    await syncFromDaemon();
  }

  // Bound to the status bar's main "Control Center" click (see below,
  // replacing a plain openDashboard) — with only one database tracked
  // (by far the common case), jumping straight to the dashboard stays a
  // single click, same as before; a second+ database is when "which one"
  // actually becomes a real question, so that's exactly when this asks it,
  // rather than making every click pay for a choice most setups never have.
  async function pickDatabaseThenOpenDashboard(): Promise<void> {
    const { databases } = await runner.call("listDatabases", {});
    if (!databases || databases.length <= 1) {
      await vscode.commands.executeCommand("multiRepoAgentControlCenter.openDashboard");
      return;
    }
    const items: (vscode.QuickPickItem & { dbId: string })[] = databases.map((d: any) => {
      const bits: string[] = [];
      if (d.requirementTitle) bits.push(d.requirementTitle);
      if (d.requirementPhase) bits.push(`(${d.requirementPhase})`);
      bits.push(d.repoCount === 1 ? "1 repo" : `${d.repoCount} repos`);
      return {
        label: (d.id === selectedDbId ? "$(check) " : "$(database) ") + d.id,
        description: bits.join(" · "),
        detail: d.requirementSummary || "No summary yet — set on completing Critique.",
        dbId: d.id as string,
      };
    });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Which database should the dashboard focus?" });
    if (!picked) return;
    if (picked.dbId !== selectedDbId) await switchDatabase(picked.dbId);
    await vscode.commands.executeCommand("multiRepoAgentControlCenter.openDashboard");
  }

  // The dashboard's own "add database" button — lets a new, genuinely
  // empty database be created and switched to directly, rather than only
  // coming into existence whenever some MCP client first happens to
  // reference that dbId (which meant waiting on external setup just to
  // see the empty state at all).
  async function createAndSwitchDatabase(): Promise<void> {
    const dbId = await vscode.window.showInputBox({
      prompt: "New database id",
      placeHolder: "e.g. teamB — letters, digits, - and _ only",
      validateInput: (v) => (/^[a-zA-Z0-9_-]{1,64}$/.test(v) ? null : "Use letters, digits, - and _ (1-64 characters)"),
    });
    if (!dbId) return;
    await runner.call("createDatabase", { dbId });
    await switchDatabase(dbId);
    // Same onboarding offer a first-ever dashboard open gets (maybeOnboard
    // below) — a freshly created dbId is by construction empty, so this
    // always finds zero repos and offers to populate it, rather than
    // leaving "+" as a dead end that only an external MCP call could fill.
    await maybeOnboard();
  }

  // Deliberately "node" from PATH, not process.execPath — inside the
  // extension host that's Electron, not a usable Node CLI for a spawned
  // script. This assumes a real Node (>=22.5, for node:sqlite) is on PATH.
  // Reassignable so restartRunner/resetAllData can swap in a fresh one
  // without reloading the whole window.
  let runner = spawnRunner();

  function spawnRunner(): RunnerClient {
    const savedPort = vscode.workspace.getConfiguration("multiRepoAgentControlCenter").get<number>("daemonPort", 0);
    const r = new RunnerClient("node", serverScript, storageDir, socketPath, selectedDbId, out, savedPort);
    r.onUpdate(() => {
      syncFromDaemon().catch((err) => out.appendLine(`sync failed: ${err?.message ?? err}`));
    });
    r.ready.then(() => syncHttpPortSetting(r)).catch(() => {});
    // Populates the per-database status bar items right away — otherwise
    // they'd stay empty/hidden until either the dashboard is opened once
    // (which is exactly what they're meant to let you avoid doing blind)
    // or the daemon happens to fire its first onUpdate event.
    r.ready.then(() => syncFromDaemon()).catch((err) => out.appendLine(`initial sync failed: ${err?.message ?? err}`));
    return r;
  }

  // Persists the daemon's HTTP port into settings the first time it's
  // ever seen (so every restart after that asks the daemon to reuse the
  // same one instead of a fresh random port breaking every already-
  // registered .mcp.json — see server.ts's --http-port), and surfaces a
  // real conflict (something else now holds that port) as an actual VS
  // Code error instead of a registration command that silently points at
  // a dead endpoint.
  let httpPortErrorShown = false;
  async function syncHttpPortSetting(r: RunnerClient): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("multiRepoAgentControlCenter");
    const saved = cfg.get<number>("daemonPort", 0);
    const result = await r.call("getHttpPort", {});
    if (result.error) {
      if (!httpPortErrorShown) {
        httpPortErrorShown = true;
        const choice = await vscode.window.showErrorMessage(`Agent Control Center: ${result.error}`, "Open Settings");
        if (choice === "Open Settings") {
          await vscode.commands.executeCommand("workbench.action.openSettings", "multiRepoAgentControlCenter.daemonPort");
        }
      }
      return;
    }
    httpPortErrorShown = false;
    if (!saved && result.port) {
      await cfg.update("daemonPort", result.port, vscode.ConfigurationTarget.Global);
    }
  }

  async function maybeOnboard() {
    await runner.ready;
    const snapshot = await runner.call("snapshot");
    if (snapshot.repos.length > 0) return;

    const defaultRoot = vscode.workspace.workspaceFolders?.[0]
      ? path.dirname(vscode.workspace.workspaceFolders[0].uri.fsPath)
      : "";

    // Both optional, both skippable — neither runs unless explicitly
    // chosen, and they're independent (either, both, or neither), not a
    // fallback chain.
    const choice = await vscode.window.showInformationMessage(
      "No repos tracked yet. How do you want to set this up?",
      "Use sibling repos",
      "Discover from GitHub",
      "Skip"
    );
    if (choice === "Use sibling repos") {
      const codeRoot = await vscode.window.showInputBox({
        prompt: "Directory to scan for git repos (no network, no gh — just what's already cloned)",
        value: defaultRoot,
      });
      if (!codeRoot) return;
      try {
        const result = await runner.call("discoverLocalRepos", { codeRoot });
        vscode.window.showInformationMessage(`Found ${result.discovered} local repos under ${codeRoot}.`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Local discovery failed: ${err?.message ?? err}`);
      }
    } else if (choice === "Discover from GitHub") {
      const owner = await vscode.window.showInputBox({
        prompt: "GitHub org or user to discover repos from (uses your existing `gh` login)",
        placeHolder: "e.g. signed-off",
      });
      if (!owner) return;
      const codeRoot = await vscode.window.showInputBox({
        prompt: "Local directory to look for existing clones in (checked as <this>/<repo-name>)",
        value: defaultRoot,
      });
      if (!codeRoot) return;
      try {
        const result = await runner.call("discoverGithubRepos", { owner, codeRoot });
        vscode.window.showInformationMessage(
          `Discovered ${result.discovered} repos (${result.withLocalClone} with a local clone found under ${codeRoot}).`
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Discovery failed: ${err?.message ?? err}`);
      }
    }
    // "Skip", or the picker dismissed: leave it empty. Both discovery modes
    // are also reachable later from an MCP-connected coordinator.
  }

  const openDashboard = vscode.commands.registerCommand("multiRepoAgentControlCenter.openDashboard", async () => {
    if (panel) {
      panel.reveal(vscode.ViewColumn.One);
      return;
    }
    await maybeOnboard();
    panel = vscode.window.createWebviewPanel("agentControlCenter", "Agent Control Center", vscode.ViewColumn.One, {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
      retainContextWhenHidden: true,
    });
    panel.onDidDispose(() => {
      panel = undefined;
      panelInitialized = false;
    });
    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg.type) {
          case "dispatch":
            await runner.call("dispatch", { repoId: msg.repoId, text: msg.text });
            break;
          case "resolveEscalation":
            await runner.call("resolveEscalation", { escalationId: msg.escalationId, answer: msg.answer });
            break;
          case "answerFinding":
            await runner.call("answerFinding", { findingId: msg.findingId, answer: msg.answer });
            break;
          case "addFinding":
            await runner.call("addFinding", { repoId: msg.repoId, text: msg.text, phase: msg.phase });
            break;
          case "setFindingDisputed":
            await runner.call("setFindingDisputed", { findingId: msg.findingId, disputed: msg.disputed });
            break;
          case "togglePause":
            await runner.call("togglePause", { repoId: msg.repoId });
            break;
          case "setCruiseControl":
            await runner.call("setCruiseControl", { on: msg.on });
            break;
          case "setOperatorGate":
            await runner.call("setOperatorGate", { on: msg.on });
            break;
          case "approveImplement": {
            const confirm = await vscode.window.showWarningMessage(
              "Approve moving this requirement to Implement? This starts real work dispatching to repos.",
              { modal: true },
              "Approve"
            );
            if (confirm === "Approve") await runner.call("approveImplement", {});
            break;
          }
          case "stopAgent":
            await runner.call("stopAgent", { repoId: msg.repoId });
            break;
          case "startAgent":
            await runner.call("startAgent", { repoId: msg.repoId });
            break;
          case "switchDatabase":
            // Only ever switches which already-known dbId this window's
            // dashboard is pointed at — never touches a path, and never
            // creates a new one implicitly (the daemon only creates a
            // dbId's file the first time something is actually written to
            // it, e.g. add_repo/discover from an MCP client using that id).
            await switchDatabase(String(msg.dbId || "default"));
            break;
          case "createDatabase":
            await createAndSwitchDatabase();
            break;
          case "deleteDatabase":
            await confirmAndDeleteDatabase();
            break;
          case "watchOutput": {
            const ch = repoChannels.get(msg.repoId);
            if (ch) ch.show(true);
            else vscode.window.showInformationMessage("No output yet for this repo.");
            break;
          }
          case "answerEscalation": {
            const snapshot = await runner.call("snapshot");
            const repo = snapshot.repos.find((r: any) => r.id === msg.repoId);
            if (repo?.escalation) await answerEscalation(msg.repoId, repo.escalation);
            break;
          }
          case "clientError":
          case "clientLog":
            // Standing capability, not scaffolding to rip out later: the
            // webview reports its own errors (window.onerror /
            // unhandledrejection — the one thing that's supposed to fire
            // even when the rest of the page crashed on load) and,
            // opt-in, its own debug logs, over the same postMessage
            // channel every other webview action already uses, straight
            // into this extension's own Output channel. This exists
            // because getting anything out of a webview's own devtools
            // console turned out to be genuinely hard in practice — nested,
            // cross-origin iframes that plain `document.scripts`
            // inspection from the workbench console can't reach, and even
            // the webview-specific devtools command didn't land in the
            // expected context. An Output channel is a much smaller thing
            // to reason about than "go find the right devtools frame," and
            // fits how this whole extension is meant to work: read the
            // Output panel, not reverse-engineer a nested iframe tree.
            out.appendLine(`[webview ${msg.type === "clientError" ? "error" : "log"}] ${msg.detail}`);
            if (msg.type === "clientError") out.show(true);
            break;
          default:
            out.appendLine(`unknown webview message: ${JSON.stringify(msg)}`);
        }
      } catch (err: any) {
        const message = err?.message ?? String(err);
        out.appendLine(`action failed: ${message}`);
        // Otherwise this only ever showed up in the output channel —
        // e.g. starting a repo with no local clone would fail server-side
        // (see server.ts's startAgent guard) while the webview's own
        // optimistic setState already flipped the dot green, with nothing
        // telling the person why it silently didn't actually start.
        vscode.window.showErrorMessage(`Agent Control Center: ${message}`);
      }
      // The daemon's own onChange event will trigger a re-render for
      // anything that actually wrote to the DB; no need to force one here.
    });
    await syncFromDaemon();
  });

  async function restart() {
    out.appendLine("restarting runner \u2014 killing current daemon and spawning a fresh one");
    runner.dispose();
    runner = spawnRunner();
    await syncFromDaemon();
  }

  const restartRunner = vscode.commands.registerCommand("multiRepoAgentControlCenter.restartRunner", async () => {
    await restart();
    vscode.window.showInformationMessage("Agent Control Center runner restarted.");
  });

  const resetAllData = vscode.commands.registerCommand(
    "multiRepoAgentControlCenter.resetAllData",
    confirmAndDeleteDatabase
  );

  const copyMcpRegistrationCommand = vscode.commands.registerCommand(
    "multiRepoAgentControlCenter.copyMcpRegistrationCommand",
    async () => {
      // Copies, doesn't run — registering an MCP server is the user's
      // call, not something this extension does to their config on its
      // own.
      try {
        const url = await mcpRegisterUrl();
        await vscode.env.clipboard.writeText(
          `claude mcp add --scope project --transport http control-center "${url}"`
        );
        vscode.window.showInformationMessage("MCP registration command copied — paste it into a terminal to run it.");
      } catch (err: any) {
        vscode.window.showErrorMessage(err?.message ?? String(err));
      }
    }
  );

  const createMcpJson = vscode.commands.registerCommand(
    "multiRepoAgentControlCenter.createMcpJson",
    async () => {
      // The other registration path: a .mcp.json file at a project root,
      // which Claude Code auto-discovers for sessions rooted there — no
      // CLI invocation, and it's a plain reviewable file (shareable,
      // diffable, committable) rather than an entry buried in
      // ~/.claude.json. Genuinely simpler for a lot of setups; offered
      // alongside the claude mcp add path above, not instead of it.
      const folders = vscode.workspace.workspaceFolders;
      let targetDir: string | undefined;
      if (folders && folders.length === 1) {
        targetDir = folders[0].uri.fsPath;
      } else {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "Create .mcp.json here",
          title: "Pick the project a coordinator session will run from",
        });
        targetDir = picked?.[0]?.fsPath;
      }
      if (!targetDir) return;

      const mcpJsonPath = path.join(targetDir, ".mcp.json");
      let existing: any = {};
      if (fs.existsSync(mcpJsonPath)) {
        try {
          existing = JSON.parse(fs.readFileSync(mcpJsonPath, "utf8"));
        } catch {
          vscode.window.showErrorMessage(`${mcpJsonPath} exists but isn't valid JSON — not touching it.`);
          return;
        }
      }
      existing.mcpServers = existing.mcpServers || {};
      if (existing.mcpServers["control-center"]) {
        const confirm = await vscode.window.showWarningMessage(
          `${mcpJsonPath} already has a "control-center" entry. Overwrite it?`,
          { modal: true },
          "Overwrite"
        );
        if (confirm !== "Overwrite") return;
      }
      let url: string;
      try {
        url = await mcpRegisterUrl();
      } catch (err: any) {
        vscode.window.showErrorMessage(err?.message ?? String(err));
        return;
      }
      // Merges into whatever else is already there (other MCP servers
      // that project already configured) rather than clobbering the file.
      // A plain URL, not a command to spawn — the daemon hosts the MCP
      // endpoint itself now (see server.ts/mcp.ts), so there's no process
      // for this entry to launch and no path for it to get wrong; dbId is
      // just a query param the daemon resolves to a file on its own.
      existing.mcpServers["control-center"] = { type: "http", url };
      fs.writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + "\n");

      const doc = await vscode.workspace.openTextDocument(mcpJsonPath);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(
        `Wrote control-center to ${mcpJsonPath} — new sessions rooted here will pick it up.`
      );
    }
  );

  const pickDatabase = vscode.commands.registerCommand(
    "multiRepoAgentControlCenter.pickDatabase",
    pickDatabaseThenOpenDashboard
  );

  const openDashboardForDbCmd = vscode.commands.registerCommand(
    "multiRepoAgentControlCenter.openDashboardForDb",
    openDashboardForDb
  );

  // The permanent, always-visible click targets are the per-database
  // items themselves (dbStatusBarItems, populated by refreshDbStatusBarItems
  // above/in syncFromDaemon) — one per non-Done database, so opening the
  // dashboard focused on a specific one never requires the Command Palette.
  // A right-click-style "give me the other commands too" QuickPick lives
  // behind a narrower chevron item next to them (this extension's other
  // commands — restart, reset, MCP registration, switching to a Done
  // database — are rare enough that they don't each need their own
  // permanent status bar real estate).
  const moreStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  moreStatusBarItem.text = "$(chevron-down)";
  moreStatusBarItem.tooltip = "Agent Control Center: more commands";
  moreStatusBarItem.command = "multiRepoAgentControlCenter.quickMenu";
  moreStatusBarItem.show();

  const quickMenu = vscode.commands.registerCommand("multiRepoAgentControlCenter.quickMenu", async () => {
    const picked = await vscode.window.showQuickPick(
      [
        { label: "$(browser) Open Dashboard", command: "multiRepoAgentControlCenter.openDashboard" },
        { label: "$(database) Switch Database…", command: "multiRepoAgentControlCenter.pickDatabase" },
        { label: "$(refresh) Restart Runner", command: "multiRepoAgentControlCenter.restartRunner" },
        { label: "$(link) Copy MCP Registration Command", command: "multiRepoAgentControlCenter.copyMcpRegistrationCommand" },
        { label: "$(new-file) Create .mcp.json", command: "multiRepoAgentControlCenter.createMcpJson" },
        { label: "$(trash) Reset All Data", command: "multiRepoAgentControlCenter.resetAllData" },
      ],
      { placeHolder: "Agent Control Center" }
    );
    if (picked) await vscode.commands.executeCommand(picked.command);
  });

  context.subscriptions.push(
    openDashboard,
    restartRunner,
    resetAllData,
    copyMcpRegistrationCommand,
    createMcpJson,
    pickDatabase,
    openDashboardForDbCmd,
    quickMenu,
    ...dbStatusBarItems,
    moreStatusBarItem,
    { dispose: () => runner.dispose() },
    { dispose: () => repoChannels.forEach((ch) => ch.dispose()) },
    out
  );
}

function renderDashboardHtml(webview: vscode.Webview, mediaRoot: vscode.Uri, bootstrap: unknown): string {
  const htmlPath = vscode.Uri.joinPath(mediaRoot, "dashboard.html");
  const raw = require("fs").readFileSync(htmlPath.fsPath, "utf8") as string;

  const uri = (relPath: string) => webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, relPath)).toString();

  const bootstrapScript = `<script>window.__CC_BOOTSTRAP__ = ${JSON.stringify(bootstrap).replace(/</g, "\\u003c")};</script>`;

  // The root cause of a crash chased at length: String.prototype.replace()'s
  // SECOND argument, even with a plain-string first argument (not a regex),
  // still interprets special "$" patterns in the replacement text — $&, $`,
  // $', $$, etc. bootstrapScript is built from real dispatch/finding text a
  // repo agent wrote, which can legitimately contain any of these — e.g. a
  // regex code snippet ending in `'$')` contains the literal two-character
  // sequence $', which means "insert everything after the match" to
  // replace(). That silently spliced this file's OWN </head><body>...
  // markup into the middle of the JSON payload, corrupting it into invalid
  // JS a few thousand characters later and crashing the dashboard on load
  // with no indication why — confirmed by bisecting the live data down to
  // the exact dispatch, then isolating it to this exact mechanism with a
  // minimal repro. A function replacer's return value is inserted
  // verbatim, with no special-pattern interpretation of any kind — use one
  // for ANY replacement value that isn't a fixed literal, not just this one,
  // since the next arbitrary text embedded here would hit the same trap.
  return raw
    .replace("{{REACT_URI}}", () => uri("vendor/react.js"))
    .replace("{{REACT_DOM_URI}}", () => uri("vendor/react-dom.js"))
    .replace("{{MARKED_URI}}", () => uri("vendor/marked.js"))
    .replace("{{MERMAID_URI}}", () => uri("vendor/mermaid.js"))
    .replace("{{SUPPORT_URI}}", () => uri("support.js"))
    .replace("</head>", () => `${bootstrapScript}\n</head>`);
}

export function deactivate() {}
