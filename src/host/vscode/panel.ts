/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import * as vscode from "vscode";
import type { Runtime } from "./runtime";

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/** Singleton webview panel that renders the TycoonAgents visualization. */
export class TycoonPanel {
  public static currentPanel: TycoonPanel | undefined;
  private static readonly viewType = "tycoonagents";

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _runtimeDisposable: { dispose(): void } | undefined;

  public static createOrShow(extensionUri: vscode.Uri, runtime: Runtime): TycoonPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (TycoonPanel.currentPanel) {
      TycoonPanel.currentPanel._panel.reveal(column);
      return TycoonPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      TycoonPanel.viewType,
      "TycoonAgents",
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );

    TycoonPanel.currentPanel = new TycoonPanel(panel, extensionUri, runtime);
    return TycoonPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    runtime: Runtime
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    this._update();

    // Subscribe to runtime state changes
    this._runtimeDisposable = runtime.onChange((state) => {
      void this._panel.webview.postMessage({ type: "state", state });
    });

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      (message: { type: string }) => {
        if (message.type === "ready") {
          void this._panel.webview.postMessage({ type: "state", state: runtime.getState() });
        }
      },
      null,
      this._disposables
    );

    // Clean up on panel dispose
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  public dispose(): void {
    TycoonPanel.currentPanel = undefined;
    this._runtimeDisposable?.dispose();
    this._panel.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
  }

  private _update(): void {
    const webview = this._panel.webview;
    this._panel.title = "TycoonAgents";
    this._panel.webview.html = this._getHtmlForWebview(webview);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "style.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "main.js")
    );

    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" nonce="${nonce}" />
  <title>TycoonAgents</title>
</head>
<body>
  <canvas id="stage"></canvas>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
