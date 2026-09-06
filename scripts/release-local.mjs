#!/usr/bin/env node
// Scripted release: `npm run release:patch` / `npm run release:minor`
// (== `node scripts/release-local.mjs patch|minor [--dry-run] [--message "<subject>"] [--allow a,b,c]`).
//
// 1. Preflight: refuses to run if the working tree has staged or unstaged
//    (including untracked) changes outside an allowlist of paths, or if
//    HEAD's last commit is already a "chore(release): <version>" for the
//    CURRENT version (before the bump) — a strong signal this was already
//    run and something re-invoked it.
// 2. `npm version <bump> --no-git-tag-version`, then commits package.json +
//    package-lock.json as "chore(release): <version>" with a Co-Authored-By
//    trailer (TYCOON_RELEASE_TRAILER env override, else a default).
// 3. `npm run package` (build + full test suite + verify:vsix-contents),
//    then reports the resulting VSIX's size and file count.
// 4. Prints a one-paragraph summary. Never leaves a half-done bump: if
//    packaging fails AFTER the commit, this prints the exact
//    `git reset --soft HEAD~1` recovery line rather than doing it itself.
// 5. --dry-run runs preflight and prints the plan without changing anything.
//
// Local-only: unlike `npm run release` (scripts/release.mjs), this never
// tags, pushes, or creates a GitHub Release.
import { readFileSync, statSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync, execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

/** Resolves the npm executable for spawnSync/execFileSync without a shell (avoids the Node DEP0190 warning). */
const NPM_CMD = process.platform === "win32" ? "npm.cmd" : "npm";

const DEFAULT_TRAILER = "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>";
const LEVELS = ["patch", "minor"];

// ---------------------------------------------------------------------------
// Pure / test-covered helpers
// ---------------------------------------------------------------------------

/** Parses `node scripts/release-local.mjs <level> [--dry-run] [--message "..."] [--allow a,b]`. */
export function parseArgs(argv) {
  const level = argv[0];
  let dryRun = false;
  let message;
  let allow = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--message") {
      message = argv[++i];
    } else if (arg.startsWith("--message=")) {
      message = arg.slice("--message=".length);
    } else if (arg === "--allow") {
      allow = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith("--allow=")) {
      allow = arg.slice("--allow=".length).split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return { level, dryRun, message, allow };
}

/**
 * Parses `git status --porcelain` output into a flat list of changed paths
 * (staged, unstaged, and untracked all count — the preflight treats any of
 * them as "dirty" unless allowlisted). Handles the `R  old -> new` rename
 * format by returning the new path.
 */
export function parsePorcelainPaths(porcelain) {
  const paths = [];
  for (const rawLine of porcelain.split("\n")) {
    if (!rawLine.trim()) continue;
    const rest = rawLine.slice(3);
    const arrowIdx = rest.indexOf(" -> ");
    const path = arrowIdx === -1 ? rest : rest.slice(arrowIdx + 4);
    paths.push(path.trim().replace(/^"|"$/g, ""));
  }
  return paths;
}

/** True if `path` sits at or under one of the allowlisted prefixes. */
export function isAllowed(path, allowlist) {
  const normalized = path.replace(/\\/g, "/");
  return allowlist.some((allowedRaw) => {
    const allowed = allowedRaw.replace(/\\/g, "/").replace(/\/+$/, "");
    return normalized === allowed || normalized.startsWith(`${allowed}/`);
  });
}

/** Returns the changed paths NOT covered by the allowlist. */
export function findOffendingPaths(porcelain, allowlist) {
  return parsePorcelainPaths(porcelain).filter((p) => !isAllowed(p, allowlist));
}

/** True if `subject` (HEAD's last commit subject line) is already this version's release commit. */
export function isAlreadyReleased(subject, currentVersion) {
  return subject.trim() === `chore(release): ${currentVersion}`;
}

/** Applies a semver bump (mirrors `npm version`'s own arithmetic, for the dry-run preview only). */
export function bumpVersion(version, level) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`Cannot parse semver version "${version}"`);
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (level === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

/**
 * Parses `npm run package` output for test totals. node:test prints one
 * summary block per suite with lines like "ℹ pass 1868" / "ℹ fail 0" /
 * "ℹ skipped 1" (also bare "# pass 42" from older/other runners) — this sums
 * pass/fail/skipped across every such block found. A separate python
 * unittest line, e.g. "Ran 217 tests in 2.665s ... OK (skipped=1)" or
 * "... FAILED (failures=2)", is reported separately as `python`.
 */
export function parseTestTotals(output) {
  const nodeStatPattern = /^[ \t]*(?:ℹ|#)\s*(pass|fail|skipped)\s+(\d+)/gim;
  let pass;
  let fail;
  let skipped;
  let match;
  while ((match = nodeStatPattern.exec(output)) !== null) {
    const key = match[1].toLowerCase();
    const value = Number(match[2]);
    if (key === "pass") pass = (pass || 0) + value;
    else if (key === "fail") fail = (fail || 0) + value;
    else if (key === "skipped") skipped = (skipped || 0) + value;
  }

  let python;
  const pythonMatch = /Ran (\d+) tests? in ([\d.]+)s\s*\r?\n*\s*(OK|FAILED)(?:\s*\(([^)]*)\))?/i.exec(output);
  if (pythonMatch) {
    const detail = pythonMatch[4] || "";
    const skippedMatch = /skipped=(\d+)/.exec(detail);
    const failuresMatch = /failures=(\d+)/.exec(detail);
    const errorsMatch = /errors=(\d+)/.exec(detail);
    python = {
      count: Number(pythonMatch[1]),
      seconds: Number(pythonMatch[2]),
      ok: pythonMatch[3].toUpperCase() === "OK",
      skipped: skippedMatch ? Number(skippedMatch[1]) : undefined,
      failures: failuresMatch ? Number(failuresMatch[1]) : undefined,
      errors: errorsMatch ? Number(errorsMatch[1]) : undefined,
    };
  }

  return { pass, fail, skipped, python };
}

/**
 * Minimal pure-Node .zip central-directory reader: returns { fileCount } by
 * scanning for the End Of Central Directory record and its file count field.
 * No dependency on `unzip` being on PATH; used as the primary strategy, with
 * `unzip -l` as a fallback strategy only (see readVsixInfo below).
 */
export function countZipEntriesFromBuffer(buf) {
  // EOCD record: signature 0x06054b50, fixed 22-byte tail (no comment).
  // Scan backward for the signature since a comment (rare for vsce output)
  // can push it earlier than the last 22 bytes.
  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === sig[0] && buf[i + 1] === sig[1] && buf[i + 2] === sig[2] && buf[i + 3] === sig[3]) {
      // Total entries (all disks) at offset +10, little-endian uint16.
      return buf.readUInt16LE(i + 10);
    }
  }
  throw new Error("Could not locate ZIP end-of-central-directory record");
}

