/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Standalone-side "Export team setup" handler (plan task p48-t3). Thin
// wrapper around the tsc-compiled out/src/host/vscode/teamSetupHost.js
// (exportTeamSetup) — same "require the compiled host-agnostic module"
// posture server.mjs uses for routingHostOps/delegationDoctrine/etc. Kept
// in its own file so the EXPORT_TEAM_SETUP case in server.mjs stays a
// one-line call, matching panel.ts's _handleExportTeamSetup.
// ---------------------------------------------------------------------------

import * as path from 'path';

/**
 * @param {object} opts
 * @param {(jsPath: string, label: string) => any} opts.requireCompiledOrThrow
 * @param {string} opts.repoRoot
 * @param {string|null} opts.projectRoot
 * @param {string} opts.version
 * @returns {{ ok: boolean, path?: string, error?: string }}
 */
export function handleExportTeamSetupStandalone({ requireCompiledOrThrow, repoRoot, projectRoot, version }) {
  if (!projectRoot) {
    return { ok: false, error: 'No project root resolved' };
  }
  try {
    const teamSetupHostPath = path.join(repoRoot, 'out', 'src', 'host', 'vscode', 'teamSetupHost.js');
    const { exportTeamSetup } = requireCompiledOrThrow(teamSetupHostPath, 'teamSetupHost');
    return exportTeamSetup({ root: projectRoot, env: process.env, version });
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Standalone-side "Apply team setup" handler (p49-t1). Same
 * require-the-compiled-module posture as the export handler above: binds
 * `applyTeamSetupHost` (out/src/host/vscode/teamSetupHost.js — that module
 * has no `vscode` import, so it loads fine under plain Node) with
 * `hookSourceDir` pointed at the standalone's own bundled `hooks/` dir
 * instead of a VS Code extension URI. No opencode-config or MCP-catalog
 * installer is bound here — the standalone has no MCP-catalog UI/confirm
 * flow equivalent to panel.ts's `_handleInstallMcp`, and no opencode-config
 * generator exists anywhere in this codebase yet — both steps report as
 * "skipped" with a detail explaining why, exactly as they do on the VS Code
 * side.
 *
 * @param {object} opts
 * @param {(jsPath: string, label: string) => any} opts.requireCompiledOrThrow
 * @param {string} opts.repoRoot
 * @param {string|null} opts.projectRoot
 * @param {string} opts.version
 * @param {'flat'|'team_leads'} [opts.delegationMode]
 * @returns {{ ok: boolean, changed: boolean, steps: Array<{name:string,status:string,detail?:string}>, missingAgents: string[], error?: string }}
 */
export function handleApplyTeamSetupStandalone({ requireCompiledOrThrow, repoRoot, projectRoot, version, delegationMode }) {
  if (!projectRoot) {
    return { ok: false, changed: false, steps: [], missingAgents: [], error: 'No project root resolved' };
  }
  try {
    const teamSetupHostPath = path.join(repoRoot, 'out', 'src', 'host', 'vscode', 'teamSetupHost.js');
    const { applyTeamSetupHost } = requireCompiledOrThrow(teamSetupHostPath, 'teamSetupHost');
    const hookSourceDir = path.join(repoRoot, 'hooks');
    return applyTeamSetupHost({
      root: projectRoot,
      env: process.env,
      version,
      hookSourceDir,
      delegationMode: delegationMode === 'team_leads' ? 'team_leads' : 'flat',
      regenerateOpencodeConfig: null,
      applyMcp: null,
    });
  } catch (err) {
    return { ok: false, changed: false, steps: [], missingAgents: [], error: err && err.message ? err.message : String(err) };
  }
}
