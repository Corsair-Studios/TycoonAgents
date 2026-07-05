#!/usr/bin/env node
// Automates the ship-a-VSIX dance: bump the version, package, verify the
// .vsix landed, commit, and push. Run via `npm run release -- <level>
// ["message"]` where <level> is "patch" (default), "minor", or "major".
//
// Mirrors the repeated manual sequence: bump patch version, `npm run
// package` (which runs the full vscode:prepublish chain — build, bundles,
// check:paths, check:webview — then `vsce package`), verify the .vsix,
// `git add -A`, commit "Release x.y.z: ...", `git push origin main`.
import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const PKG_PATH = join(ROOT, 'package.json');

const LEVELS = ['patch', 'minor', 'major'];

function bumpVersion(version, level) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Cannot parse semver version "${version}" (expected "x.y.z")`);
  }
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (level === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (level === 'minor') {
    minor += 1;
    patch = 0;
  } else if (level === 'patch') {
    patch += 1;
  } else {
    throw new Error(`Unknown bump level "${level}" (expected ${LEVELS.join(', ')})`);
  }
  return `${major}.${minor}.${patch}`;
}

function main() {
  const level = process.argv[2] || 'patch';
  const message = process.argv[3];

  if (!LEVELS.includes(level)) {
    console.error(`[release] Invalid level "${level}" — expected one of: ${LEVELS.join(', ')}.`);
    process.exit(1);
  }

  const pkgRaw = readFileSync(PKG_PATH, 'utf8');
  // Targeted string replace (not a JSON.parse/reserialize) so package.json's
  // existing formatting/indentation survives untouched.
  const versionRe = /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/;
  const versionMatch = versionRe.exec(pkgRaw);
  if (!versionMatch) {
    console.error('[release] Could not find a "version": "x.y.z" field in package.json.');
    process.exit(1);
  }
  const currentVersion = versionMatch[2];
  const newVersion = bumpVersion(currentVersion, level);

  const newPkgRaw = pkgRaw.replace(versionRe, `$1${newVersion}$3`);
  writeFileSync(PKG_PATH, newPkgRaw);
  console.log(`[release] Bumped version ${currentVersion} -> ${newVersion} (${level}) in package.json.`);

  // `npm run package` runs the full vscode:prepublish chain (build, bundles,
  // check:paths, check:webview) before `vsce package`. shell:true lets Node
  // resolve `npm` (a .cmd shim on Windows) the same way a terminal would.
  console.log('[release] Running `npm run package`...');
  const packageResult = spawnSync('npm', ['run', 'package'], {
    stdio: 'inherit',
    shell: true,
    cwd: ROOT,
  });

  if (packageResult.status !== 0) {
    console.error(
      `\n[release] Packaging FAILED (npm run package exited ${packageResult.status}).\n` +
      `[release] Nothing was committed or pushed. package.json is left bumped to ` +
      `${newVersion} so you can inspect and re-run once the issue is fixed.\n`,
    );
    process.exit(packageResult.status || 1);
  }

  const vsixName = `tycoonagents-${newVersion}.vsix`;
  const vsixPath = join(ROOT, vsixName);
  if (!existsSync(vsixPath)) {
    console.error(
      `\n[release] Expected "${vsixName}" at repo root after packaging, but it's missing.\n` +
      '[release] Aborting before any git action.\n',
    );
    process.exit(1);
  }
  const vsixSize = statSync(vsixPath).size;

  const commitMessage = message ? `Release ${newVersion}: ${message}` : `Release ${newVersion}`;
  const commitBody = `${commitMessage}\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`;

  try {
    execSync('git add -A', { stdio: 'inherit', cwd: ROOT });
  } catch (err) {
    console.error(`\n[release] "git add -A" failed: ${err.message}\n[release] Nothing was committed or pushed.\n`);
    process.exit(1);
  }

  // Commit message is written to a temp file and passed via `-F` so no
  // shell-quoting concerns arise across bash/cmd/PowerShell.
  const tmpMsgPath = join(tmpdir(), `tycoonagents-release-msg-${Date.now()}.txt`);
  writeFileSync(tmpMsgPath, commitBody, 'utf8');
  try {
    execSync(`git commit -F "${tmpMsgPath}"`, { stdio: 'inherit', cwd: ROOT });
  } catch (err) {
    console.error(`\n[release] git commit failed: ${err.message}\n[release] Nothing was pushed.\n`);
    process.exit(1);
  } finally {
    try {
      unlinkSync(tmpMsgPath);
    } catch {
      // best-effort cleanup; a stray temp file is harmless
    }
  }

  let pushed = true;
  try {
    execSync('git push origin main', { stdio: 'inherit', cwd: ROOT });
  } catch (err) {
    pushed = false;
    console.error(
      `\n[release] git push failed: ${err.message}\n` +
      '[release] The commit is local — push manually once resolved.\n',
    );
  }

  const sizeKb = (vsixSize / 1024).toFixed(1);
  console.log(
    `\n[release] ${pushed ? 'Done' : 'Committed (push failed, see above)'} — ` +
    `${vsixName} (${sizeKb} KB), version ${newVersion}.\n`,
  );

  if (!pushed) {
    process.exit(1);
  }
}

main();
