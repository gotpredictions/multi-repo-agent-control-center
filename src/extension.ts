import * as vscode from "vscode";
import * as cp from "node:child_process";
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
  const dbPath = path.join(context.globalStorageUri.fsPath, "control-center.db");

  // Deliberately "node" from PATH, not process.execPath — inside the
  // extension host that's Electron, not a usable Node CLI for a spawned
  // script. This assumes a real Node (>=22.5, for node:sqlite) is on PATH.
  const runner = new RunnerClient("node", serverScript, dbPath, out);
  context.subscriptions.push({ dispose: () => runner.dispose() });

  let panel: vscode.WebviewPanel | undefined;

  async function renderPanel() {
    if (!panel) return;
    await runner.ready;
    const snapshot = await runner.call("snapshot");
    const bootstrap = toBootstrap(snapshot);
    panel.webview.html = renderDashboardHtml(panel.webview, mediaRoot, bootstrap);
  }

  runner.onUpdate(() => {
    renderPanel().catch((err) => out.appendLine(`render failed: ${err?.message ?? err}`));
  });

  const openDashboard = vscode.commands.registerCommand("multiRepoAgentControlCenter.openDashboard", async () => {
    if (panel) {
      panel.reveal(vscode.ViewColumn.One);
      return;
    }
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
        out.appendLine(`action failed: ${err?.message ?? err}`);
      }
      // The daemon's own onChange event will trigger a re-render for
      // anything that actually wrote to the DB; no need to force one here.
    });
    await renderPanel();
  });

  const restartRunner = vscode.commands.registerCommand("multiRepoAgentControlCenter.restartRunner", () => {
    out.appendLine("restart requested \u2014 reload the window to pick it up (the daemon is spawned once, on activate).");
    vscode.window.showInformationMessage("Reload the window to restart the Agent Control Center runner.");
  });

  context.subscriptions.push(openDashboard, restartRunner, out);
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
