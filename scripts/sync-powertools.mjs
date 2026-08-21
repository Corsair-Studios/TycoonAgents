#!/usr/bin/env node
// Best-effort mirror of the UEFN Power Tools bridge (media/uefn-bridge/*.py +
// the MCP server source) into a separate, standalone "Trashbyrd's UEFN Power
// Tools" repo so that repo can be distributed independently of TycoonAgents.
// Also stamps a LICENSE and a date-based version (see computeDateVersion())
// into that repo's own package.json, and — once the sync commit has
// actually landed on the target's remote — tags and best-effort
// GitHub-Releases it there too. The standalone repo's version is its OWN,
// wholly independent of TycoonAgents' package.json version.
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
import { fileURLToPath, pathToFileURL } from 'node:url';
// The release asset must be the runtime-only end-user zip (python/,
// skills/uefn/, docs/, README/INSTALL/LICENSE, uefn-server.mjs at root --
// no .ts, no build/dev material), never a `git archive` snapshot of the
// whole target repo tree (that previously shipped .github/, .gitignore,
// package.json/package-lock.json, an internal spec doc, and uefn-server.ts
// while OMITTING uefn-server.mjs, which INSTALL.md tells users to run).
// Reuses package-powertools.mjs's own build/verify logic rather than
// duplicating it here.
import { buildPowerToolsZip } from './package-powertools.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR); // repo root (scripts/ is one level down)

const LOCAL_CONFIG_PATH = join(SCRIPT_DIR, 'powertools-sync.local.json');
const BRIDGE_DIR = join(ROOT, 'media', 'uefn-bridge');
const SERVER_SRC = join(ROOT, 'uefn-bridge', 'uefn-server.ts');
// Power Tools is MIT licensed. This is DELIBERATELY DIFFERENT from
// TycoonAgents' own root LICENSE, which is free-to-use but not-for-sale and
// is not OSI-approved: Power Tools is meant to be genuinely forkable, and the
// previous shared text explicitly withheld permission to "redistribute
// modified versions", forbidding exactly that. Do not re-unify these two
// files -- they are two products with two different licenses on purpose.
const LICENSE_SRC = join(SCRIPT_DIR, 'powertools-assets', 'LICENSE');
// README.md and INSTALL.md are authored here (scripts/powertools-assets/)
// and mirrored verbatim into the target repo root on every sync, same as
// LICENSE — this repo is their source of truth; the target repo's copies
// must never be hand-edited there.
const README_SRC = join(SCRIPT_DIR, 'powertools-assets', 'README.md');
const INSTALL_SRC = join(SCRIPT_DIR, 'powertools-assets', 'INSTALL.md');
// Panel screenshot for the standalone README, authored the same way as
// README.md/INSTALL.md above (scripts/powertools-assets/) and mirrored
// verbatim into <target>/docs/ on every sync. This repo is its source of
// truth; the target repo's copy must never be hand-edited there. It is a
// binary PNG, so it is copied with copyFileSync (see copyDoc()) rather than
// any text-mode read/write -- copyFileSync is already a raw byte copy with
// no encoding or newline transformation, so it's safe to reuse as-is.
const PANEL_SCREENSHOT_SRC = join(SCRIPT_DIR, 'powertools-assets', 'docs', 'trashbyrds_power_tools_panel.png');
// verse_lsp_check.py powers uefn_verse_check but lives outside media/uefn-bridge/
// (it's under media/skills/uefn/, alongside this repo's other Verse skill
// docs/scripts, not the bridge's Python tools). Mirrored into the target
// repo at <target>/skills/uefn/verse_lsp_check.py — same "skills/uefn/"
// shape as the source side — so it's present at a predictable, documentable
// location. The server's own discovery ladder (uefn-bridge/uefn-server.ts)
// is NOT changed for this: in a standalone install its non-override
// fallbacks can never resolve into this repo, so standalone users are
// expected to point VERSE_LSP_CHECK_SCRIPT at this file (see INSTALL.md).
const VERSE_CHECK_SRC = join(ROOT, 'media', 'skills', 'uefn', 'verse_lsp_check.py');

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

