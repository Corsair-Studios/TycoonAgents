#!/usr/bin/env node
// Best-effort mirror of the UEFN Power Tools bridge (media/uefn-bridge/*.py +
// the MCP server source) into a separate, standalone "Trashbyrd's UEFN Power
// Tools" repo so that repo can be distributed independently of TycoonAgents.
// Also stamps a LICENSE and the TycoonAgents version into that repo's
// package.json, and — once the sync commit has actually landed on the
// target's remote — tags and best-effort GitHub-Releases it there too.
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
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR); // repo root (scripts/ is one level down)

const LOCAL_CONFIG_PATH = join(SCRIPT_DIR, 'powertools-sync.local.json');
const BRIDGE_DIR = join(ROOT, 'media', 'uefn-bridge');
const SERVER_SRC = join(ROOT, 'uefn-bridge', 'uefn-server.ts');
// Adapted from this repo's own LICENSE (same terms, renamed for the Power
// Tools project; see scripts/powertools-assets/LICENSE for the diff notes).
const LICENSE_SRC = join(SCRIPT_DIR, 'powertools-assets', 'LICENSE');

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

// Copies the Power Tools LICENSE (see scripts/powertools-assets/LICENSE)
// into <target>/LICENSE on every sync. Non-fatal on any failure — a missing
// or unwritable LICENSE must never block the rest of the sync.
function copyLicense(targetDir) {
  if (!existsSync(LICENSE_SRC)) {
    console.log(`[sync-powertools] Warning: ${LICENSE_SRC} not found; skipped LICENSE.`);
    return false;
  }
  try {
    copyFileSync(LICENSE_SRC, join(targetDir, 'LICENSE'));
    return true;
  } catch (err) {
    console.log(`[sync-powertools] Could not copy LICENSE (non-fatal): ${err.message}`);
    return false;
  }
}

