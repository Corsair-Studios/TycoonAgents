#!/usr/bin/env node
// Builds a versioned, RUNTIME-ONLY release zip for "Trashbyrd's Power Tools"
// at dist/trashbyrd-power-tools-<version>.zip.
//
// This is deliberately separate from scripts/sync-powertools.mjs: that
// script mirrors FULL SOURCE into a forkable public repo
// (D:\ACode\Trashbyrds Power Tools). This script packages a stripped-down
// END-USER download from that same source-of-truth layout -- python tools,
// the compiled MCP server source, docs, and license only. No tests, no
// build tooling, no dev config.
//
// Source layout and conventions (EXCLUDE_NAMES, the date-version scheme,
// the python/skills/docs shape) are mirrored from sync-powertools.mjs on
// purpose -- read that file first if editing this one.
//
// Zip strategy: shells out to Windows PowerShell's Compress-Archive rather
// than hand-rolling a zlib-based ZIP writer or adding a new npm dependency
// (this repo has a standing no-new-dependencies rule). Compress-Archive is
// built into every Windows install (PowerShell 5.1+), needs no dependency,
// and produces a standard, widely-compatible zip. Staging first into a
// temp directory with the exact in-zip relative layout (python/, skills/
// uefn/, docs/, plus the three root files) means Compress-Archive's own
// path handling can't leak an absolute or machine-specific path into an
// entry name -- entries are named relative to the staging root, which
// contains nothing but the intended relative shape.
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  statSync,
  rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR); // repo root (scripts/ is one level down)

const BRIDGE_DIR = join(ROOT, 'media', 'uefn-bridge');
// The runnable server this zip ships: the esbuild bundle, dependency-free
// (everything inlined), so `node uefn-server.mjs` works with no `npm
// install` and no `tsx` -- exactly what a runtime-only end-user zip needs.
// This is staged into the zip.
const SERVER_BUNDLE = join(ROOT, 'media', 'uefn-bridge', 'uefn-server.mjs');
// The TypeScript SOURCE the bundle is built from (`npm run bundle:uefn`,
// package.json). NEVER staged into the zip -- a bare .ts needs npm install
// plus tsx to run, which is exactly the dev tooling this zip exists to
// avoid. Kept only so main() can compare mtimes and warn if the bundle is
// stale relative to its source.
const SERVER_SRC = join(ROOT, 'uefn-bridge', 'uefn-server.ts');
const VERSE_CHECK_SRC = join(ROOT, 'media', 'skills', 'uefn', 'verse_lsp_check.py');
const LICENSE_SRC = join(ROOT, 'scripts', 'powertools-assets', 'LICENSE');
const README_SRC = join(ROOT, 'scripts', 'powertools-assets', 'README.md');
const INSTALL_SRC = join(ROOT, 'scripts', 'powertools-assets', 'INSTALL.md');
const PANEL_SCREENSHOT_SRC = join(ROOT, 'scripts', 'powertools-assets', 'docs', 'trashbyrds_power_tools_panel.png');

const DIST_DIR = join(ROOT, 'dist');
const GITIGNORE_PATH = join(ROOT, '.gitignore');

// Filters media/uefn-bridge/*.py (plus the icon PNG) when staging into
// <stageDir>/python/ -- see stageBridgeFiles(). uefn-server.mjs lives in
// that same source directory but must stay excluded from THIS filter for
// the opposite reason sync-powertools.mjs excludes it: sync-powertools.mjs
// never ships the .mjs at all (it mirrors forkable SOURCE, and the bundle
// is a build output, not source). This script DOES ship the .mjs -- as the
// runnable server for end users -- but staged explicitly at the zip ROOT
// (see SERVER_BUNDLE / main()), never through this python/ sweep. If
// 'uefn-server.mjs' were removed from this set, the sweep would ALSO copy
// it into python/, producing a duplicate in the wrong location. Keep it
// excluded here; do not "fix" this back by removing it.
// NOTE: this is the ONLY filter applied to media/uefn-bridge/*.py -- never
// filter by docstring content or file name "look" (tag_inspect.py,
// dependency_viewer.py, and moderation_scanner.py are large, real product
// tools, not tests, despite their size).
const EXCLUDE_NAMES = new Set(['uefn-server.mjs']);

