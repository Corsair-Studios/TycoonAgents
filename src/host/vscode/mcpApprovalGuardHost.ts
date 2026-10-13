/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// VS Code wiring for the always-on approval guard (see mcpApprovalGuard.ts).

import * as fs from "fs";
import * as vscode from "vscode";
import * as path from "path";
import { McpApprovalWatcher, runApprovalGuardDeferred } from "./mcpApprovalGuard";
import { copiesFromNewerInstall, discoverSiblingExtensions, extensionHookSource } from "./installedExtensions";
import { hasTycoonCommandsInSettings } from "./hookDoctor";
import { recordHooksChanged } from "./hookWait";
import { healInstalledHookCopies } from "./hookInstall";
import { log } from "./log";
import { resolveProjectRoot } from "./progressScope";
import type { ApprovalEnv } from "../../core/mcpApproval";

function guardRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  return resolveProjectRoot(folders ? folders.map((f) => f.uri.fsPath) : [], process.env["CLAUDE_PROJECT_DIR"]);
}

/** Same source the installer copies from: the installed extension's hooks/ then out/src/core. Siblings (other editors' installs) count as ours too. */
export function guardEnv(extensionUri: vscode.Uri): ApprovalEnv {
  return {
    resolveSrc: (fileName) => extensionHookSource(extensionUri.fsPath, fileName),
    altSrcs: (fileName) =>
      discoverSiblingExtensions(extensionUri.fsPath)
        .map((e) => extensionHookSource(e.dir, fileName))
        .filter((p): p is string => p !== undefined),
  };
}

/** True when this project's settings.local.json wires Claude hooks (Claude hooks in use, not a Codex-only project). */
function claudeHooksInUse(root: string): boolean {
  try {
    return hasTycoonCommandsInSettings(JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8")));
  } catch {
    return false;
  }
}

function extensionVersion(extensionUri: vscode.Uri): string | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(extensionUri.fsPath, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}

/**
 * One deferred, race-safe check (activation, panel construction, watcher events). Never blocks the caller.
 * The guard ALWAYS runs; nothing in the project decides whether it does. Our own refresh of the project's
 * hook copies runs FIRST (trusted workspaces with Claude hooks in use only, never over copies produced by a
 * newer installed TycoonAgents found on disk), so the guard never compares an old copy against this
 * extension. Copies identical to another installed extension's hooks count as ours (two editors, one
 * project). Revocations are logged only (no popup).
 */
export function runApprovalGuardSoon(extensionUri: vscode.Uri): Promise<string[]> {
  const root = guardRoot();
  const env = guardEnv(extensionUri);
  const version = extensionVersion(extensionUri);
  return Promise.resolve().then(() => {
    if (root === "") return [];
    if (vscode.workspace.isTrusted && claudeHooksInUse(root)) {
      try {
        if (!copiesFromNewerInstall(root, version, discoverSiblingExtensions(extensionUri.fsPath))) {
          if (healInstalledHookCopies(root, env.resolveSrc).length > 0) recordHooksChanged(root);
        }
      } catch {
        /* best effort: the guard still runs against whatever is on disk */
      }
    }
    return runApprovalGuardDeferred(root, vscode.Uri.joinPath(extensionUri, "media").fsPath, env, (m) => {
      log(m);
    });
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
