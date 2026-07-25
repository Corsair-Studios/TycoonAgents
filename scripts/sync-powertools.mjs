#!/usr/bin/env node
// Best-effort mirror of the UEFN Power Tools bridge (media/uefn-bridge/*.py +
// the MCP server source) into a separate, standalone "Trashbyrd's UEFN Power
// Tools" repo so that repo can be distributed independently of TycoonAgents.
//
// This script is a NO-OP on any machine that hasn't configured a target
// directory (every contributor's machine except the maintainer's release
// box), and it must NEVER fail a release — every failure path logs and
// returns/exits cleanly rather than throwing.
//
// Target dir resolution (first match wins):
//   1. process.env.POWERTOOLS_REPO_DIR
//   2. scripts/powertools-sync.local.json -> { "targetDir": "..." }
//      (gitignored; machine-local, never committed)
// If neither resolves, or the resolved directory doesn't exist, this is a
// clean no-op (exit 0).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR); // repo root (scripts/ is one level down)

const LOCAL_CONFIG_PATH = join(SCRIPT_DIR, 'powertools-sync.local.json');
const BRIDGE_DIR = join(ROOT, 'media', 'uefn-bridge');
const SERVER_SRC = join(ROOT, 'uefn-bridge', 'uefn-server.ts');

// Files that must never be synced even though they live alongside the .py
// tools in media/uefn-bridge/ (build artifacts / caches, not source).
const EXCLUDE_NAMES = new Set(['uefn-server.mjs']);

function resolveTargetDir() {
  const fromEnv = process.env.POWERTOOLS_REPO_DIR;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim();
  }
  if (existsSync(LOCAL_CONFIG_PATH)) {
    try {
      const raw = readFileSync(LOCAL_CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.targetDir === 'string' && parsed.targetDir.trim()) {
        return parsed.targetDir.trim();
      }
    } catch (err) {
      console.log(`[sync-powertools] Could not parse ${LOCAL_CONFIG_PATH}: ${err.message}. Skipping.`);
      return null;
    }
  }
  return null;
}

function readVersion() {
  try {
    const pkgPath = join(ROOT, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function copyBridgeFiles(targetDir) {
  const targetPythonDir = join(targetDir, 'python');
  if (!existsSync(targetPythonDir)) {
    mkdirSync(targetPythonDir, { recursive: true });
  }

  const entries = readdirSync(BRIDGE_DIR, { withFileTypes: true });
  let copiedCount = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue; // skips __pycache__ and any other subdirs
    const name = entry.name;
    if (EXCLUDE_NAMES.has(name)) continue;
    const isPy = name.endsWith('.py');
    const isIcon = name === 'trashbyrd_40x40.png';
    if (!isPy && !isIcon) continue;
    copyFileSync(join(BRIDGE_DIR, name), join(targetPythonDir, name));
    copiedCount += 1;
  }

  if (existsSync(SERVER_SRC)) {
    copyFileSync(SERVER_SRC, join(targetDir, 'uefn-server.ts'));
    copiedCount += 1;
  } else {
    console.log(`[sync-powertools] Warning: ${SERVER_SRC} not found; skipped uefn-server.ts.`);
  }

  return copiedCount;
}

function syncGitIfPresent(targetDir, version) {
  const gitDir = join(targetDir, '.git');
  if (!existsSync(gitDir)) {
    console.log('[sync-powertools] Files copied (target is not a git repo yet).');
    return;
  }

  try {
    execFileSync('git', ['-C', targetDir, 'add', '-A'], { stdio: 'inherit' });

    const status = execFileSync('git', ['-C', targetDir, 'status', '--porcelain'], {
      encoding: 'utf8',
    });

    if (!status.trim()) {
      console.log('[sync-powertools] Power Tools already up to date.');
      return;
    }

    execFileSync(
      'git',
      ['-C', targetDir, 'commit', '-m', `Sync from TycoonAgents v${version}`],
      { stdio: 'inherit' },
    );
    execFileSync('git', ['-C', targetDir, 'push'], { stdio: 'inherit' });
    console.log(`[sync-powertools] Committed and pushed sync from TycoonAgents v${version}.`);
  } catch (err) {
    // Never let a git failure (no remote, auth, detached HEAD, etc.) fail
    // whatever invoked this script (e.g. a release).
    console.log(`[sync-powertools] git sync step failed (non-fatal): ${err.message}`);
  }
}

function main() {
  const targetDir = resolveTargetDir();
  if (!targetDir || !existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
    console.log('Power Tools sync target not configured; skipping.');
    process.exit(0);
    return;
  }

  const version = readVersion();
  const copiedCount = copyBridgeFiles(targetDir);
  console.log(`[sync-powertools] Copied ${copiedCount} file(s) into ${targetDir}.`);

  syncGitIfPresent(targetDir, version);
}

try {
  main();
} catch (err) {
  console.log(`[sync-powertools] Unexpected error (non-fatal, skipping): ${err.message}`);
  process.exit(0);
}
