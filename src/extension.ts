import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  const openDashboard = vscode.commands.registerCommand(
    "multiRepoAgentControlCenter.openDashboard",
    () => {
      const mediaRoot = vscode.Uri.joinPath(context.extensionUri, "media");
      const panel = vscode.window.createWebviewPanel(
        "agentControlCenter",
        "Agent Control Center",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          localResourceRoots: [mediaRoot],
        }
      );
      panel.webview.html = renderDashboardHtml(panel.webview, mediaRoot);
    }
  );

  context.subscriptions.push(openDashboard);
}

function renderDashboardHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const htmlPath = vscode.Uri.joinPath(mediaRoot, "dashboard.html");
  const raw = require("fs").readFileSync(htmlPath.fsPath, "utf8") as string;

  const uri = (relPath: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, relPath)).toString();

  // Currently loads the design mockup verbatim, mock data and all — this is
  // the fastest way to have something real to click through and iterate on
  // inside actual VS Code, not the final shape. Wiring it to live SQLite
  // status and the SDK-managed sessions replaces the mock data next.
  return raw
    .replace("{{REACT_URI}}", uri("vendor/react.js"))
    .replace("{{REACT_DOM_URI}}", uri("vendor/react-dom.js"))
    .replace("{{SUPPORT_URI}}", uri("support.js"));
}

export function deactivate() {}
