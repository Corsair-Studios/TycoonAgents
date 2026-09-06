/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";

/*
 * Coverage for scripts/release-local.mjs's pure helpers (parseArgs,
 * parsePorcelainPaths, isAllowed, findOffendingPaths, isAlreadyReleased,
 * bumpVersion, parseTestTotals, countZipEntriesFromBuffer) plus an
 * end-to-end preflight/dry-run pass against a real temp git repo fixture.
 * No packaging (`npm run package`) is ever invoked here — the temp repo has
 * no build tooling, so only `--dry-run` and preflight-refusal paths run the
 * script as a subprocess.
 */

const SCRIPT_PATH = join(process.cwd(), "scripts", "release-local.mjs");
const SCRIPT_URL = pathToFileURL(SCRIPT_PATH).href;

// tsc downlevels a plain `import()` in this CommonJS-compiled test to
// `require()`, which cannot load an ESM .mjs — go through `new Function` so
// the dynamic import survives untouched (same trick as checkNoAbsolutePaths.test.ts).
const dynamicImport = new Function("specifier", "return import(specifier);") as (
  specifier: string,
) => Promise<Record<string, any>>;

async function loadScript() {
  return dynamicImport(SCRIPT_URL);
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tycoon-release-test-"));
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.2.3" }, null, 2));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.2.3" }, null, 2));
  execSync("git add -A", { cwd: dir });
  execSync('git commit -q -m "init"', { cwd: dir });
  return dir;
}

function runScript(dir: string, args: string[]) {
  return spawnSync("node", [SCRIPT_PATH, ...args], { cwd: dir, encoding: "utf8" });
}

// --- pure helpers -----------------------------------------------------

test("parseArgs reads level, --dry-run, --message, --allow", async () => {
  const { parseArgs } = await loadScript();
  const parsed = parseArgs(["patch", "--dry-run", "--message", "hello world", "--allow", "docs/,notes.md"]);
  assert.equal(parsed.level, "patch");
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.message, "hello world");
  assert.deepEqual(parsed.allow, ["docs/", "notes.md"]);
});

test("parsePorcelainPaths handles staged, unstaged, untracked, and renames", async () => {
  const { parsePorcelainPaths } = await loadScript();
  const porcelain = [" M src/a.ts", "?? notes.md", "A  src/b.ts", "R  old.ts -> new.ts"].join("\n");
  assert.deepEqual(parsePorcelainPaths(porcelain), ["src/a.ts", "notes.md", "src/b.ts", "new.ts"]);
});

test("isAllowed matches exact paths and prefix directories only", async () => {
  const { isAllowed } = await loadScript();
  assert.equal(isAllowed("docs/DISTRIBUTION.md", ["docs"]), true);
  assert.equal(isAllowed("docs/DISTRIBUTION.md", ["docs/"]), true);
  assert.equal(isAllowed("docs-other/file.md", ["docs"]), false);
  assert.equal(isAllowed("src/a.ts", ["docs"]), false);
});

test("findOffendingPaths returns only paths outside the allowlist", async () => {
  const { findOffendingPaths } = await loadScript();
  const porcelain = [" M docs/DISTRIBUTION.md", " M src/a.ts", "?? scratch.log"].join("\n");
  const offending = findOffendingPaths(porcelain, ["docs"]);
  assert.deepEqual(offending, ["src/a.ts", "scratch.log"]);
});

test("isAlreadyReleased recognizes the exact chore(release) subject for the current version only", async () => {
  const { isAlreadyReleased } = await loadScript();
  assert.equal(isAlreadyReleased("chore(release): 1.2.3", "1.2.3"), true);
  assert.equal(isAlreadyReleased("chore(release): 1.2.3", "1.2.4"), false);
  assert.equal(isAlreadyReleased("feat: something chore(release): 1.2.3 extra", "1.2.3"), false);
});

test("bumpVersion applies patch and minor semver arithmetic", async () => {
  const { bumpVersion } = await loadScript();
  assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
});

test("parseTestTotals extracts node --test pass/fail counts", async () => {
  const { parseTestTotals } = await loadScript();
  const totals = parseTestTotals("some output\n# pass 42\n# fail 1\n");
  assert.deepEqual(totals, { pass: 42, fail: 1 });
});

test("countZipEntriesFromBuffer reads the EOCD file count from a real zip", async () => {
  const { countZipEntriesFromBuffer } = await loadScript();
  const dir = mkdtempSync(join(tmpdir(), "tycoon-zip-test-"));
  try {
    writeFileSync(join(dir, "a.txt"), "hello");
    writeFileSync(join(dir, "b.txt"), "world");
    const zipPath = join(dir, "out.zip");
    const zipResult = spawnSync("zip", ["-q", "-j", zipPath, join(dir, "a.txt"), join(dir, "b.txt")], { cwd: dir });
    if (zipResult.status !== 0 || !zipResult.pid) {
      // `zip` isn't guaranteed present on Windows CI — skip gracefully rather
      // than failing on an environment gap unrelated to the reader logic.
      return;
    }
    const { readFileSync } = await import("node:fs");
    const count = countZipEntriesFromBuffer(readFileSync(zipPath));
    assert.equal(count, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- subprocess / temp-repo fixture ------------------------------------

test("refuses on a dirty tree outside the allowlist, listing offending paths", () => {
  const dir = makeTempRepo();
  try {
    writeFileSync(join(dir, "src.ts"), "// dirty");
    const result = runScript(dir, ["patch", "--dry-run"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Preflight FAILED/);
    assert.match(result.stderr, /src\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accepts a dirty tree when every changed path is covered by --allow", () => {
  const dir = makeTempRepo();
  try {
    writeFileSync(join(dir, "notes.md"), "scratch");
    const result = runScript(dir, ["patch", "--dry-run", "--allow", "notes.md"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /DRY RUN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses when HEAD is already this version's release commit", () => {
  const dir = makeTempRepo();
  try {
    execSync('git commit -q --allow-empty -m "chore(release): 1.2.3"', { cwd: dir });
    const result = runScript(dir, ["patch", "--dry-run"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--dry-run on a clean tree prints the plan without changing package.json", () => {
  const dir = makeTempRepo();
  try {
    const before = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    const result = runScript(dir, ["patch", "--dry-run"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /1\.2\.3 -> 1\.2\.4/);
    assert.match(result.stdout, /npm run package/);
    const after = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    assert.equal(before, after, "dry-run must not create any commit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
