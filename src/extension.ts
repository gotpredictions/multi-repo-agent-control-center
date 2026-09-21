import * as vscode from "vscode";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

// The extension host never touches SQLite directly — its own Electron/Node
// runtime isn't guaranteed to have node:sqlite. Everything goes through the
// server.ts daemon (spawned below) over a small newline-delimited JSON
// protocol on its stdin/stdout.
class RunnerClient {
  private proc: cp.ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private updateListeners: Array<() => void> = [];
  readonly ready: Promise<void>;

  constructor(nodeBin: string, serverScript: string, dbPath: string, out: vscode.OutputChannel) {
    this.proc = cp.spawn(nodeBin, [serverScript, "--db", dbPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stderr?.on("data", (d) => out.append(`[runner] ${d}`));
    this.proc.on("exit", (code) => out.appendLine(`[runner] exited (${code})`));

    let resolveReady: () => void;
    this.ready = new Promise((r) => (resolveReady = r));

    const rl = readline.createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        out.appendLine(`[runner] unparsable line: ${line}`);
        return;
      }
      if (msg.event === "ready") {
        resolveReady();
        return;
      }
      if (msg.event === "update") {
        for (const l of this.updateListeners) l();
        return;
      }
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.ok) pending.resolve(msg.data);
      else pending.reject(new Error(msg.error));
    });
  }

  onUpdate(cb: () => void) {
    this.updateListeners.push(cb);
  }

  call(cmd: string, params: Record<string, any> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin!.write(JSON.stringify({ id, cmd, ...params }) + "\n");
    });
  }

  dispose() {
    this.proc.kill("SIGTERM");
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
function toBootstrap(snapshot: any) {
  const repos = snapshot.repos.map((r: any) => ({
    id: r.id,
    repo: r.repo,
    phase: r.phase,
    prs: r.prs,
    agent: r.agent_status,
    paused: !!r.paused,
    dispatches: r.dispatches.map((d: any) => ({
      id: d.id,
      text: d.text,
      state: d.state,
      at: d.at,
      response: d.response,
    })),
  }));

  const repoNameById: Record<string, string> = {};
  for (const r of snapshot.repos) repoNameById[r.id] = r.repo;

  const items = snapshot.findings.map((f: any) => ({
    id: f.id,
    repo: repoNameById[f.repo_id] || f.repo_id,
    text: f.text,
    phase: f.phase,
    disposition: f.disposition,
    by: f.by,
    sev: f.sev,
    answer: f.answer,
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
  }));

  const log = (snapshot.log || []).map((e: any) => ({ when: e.when, repo: e.repo, text: e.text }));

  return {
    repos,
    items,
    tasks,
    log,
    requirementPhase: snapshot.requirementPhase || null,
    requirementTitle: snapshot.requirementTitle || null,
  };
}

export function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel("Agent Control Center");
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, "media");
  const serverScript = path.join(context.extensionUri.fsPath, "out", "server.js");
  const mcpServerScript = path.join(context.extensionUri.fsPath, "out", "mcpServer.js");
  const dbPath = path.join(context.globalStorageUri.fsPath, "control-center.db");
  // Without --db, the standalone MCP server process falls back to its own
  // default (~/.control-center/control-center.db) — a completely
  // different file from the one this extension's daemon actually watches
  // (context.globalStorageUri). Every tool call would "succeed" while
  // writing into a file the daemon never reads, so nothing dispatched
  // through MCP would ever actually run. Must match dbPath exactly.
  const mcpRegisterCommand = `claude mcp add --scope project control-center -- node ${mcpServerScript} --db "${dbPath}"`;
  out.appendLine(`DB: ${dbPath}`);
  out.appendLine(`To register the MCP server: ${mcpRegisterCommand}`);

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

    const picked = await vscode.window.showQuickPick(items, {
      title:
        (esc.kind === "reply" ? "Awaiting reply" : "Permission required") +
        (esc.asked_by ? ` — requested by ${esc.asked_by}` : ""),
      placeHolder: String(esc.text).split("\n")[0].slice(0, 200),
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

  async function syncFromDaemon() {
    await runner.ready;
    const snapshot = await runner.call("snapshot");
    tailLogsToOutputChannels(snapshot);
    notifyNewEscalations(snapshot);
    if (!panel) return;
    const bootstrap = toBootstrap(snapshot);
    if (!panelInitialized) {
      panel.webview.html = renderDashboardHtml(panel.webview, mediaRoot, bootstrap);
      panelInitialized = true;
    } else {
      panel.webview.postMessage({ type: "snapshot", data: bootstrap });
    }
  }

  // Deliberately "node" from PATH, not process.execPath — inside the
  // extension host that's Electron, not a usable Node CLI for a spawned
  // script. This assumes a real Node (>=22.5, for node:sqlite) is on PATH.
  // Reassignable so restartRunner/resetAllData can swap in a fresh one
  // without reloading the whole window.
  let runner = spawnRunner();

  function spawnRunner(): RunnerClient {
    const r = new RunnerClient("node", serverScript, dbPath, out);
    r.onUpdate(() => {
      syncFromDaemon().catch((err) => out.appendLine(`sync failed: ${err?.message ?? err}`));
    });
    return r;
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
          case "togglePause":
            await runner.call("togglePause", { repoId: msg.repoId });
            break;
          case "stopAgent":
            await runner.call("stopAgent", { repoId: msg.repoId });
            break;
          case "startAgent":
            await runner.call("startAgent", { repoId: msg.repoId });
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

  const resetAllData = vscode.commands.registerCommand("multiRepoAgentControlCenter.resetAllData", async () => {
    // Deletes every tracked repo, dispatch, escalation, finding, log, and
    // task \u2014 back to a genuinely empty state, same as a first install.
    // Mainly for exactly the situation that prompted this command: a
    // stale build having already seeded rows a fixed build won't remove
    // on its own (removing the code that writes bad data doesn't undo
    // data it already wrote).
    const confirm = await vscode.window.showWarningMessage(
      `Delete all tracked repos, dispatches, escalations, findings, and the plan? This cannot be undone.\n\n${dbPath}`,
      { modal: true },
      "Delete Everything"
    );
    if (confirm !== "Delete Everything") return;
    runner.dispose();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // fine if it didn't exist
      }
    }
    runner = spawnRunner();
    await syncFromDaemon();
    vscode.window.showInformationMessage("Agent Control Center data cleared.");
  });

  const copyMcpRegistrationCommand = vscode.commands.registerCommand(
    "multiRepoAgentControlCenter.copyMcpRegistrationCommand",
    async () => {
      // Copies, doesn't run — registering an MCP server is the user's
      // call, not something this extension does to their config on its
      // own. This just saves finding the right path by hand: it's
      // computed from context.extensionUri, so it's always correct for
      // wherever THIS install actually is (dev checkout vs. installed
      // .vsix are different paths, and a hardcoded one in a README or
      // walkthrough would be wrong for whichever case it wasn't written
      // for).
      await vscode.env.clipboard.writeText(mcpRegisterCommand);
      vscode.window.showInformationMessage("MCP registration command copied — paste it into a terminal to run it.");
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
      // Merges into whatever else is already there (other MCP servers
      // that project already configured) rather than clobbering the file.
      // --db must match dbPath exactly (see mcpRegisterCommand's comment
      // above) — without it the server defaults to its own
      // ~/.control-center/control-center.db, a different file from the
      // one this extension's daemon actually watches, and nothing
      // dispatched through it would ever be picked up.
      existing.mcpServers["control-center"] = { command: "node", args: [mcpServerScript, "--db", dbPath] };
      fs.writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + "\n");

      const doc = await vscode.workspace.openTextDocument(mcpJsonPath);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(
        `Wrote control-center to ${mcpJsonPath} — new sessions rooted here will pick it up.`
      );
    }
  );

  context.subscriptions.push(
    openDashboard,
    restartRunner,
    resetAllData,
    copyMcpRegistrationCommand,
    createMcpJson,
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

  return raw
    .replace("{{REACT_URI}}", uri("vendor/react.js"))
    .replace("{{REACT_DOM_URI}}", uri("vendor/react-dom.js"))
    .replace("{{SUPPORT_URI}}", uri("support.js"))
    .replace("</head>", `${bootstrapScript}\n</head>`);
}

export function deactivate() {}
