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
import { execFileSync } from 'child_process';

/**
 * @param {object} opts
 * @param {(jsPath: string, label: string) => any} opts.requireCompiledOrThrow
 * @param {string} opts.repoRoot
 * @param {string|null} opts.projectRoot
 * @param {string} opts.version
 * @param {string} [opts.harness] Caller's already-resolved effective harness
 *   (e.g. resolveEffectiveHarness(projectRoot) in server.mjs) — recorded on
 *   the manifest when it is a recognized harness id.
 * @returns {{ ok: boolean, path?: string, error?: string }}
 */
export function handleExportTeamSetupStandalone({ requireCompiledOrThrow, repoRoot, projectRoot, version, harness }) {
  if (!projectRoot) {
    return { ok: false, error: 'No project root resolved' };
  }
  try {
    const teamSetupHostPath = path.join(repoRoot, 'out', 'src', 'host', 'vscode', 'teamSetupHost.js');
    const { exportTeamSetup } = requireCompiledOrThrow(teamSetupHostPath, 'teamSetupHost');
    return exportTeamSetup({ root: projectRoot, env: process.env, version, harness });
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

/**
 * Standalone-side "Check team readiness" handler (p50-t2). Binds
 * `buildTeamReadinessHost` (out/src/host/vscode/teamSetupHost.js) with
 * `hostKind: 'standalone'` and an execSeam wired to child_process's
 * execFileSync (argv array only — never a shell string) so the codex/
 * opencode discovery probes can run under plain Node the same way they do
 * inside the VS Code host.
 *
 * @param {object} opts
 * @param {(jsPath: string, label: string) => any} opts.requireCompiledOrThrow
 * @param {string} opts.repoRoot
 * @param {string|null} opts.projectRoot
 * @param {boolean} [opts.probeReachability]
 * @returns {Promise<{ ok: boolean, report?: object, text?: string, error?: string }>}
 */
export async function handleCheckTeamReadinessStandalone({ requireCompiledOrThrow, repoRoot, projectRoot, probeReachability }) {
  if (!projectRoot) {
    return { ok: false, error: 'No project root resolved' };
  }
  try {
    const teamSetupHostPath = path.join(repoRoot, 'out', 'src', 'host', 'vscode', 'teamSetupHost.js');
    const { buildTeamReadinessHost } = requireCompiledOrThrow(teamSetupHostPath, 'teamSetupHost');
    const execSeam = (command) => execFileSync(command, { encoding: 'utf8' });
    return await buildTeamReadinessHost({
      root: projectRoot,
      env: process.env,
      probeReachability: !!probeReachability,
      hostKind: 'standalone',
      execSeam,
    });
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Standalone-side "Get team setup drift" handler (p50-t2). Thin wrapper
 * around `getTeamSetupDriftHost` (out/src/host/vscode/teamSetupHost.js).
 *
 * @param {object} opts
 * @param {(jsPath: string, label: string) => any} opts.requireCompiledOrThrow
 * @param {string} opts.repoRoot
 * @param {string|null} opts.projectRoot
 * @returns {{ hasManifest: boolean, drift: boolean, rosterChanged: boolean, routingChanged: boolean, manifestExportedAt?: string, appliedExportedAt?: string }}
 */
export function handleGetTeamSetupDriftStandalone({ requireCompiledOrThrow, repoRoot, projectRoot }) {
  if (!projectRoot) {
    return { hasManifest: false, drift: false, rosterChanged: false, routingChanged: false };
  }
  try {
    const teamSetupHostPath = path.join(repoRoot, 'out', 'src', 'host', 'vscode', 'teamSetupHost.js');
    const { getTeamSetupDriftHost } = requireCompiledOrThrow(teamSetupHostPath, 'teamSetupHost');
    return getTeamSetupDriftHost(projectRoot);
  } catch {
    return { hasManifest: false, drift: false, rosterChanged: false, routingChanged: false };
  }
}