// Formats a Date as npm-semver-valid `YYYY.M.D` (NO zero padding on month
// or day -- `2026.08.20` is INVALID per npm's semver parser because a
// leading zero makes a numeric identifier illegal; `2026.8.20` is valid).
// Exported for tests via computeDateVersion() below, which is the function
// that should actually be called -- this is the pure formatting half.
export function formatDateVersion(date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${year}.${month}.${day}`;
}

// Lists annotated/lightweight tag names in targetDir matching `v<base>` or
// `v<base>-<letter>` for the given base date version (e.g. base "2026.8.20"
// matches tags "v2026.8.20", "v2026.8.20-b", "v2026.8.20-c", ...). Uses
// `git tag --list` against the local tag refs; callers are expected to have
// already run `git fetch --tags` (tagAndReleaseTarget() does this) so the
// list reflects the remote's tags too. Non-fatal: any git failure (no repo,
// no tags yet) yields an empty list rather than throwing.
export function listVersionTags(targetDir, baseVersion) {
  try {
    const escaped = baseVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const out = execFileSync(
      'git',
      ['-C', targetDir, 'tag', '--list', `v${baseVersion}*`],
      { encoding: 'utf8' },
    );
    const pattern = new RegExp(`^v${escaped}(-([a-z]))?$`);
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((name) => pattern.test(name));
  } catch {
    return [];
  }
}

// Computes today's date-based version for the target repo, deriving the
// next free same-day suffix from tags that already exist there. First
// release of a day has no suffix ("2026.8.20"); a second/third/etc. same-day
// release appends "-b", "-c", ... in order. `today` is a Date, injected by
// the caller (main() computes it once per run) so tests can pass a fixed
// date instead of depending on the real clock, and so a run never risks a
// midnight split between two separately-computed "now"s.
export function computeDateVersion(targetDir, today) {
  const base = formatDateVersion(today);
  const existing = listVersionTags(targetDir, base);
  if (existing.length === 0) return base;

  const usedLetters = new Set();
  let baseTagExists = false;
  for (const tag of existing) {
    const m = tag.match(/^v[0-9.]+(?:-([a-z]))?$/);
    if (!m) continue;
    if (m[1]) usedLetters.add(m[1]);
    else baseTagExists = true;
  }
  if (!baseTagExists) return base;

  for (let code = 'b'.charCodeAt(0); code <= 'z'.charCodeAt(0); code += 1) {
    const letter = String.fromCharCode(code);
    if (!usedLetters.has(letter)) return `${base}-${letter}`;
  }
  // Exhausted a-z (26 releases in one day) -- fall back to a timestamp
  // suffix rather than colliding or throwing.
  return `${base}-${Date.now()}`;
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

// Copies README.md and INSTALL.md (see scripts/powertools-assets/) into
// <target>/README.md and <target>/INSTALL.md on every sync, mirroring
// copyLicense() above. Non-fatal on any failure — a missing or unwritable
// doc file must never block the rest of the sync. `destRelPath` is a path
// relative to targetDir (e.g. 'README.md' or 'docs/trashbyrds_power_tools_panel.png');
// when it contains a subdirectory, that directory is created first the same
// way copyVerseCheckScript() creates <target>/skills/uefn/. copyFileSync is
// a raw byte copy (no encoding/newline transformation), so this is safe to
// use for both text docs and binary assets like the PNG.
function copyDoc(srcPath, destRelPath, targetDir) {
  if (!existsSync(srcPath)) {
    console.log(`[sync-powertools] Warning: ${srcPath} not found; skipped ${destRelPath}.`);
    return false;
  }
  try {
    const destPath = join(targetDir, destRelPath);
    const destDir = dirname(destPath);
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    copyFileSync(srcPath, destPath);
    return true;
  } catch (err) {
    console.log(`[sync-powertools] Could not copy ${destRelPath} (non-fatal): ${err.message}`);
    return false;
  }
}

// Copies media/skills/uefn/verse_lsp_check.py into
// <target>/skills/uefn/verse_lsp_check.py, creating the target's skills/uefn/
// directory if needed. Mirrors copyDoc()'s single-file, non-fatal shape
// (this is one named file, not a directory scan like copyBridgeFiles()) —
// a missing source or an unwritable target logs a warning and is skipped,
// never thrown.
function copyVerseCheckScript(targetDir) {
  if (!existsSync(VERSE_CHECK_SRC)) {
    console.log(`[sync-powertools] Warning: ${VERSE_CHECK_SRC} not found; skipped verse_lsp_check.py.`);
    return false;
  }
  try {
    const targetSkillsDir = join(targetDir, 'skills', 'uefn');
    if (!existsSync(targetSkillsDir)) {
      mkdirSync(targetSkillsDir, { recursive: true });
    }
    copyFileSync(VERSE_CHECK_SRC, join(targetSkillsDir, 'verse_lsp_check.py'));
    return true;
  } catch (err) {
    console.log(`[sync-powertools] Could not copy verse_lsp_check.py (non-fatal): ${err.message}`);
    return false;
  }
}

// Prune verse_lsp_check.py from <target>/skills/uefn/ if it no longer
// exists in the source (media/skills/uefn/). Scoped as narrowly as
// pruneStaleFiles() above: this checks and removes ONLY the single file
// name 'verse_lsp_check.py', at the exact <target>/skills/uefn/ path this
// mirror writes to — it never touches any other file under skills/uefn/
// (that directory is not otherwise owned by this sync) and never recurses
// or removes directories. Non-fatal: a failed prune logs and moves on.
function pruneStaleVerseCheckScript(targetDir) {
  const targetPath = join(targetDir, 'skills', 'uefn', 'verse_lsp_check.py');
  if (!existsSync(targetPath)) return false;
  if (existsSync(VERSE_CHECK_SRC)) return false; // still owned by source, keep it

  try {
    unlinkSync(targetPath);
    console.log('[sync-powertools] Pruned stale file: skills/uefn/verse_lsp_check.py');
    return true;
  } catch (err) {
    console.log(`[sync-powertools] Could not prune skills/uefn/verse_lsp_check.py (non-fatal): ${err.message}`);
    return false;
  }
}

// Stamps the computed DATE-BASED version (see computeDateVersion() above)
// into the target repo's package.json "version" field only — every other
// field, key order, indentation style, and trailing newline are preserved
// as-is. This is the standalone Power Tools repo's OWN version now, wholly
// independent of TycoonAgents' package.json version. Non-fatal on any
// failure (a missing/malformed target package.json must never block the
// rest of sync).
export function updateTargetPackageVersion(targetDir, version) {
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
//
// Stages everything (`git add -A`) and reports whether the resulting index
// actually differs from HEAD, i.e. whether this run changed any synced
// content. This is the ground-truth no-op signal for the whole script: the
// copy steps above (copyBridgeFiles, copyLicense, copyDoc, ...) write their
// files unconditionally on every run regardless of whether the content
// actually differs from what's already on disk, so a per-step "did I copy a
// file" count is always non-zero on a non-empty source and CANNOT tell a
// real change from a byte-identical rewrite. `git status --porcelain`
// against the target's own last commit is what actually answers "did
// anything change" -- so detection happens once, here, before any
// version/commit/tag/release decision is made, and that single answer is
// threaded through the rest of main() rather than re-derived per step.
// Non-fatal: any git failure yields `changed: false` (treated as a no-op,
// never a false "changed").
export function detectContentChanged(targetDir) {
  const gitDir = join(targetDir, '.git');
  if (!existsSync(gitDir)) {
    // Not a git repo (yet) -- there's no commit history to diff against, so
    // this can't be treated as "unchanged"; let the caller proceed to
    // syncGitIfPresent()'s own "not a git repo yet" logging.
    return { isGitRepo: false, changed: false };
  }
  try {
    execFileSync('git', ['-C', targetDir, 'add', '-A'], { stdio: 'inherit' });
    const status = execFileSync('git', ['-C', targetDir, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    return { isGitRepo: true, changed: status.trim().length > 0 };
  } catch (err) {
    console.log(`[sync-powertools] Could not check target repo status (non-fatal): ${err.message}`);
    return { isGitRepo: true, changed: false };
  }
}

// Commits and pushes the already-staged changes (see detectContentChanged()
// above, which ran `git add -A` and confirmed the index differs from HEAD
// before this is called). Only called when contentChanged is true, so this
// itself no longer re-checks `git status` -- that check already happened
// once, up front, and its answer is what gated the call.
function syncGitIfPresent(targetDir, version) {
  const gitDir = join(targetDir, '.git');
  if (!existsSync(gitDir)) {
    console.log('[sync-powertools] Files copied (target is not a git repo yet).');
    return false;
  }

  try {
    execFileSync(
      'git',
      ['-C', targetDir, 'commit', '-m', `Sync: Power Tools ${version}`],
      { stdio: 'inherit' },
    );
    execFileSync('git', ['-C', targetDir, 'push'], { stdio: 'inherit' });
    console.log(`[sync-powertools] Committed and pushed Power Tools ${version}.`);
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
        ['-C', targetDir, 'tag', '-a', tagName, '-m', `Sync: Power Tools ${version}`],
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
// tag is confirmed pushed. The release asset is the runtime-only end-user
// zip built by package-powertools.mjs's buildPowerToolsZip() -- NEVER a
// `git archive` snapshot of the target repo tree, which would include
// .github/, .gitignore, package.json/package-lock.json, dev docs, and the
// TypeScript server source while omitting uefn-server.mjs (the file
// INSTALL.md tells users to run). buildPowerToolsZip() fails loudly
// (process.exit(1) via its own fail()) on any build problem; that failure
// is caught here and turned into a loud, explicit, non-fatal-to-the-whole-
// sync error -- the commit/tag/push above have already landed, and a
// missing release is recoverable, but publishing a WRONG asset is exactly
// the mistake this function exists to prevent. There is no git-archive
// fallback.
function publishTargetRelease(targetDir, version, tagName) {
  let built;
  try {
    built = buildPowerToolsZip();
  } catch (err) {
    console.log(
      `[sync-powertools] GitHub Release NOT published for target repo: ` +
      `building the runtime-only release zip FAILED (${err.message}). ` +
      'Refusing to fall back to a full-tree git archive. ' +
      `The tag "${tagName}" and its push have already landed; publish the release ` +
      `manually once the build issue is fixed: node scripts/package-powertools.mjs, ` +
      `then gh release create ${tagName} "<dist zip>" --title ${tagName} --notes "..." (run from ${targetDir})`,
    );
    return;
  }

  const zipName = `trashbyrds-power-tools-v${version}.zip`;
  const tmpWorkDir = join(tmpdir(), `sync-powertools-release-${Date.now()}`);
  const zipPath = join(tmpWorkDir, zipName);
  try {
    mkdirSync(tmpWorkDir, { recursive: true });
    copyFileSync(built.zipPath, zipPath);
    console.log(
      `[sync-powertools] Built runtime-only release asset (${built.entryCount} entries) ` +
      `at ${zipPath} (from ${built.zipPath}).`,
    );
  } catch (err) {
    console.log(
      `[sync-powertools] GitHub Release NOT published for target repo: could not stage the ` +
      `runtime-only zip for upload (${err.message}). Refusing to fall back to a git archive. ` +
      `The tag "${tagName}" and its push have already landed; publish the release ` +
      `manually once resolved: gh release create ${tagName} "${built.zipPath}" --title ${tagName} --notes "..." (run from ${targetDir})`,
    );
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
      ['release', 'create', tagName, zipPath, '--title', tagName, '--notes', `Sync: Power Tools ${version}`],
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

  // Computed exactly once for the whole run and threaded through everywhere
  // a version string is needed (computeDateVersion, updateTargetPackageVersion,
  // syncGitIfPresent, tagAndReleaseTarget) so a run that happens to straddle
  // midnight can't compute two different "today"s and produce inconsistent
  // version strings across package.json/commit/tag/release within one run.
  const today = new Date();

  const copiedCount = copyBridgeFiles(targetDir);
  console.log(`[sync-powertools] Copied ${copiedCount} file(s) into ${targetDir}.`);

  const prunedCount = pruneStaleFiles(targetDir);
  console.log(`[sync-powertools] Pruned ${prunedCount} stale file(s) from ${targetDir}.`);

  if (copyVerseCheckScript(targetDir)) {
    console.log('[sync-powertools] Copied verse_lsp_check.py into target repo (skills/uefn/).');
  }
  if (pruneStaleVerseCheckScript(targetDir)) {
    console.log('[sync-powertools] Pruned stale verse_lsp_check.py from target repo.');
  }

  if (copyLicense(targetDir)) {
    console.log('[sync-powertools] Copied LICENSE into target repo.');
  }

  if (copyDoc(README_SRC, 'README.md', targetDir)) {
    console.log('[sync-powertools] Copied README.md into target repo.');
  }
  if (copyDoc(INSTALL_SRC, 'INSTALL.md', targetDir)) {
    console.log('[sync-powertools] Copied INSTALL.md into target repo.');
  }
  if (copyDoc(PANEL_SCREENSHOT_SRC, join('docs', 'trashbyrds_power_tools_panel.png'), targetDir)) {
    console.log('[sync-powertools] Copied docs/trashbyrds_power_tools_panel.png into target repo.');
  }

  // Ground-truth no-op detection: stage everything and see if the target's
  // own git index actually differs from HEAD (see detectContentChanged()).
  // This -- not the copy/prune step counts above, which are always non-zero
  // on a non-empty source regardless of whether content actually changed --
  // is what gates the version bump, commit, tag, and release below. A run
  // that changed nothing must commit nothing, tag nothing, and release
  // nothing.
  const { isGitRepo, changed: contentChanged } = detectContentChanged(targetDir);

  if (isGitRepo && !contentChanged) {
    console.log('[sync-powertools] No-op run: no synced content changed since the last sync. Skipping version bump, commit, tag, and release.');
    return;
  }

  // Only compute/stamp a new date version when there is actually something
  // new to publish -- computeDateVersion() looks at existing tags in the
  // target repo, which requires targetDir to be a usable git repo.
  const version = isGitRepo ? computeDateVersion(targetDir, today) : formatDateVersion(today);

  if (updateTargetPackageVersion(targetDir, version)) {
    console.log(`[sync-powertools] Stamped target package.json version to ${version}.`);
  }

  if (isGitRepo) {
    // Re-stage: updateTargetPackageVersion() above wrote package.json AFTER
    // detectContentChanged()'s `git add -A`, so it needs to be staged too
    // before committing.
    try {
      execFileSync('git', ['-C', targetDir, 'add', '-A'], { stdio: 'inherit' });
    } catch (err) {
      console.log(`[sync-powertools] Could not re-stage target repo after version stamp (non-fatal): ${err.message}`);
    }
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

// Only run the real sync (and its process.exit calls) when this script is
// executed directly, e.g. `node scripts/sync-powertools.mjs` or
// `npm run sync:powertools`. Tests import the exported pure/git-backed
// functions above as a module, which must NOT trigger a live sync against
// whatever POWERTOOLS_REPO_DIR happens to be set on the machine running the
// tests. Same guard shape as scripts/check-no-absolute-paths.mjs.
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  try {
    main();
  } catch (err) {
    console.log(`[sync-powertools] Unexpected error (non-fatal, skipping): ${err.message}`);
    process.exit(0);
  }
}