// Stamps the TycoonAgents version into the target repo's package.json
// "version" field only — every other field, key order, indentation style,
// and trailing newline are preserved as-is. Non-fatal on any failure (a
// missing/malformed target package.json must never block the rest of sync).
function updateTargetPackageVersion(targetDir, version) {
  const pkgPath = join(targetDir, 'package.json');
  if (!existsSync(pkgPath)) {
    console.log('[sync-powertools] Warning: target package.json not found; skipped version stamp.');
    return false;
  }
  try {
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    pkg.version = version;
    // Detect the file's own indentation rather than assuming 2 spaces, so a
    // differently-formatted target package.json isn't silently reformatted.
    const indentMatch = raw.match(/^[ \t]+(?=")/m);
    const indent = indentMatch ? indentMatch[0] : '  ';
    const trailingNewline = raw.endsWith('\n');
    const serialized = JSON.stringify(pkg, null, indent) + (trailingNewline ? '\n' : '');
    writeFileSync(pkgPath, serialized, 'utf8');
    return true;
  } catch (err) {
    console.log(`[sync-powertools] Could not update target package.json version (non-fatal): ${err.message}`);
    return false;
  }
}

// Returns true only if this run actually created a new commit AND pushed it
// to the target's remote. Informational / logging only now — tag/release
// gating uses isTargetPublishable() below instead, because a target that's
// already in sync (nothing new to commit) can still be missing its tag or
// release, e.g. a prior run pushed the sync commit but was killed before
// tagging. Gating on "did we just commit" made that state permanent: every
// later run would see a clean tree, log "already up to date", and skip
// tag/release forever.
function syncGitIfPresent(targetDir, version) {
  const gitDir = join(targetDir, '.git');
  if (!existsSync(gitDir)) {
    console.log('[sync-powertools] Files copied (target is not a git repo yet).');
    return false;
  }

  try {
    execFileSync('git', ['-C', targetDir, 'add', '-A'], { stdio: 'inherit' });

    const status = execFileSync('git', ['-C', targetDir, 'status', '--porcelain'], {
      encoding: 'utf8',
    });

    if (!status.trim()) {
      console.log('[sync-powertools] Power Tools already up to date.');
      return false;
    }

    execFileSync(
      'git',
      ['-C', targetDir, 'commit', '-m', `Sync from TycoonAgents v${version}`],
      { stdio: 'inherit' },
    );
    execFileSync('git', ['-C', targetDir, 'push'], { stdio: 'inherit' });
    console.log(`[sync-powertools] Committed and pushed sync from TycoonAgents v${version}.`);
    return true;
  } catch (err) {
    // Never let a git failure (no remote, auth, detached HEAD, etc.) fail
    // whatever invoked this script (e.g. a release).
    console.log(`[sync-powertools] git sync step failed (non-fatal): ${err.message}`);
    return false;
  }
}

// True only when the target repo is in a state safe to tag/release: a
// clean working tree AND local HEAD equal to origin/main. Fetches origin
// first (best-effort) so the origin/main comparison reflects the current
// remote rather than a stale local view. Comparison is done with
// `git rev-parse HEAD` vs `git rev-parse origin/main` (plain SHA string
// equality) rather than `git status` alone, because a clean working tree
// only proves there are no uncommitted changes — it says nothing about
// whether local commits have actually been pushed, or whether the remote
// has commits this clone doesn't have. Never tags a dirty or diverged tree.
function isTargetPublishable(targetDir) {
  const gitDir = join(targetDir, '.git');
  if (!existsSync(gitDir)) return false;

  try {
    execFileSync('git', ['-C', targetDir, 'fetch', 'origin'], { stdio: 'ignore' });
  } catch (err) {
    console.log(`[sync-powertools] "git fetch origin" failed in target repo (non-fatal): ${err.message}`);
  }

  try {
    const status = execFileSync('git', ['-C', targetDir, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    if (status.trim()) {
      console.log(
        '[sync-powertools] Target repo working tree is not clean; skipping tag/release for this run.',
      );
      return false;
    }
  } catch (err) {
    console.log(`[sync-powertools] Could not check target repo status (non-fatal): ${err.message}`);
    return false;
  }

  try {
    const localHead = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const remoteHead = execFileSync('git', ['-C', targetDir, 'rev-parse', 'origin/main'], {
      encoding: 'utf8',
    }).trim();
    if (localHead !== remoteHead) {
      console.log(
        `[sync-powertools] Target repo HEAD (${localHead}) does not match origin/main (${remoteHead}); ` +
        'skipping tag/release for this run (not in sync with remote).',
      );
      return false;
    }
    return true;
  } catch (err) {
    console.log(
      `[sync-powertools] Could not compare target repo HEAD to origin/main (non-fatal): ${err.message}`,
    );
    return false;
  }
}

// Best-effort tag + GitHub Release for the target repo, invoked once the
// target repo is confirmed publishable (see isTargetPublishable() above —
// clean tree, HEAD in sync with origin/main). Mirrors the guarded pattern
// in scripts/release.mjs: fetch tags
// first (best-effort) before checking existence, skip creation with a clear
// warning if the tag already exists, and roll back a tag this run created
// if pushing it fails. Every step is try/catch'd with a console.log warning
// on failure — never fatal, this must never break a TycoonAgents release
// that has already pushed.
function tagAndReleaseTarget(targetDir, version) {
  const tagName = `v${version}`;

  try {
    execFileSync('git', ['-C', targetDir, 'fetch', '--tags'], { stdio: 'ignore' });
  } catch (err) {
    console.log(
      `[sync-powertools] "git fetch --tags" failed in target repo (non-fatal): ${err.message}`,
    );
  }

  let tagExists = false;
  try {
    execFileSync(
      'git',
      ['-C', targetDir, 'rev-parse', '-q', '--verify', `refs/tags/${tagName}`],
      { stdio: 'ignore' },
    );
    tagExists = true;
  } catch {
    tagExists = false;
  }

  let tagCreatedThisRun = false;
  if (tagExists) {
    console.log(
      `[sync-powertools] Tag "${tagName}" already exists in target repo — skipping tag creation, still attempting push/release.`,
    );
  } else {
    try {
      execFileSync(
        'git',
        ['-C', targetDir, 'tag', '-a', tagName, '-m', `Sync from TycoonAgents v${version}`],
        { stdio: 'inherit' },
      );
      tagCreatedThisRun = true;
      console.log(`[sync-powertools] Created annotated tag "${tagName}" in target repo.`);
    } catch (err) {
      console.log(`[sync-powertools] Could not create tag "${tagName}" in target repo (non-fatal): ${err.message}`);
      return;
    }
  }

  let tagPushed = false;
  try {
    execFileSync('git', ['-C', targetDir, 'push', 'origin', tagName], { stdio: 'inherit' });
    tagPushed = true;
    console.log(`[sync-powertools] Pushed tag "${tagName}" to target repo remote.`);
  } catch (err) {
    console.log(`[sync-powertools] Could not push tag "${tagName}" to target repo (non-fatal): ${err.message}`);
    // Roll back the tag ONLY if this run created it — never a pre-existing
    // tag that was merely detected and skipped above.
    if (tagCreatedThisRun) {
      try {
        execFileSync('git', ['-C', targetDir, 'tag', '-d', tagName], { stdio: 'inherit' });
        console.log(`[sync-powertools] Rolled back local tag "${tagName}" so a re-run won't push an orphaned tag.`);
      } catch (deleteErr) {
        console.log(`[sync-powertools] Could not roll back local tag "${tagName}" (non-fatal): ${deleteErr.message}`);
      }
    }
  }

  if (!tagPushed) return;

  publishTargetRelease(targetDir, version, tagName);
}

// Best-effort GitHub Release for the target repo, attempted only once its
// tag is confirmed pushed. Builds the installable zip from the pushed tag
// via `git archive`, which packages ONLY tracked files at that tag — this
// is what keeps node_modules (~59MB) out of the asset, but only as long as
// node_modules is actually gitignored in the target repo, so that's
// verified here rather than assumed. Written to a temp dir (never into
// either repo's working tree) and cleaned up afterward.
function publishTargetRelease(targetDir, version, tagName) {
  const gitignorePath = join(targetDir, '.gitignore');
  let gitignoreText = '';
  try {
    gitignoreText = readFileSync(gitignorePath, 'utf8');
  } catch (err) {
    console.log(
      `[sync-powertools] Could not read target .gitignore (non-fatal): ${err.message}. ` +
      'Skipping release asset build to avoid risking an unfiltered archive.',
    );
    return;
  }

  const ignoresNodeModules = /^node_modules\/?\s*$/m.test(gitignoreText);
  if (!ignoresNodeModules) {
    console.log(
      '[sync-powertools] Target .gitignore does not appear to ignore node_modules; ' +
      'skipping release asset build rather than risk shipping it.',
    );
    return;
  }

  const zipName = `trashbyrds-power-tools-v${version}.zip`;
  const tmpWorkDir = join(tmpdir(), `sync-powertools-release-${Date.now()}`);
  const zipPath = join(tmpWorkDir, zipName);
  try {
    mkdirSync(tmpWorkDir, { recursive: true });
    execFileSync('git', ['-C', targetDir, 'archive', '--format=zip', '-o', zipPath, tagName], {
      stdio: 'inherit',
    });
    console.log(`[sync-powertools] Built release asset at ${zipPath}.`);
  } catch (err) {
    console.log(`[sync-powertools] Could not build release archive (non-fatal): ${err.message}`);
    try {
      rmSync(tmpWorkDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; a stray temp dir is harmless
    }
    return;
  }

  try {
    execFileSync(
      'gh',
      ['release', 'create', tagName, zipPath, '--title', tagName, '--notes', `Sync from TycoonAgents v${version}`],
      { stdio: 'inherit', cwd: targetDir },
    );
    console.log(`[sync-powertools] Published GitHub Release "${tagName}" for target repo (see URL above).`);
  } catch (err) {
    console.log(
      `[sync-powertools] GitHub Release NOT published for target repo (non-fatal): ${err.message}\n` +
      `[sync-powertools] Publish it manually once resolved: gh release create ${tagName} "${zipPath}" --title ${tagName} --notes "..." (run from ${targetDir})`,
    );
  } finally {
    try {
      rmSync(tmpWorkDir, { recursive: true, force: true });
    } catch (err) {
      console.log(`[sync-powertools] Could not clean up temp release asset (non-fatal): ${err.message}`);
    }
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

  if (copyLicense(targetDir)) {
    console.log('[sync-powertools] Copied LICENSE into target repo.');
  }

  if (updateTargetPackageVersion(targetDir, version)) {
    console.log(`[sync-powertools] Stamped target package.json version to ${version}.`);
  }

  syncGitIfPresent(targetDir, version);

  // Tag + best-effort GitHub Release once the target repo is confirmed
  // publishable — clean tree AND HEAD in sync with origin/main (see
  // isTargetPublishable()). Deliberately NOT gated on whether the line
  // above just created a commit: a target that's already in sync (nothing
  // new to commit) can still be missing its tag/release from a prior
  // interrupted run, and gating on "did we just commit" made that
  // permanent — every later run would see a clean tree and skip forever.
  if (isTargetPublishable(targetDir)) {
    tagAndReleaseTarget(targetDir, version);
  } else {
    console.log('[sync-powertools] Target repo not publishable this run; skipping tag/release.');
  }
}

try {
  main();
} catch (err) {
  console.log(`[sync-powertools] Unexpected error (non-fatal, skipping): ${err.message}`);
  process.exit(0);
}
