import * as vscode from 'vscode';
import type { WorldState, ThemeManifest } from '../shared/types';
import { loadLatestTheme } from './themeService';
import { waitForBundledThemes } from '../host/vscode/themeReady';
import { MSG } from '../host/vscode/messages';

let activeWebview: vscode.Webview | undefined;
let heartbeat: NodeJS.Timeout | undefined;
// The last theme broadcast to the Theater view, kept so a view that is
// re-resolved after "Restart Extensions" (its old webview torn down, a new
// one created) can be re-sent the theme on its next ready handshake instead
// of re-reading disk.
let lastTheme: { manifest: ThemeManifest; frames: Record<string, string[]> } | undefined;

/**
 * Injected dependencies for handleTheaterReady, factored out so the
 * ready-gated handshake is unit-testable without a real vscode.Webview.
 */
export interface TheaterReadyDeps {
  /** Resolves (bounded) once the first-run bundled-theme seed has settled. */
  bundledThemesReady: Promise<unknown> | undefined;
  /** Returns the last broadcast theme, if any, without touching disk. */
  getLastTheme: () => { manifest: ThemeManifest; frames: Record<string, string[]> } | undefined;
  /** Reads the latest theme from disk (global storage). */
  loadLatestTheme: () => Promise<{ manifest: ThemeManifest; frames: Record<string, string[]> } | undefined>;
  /** Posts a message back to the webview that sent THEATER_READY. */
  post: (msg: { type: string; payload?: unknown }) => void;
}

/**
 * The Theater webview's ready handshake: only once the webview confirms its
 * message listener is attached (THEATER_READY, reusing the generic
 * MSG.READY the main panel already uses) do we await the bundled-theme seed
 * and post a theme — never unconditionally at resolve time, which is what
 * raced the webview's script load and dropped THEME_INITIALIZED after a
 * "Restart Extensions".
 */
export async function handleTheaterReady(deps: TheaterReadyDeps): Promise<void> {
  const cached = deps.getLastTheme();
  if (cached) {
    deps.post({
      type: MSG.THEME_INITIALIZED,
      payload: { manifest: cached.manifest, frames: cached.frames, is_editor_mode: false },
    });
    return;
  }
  await waitForBundledThemes(deps.bundledThemesReady);
  const t = await deps.loadLatestTheme();
  if (t) {
    deps.post({
      type: MSG.THEME_INITIALIZED,
      payload: { manifest: t.manifest, frames: t.frames, is_editor_mode: false },
    });
  } else {
    deps.post({ type: MSG.THEME_NONE });
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
  /**
   * The activation-time bundled-theme seed promise (extension.ts's
   * `bundledThemesReady`), injected so a fresh install's Theater view waits
   * for the seed instead of racing it and showing nothing.
   */
  private readonly _bundledThemesReady: Promise<unknown> | undefined;

  constructor(
    extensionUri: vscode.Uri,
    globalStorageUri: vscode.Uri,
    bundledThemesReady?: Promise<unknown>,
  ) {
    this._extensionUri = extensionUri;
    this._globalStorageUri = globalStorageUri;
    this._bundledThemesReady = bundledThemesReady;
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

    webviewView.webview.onDidReceiveMessage(async (msg: { type?: string }) => {
      if (msg?.type === MSG.READY || msg?.type === 'THEME_REQUEST') {
        // THEME_REQUEST is the webview's own explicit re-request (e.g. a
        // manual retry); MSG.READY is the first-attach handshake. Both land
        // here so either broadcasts through the same lastTheme-or-disk path.
        await handleTheaterReady({
          bundledThemesReady: this._bundledThemesReady,
          getLastTheme: () => lastTheme,
          loadLatestTheme: () => loadLatestTheme(this._globalStorageUri),
          post: (m) => {
            if (m.type === MSG.THEME_INITIALIZED) {
              const p = m.payload as { manifest: ThemeManifest; frames: Record<string, string[]> };
              lastTheme = { manifest: p.manifest, frames: p.frames };
            }
            void webviewView.webview.postMessage(m);
          },
        });
      }
    });

    webviewView.webview.html = this._getHtml(webviewView.webview);

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

export function sendTelemetryUpdate(state: WorldState): void {
  if (activeWebview !== undefined) {
    void activeWebview.postMessage({ type: 'WORLD_TELEMETRY_UPDATE', payload: state });
  }
}

export function activate(
  context: vscode.ExtensionContext,
  bundledThemesReady?: Promise<unknown>,
): void {
  // 1. Register the webview view provider
  const provider = new TheaterViewProvider(
    context.extensionUri,
    context.globalStorageUri,
    bundledThemesReady,
  );
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
