/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import * as vscode from "vscode";
import * as path from "path";
import { Runtime } from "./runtime";
import { TycoonPanel } from "./panel";
import { runDemo } from "./demo";
import { ClaudeCodeProvider } from "../../providers/claude-code/claudeCodeProvider";
import { loadAgentRoster } from "../../providers/claude-code/agentRoster";
import { activate as activateTheater, deactivate as deactivateTheater } from "../../extension/main";

let provider: ClaudeCodeProvider | undefined;
let demoDisposable: { dispose(): void } | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration("tycoonagents");
  const idleFreezeMs = cfg.get<number>("idleFreezeMinutes", 3) * 60000;
  const sanityCapMs = cfg.get<number>("sanityCapMinutes", 15) * 60000;
  const runtime = new Runtime({ idleFreezeMs, sanityCapMs });

  // Command: open (or reveal) the TycoonAgents panel
  const openCmd = vscode.commands.registerCommand("tycoonagents.open", () => {
    TycoonPanel.createOrShow(context.extensionUri, runtime, context.globalStorageUri);

    // Start the Claude Code provider if not already running
    if (!provider) {
      // Resolve activity file: prefer CLAUDE_PROJECT_DIR env var, else the first
      // VS Code workspace folder. Must match the path resolution in the hook script.
      const projectRoot =
        process.env["CLAUDE_PROJECT_DIR"] ??
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
        "";
      const activityFile = path.join(projectRoot, ".claude", "tycoon", "activity.jsonl");

      // Seed the full installed-agent roster so every agent appears as an idle
      // row from the start, regardless of whether it has done any work yet.
      const agentsDir = path.join(projectRoot, ".claude", "agents");
      for (const agent of loadAgentRoster(agentsDir)) {
        // Post-process: shorten the search-retrieval agent's display name.
        const displayName =
          agent.id === "search-retrieval"
            ? agent.name.replace(/ Agent$/, "")
            : agent.name;
        runtime.ingest({
          type: "WorkerRegistered",
          at: Date.now(),
          workerId: agent.id,
          name: displayName,
          ...(agent.model !== undefined ? { model: agent.model } : {}),
          ...(agent.description !== undefined ? { description: agent.description } : {}),
        });
      }

      provider = new ClaudeCodeProvider({ activityFile });
      provider.start((e) => runtime.ingest(e));

      // Stop provider when the panel is disposed
      const checkDispose = setInterval(() => {
        if (!TycoonPanel.currentPanel) {
          clearInterval(checkDispose);
          provider?.stop();
          provider = undefined;
        }
      }, 500);
      context.subscriptions.push({ dispose: () => clearInterval(checkDispose) });
    }
  });

  // Command: run demo sequence
  const demoCmd = vscode.commands.registerCommand("tycoonagents.demo", () => {
    TycoonPanel.createOrShow(context.extensionUri, runtime, context.globalStorageUri);
    // Cancel any previous demo
    demoDisposable?.dispose();
    demoDisposable = runDemo(runtime);
    context.subscriptions.push({ dispose: () => demoDisposable?.dispose() });
  });

  context.subscriptions.push(openCmd, demoCmd);

  // Auto-open the live panel on startup if the setting is enabled
  const autoShow = vscode.workspace
    .getConfiguration("tycoonagents")
    .get<boolean>("autoShow", true);
  if (autoShow) {
    setTimeout(() => {
      vscode.commands.executeCommand("tycoonagents.open");
    }, 500);
  }

  // Boot the Theme Factory / Theater lifecycle controller (webview view, generateTheme command, telemetry heartbeat).
  activateTheater(context);
}

export function deactivate(): void {
  provider?.stop();
  provider = undefined;
  demoDisposable?.dispose();
  demoDisposable = undefined;
  deactivateTheater();
}