// ---------------------------------------------------------------------------
// Side-effecting steps
// ---------------------------------------------------------------------------

function readCurrentVersion(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return pkg.version;
}

function readLastCommitSubject(root) {
  try {
    return execSync("git log -1 --pretty=%s", { cwd: root, encoding: "utf8" });
  } catch {
    return "";
  }
}

function readPorcelain(root) {
  return execSync("git status --porcelain", { cwd: root, encoding: "utf8" });
}

function readVsixInfo(vsixPath) {
  const size = statSync(vsixPath).size;
  let fileCount;
  try {
    const buf = readFileSync(vsixPath);
    fileCount = countZipEntriesFromBuffer(buf);
  } catch (err) {
    console.warn(`[release] Pure-node zip listing failed (${err.message}); trying \`unzip -l\`.`);
    const result = spawnSync("unzip", ["-l", vsixPath], { encoding: "utf8" });
    if (result.status === 0) {
      const lines = result.stdout.trim().split("\n");
      const lastLine = lines[lines.length - 1];
      const match = /^\s*\d+\s+(\d+)\s+files?/.exec(lastLine);
      fileCount = match ? Number(match[1]) : undefined;
    } else {
      console.warn("[release] `unzip -l` unavailable — file count will be omitted from the summary.");
    }
  }
  return { size, fileCount };
}

function runPreflight(root, allowlist) {
  const porcelain = readPorcelain(root);
  const offending = findOffendingPaths(porcelain, allowlist);
  if (offending.length > 0) {
    console.error(
      "\n[release] Preflight FAILED: the working tree has changes outside the allowlist.\n" +
      "[release] Offending paths:\n" +
      offending.map((p) => `[release]   - ${p}`).join("\n") +
      `\n[release] Pass --allow ".vscodeignore,..." to permit them, or commit/stash first.\n`,
    );
    process.exit(1);
  }

  const currentVersion = readCurrentVersion(root);
  const lastSubject = readLastCommitSubject(root);
  if (isAlreadyReleased(lastSubject, currentVersion)) {
    console.error(
      `\n[release] Preflight FAILED: HEAD is already "chore(release): ${currentVersion}".\n` +
      "[release] This version appears already released — nothing to do.\n",
    );
    process.exit(1);
  }

  return { currentVersion };
}

