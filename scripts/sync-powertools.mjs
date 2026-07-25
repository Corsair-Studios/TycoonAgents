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
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, statSync, unlinkSync } from 'node:fs';
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

// Prune files from <target>/python/ that the mirror no longer owns (e.g. a
// tool deleted from media/uefn-bridge/ since the last sync). This is scoped
// deliberately narrowly:
//   - Only names ending in .py, plus the single trashbyrd_40x40.png icon —
//     the exact same two patterns copyBridgeFiles() writes. The target repo
//     is NOT ours; it may contain a README, docs, or other files a maintainer
//     added by hand, and this must never touch those.
//   - Non-recursive, top-level of <target>/python/ only — directories are
//     never removed or descended into.
//   - Respects EXCLUDE_NAMES, same as the copy step.
//   - Every delete is wrapped in try/catch: a failed prune logs and moves on,
//     it must never throw (this script must never fail a release).
function pruneStaleFiles(targetDir) {
  const targetPythonDir = join(targetDir, 'python');
  if (!existsSync(targetPythonDir)) return 0;

  // Recompute the set of names the source currently owns, using the same
  // filter as copyBridgeFiles().
  const sourceEntries = readdirSync(BRIDGE_DIR, { withFileTypes: true });
  const currentNames = new Set();
  for (const entry of sourceEntries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (EXCLUDE_NAMES.has(name)) continue;
    const isPy = name.endsWith('.py');
    const isIcon = name === 'trashbyrd_40x40.png';
    if (!isPy && !isIcon) continue;
    currentNames.add(name);
  }

  const targetEntries = readdirSync(targetPythonDir, { withFileTypes: true });
  let prunedCount = 0;
  for (const entry of targetEntries) {
    if (!entry.isFile()) continue; // never recurse into / remove directories
    const name = entry.name;
    if (EXCLUDE_NAMES.has(name)) continue;
    const isPy = name.endsWith('.py');
    const isIcon = name === 'trashbyrd_40x40.png';
    if (!isPy && !isIcon) continue; // not a file type the mirror manages
    if (currentNames.has(name)) continue; // still present in source, keep it

    try {
      unlinkSync(join(targetPythonDir, name));
      console.log(`[sync-powertools] Pruned stale file: ${name}`);
      prunedCount += 1;
    } catch (err) {
      console.log(`[sync-powertools] Could not prune ${name} (non-fatal): ${err.message}`);
    }
  }

  return prunedCount;
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

  const prunedCount = pruneStaleFiles(targetDir);
  console.log(`[sync-powertools] Pruned ${prunedCount} stale file(s) from ${targetDir}.`);

  syncGitIfPresent(targetDir, version);
}

try {
  main();
} catch (err) {
  console.log(`[sync-powertools] Unexpected error (non-fatal, skipping): ${err.message}`);
  process.exit(0);
}
