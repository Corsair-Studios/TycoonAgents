/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
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
    // Dock beside the editor (ViewColumn.Two) so we never cover the active
    // Claude Code session in column One.
    const column = vscode.ViewColumn.Two;

    if (TycoonPanel.currentPanel) {
      TycoonPanel.currentPanel._panel.reveal(column, /* preserveFocus */ true);
      return TycoonPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      TycoonPanel.viewType,
      "TycoonAgents",
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        // Keep the webview alive when hidden so state/animation don't reset.
        retainContextWhenHidden: true,
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
      (message: { type: string; id?: string }) => {
        if (message.type === "ready") {
          void this._panel.webview.postMessage({ type: "state", state: runtime.getState() });
        } else if (message.type === "getSkills") {
          this._handleGetSkills();
        } else if (message.type === "installSkill") {
          if (message.id !== undefined) {
            this._handleInstallSkill(message.id);
          }
        }
      },
      null,
      this._disposables
    );

    // Clean up on panel dispose
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  private _handleGetSkills(): void {
    const catalogPath = path.join(this._extensionUri.fsPath, "media", "skills", "catalog.json");
    const projectRoot =
      process.env["CLAUDE_PROJECT_DIR"] ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      "";
    try {
      const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as Array<{
        id: string;
        name: string;
        description: string;
      }>;
      const skills = catalog.map((entry) => ({
        ...entry,
        installed:
          projectRoot !== "" &&
          fs.existsSync(path.join(projectRoot, ".claude", "skills", entry.id)),
      }));
      void this._panel.webview.postMessage({ type: "skills", skills });
    } catch (e) {
      void this._panel.webview.postMessage({ type: "skills", skills: [], error: String(e) });
    }
  }

  private _handleInstallSkill(id: string): void {
    const catalogPath = path.join(this._extensionUri.fsPath, "media", "skills", "catalog.json");
    const projectRoot =
      process.env["CLAUDE_PROJECT_DIR"] ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      "";

    let catalog: Array<{ id: string; name: string; description: string }>;
    try {
      catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as Array<{
        id: string;
        name: string;
        description: string;
      }>;
    } catch (e) {
      void this._panel.webview.postMessage({
        type: "skillInstalled",
        id,
        ok: false,
        error: String(e),
      });
      return;
    }

    const known = catalog.some((entry) => entry.id === id);
    if (!known) {
      void this._panel.webview.postMessage({
        type: "skillInstalled",
        id,
        ok: false,
        error: "Unknown skill",
      });
      return;
    }

    if (projectRoot === "") {
      void this._panel.webview.postMessage({
        type: "skillInstalled",
        id,
        ok: false,
        error: "No workspace folder open",
      });
      return;
    }

    const target = path.join(projectRoot, ".claude", "skills", id);
    if (fs.existsSync(target)) {
      void this._panel.webview.postMessage({ type: "skillInstalled", id, ok: true, alreadyExisted: true });
      return;
    }

    try {
      const src = path.join(this._extensionUri.fsPath, "media", "skills", id);
      fs.mkdirSync(path.join(projectRoot, ".claude", "skills"), { recursive: true });
      fs.cpSync(src, target, { recursive: true });
      void this._panel.webview.postMessage({ type: "skillInstalled", id, ok: true, alreadyExisted: false });
    } catch (e) {
      void this._panel.webview.postMessage({
        type: "skillInstalled",
        id,
        ok: false,
        error: String(e),
      });
    }
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

    let version = "";
    try {
      const pkgRaw = fs.readFileSync(
        path.join(this._extensionUri.fsPath, "package.json"),
        "utf8"
      );
      version = JSON.parse(pkgRaw).version || "";
    } catch {
      /* version stays empty if package.json can't be read */
    }

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
  <!-- Canvas kept in DOM so existing render loop does not crash; hidden via CSS -->
  <canvas id="stage"></canvas>

  <!-- App shell: stage on top, resize handle, metrics panel on bottom -->
  <div id="app">

    <!-- Stage area: placeholder for future characters / background -->
    <div id="stage-area">
      <!-- Hamburger menu: scaffold for future panel controls -->
      <button id="menu-btn" aria-label="Open menu" aria-expanded="false" aria-haspopup="true">&#9776;</button>
      <div id="menu-popover" role="menu" hidden>
        <button class="menu-item" role="menuitem" id="menu-skills">Skills</button>
        <button class="menu-item" role="menuitem">Settings</button>
        <button class="menu-item" role="menuitem" id="menu-theme-builder">Theme builder</button>
        <button class="menu-item" role="menuitem" id="menu-about">About</button>
        ${version ? `<div class="menu-version" role="presentation">v${version}</div>` : ""}
      </div>
    </div>

    <!-- Resize handle: drag to split stage vs metrics panel -->
    <div id="resize-handle" role="separator" aria-label="Drag to resize panels">
      <span class="resize-grip"></span>
    </div>

    <!-- Metrics panel -->
    <div id="metrics-panel">
      <div id="metrics-header">
        <span class="header-dot"></span>
        <span class="header-title">Tycoon Agents &mdash; Agent Metrics</span>
      </div>
      <div id="metrics-body">
        <div id="metrics-empty">No agents yet &mdash; start a session to see activity.</div>
        <table id="metrics-table" style="display:none">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Tokens/min</th>
              <th class="col-tasks">Tasks</th>
              <th class="col-mcp">MCP</th>
              <th class="col-time">Time</th>
              <th class="col-tokens">Tokens</th>
            </tr>
          </thead>
          <tbody id="metrics-tbody"></tbody>
        </table>
      </div>
    </div>

  </div><!-- /#app -->

  <!-- Skills modal overlay -->
  <div id="skills-modal" role="dialog" aria-modal="true" aria-labelledby="skills-modal-title" hidden>
    <div id="skills-backdrop"></div>
    <div id="skills-dialog">
      <button id="skills-modal-close" aria-label="Close dialog">&times;</button>
      <h2 id="skills-modal-title">Skills</h2>
      <div id="skills-list"></div>
    </div>
  </div>

  <!-- About modal overlay -->
  <div id="about-modal" role="dialog" aria-modal="true" aria-labelledby="about-modal-title" hidden>
    <div id="about-backdrop"></div>
    <div id="about-dialog">
      <button id="modal-close" aria-label="Close dialog">&times;</button>
      <h2 id="about-modal-title">TycoonAgents</h2>
      <p>Created by Scott McClellan</p>
      <p>
        <a href="https://x.com/thetrashbyrd" target="_blank" rel="noopener noreferrer">@thetrashbyrd</a>
      </p>
      <p>
        <a href="https://github.com/Corsair-Studios/TycoonAgents" target="_blank" rel="noopener noreferrer">GitHub repository</a>
      </p>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
