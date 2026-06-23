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

let provider: ClaudeCodeProvider | undefined;
let demoDisposable: { dispose(): void } | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const runtime = new Runtime();

  // Command: open (or reveal) the TycoonAgents panel
  const openCmd = vscode.commands.registerCommand("tycoonagents.open", () => {
    TycoonPanel.createOrShow(context.extensionUri, runtime);

    // Start the Claude Code provider if not already running
    if (!provider) {
      // Resolve activity file: prefer CLAUDE_PROJECT_DIR env var, else the first
      // VS Code workspace folder. Must match the path resolution in the hook script.
      const projectRoot =
        process.env["CLAUDE_PROJECT_DIR"] ??
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
        "";
      const activityFile = path.join(projectRoot, ".claude", "tycoon", "activity.jsonl");
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
    TycoonPanel.createOrShow(context.extensionUri, runtime);
    // Cancel any previous demo
    demoDisposable?.dispose();
    demoDisposable = runDemo(runtime);
    context.subscriptions.push({ dispose: () => demoDisposable?.dispose() });
  });

  context.subscriptions.push(openCmd, demoCmd);
}

export function deactivate(): void {
  provider?.stop();
  provider = undefined;
  demoDisposable?.dispose();
  demoDisposable = undefined;
}
