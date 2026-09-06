/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as vscode from "vscode";
import * as path from "path";
import { Runtime } from "./runtime";
import { TycoonPanel, readExplicitProviderSetting } from "./panel";
import { runDemo } from "./demo";
import type { Provider } from "../../core/provider";
import { loadAgentRoster } from "../../providers/claude-code/agentRoster";
import { activate as activateTheater, deactivate as deactivateTheater } from "../../extension/main";
import { upgradeInstalledThemes } from "../../extension/themeService";
import { seedBundledThemes, type SeedResult } from "./bundledThemeSeeds";
import { resolveProjectRoot } from "./progressScope";
import { initLog, log } from "./log";
import { resolveProviderId } from "../../core/providerSelection";
import type { ProviderId } from "../../core/providerSelection";
import { createProvider } from "./providerFactory";

let provider: Provider | undefined;
// p13-t7: module state captured once the panel/provider are first started,
// so trySwapProvider (wired into TycoonPanel via setProviderSwap) can
// dispose the running Provider and construct the other one without an
// extension reload. Both are set together with `provider` in the openCmd
// handler below and never partially populated.
let swapRuntime: Runtime | undefined;
let swapActivityFile: string | undefined;
// The provider id actually feeding `provider` right now (set alongside it,
// both on initial start and on every successful trySwapProvider). Read by
// getRunningProviderId, wired into TycoonPanel via setProviderSwap so the
// Settings harness payload can report `running` separately from `effective`
// (the file/setting/env-derived value, which may already have moved on).
let currentProviderId: ProviderId | undefined;

function getRunningProviderId(): ProviderId | undefined {
  return currentProviderId;
}

/**
 * Attempts to replace the running Provider with one for `newId` in place.
 * Construct-and-start the NEW provider FIRST, and only stop the old one once
 * the new one is confirmed running — so a failure (factory throw, or the new
 * provider's start() throwing) leaves the OLD provider running rather than
 * neither. Returns false (no live swap happened; the old provider, if any,
 * is still running unchanged) when the extension hasn't started a provider
 * yet in this window (swapRuntime/swapActivityFile unset) or the new
 * provider failed to construct/start — the caller falls back to reporting
 * requiresRestart via the running/effective mismatch.
 */
function trySwapProvider(newId: ProviderId): boolean {
  if (swapRuntime === undefined || swapActivityFile === undefined) return false;
  const oldProvider = provider;
  let newProvider: Provider;
  try {
    newProvider = createProvider(newId, swapActivityFile);
    newProvider.start((e) => swapRuntime!.ingest(e));
  } catch (err) {
    console.error(
      "TycoonAgents: live provider swap failed (new provider did not start; keeping the previous one running):",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
  // New provider is up — safe to retire the old one now.
  try {
    oldProvider?.stop();
  } catch (err) {
    console.error("TycoonAgents: stopping the previous provider after a live swap failed:", err instanceof Error ? err.message : err);
  }
  provider = newProvider;
  currentProviderId = newId;
  log(`TycoonAgents: live-swapped provider to "${newId}".`);
  return true;
}

/**
 * Resolves when the first-run bundled-theme seed has finished (or was skipped
 * / failed). The panel awaits this — bounded by THEME_SEED_WAIT_MS — before
 * its first loadLatestTheme() so a fresh install doesn't race the seed and
 * paint the "no theme" placeholder. Initialized to an already-resolved empty
 * result so it is NEVER undefined and never rejects, whatever happens during
 * activation.
 */
export let bundledThemesReady: Promise<SeedResult> = Promise.resolve({ seeded: [], skipped: [] });
let demoDisposable: { dispose(): void } | undefined;

export function activate(context: vscode.ExtensionContext): void {
  initLog(context);
  const cfg = vscode.workspace.getConfiguration("tycoonagents");
  const idleFreezeMs = cfg.get<number>("idleFreezeMinutes", 3) * 60000;
  const sanityCapMs = cfg.get<number>("sanityCapMinutes", 15) * 60000;
  const runtime = new Runtime({ idleFreezeMs, sanityCapMs });

  // Best-effort: seed bundled starter themes into global storage on first
  // run so a freshly installed plugin has a default theme available.
  // Non-blocking (activation is not awaited on it), but the promise is
  // captured and handed to the panel so the panel's first theme load can wait
  // on it instead of racing it.
  bundledThemesReady = seedBundledThemes(context.extensionUri, context.globalStorageUri).catch(
    (error): SeedResult => {
      console.warn("TycoonAgents: bundled theme seeding failed:", error);
      return { seeded: [], skipped: [] };
    },
  );
  void bundledThemesReady;

  // Command: open (or reveal) the TycoonAgents panel
  const openCmd = vscode.commands.registerCommand("tycoonagents.open", () => {
    const panel = TycoonPanel.createOrShow(context.extensionUri, runtime, context.globalStorageUri, context.secrets, bundledThemesReady);
    panel.setProviderSwap(trySwapProvider, getRunningProviderId);

    // Start the Claude Code provider if not already running
    if (!provider) {
      // Resolve activity file: workspace-first, CLAUDE_PROJECT_DIR only as a
      // match/fallback (it's a process-wide env var, not per-window — see
      // resolveProjectRoot() in progressScope.ts). Must match panel.ts's
      // _projectRoot() and the path resolution in the hook script.
      const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const projectRoot = resolveProjectRoot(workspacePaths, process.env["CLAUDE_PROJECT_DIR"]);
      const activityFile = path.join(projectRoot, ".claude", "tycoon", "activity.jsonl");

      // Reset accumulated metrics state FIRST: a fresh ClaudeCodeProvider below
      // replays the ENTIRE activity.jsonl from byte 0 into `runtime`. Without
      // this, closing and reopening the panel re-ingests the same records into
      // the still-populated runtime, doubling every agent's taskCount/tokens/
      // activeMs on each reopen (tripling on a third reopen, etc). `runtime` is
      // a single long-lived instance held by TycoonPanel across reopens, so
      // reset() mutates it in place rather than the caller reassigning a new
      // Runtime object. Must run BEFORE roster seeding below, or the reset
      // would immediately erase the freshly-seeded WorkerRegistered rows.
      runtime.reset();

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

      const providerId = resolveProviderId({
        settingValue: readExplicitProviderSetting(cfg),
        projectDir: projectRoot,
      });
      log(`TycoonAgents: using provider "${providerId}".`);
      provider = createProvider(providerId, activityFile);
      provider.start((e) => runtime.ingest(e));
      swapRuntime = runtime;
      swapActivityFile = activityFile;
      currentProviderId = providerId;

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
    TycoonPanel.createOrShow(context.extensionUri, runtime, context.globalStorageUri, context.secrets, bundledThemesReady);
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
  activateTheater(context, bundledThemesReady);
}

export function deactivate(): void {
  provider?.stop();
  provider = undefined;
  swapRuntime = undefined;
  swapActivityFile = undefined;
  currentProviderId = undefined;
  demoDisposable?.dispose();
  demoDisposable = undefined;
  deactivateTheater();
}
