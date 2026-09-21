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
// its hardcoded arrays.
function toBootstrap(snapshot: any) {
  const repos = snapshot.repos.map((r: any) => ({
    id: r.id,
    repo: r.repo,
    phase: r.phase,
    prs: r.prs,
    agent: r.agent_status,
    paused: !!r.paused,
    questions: r.escalation
      ? [
          {
            id: r.escalation.id,
            kind: r.escalation.kind,
            text: r.escalation.text,
            askedBy: r.escalation.asked_by,
            options: r.escalation.options,
            peerNote: r.escalation.peer_note,
            answer: r.escalation.answer || "",
          },
        ]
      : [],
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

  const logs: Record<string, any[]> = {};
  for (const [repoId, lines] of Object.entries(snapshot.logs)) {
    logs[repoId] = (lines as any[]).map((l) => ({ t: l.t, tag: l.tag, text: l.text }));
  }

  return { repos, items, tasks, logs };
}

export function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel("Agent Control Center");
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, "media");
  const serverScript = path.join(context.extensionUri.fsPath, "out", "server.js");
  const mcpServerScript = path.join(context.extensionUri.fsPath, "out", "mcpServer.js");
  const dbPath = path.join(context.globalStorageUri.fsPath, "control-center.db");
  out.appendLine(`DB: ${dbPath}`);
  out.appendLine(`To register the MCP server: claude mcp add --scope project control-center -- node ${mcpServerScript}`);

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

  async function renderPanel() {
    if (!panel) return;
    await runner.ready;
    const snapshot = await runner.call("snapshot");
    const bootstrap = toBootstrap(snapshot);
    panel.webview.html = renderDashboardHtml(panel.webview, mediaRoot, bootstrap);
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
      renderPanel().catch((err) => out.appendLine(`render failed: ${err?.message ?? err}`));
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
    await renderPanel();
  });

  async function restart() {
    out.appendLine("restarting runner \u2014 killing current daemon and spawning a fresh one");
    runner.dispose();
    runner = spawnRunner();
    await renderPanel();
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
    await renderPanel();
    vscode.window.showInformationMessage("Agent Control Center data cleared.");
  });

  context.subscriptions.push(openDashboard, restartRunner, resetAllData, { dispose: () => runner.dispose() }, out);
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
