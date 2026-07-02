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
import { seedBundledThemes, upgradeInstalledThemes } from "../../extension/themeService";

let provider: ClaudeCodeProvider | undefined;
let demoDisposable: { dispose(): void } | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration("tycoonagents");
  const idleFreezeMs = cfg.get<number>("idleFreezeMinutes", 3) * 60000;
  const sanityCapMs = cfg.get<number>("sanityCapMinutes", 15) * 60000;
  const runtime = new Runtime({ idleFreezeMs, sanityCapMs });

  // Best-effort: seed bundled starter themes into global storage on first
  // run so a freshly installed plugin has a default theme available.
  void seedBundledThemes(context.extensionUri, context.globalStorageUri);

  // Command: open (or reveal) the TycoonAgents panel
  const openCmd = vscode.commands.registerCommand("tycoonagents.open", () => {
    TycoonPanel.createOrShow(context.extensionUri, runtime, context.globalStorageUri, context.secrets);

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
    TycoonPanel.createOrShow(context.extensionUri, runtime, context.globalStorageUri, context.secrets);
    // Cancel any previous demo
    demoDisposable?.dispose();
    demoDisposable = runDemo(runtime);
    context.subscriptions.push({ dispose: () => demoDisposable?.dispose() });
  });

  // Command: upgrade every installed theme manifest to the current data
  // contract (adds decor_objects, crate/poof/projectile assets, enemy_config)
  // without regenerating art. Missing art shows as labeled placeholders.
  const upgradeThemesCmd = vscode.commands.registerCommand(
    "tycoonagents.upgradeInstalledThemes",
    async () => {
      try {
        const results = await upgradeInstalledThemes(context.globalStorageUri);
        if (results.length === 0) {
          void vscode.window.showInformationMessage("No installed themes found.");
          return;
        }

        const upgraded = results.filter((r) => r.changed.length > 0);
        const upToDateCount = results.length - upgraded.length;

        for (const r of upgraded) {
          console.log(`[TycoonAgents] Upgraded theme "${r.theme_id}": ${r.changed.join("; ")}`);
        }

        if (upgraded.length === 0) {
          void vscode.window.showInformationMessage(
            `All ${results.length} installed theme(s) are already up to date.`,
          );
          return;
        }

        const detail = upgraded
          .map((r) => `${r.theme_id} (${r.changed.length} update${r.changed.length === 1 ? "" : "s"})`)
          .join(", ");
        const upToDateSuffix = upToDateCount > 0 ? ` ${upToDateCount} already current.` : "";
        void vscode.window.showInformationMessage(
          `Upgraded ${upgraded.length} of ${results.length} theme(s): ${detail}.${upToDateSuffix}`,
        );
      } catch (error) {
        console.error("[TycoonAgents] Theme upgrade failed:", error);
        void vscode.window.showErrorMessage(
          `TycoonAgents: Theme upgrade failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );

  context.subscriptions.push(openCmd, demoCmd, upgradeThemesCmd);

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
