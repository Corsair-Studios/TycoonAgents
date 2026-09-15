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
