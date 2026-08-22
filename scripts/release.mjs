#!/usr/bin/env node
// Automates the ship-a-VSIX dance: bump the version, package, verify the
// .vsix landed, commit, tag, and push. Run via `npm run release -- <level>
// ["message"]` where <level> is "patch" (default), "minor", or "major".
//
// Mirrors the repeated manual sequence: bump patch version, `npm run
// package` (which runs the full vscode:prepublish chain — build, bundles,
// check:paths, check:webview — then `vsce package`), verify the .vsix,
// `git add -A`, commit "Release x.y.z: ...", create an annotated `vx.y.z`
// tag, `git push origin main --follow-tags`, then a best-effort step that
// never fails the release itself: publish a GitHub Release (`gh release
// create`) with the .vsix attached.
import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { execSync, execFileSync, spawnSync } from 'node:child_process';
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

  // Pre-flight: confirm `origin` is reachable BEFORE touching anything.
  // Most push failures are auth/network, not code — catching that here
  // means a bad connection or expired credential aborts before a version
  // number gets burned, instead of after packaging a VSIX for a release
  // that then fails to push.
  try {
    execSync('git ls-remote --exit-code origin HEAD', { cwd: ROOT, stdio: 'ignore' });
  } catch (err) {
    console.error(
      `\n[release] Pre-flight failed: "git ls-remote --exit-code origin HEAD" could not reach ` +
      `"origin" (${err.message}).\n` +
      '[release] Nothing was changed — check your network connection and git credentials, then re-run.\n',
    );
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
  const commitBody = `${commitMessage}\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>`;

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
    try {
      unlinkSync(tmpMsgPath);
    } catch {
      // best-effort cleanup; a stray temp file is harmless
    }
  } catch (err) {
    // Clean up before process.exit — a finally block would never run here
    // since process.exit() terminates immediately without unwinding.
    try {
      unlinkSync(tmpMsgPath);
    } catch {
      // best-effort cleanup; a stray temp file is harmless
    }
    console.error(`\n[release] git commit failed: ${err.message}\n[release] Nothing was pushed.\n`);
    process.exit(1);
  }

  // Best-effort: make sure remote tags are visible before checking whether
  // this version's tag already exists. A clone can carry zero LOCAL tags
  // while the remote already has plenty (verified on this clone: 0 local
  // tags, but GitHub already had v0.0.450 and v0.0.442) — without this fetch
  // the existence check below only ever sees local refs and false-negatives
  // on a tag that's actually already on GitHub. Never fatal: offline or an
  // auth hiccup just means the check below falls back to local-only
  // knowledge, same as before this fix existed.
  try {
    execSync('git fetch --tags', { cwd: ROOT, stdio: 'ignore' });
  } catch (err) {
    console.warn(
      `[release] "git fetch --tags" failed (${err.message}) — the tag-existence check below is local-only for this run.`,
    );
  }

  // Annotated `v<version>` tag, created before the push so `--follow-tags`
  // carries it up atomically with the commit. Must be annotated (`git tag
  // -a`, not a lightweight tag) — `--follow-tags` only pushes annotated tags.
  // Guard against a re-run after a partial failure: if the tag already
  // exists, skip creation (don't fail, don't overwrite) and fall through to
  // the push, since the earlier run may have tagged but not pushed.
  // Detected via `git rev-parse -q --verify refs/tags/<name>`, which exits 0
  // if the ref resolves (locally OR from the fetch above) and non-zero
  // (silently, thanks to -q) if it doesn't — the standard git idiom for
  // "does this ref exist" without parsing `git tag -l` output.
  const tagName = `v${newVersion}`;
  let tagExists = false;
  try {
    execSync(`git rev-parse -q --verify "refs/tags/${tagName}"`, { cwd: ROOT, stdio: 'ignore' });
    tagExists = true;
  } catch {
    tagExists = false;
  }

  // Tracks whether THIS run created the tag, so a push failure below can
  // roll back only a tag it created itself — never a pre-existing one that
  // was merely detected and skipped.
  let tagCreatedThisRun = false;

  if (tagExists) {
    console.warn(
      `[release] Tag "${tagName}" already exists — skipping tag creation ` +
      '(likely a re-run after a partial failure, or already released) and continuing with the push.',
    );
  } else {
    // Tag annotation reuses the release message (same text as the commit
    // subject, minus the Co-Authored-By trailer, which is commit metadata
    // and not part of the release description). Written to a temp file and
    // passed via `-F` for the same shell-quoting-safety reason as the commit
    // message above. If the message is long/multi-line, git's own tag
    // display treats the first line as the subject — no manual truncation
    // needed here.
    const tmpTagMsgPath = join(tmpdir(), `tycoonagents-release-tag-msg-${Date.now()}.txt`);
    writeFileSync(tmpTagMsgPath, commitMessage, 'utf8');
    try {
      execSync(`git tag -a "${tagName}" -F "${tmpTagMsgPath}"`, { stdio: 'inherit', cwd: ROOT });
      tagCreatedThisRun = true;
      console.log(`[release] Created annotated tag "${tagName}".`);
      try {
        unlinkSync(tmpTagMsgPath);
      } catch {
        // best-effort cleanup; a stray temp file is harmless
      }
    } catch (err) {
      // Clean up before process.exit — a finally block would never run here
      // since process.exit() terminates immediately without unwinding.
      try {
        unlinkSync(tmpTagMsgPath);
      } catch {
        // best-effort cleanup; a stray temp file is harmless
      }
      console.error(
        `\n[release] git tag failed: ${err.message}\n` +
        '[release] The commit is local but untagged — resolve and re-run.\n',
      );
      process.exit(1);
    }
  }

  let pushed = true;
  try {
    execSync('git push origin main --follow-tags', { stdio: 'inherit', cwd: ROOT });
  } catch (err) {
    pushed = false;
    console.error(
      `\n[release] git push failed: ${err.message}\n` +
      '[release] The commit and tag are local — push manually once resolved ' +
      '(`git push origin main --follow-tags`).\n',
    );
    // Roll back the tag ONLY if this run created it — never a pre-existing
    // tag that was detected and skipped above. Otherwise a later re-run
    // bumps the version again, and `--follow-tags` sweeps up this orphaned
    // tag (still reachable from HEAD) and pushes it — leaving a remote tag
    // for a version with no VSIX and no GitHub Release. Guarded in its own
    // try/catch so a delete failure can never mask the original push error.
    if (tagCreatedThisRun) {
      try {
        execSync(`git tag -d "${tagName}"`, { stdio: 'inherit', cwd: ROOT });
        console.warn(`[release] Rolled back local tag "${tagName}" so a re-run won't push an orphaned tag.`);
      } catch (deleteErr) {
        console.warn(
          `[release] Could not roll back local tag "${tagName}" (${deleteErr.message}). ` +
          `Delete it manually before re-running: git tag -d ${tagName}`,
        );
      }
    }
  }

  // Best-effort GitHub Release: only attempted once the push has actually
  // landed the tag on the remote (gh needs the tag to exist on GitHub).
  // Mirrors the exact best-effort pattern used by the Power Tools sync
  // immediately below — execFileSync wrapped in try/catch, a console.warn on
  // failure, and no process.exit — so a missing/unauthenticated `gh`, an
  // already-existing release, or an API hiccup can never fail the release
  // itself. The commit and tag are already safely pushed by this point.
  if (pushed) {
    const releaseNotes = message || commitMessage;
    const manualCmd = `gh release create ${tagName} "${vsixPath}" --title "${tagName}" --notes "<release notes>"`;
    try {
      execFileSync(
        'gh',
        ['release', 'create', tagName, vsixPath, '--title', tagName, '--notes', releaseNotes],
        { stdio: 'inherit', cwd: ROOT },
      );
      // `gh release create` prints the release URL to stdout on success;
      // stdio: 'inherit' above already surfaced it directly to the console.
      console.log(`[release] Published GitHub Release "${tagName}" (see URL above).`);
    } catch (err) {
      console.warn(
        `[release] GitHub Release NOT published: ${err.message}\n` +
        '[release] This usually means `gh` is missing/not on PATH or not authenticated ' +
        '(`gh auth status`), or a release for this tag already exists.\n' +
        `[release] Publish it manually once resolved:\n[release]   ${manualCmd}\n`,
      );
    }
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