function main() {
  const root = process.cwd();
  const { level, dryRun, message, allow } = parseArgs(process.argv.slice(2));

  if (!LEVELS.includes(level)) {
    console.error(`[release] Invalid or missing level "${level}" — expected one of: ${LEVELS.join(", ")}.`);
    console.error("[release] Usage: node scripts/release-local.mjs patch|minor [--dry-run] [--message \"<subject>\"] [--allow a,b]");
    process.exit(1);
  }

  const { currentVersion } = runPreflight(root, allow);
  const plannedVersion = bumpVersion(currentVersion, level);
  const commitSubject = `chore(release): ${plannedVersion}`;
  const trailer = process.env.TYCOON_RELEASE_TRAILER || DEFAULT_TRAILER;

  if (dryRun) {
    console.log(
      "\n[release] DRY RUN — preflight passed, nothing changed.\n" +
      `[release] Plan:\n` +
      `[release]   1. npm version ${level} --no-git-tag-version   (${currentVersion} -> ${plannedVersion})\n` +
      `[release]   2. git commit package.json + package-lock.json as:\n` +
      `[release]        ${commitSubject}\n` +
      `[release]        ${trailer}\n` +
      `[release]   3. npm run package  (build + tests + verify:vsix-contents)\n` +
      `[release]   4. report dist/tycoonagents-${plannedVersion}.vsix size + file count\n` +
      (message ? `[release]   (commit body message: "${message}")\n` : ""),
    );
    return;
  }

  console.log(`[release] Bumping ${level}: ${currentVersion} -> (npm version will confirm)...`);
  const versionResult = spawnSync(NPM_CMD, ["version", level, "--no-git-tag-version"], {
    stdio: "inherit",
    shell: false,
    cwd: root,
  });
  if (versionResult.status !== 0) {
    console.error(`\n[release] "npm version ${level} --no-git-tag-version" FAILED. Nothing committed.\n`);
    process.exit(versionResult.status || 1);
  }

  const newVersion = readCurrentVersion(root);
  const subject = `chore(release): ${newVersion}`;
  const commitBody = message ? `${subject}\n\n${message}\n\n${trailer}` : `${subject}\n\n${trailer}`;

  const commitMsgFile = join(tmpdir(), `tycoon-release-commit-${process.pid}-${Date.now()}.txt`);
  try {
    writeFileSync(commitMsgFile, commitBody, "utf8");
    execSync("git add package.json package-lock.json", { stdio: "inherit", cwd: root });
    execFileSync("git", ["commit", "-F", commitMsgFile], { stdio: "inherit", cwd: root });
  } catch (err) {
    console.error(
      `\n[release] git commit FAILED: ${err.message}\n` +
      "[release] package.json/package-lock.json are bumped but uncommitted — resolve and re-run, " +
      "or revert with: git checkout -- package.json package-lock.json\n",
    );
    process.exit(1);
  } finally {
    try {
      unlinkSync(commitMsgFile);
    } catch {
      // best-effort cleanup only
    }
  }

  const commitHash = execSync("git rev-parse --short HEAD", { cwd: root, encoding: "utf8" }).trim();

  console.log("[release] Running `npm run package`...");
  const packageResult = spawnSync(NPM_CMD, ["run", "package"], { stdio: "pipe", shell: false, cwd: root, encoding: "utf8" });
  process.stdout.write(packageResult.stdout || "");
  process.stderr.write(packageResult.stderr || "");

  if (packageResult.status !== 0) {
    console.error(
      "\n[release] PACKAGING FAILED after the release commit already landed.\n" +
      "[release] The bump is committed but the VSIX was not produced. To undo the commit " +
      "(keeping your working tree files as they are) and try again:\n" +
      "[release]   git reset --soft HEAD~1\n",
    );
    process.exit(packageResult.status || 1);
  }

  const totals = parseTestTotals(`${packageResult.stdout}\n${packageResult.stderr}`);
  const vsixName = `tycoonagents-${newVersion}.vsix`;
  const vsixPath = join(root, "dist", vsixName);
  if (!existsSync(vsixPath)) {
    console.error(
      `\n[release] Expected "${vsixName}" in dist/ after packaging, but it's missing.\n` +
      "[release] The release commit already landed. Recovery: git reset --soft HEAD~1\n",
    );
    process.exit(1);
  }
  const { size, fileCount } = readVsixInfo(vsixPath);
  const sizeKb = (size / 1024).toFixed(1);

  const nodeTestsSummary =
    totals.pass !== undefined
      ? `${totals.pass} passed` +
        `${totals.fail ? `, ${totals.fail} failed` : ""}` +
        `${totals.skipped ? `, ${totals.skipped} skipped` : ""}`
      : "unknown";
  const pythonSummary = totals.python
    ? `; python: ${totals.python.count} tests in ${totals.python.seconds}s (${totals.python.ok ? "OK" : "FAILED"}` +
      `${totals.python.skipped ? `, ${totals.python.skipped} skipped` : ""}` +
      `${totals.python.failures ? `, ${totals.python.failures} failures` : ""}` +
      `${totals.python.errors ? `, ${totals.python.errors} errors` : ""})`
    : "";

  console.log(
    `\n[release] Released ${newVersion} (commit ${commitHash}): ${vsixPath} — ${sizeKb} KB, ` +
    `${fileCount !== undefined ? `${fileCount} files` : "file count unavailable"}. ` +
    `Tests: ${nodeTestsSummary}${pythonSummary}.\n`,
  );
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
