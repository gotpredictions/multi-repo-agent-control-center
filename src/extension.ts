import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  const openDashboard = vscode.commands.registerCommand(
    "multiRepoAgentControlCenter.openDashboard",
    () => {
      const panel = vscode.window.createWebviewPanel(
        "agentControlCenter",
        "Agent Control Center",
        vscode.ViewColumn.One,
        {}
      );
      panel.webview.html = `<!DOCTYPE html>
        <html>
          <body>
            <h1>Agent Control Center</h1>
            <p>Placeholder dashboard — wire up the SQLite status feed next.</p>
          </body>
        </html>`;
    }
  );

  context.subscriptions.push(openDashboard);
}

export function deactivate() {}