// formatDateVersion: npm-semver-valid `YYYY.M.D`, NO zero-padding on month
// or day (a leading zero makes a numeric identifier invalid per semver).
// Mirrors sync-powertools.mjs's formatDateVersion() exactly -- duplicated
// rather than imported because that module's import path executes
// top-level main() only under its own isMainModule guard, and importing it
// here would be reasonable, but keeping this file dependency-free of the
// sync script avoids coupling two independently-runnable release tools.
function formatDateVersion(date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${year}.${month}.${day}`;
}

function fail(message) {
  console.error(`[package-powertools] ERROR: ${message}`);
  process.exit(1);
}

function requireFile(path, label) {
  if (!existsSync(path)) {
    fail(`required source file missing: ${label} (expected at ${path})`);
  }
  const st = statSync(path);
  if (!st.isFile()) {
    fail(`expected a file but found something else at ${label} (${path})`);
  }
}

function requireDir(path, label) {
  if (!existsSync(path)) {
    fail(`required source directory missing: ${label} (expected at ${path})`);
  }
  const st = statSync(path);
  if (!st.isDirectory()) {
    fail(`expected a directory but found a file at ${label} (${path})`);
  }
}

// Copies a single file into the staging tree at destRelPath (relative to
// stageDir), creating parent directories as needed. Fails loudly (via
// fail()) rather than skipping -- unlike sync-powertools.mjs, this script's
// whole purpose is to be a single artifact-producing run: a silently
// incomplete zip is worse than a failed build.
function stageFile(srcPath, destRelPath, stageDir, label) {
  requireFile(srcPath, label);
  const destPath = join(stageDir, destRelPath);
  const destDir = dirname(destPath);
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }
  copyFileSync(srcPath, destPath);
  return statSync(destPath).size;
}

// Stages every runtime .py tool plus the panel icon from media/uefn-bridge/
// into <stageDir>/python/, honoring EXCLUDE_NAMES exactly like
// sync-powertools.mjs's copyBridgeFiles(). Returns the staged file count.
function stageBridgeFiles(stageDir) {
  requireDir(BRIDGE_DIR, 'media/uefn-bridge/');
  const targetPythonDir = join(stageDir, 'python');
  mkdirSync(targetPythonDir, { recursive: true });

  const entries = readdirSync(BRIDGE_DIR, { withFileTypes: true });
  let copiedCount = 0;
  const pyNames = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue; // skips __pycache__, moderation_thumbnails/, etc.
    const name = entry.name;
    if (EXCLUDE_NAMES.has(name)) continue;
    const isPy = name.endsWith('.py');
    const isIcon = name === 'trashbyrd_40x40.png';
    if (!isPy && !isIcon) continue;
    copyFileSync(join(BRIDGE_DIR, name), join(targetPythonDir, name));
    copiedCount += 1;
    if (isPy) pyNames.push(name);
  }

  if (copiedCount === 0) {
    fail(`no runtime files found to stage from ${BRIDGE_DIR}`);
  }

  // Guard the three tools the brief calls out explicitly -- large product
  // tools that must never be dropped by a future docstring/name-based
  // filter accidentally introduced here.
  for (const required of ['tag_inspect.py', 'dependency_viewer.py', 'moderation_scanner.py']) {
    if (!pyNames.includes(required)) {
      fail(`expected runtime tool ${required} was not staged from ${BRIDGE_DIR}`);
    }
  }

  return copiedCount;
}

// Recursively lists every file entry under dir as paths relative to dir,
// using forward slashes (zip entry names are conventionally '/'-separated
// regardless of host OS, and this keeps the manifest/verification stable
// across platforms).
function listFilesRecursive(dir, baseDir = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, baseDir));
    } else if (entry.isFile()) {
      const rel = full.slice(baseDir.length + 1).split('\\').join('/');
      out.push({ rel, full, size: statSync(full).size });
    }
  }
  return out;
}

// SHA256 hex digest of a file's bytes, used to verify staged/zipped content
// is byte-identical to its source (never trust a copy just because
// copyFileSync/Compress-Archive reported no error).
function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function ensureDistGitignored() {
  let text = '';
  try {
    text = readFileSync(GITIGNORE_PATH, 'utf8');
  } catch (err) {
    console.log(`[package-powertools] Could not read .gitignore (non-fatal): ${err.message}`);
    return;
  }
  const alreadyIgnored = /^dist\/?\s*$/m.test(text);
  if (alreadyIgnored) return;
  const withNewline = text.endsWith('\n') ? text : `${text}\n`;
  writeFileSync(GITIGNORE_PATH, `${withNewline}dist/\n`, 'utf8');
  console.log('[package-powertools] Added dist/ to .gitignore.');
}

// Builds the zip via Windows PowerShell's Compress-Archive. Invoked through
// execFileSync with an argument array (never a shell string), which is what
// makes paths containing spaces (e.g. this repo's own "D:\ACode\..." tree,
// or a machine where the repo lives under "Program Files") safe without
// manual quoting -- execFileSync passes argv entries through untouched, no
// shell tokenizes them.
function compressWithPowerShell(stageDir, zipPath) {
  if (existsSync(zipPath)) {
    rmSync(zipPath, { force: true });
  }
  // Compress everything INSIDE stageDir (stageDir\*) so entry names are
  // relative to stageDir's contents (python/..., skills/..., README.md,
  // ...) rather than being nested under a stageDir-named folder.
  const psCommand =
    `Compress-Archive -Path (Join-Path -Path $env:PT_STAGE_DIR -ChildPath '*') ` +
    `-DestinationPath $env:PT_ZIP_PATH -CompressionLevel Optimal -Force`;
  const result = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psCommand],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, PT_STAGE_DIR: stageDir, PT_ZIP_PATH: zipPath },
    },
  );
  return result;
}

// Extracts a single named entry from the produced zip (via .NET's
// System.IO.Compression.ZipFile, the same PowerShell-native mechanism used
// elsewhere in this file to avoid a new npm dependency) and SHA256-compares
// its bytes against sourcePath. Fails loudly on any mismatch, missing
// entry, or extraction error -- a zip that LOOKS right but silently
// contains corrupted or substituted bytes is exactly the failure mode this
// guards against.
function verifyZipEntryMatchesSource(zipPath, entryName, sourcePath) {
  const extractPath = join(tmpdir(), `package-powertools-verify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const psCommand =
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
    `$zip = [System.IO.Compression.ZipFile]::OpenRead($env:PT_ZIP_PATH); ` +
    `try { ` +
    `  $entry = $zip.GetEntry($env:PT_ENTRY_NAME); ` +
    `  if ($null -eq $entry) { Write-Error "entry not found: $env:PT_ENTRY_NAME"; exit 1 } ` +
    `  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $env:PT_EXTRACT_PATH, $true) ` +
    `} finally { $zip.Dispose() }`;
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psCommand],
      {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: {
          ...process.env,
          PT_ZIP_PATH: zipPath,
          PT_ENTRY_NAME: entryName,
          PT_EXTRACT_PATH: extractPath,
        },
      },
    );
  } catch (err) {
    fail(`could not extract zip entry '${entryName}' for verification: ${err.message}`);
  }
  if (!existsSync(extractPath)) {
    fail(`zip entry '${entryName}' did not extract to ${extractPath}`);
  }
  const sourceHash = sha256File(sourcePath);
  const extractedHash = sha256File(extractPath);
  rmSync(extractPath, { force: true });
  if (sourceHash !== extractedHash) {
    fail(
      `zip entry '${entryName}' does not match source ${sourcePath} ` +
        `(source sha256 ${sourceHash}, zipped sha256 ${extractedHash})`,
    );
  }
  console.log(`[package-powertools]   OK: ${entryName} matches source (sha256 ${sourceHash})`);
}

