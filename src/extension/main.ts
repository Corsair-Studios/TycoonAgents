import * as vscode from 'vscode';
import { expandThemePrompt, buildCharacterAtlasPrompt, buildEnvironmentPrompt } from './translator';
import { generateThemeImage } from './imageClient';
import { sliceAndNormalizeAtlas } from './slicer';
import type { WorldState, ThemeManifest, AgentConfig, RivalConfig } from '../shared/types';

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
    const entries = await vscode.workspace.fs.readDirectory(globalStorageUri);
    const manifests = entries.filter(([name, kind]) => kind === vscode.FileType.File && name.endsWith('_manifest.json'));
    if (manifests.length === 0) return undefined;
    let newest: { name: string; mtime: number } | undefined;
    for (const [name] of manifests) {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(globalStorageUri, name));
      if (newest === undefined || stat.mtime > newest.mtime) newest = { name, mtime: stat.mtime };
    }
    if (!newest) return undefined;
    const themeId = newest.name.replace(/_manifest\.json$/, '');
    const manifestBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(globalStorageUri, newest.name));
    const framesBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(globalStorageUri, `${themeId}_frames.json`));
    const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as ThemeManifest;
    const frames = JSON.parse(Buffer.from(framesBytes).toString('utf8')) as Record<string, string[]>;
    return { manifest, frames };
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
      const input = await vscode.window.showInputBox({
        prompt: 'Describe your theme (e.g. "GI Joe Cobra")',
      });
      if (input === undefined || input.trim() === '') {
        return;
      }

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Generating Theme Tycoon Assets',
            cancellable: true,
          },
          async (progress, token) => {
            // Gate 1: expand theme
            progress.report({ message: 'Expanding theme concept...' });
            const { systemPrompt, suggestedManifest } = await expandThemePrompt(input);

            const displayName = suggestedManifest.display_name ?? input;
            // Slugify display_name → theme_id
            const theme_id = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
            const sidecarFilename = `${theme_id}_frames.json`;

            // Build the work list: 16 agents + 2 rivals = 18 characters
            const agentEntries = (suggestedManifest.roster_agents ?? []).map((a) => ({
              key: `agent_${a.slot_id}`,
              name: a.name,
              kind: 'agent' as const,
              original: a,
            }));
            const rivalEntries = (suggestedManifest.roster_rivals ?? []).map((r) => ({
              key: r.rival_id,
              name: r.name,
              kind: 'rival' as const,
              original: r,
            }));
            const workList = [...agentEntries, ...rivalEntries];

            const frames: Record<string, string[]> = {};
            const updatedAgents: AgentConfig[] = [];
            const updatedRivals: RivalConfig[] = [];

            // Generate one atlas per character
            for (let i = 0; i < workList.length; i++) {
              if (token.isCancellationRequested) {
                vscode.window.showInformationMessage('TycoonAgents: Theme generation cancelled.');
                return;
              }

              const entry = workList[i];
              progress.report({ message: `${entry.name} (${i + 1}/${workList.length})` });

              const charPrompt = buildCharacterAtlasPrompt(systemPrompt, entry.name, displayName);
              const buf = await generateThemeImage(charPrompt);
              const pkg = await sliceAndNormalizeAtlas(buf, suggestedManifest);

              frames[entry.key] = pkg.slots.map((s) => s.data);

              const atlasRef = `${sidecarFilename}#${entry.key}`;
              if (entry.kind === 'agent') {
                updatedAgents.push({ ...entry.original, atlas_asset: atlasRef });
              } else {
                updatedRivals.push({ ...entry.original, atlas_asset: atlasRef });
              }

              // Rate-limit: 1500ms between calls except after the last character
              if (i < workList.length - 1) {
                await new Promise<void>((r) => setTimeout(r, 1500));
              }
            }

            // Environment background (after all characters)
            if (!token.isCancellationRequested) {
              progress.report({ message: 'Environment background (18/18)' });
              try {
                const envBuf = await generateThemeImage(
                  buildEnvironmentPrompt(systemPrompt, displayName),
                );
                const envDataUri = 'data:image/png;base64,' + envBuf.toString('base64');
                frames['environment_background'] = [envDataUri];
                if (suggestedManifest.viewport) {
                  suggestedManifest.viewport.background_asset =
                    `${sidecarFilename}#environment_background`;
                }
              } catch (envErr) {
                console.warn(
                  'TycoonAgents: Environment background generation failed (non-fatal):',
                  envErr,
                );
              }
            }

            // Assemble full ThemeManifest
            const manifest: ThemeManifest = {
              manifest_version: '1.0.0',
              theme_id,
              display_name: displayName,
              author: 'TycoonAgents Factory',
              viewport: suggestedManifest.viewport ?? {
                native_width: 1280,
                native_height: 720,
                background_asset: 'background.png',
                walkable_nav_polygon: [
                  [0.50, 0.15], [0.88, 0.38], [0.88, 0.82],
                  [0.50, 0.95], [0.12, 0.82], [0.12, 0.38],
                ],
              },
              roster_agents: updatedAgents,
              roster_rivals: updatedRivals,
              // TODO: props/badges/emotes not yet emitted by Gate 1; pending schema coordination (docs/IPC-CONTRACT.md)
              buildable_objects: [],
              badges: [],
            };

            // Persist to global storage
            await vscode.workspace.fs.createDirectory(context.globalStorageUri);

            const manifestUri = vscode.Uri.joinPath(
              context.globalStorageUri,
              `${theme_id}_manifest.json`,
            );
            await vscode.workspace.fs.writeFile(
              manifestUri,
              Buffer.from(JSON.stringify(manifest, null, 2)),
            );

            const framesUri = vscode.Uri.joinPath(context.globalStorageUri, sidecarFilename);
            await vscode.workspace.fs.writeFile(
              framesUri,
              Buffer.from(JSON.stringify(frames, null, 2)),
            );

            lastTheme = { manifest, frames };
            broadcastTheme(manifest, frames, true);

            vscode.window.showInformationMessage(
              `TycoonAgents: Theme manifest saved → ${manifestUri.fsPath}`,
            );
          },
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `TycoonAgents: Theme generation failed — ${String(err)}`,
        );
      }
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
