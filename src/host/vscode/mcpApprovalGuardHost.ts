/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// VS Code wiring for the always-on approval guard (see mcpApprovalGuard.ts).

import * as fs from "fs";
import * as vscode from "vscode";
import { McpApprovalWatcher, runApprovalGuardDeferred } from "./mcpApprovalGuard";
import { resolveProjectRoot } from "./progressScope";
import type { ApprovalEnv } from "../../core/mcpApproval";

function guardRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  return resolveProjectRoot(folders ? folders.map((f) => f.uri.fsPath) : [], process.env["CLAUDE_PROJECT_DIR"]);
}

/** Same source the installer copies from: the installed extension's hooks/ then out/src/core. */
export function guardEnv(extensionUri: vscode.Uri): ApprovalEnv {
  return {
    resolveSrc: (fileName) => {
      const hooksPath = vscode.Uri.joinPath(extensionUri, "hooks", fileName).fsPath;
      if (fs.existsSync(hooksPath)) return hooksPath;
      const outPath = vscode.Uri.joinPath(extensionUri, "out", "src", "core", fileName).fsPath;
      return fs.existsSync(outPath) ? outPath : undefined;
    },
  };
}

/** One deferred, race-safe check (activation, panel construction, watcher events). Never blocks the caller. */
export function runApprovalGuardSoon(extensionUri: vscode.Uri): Promise<string[]> {
  return runApprovalGuardDeferred(guardRoot(), vscode.Uri.joinPath(extensionUri, "media").fsPath, guardEnv(extensionUri), (m) => {
    void vscode.window.showWarningMessage(m);
  });
}

/** Check soon, then re-check (debounced) on changes to <root>/.claude/hooks/** and <root>/.mcp.json. */
export function startMcpApprovalGuard(extensionUri: vscode.Uri): vscode.Disposable {
  const root = guardRoot();
  void runApprovalGuardSoon(extensionUri);
  if (root === "") return { dispose() {} };
  const watcher = new McpApprovalWatcher(
    root,
    (r, glob, onEvent) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(r, glob));
      w.onDidChange(onEvent);
      w.onDidCreate(onEvent);
      w.onDidDelete(onEvent);
      return w;
    },
    () => {
      void runApprovalGuardSoon(extensionUri);
    },
  );
  return { dispose: () => watcher.dispose() };
}