function main() {
  const today = new Date();
  const version = formatDateVersion(today);

  console.log('[package-powertools] Verifying required source files...');
  requireDir(BRIDGE_DIR, 'media/uefn-bridge/');
  requireFile(VERSE_CHECK_SRC, 'media/skills/uefn/verse_lsp_check.py');
  requireFile(
    SERVER_BUNDLE,
    'media/uefn-bridge/uefn-server.mjs (run `npm run bundle:uefn` to produce it)',
  );
  requireFile(LICENSE_SRC, 'scripts/powertools-assets/LICENSE');
  requireFile(README_SRC, 'scripts/powertools-assets/README.md');
  requireFile(INSTALL_SRC, 'scripts/powertools-assets/INSTALL.md');
  requireFile(PANEL_SCREENSHOT_SRC, 'scripts/powertools-assets/docs/trashbyrds_power_tools_panel.png');

  // Staleness guard: if the TS source is newer than the bundle we're about
  // to ship, the bundle does not reflect the current source and shipping it
  // would silently give end users stale behavior. SERVER_SRC may not exist
  // on a machine that only has the compiled bundle (e.g. a stripped
  // checkout) -- that's fine, the check just can't run, not fatal.
  if (existsSync(SERVER_SRC)) {
    const srcMtime = statSync(SERVER_SRC).mtimeMs;
    const bundleMtime = statSync(SERVER_BUNDLE).mtimeMs;
    if (srcMtime > bundleMtime) {
      console.error(
        '[package-powertools] WARNING: uefn-server.ts is NEWER than uefn-server.mjs -- ' +
          'the bundle is STALE and this zip would ship outdated server code.\n' +
          `  source: ${SERVER_SRC} (mtime ${new Date(srcMtime).toISOString()})\n` +
          `  bundle: ${SERVER_BUNDLE} (mtime ${new Date(bundleMtime).toISOString()})\n` +
          '  Run `npm run bundle:uefn` to rebuild the bundle before packaging.',
      );
    }
  }

  const stageDir = join(tmpdir(), `package-powertools-${Date.now()}`);
  mkdirSync(stageDir, { recursive: true });

  try {
    console.log('[package-powertools] Staging runtime files...');
    const bridgeCount = stageBridgeFiles(stageDir);
    stageFile(VERSE_CHECK_SRC, join('skills', 'uefn', 'verse_lsp_check.py'), stageDir, 'verse_lsp_check.py');
    stageFile(SERVER_BUNDLE, 'uefn-server.mjs', stageDir, 'uefn-server.mjs');
    stageFile(README_SRC, 'README.md', stageDir, 'README.md');
    stageFile(INSTALL_SRC, 'INSTALL.md', stageDir, 'INSTALL.md');
    stageFile(LICENSE_SRC, 'LICENSE', stageDir, 'LICENSE');
    stageFile(PANEL_SCREENSHOT_SRC, join('docs', 'trashbyrds_power_tools_panel.png'), stageDir, 'docs/trashbyrds_power_tools_panel.png');

    const stagedFiles = listFilesRecursive(stageDir);
    const totalUncompressed = stagedFiles.reduce((sum, f) => sum + f.size, 0);
    console.log(`[package-powertools] Staged ${stagedFiles.length} file(s) (${bridgeCount} from media/uefn-bridge/), ${totalUncompressed} bytes uncompressed.`);

    if (!existsSync(DIST_DIR)) {
      mkdirSync(DIST_DIR, { recursive: true });
    }
    ensureDistGitignored();

    const zipName = `trashbyrd-power-tools-${version}.zip`;
    const zipPath = join(DIST_DIR, zipName);

    console.log(`[package-powertools] Compressing to ${zipPath}...`);
    compressWithPowerShell(stageDir, zipPath);

    if (!existsSync(zipPath)) {
      fail(`Compress-Archive reported success but ${zipPath} does not exist`);
    }
    const zipSize = statSync(zipPath).size;
    if (zipSize === 0) {
      fail(`produced zip is empty: ${zipPath}`);
    }

    console.log('[package-powertools] Verifying zip contents byte-for-byte...');
    verifyZipEntryMatchesSource(zipPath, 'uefn-server.mjs', SERVER_BUNDLE);
    verifyZipEntryMatchesSource(
      zipPath,
      // Compress-Archive names zip entries with the host path separator
      // (backslash on Windows), not the conventional forward-slash -- must
      // match GetEntry()'s lookup exactly, so build this with join() rather
      // than a hardcoded '/' literal.
      join('docs', 'trashbyrds_power_tools_panel.png'),
      PANEL_SCREENSHOT_SRC,
    );

    console.log('[package-powertools] Manifest:');
    console.log(`  files:               ${stagedFiles.length}`);
    console.log(`  total uncompressed:  ${totalUncompressed} bytes`);
    console.log(`  zip size:            ${zipSize} bytes`);
    console.log(`  output:              ${zipPath}`);
    console.log(`  version:             ${version}`);
  } finally {
    try {
      rmSync(stageDir, { recursive: true, force: true });
    } catch (err) {
      console.log(`[package-powertools] Could not clean up staging dir ${stageDir} (non-fatal): ${err.message}`);
    }
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
