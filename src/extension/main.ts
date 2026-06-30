import * as vscode from 'vscode';
import type { WorldState, ThemeManifest } from '../shared/types';
import {
  listThemes,
  loadTheme,
} from './themeService';
import { themeManifestUri } from './themeStorage';

let activeWebview: vscode.Webview | undefined;
let heartbeat: NodeJS.Timeout | undefined;
let lastTheme: { manifest: ThemeManifest; frames: Record<string, string[]> } | undefined;

function broadcastTheme(manifest: ThemeManifest, frames: Record<string, string[]>, isEditorMode: boolean): void {
  if (activeWebview !== undefined) {
    void activeWebview.postMessage({
      type: 'THEME_INITIALIZED',
      payload: { manifest, frames, is_editor_mode: isEditorMode },
    });
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

class TheaterViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'tycoon.theaterView';
  private readonly _extensionUri: vscode.Uri;
  private readonly _globalStorageUri: vscode.Uri;

  constructor(extensionUri: vscode.Uri, globalStorageUri: vscode.Uri) {
    this._extensionUri = extensionUri;
    this._globalStorageUri = globalStorageUri;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'media'),
        vscode.Uri.joinPath(this._extensionUri, 'assets'),
      ],
    };

    activeWebview = webviewView.webview;
    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg: { type?: string }) => {
      if (msg?.type === 'THEME_REQUEST') {
        const t = lastTheme ?? await loadLatestTheme(this._globalStorageUri);
        if (t) broadcastTheme(t.manifest, t.frames, false);
      }
    });

    void (async () => {
      const t = lastTheme ?? await loadLatestTheme(this._globalStorageUri);
      if (t) broadcastTheme(t.manifest, t.frames, false);
    })();

    webviewView.onDidDispose(() => {
      activeWebview = undefined;
    });
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'theme-builder.js'),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Tycoon Theater</title>
</head>
<body>
  <div id="theme-builder-root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
  <script nonce="${nonce}">
    (function () {
      var root = document.getElementById('theme-builder-root');
      if (root && typeof window.initThemeBuilder === 'function') {
        window.initThemeBuilder(root);
      }
    })();
  </script>
</body>
</html>`;
  }
}

async function loadLatestTheme(globalStorageUri: vscode.Uri): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]> } | undefined> {
  try {
    const themes = await listThemes(globalStorageUri);
    let newest: { themeId: string; mtime: number } | undefined;
    for (const theme of themes) {
      let mtime = 0;
      try {
        mtime = (await vscode.workspace.fs.stat(themeManifestUri(globalStorageUri, theme.theme_id))).mtime;
      } catch {
        try {
          mtime = (await vscode.workspace.fs.stat(
            vscode.Uri.joinPath(globalStorageUri, `${theme.theme_id}_manifest.json`),
          )).mtime;
        } catch {
          continue;
        }
      }
      if (newest === undefined || mtime > newest.mtime) newest = { themeId: theme.theme_id, mtime };
    }
    if (!newest) return undefined;
    return loadTheme(globalStorageUri, newest.themeId);
  } catch {
    return undefined;
  }
}

export function sendTelemetryUpdate(state: WorldState): void {
  if (activeWebview !== undefined) {
    void activeWebview.postMessage({ type: 'WORLD_TELEMETRY_UPDATE', payload: state });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // 1. Register the webview view provider
  const provider = new TheaterViewProvider(context.extensionUri, context.globalStorageUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TheaterViewProvider.viewType, provider),
  );

  // 2. Mock CLI heartbeat watcher
  let buildProgressUnits = 0;
  heartbeat = setInterval(() => {
    void (async () => {
      const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
      let activeAgents: string[] = [];

      if (folderUri !== undefined) {
        try {
          const fileUri = vscode.Uri.joinPath(folderUri, '.telemetry_state');
          const raw = await vscode.workspace.fs.readFile(fileUri);
          const text = Buffer.from(raw).toString('utf8').trim();
          // Try JSON first, fall back to newline/comma-separated strings
          try {
            const parsed: unknown = JSON.parse(text);
            if (Array.isArray(parsed)) {
              activeAgents = (parsed as unknown[]).filter((x): x is string => typeof x === 'string');
            } else if (parsed !== null && typeof parsed === 'object') {
              activeAgents = Object.keys(parsed as Record<string, unknown>);
            }
          } catch {
            // Newline or comma-separated
            activeAgents = text
              .split(/[\n,]+/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
          }
        } catch {
          // File absent or unreadable — normal, swallow silently
        }
      }

      const hasActiveAgents = activeAgents.length > 0;
      if (hasActiveAgents) {
        buildProgressUnits += 1;
      }

      const worldState: WorldState = {
        current_mode: hasActiveAgents ? 'MODE_CONSTRUCT' : 'MODE_IDLE',
        active_build_target_id: hasActiveAgents ? (activeAgents[0] ?? null) : null,
        build_progress_units: buildProgressUnits,
        active_rivals: [],
      };

      sendTelemetryUpdate(worldState);
    })();
  }, 1000);

  // Disposable to clear the heartbeat interval
  context.subscriptions.push({
    dispose: () => {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    },
  });

  // 3. Register tycoon.generateTheme command
  context.subscriptions.push(
    vscode.commands.registerCommand('tycoon.generateTheme', async () => {
      await vscode.commands.executeCommand('tycoonagents.open');
      void vscode.window.showInformationMessage(
        'Open Themes > Theme Builder to AI-fill and review every slot before generation.',
      );
    }),
  );
}

export function deactivate(): void {
  if (heartbeat !== undefined) {
    clearInterval(heartbeat);
    heartbeat = undefined;
  }
  activeWebview = undefined;
}
