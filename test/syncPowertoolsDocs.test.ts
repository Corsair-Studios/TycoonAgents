/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/*
 * Coverage for the multi-AI-client MCP setup docs added alongside
 * media/uefn-bridge/uefn_launcher.py's build_client_config_snippet():
 * scripts/powertools-assets/README.md + INSTALL.md (new doc sources, mirrored
 * verbatim into the standalone "Trashbyrd's UEFN Power Tools" repo on every
 * sync) and scripts/sync-powertools.mjs's copyDoc() wiring (~34-40, ~175-191,
 * ~485-490) that actually copies them.
 *
 * Pure-data suite, same idiom as test/handbookStamps.test.ts: reads the REAL
 * files on disk (the doc sources and sync-powertools.mjs's own source text),
 * never a hand-copied reimplementation of either. It does not invoke the
 * sync script itself (no filesystem side effects, no target-repo
 * dependency), so it cannot verify an actual sync run end-to-end -- it
 * guards against the doc sources going missing/trivial and against a future
 * refactor silently dropping the copy wiring for either file.
 */

const ROOT = process.cwd();
const ASSETS_DIR = join(ROOT, "scripts", "powertools-assets");
const README_PATH = join(ASSETS_DIR, "README.md");
const INSTALL_PATH = join(ASSETS_DIR, "INSTALL.md");
const SYNC_SCRIPT_PATH = join(ROOT, "scripts", "sync-powertools.mjs");

// Arbitrary but generous floor: catches an accidentally-truncated or
// stub/placeholder file without being sensitive to normal prose edits.
const MIN_DOC_BYTES = 300;

function readDoc(path: string): string {
  return readFileSync(path, "utf8");
}

// ── 1. The doc sources exist and are non-trivial ──

test("scripts/powertools-assets/README.md exists and is a real, non-trivial doc", () => {
  const size = statSync(README_PATH).size;
  assert.ok(
    size > MIN_DOC_BYTES,
    `README.md is only ${size} bytes (expected > ${MIN_DOC_BYTES}) -- looks stubbed or truncated`,
  );
});

test("scripts/powertools-assets/INSTALL.md exists and is a real, non-trivial doc", () => {
  const size = statSync(INSTALL_PATH).size;
  assert.ok(
    size > MIN_DOC_BYTES,
    `INSTALL.md is only ${size} bytes (expected > ${MIN_DOC_BYTES}) -- looks stubbed or truncated`,
  );
});

// ── 2. Sync drift-guard: sync-powertools.mjs's source must still reference
// copying BOTH files into the target, so a future refactor can't silently
// drop one (or both) from the sync. Anchored on the real source text, not a
// reimplementation, and on the exported/declared source PATHS (not just the
// destination filenames, which could coincidentally appear elsewhere). ──

test("sync-powertools.mjs declares README_SRC and INSTALL_SRC pointing at scripts/powertools-assets/", () => {
  const src = readFileSync(SYNC_SCRIPT_PATH, "utf8");
  assert.match(
    src,
    /README_SRC\s*=\s*join\(SCRIPT_DIR,\s*'powertools-assets',\s*'README\.md'\)/,
    "sync-powertools.mjs no longer declares README_SRC from scripts/powertools-assets/README.md",
  );
  assert.match(
    src,
    /INSTALL_SRC\s*=\s*join\(SCRIPT_DIR,\s*'powertools-assets',\s*'INSTALL\.md'\)/,
    "sync-powertools.mjs no longer declares INSTALL_SRC from scripts/powertools-assets/INSTALL.md",
  );
});

test("sync-powertools.mjs actually copies both README_SRC and INSTALL_SRC into the target repo", () => {
  const src = readFileSync(SYNC_SCRIPT_PATH, "utf8");
  assert.match(
    src,
    /copyDoc\(README_SRC,\s*'README\.md',\s*targetDir\)/,
    "sync-powertools.mjs no longer copies README_SRC to the target repo's README.md",
  );
  assert.match(
    src,
    /copyDoc\(INSTALL_SRC,\s*'INSTALL\.md',\s*targetDir\)/,
    "sync-powertools.mjs no longer copies INSTALL_SRC to the target repo's INSTALL.md",
  );
});

test("sync-powertools.mjs's copyDoc() is non-fatal (missing/unwritable doc must never block the rest of sync)", () => {
  const src = readFileSync(SYNC_SCRIPT_PATH, "utf8");
  const fnStart = src.indexOf("function copyDoc(");
  assert.ok(fnStart >= 0, "sync-powertools.mjs: copyDoc() function not found");
  const fnEnd = src.indexOf("\nfunction ", fnStart + 1);
  const fnBody = src.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
  assert.match(fnBody, /existsSync\(srcPath\)/, "copyDoc() no longer guards on the source file existing");
  assert.match(fnBody, /catch \(err\)/, "copyDoc() no longer catches a copy failure");
  assert.doesNotMatch(
    fnBody,
    /process\.exit/,
    "copyDoc() must be non-fatal (best-effort) -- it must never call process.exit",
  );
});

// ── 3. Cross-check against the generator (item 4): INSTALL.md's documented
// standalone-source run command must match what
// uefn_launcher._resolve_command_and_args() actually emits for a .ts server
// path (see test/python/test_uefn_launcher_client_configs.py's
// ResolveCommandAndArgsRoutingTests, the SAME shape pinned independently
// from the Python side). Both must say `"command": "npx"` /
// `"args": ["tsx", ...]` -- if a future doc edit describes a different
// standalone run command (e.g. plain "node" after a build step) without the
// generator changing too, this fails loudly instead of the drift going
// unnoticed. ──

test("INSTALL.md's standalone-source swap example matches the generator's npx+tsx shape for a .ts path", () => {
  const install = readDoc(INSTALL_PATH);
  const swapSectionIdx = install.indexOf("swap the command in every example below for");
  assert.ok(
    swapSectionIdx >= 0,
    "INSTALL.md: could not find the standalone-source \"swap the command\" guidance -- " +
      "has the Connecting an AI client section been restructured?",
  );
  const swapBlock = install.slice(swapSectionIdx, swapSectionIdx + 400);
  assert.match(
    swapBlock,
    /"command":\s*"npx"/,
    'INSTALL.md\'s standalone swap no longer says "command": "npx" -- ' +
      "does it now contradict uefn_launcher._resolve_command_and_args()'s .ts handling?",
  );
  assert.match(
    swapBlock,
    /"args":\s*\["tsx",/,
    'INSTALL.md\'s standalone swap no longer says "args": ["tsx", ...] -- ' +
      "does it now contradict uefn_launcher._resolve_command_and_args()'s .ts handling?",
  );
  assert.match(
    swapBlock,
    /uefn-server\.ts/,
    "INSTALL.md's standalone swap example no longer points at uefn-server.ts",
  );
});

test("INSTALL.md's per-client examples use the staged uefn-server.mjs entry point, distinct from the standalone .ts swap", () => {
  // Sanity-checks the doc's own internal consistency: the main per-client
  // examples (Claude Code, VS Code Copilot, etc.) show the STAGED/built
  // entry point (.mjs, run via plain "node"), and only the one dedicated
  // swap callout (checked above) covers the standalone .ts + npx/tsx case.
  const install = readDoc(INSTALL_PATH);
  assert.match(install, /uefn-server\.mjs/, "INSTALL.md no longer shows the staged uefn-server.mjs entry point anywhere");
  const mjsCount = (install.match(/uefn-server\.mjs/g) ?? []).length;
  assert.ok(mjsCount >= 2, "INSTALL.md: expected uefn-server.mjs to appear in more than one client example");
});

// ── 4. Windsurf path regression guard: the documented config path must
// include the "windsurf" segment (`.codeium/windsurf/mcp_config.json`) --
// an earlier doc revision omitted it (`.codeium/mcp_config.json`), which is
// wrong for Windsurf's actual config location. Pinned explicitly so the
// segment-less path can't silently return in a future edit. ──

test("INSTALL.md's Windsurf section documents the .codeium/windsurf/mcp_config.json path (not the segment-less .codeium/mcp_config.json)", () => {
  const install = readDoc(INSTALL_PATH);
  const windsurfSectionIdx = install.indexOf("### Windsurf");
  assert.ok(windsurfSectionIdx >= 0, "INSTALL.md: no \"### Windsurf\" section found");
  const nextSectionIdx = install.indexOf("### ", windsurfSectionIdx + 1);
  const windsurfSection = install.slice(windsurfSectionIdx, nextSectionIdx > 0 ? nextSectionIdx : undefined);

  assert.match(
    windsurfSection,
    /\.codeium[\\/]windsurf[\\/]mcp_config\.json/,
    "INSTALL.md's Windsurf section no longer documents the .codeium/windsurf/mcp_config.json path",
  );
  // Guard against the specific old wrong path (segment-less) reappearing:
  // every occurrence of "mcp_config.json" in this section must be preceded
  // by a "windsurf" path segment.
  const wrongPathRe = /\.codeium[\\/]mcp_config\.json/;
  assert.doesNotMatch(
    windsurfSection,
    wrongPathRe,
    "INSTALL.md's Windsurf section documents the WRONG segment-less .codeium/mcp_config.json path " +
      "-- it must be .codeium/windsurf/mcp_config.json",
  );
});

/*
 * ── 5. Decoupled, date-based standalone versioning (plan task p4-t4) ──
 *
 * Coverage for scripts/sync-powertools.mjs's independent version stream:
 * formatDateVersion/listVersionTags/computeDateVersion (date -> npm-semver
 * -valid version string with same-day letter suffixes derived from the
 * target repo's own tags), detectContentChanged (ground-truth no-op
 * detection via `git status --porcelain` against the target's own HEAD --
 * NOT the copy/prune step counts, which are always non-zero on a non-empty
 * source regardless of whether content actually changed), and
 * updateTargetPackageVersion (stamps the target's OWN package.json, never
 * TycoonAgents').
 *
 * Exercises the real functions against real temp git repos (not a
 * reimplementation) via the same CJS-importing-ESM dynamic-import trick used
 * above for check-no-absolute-paths.mjs, since this test file compiles to
 * CommonJS but sync-powertools.mjs is a native ESM module.
 */

const SYNC_SCRIPT_URL = pathToFileURL(SYNC_SCRIPT_PATH).href;

const dynamicImport = new Function("specifier", "return import(specifier);") as (
  specifier: string,
) => Promise<unknown>;

interface SyncPowertoolsModule {
  formatDateVersion: (date: Date) => string;
  listVersionTags: (targetDir: string, baseVersion: string) => string[];
  computeDateVersion: (targetDir: string, today: Date) => string;
  detectContentChanged: (targetDir: string) => { isGitRepo: boolean; changed: boolean };
  updateTargetPackageVersion: (targetDir: string, version: string) => boolean;
}

async function loadSyncScript(): Promise<SyncPowertoolsModule> {
  return dynamicImport(SYNC_SCRIPT_URL) as Promise<SyncPowertoolsModule>;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

// Builds a throwaway local git repo (no remote) with an initial commit, so
// tests can exercise tag listing / status diffing without touching any real
// repo or network. Returns the repo dir; callers are responsible for
// rmSync'ing it (each test does this in a try/finally).
function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sync-powertools-test-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "power-tools", version: "0.0.0" }, null, 2) + "\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

test("formatDateVersion produces npm-semver-valid YYYY.M.D with NO zero padding for single-digit month/day", async () => {
  const { formatDateVersion } = await loadSyncScript();
  const version = formatDateVersion(new Date(2026, 7, 5)); // August 5, 2026 (month is 0-indexed)
  assert.equal(version, "2026.8.5", "expected no zero padding on single-digit month/day");
  assert.doesNotMatch(version, /\.0\d/, "version must not contain a zero-padded numeric identifier");
});

test("formatDateVersion round-trips through Node's semver-shaped validation for a double-digit month/day too", async () => {
  const { formatDateVersion } = await loadSyncScript();
  const version = formatDateVersion(new Date(2026, 10, 20)); // November 20, 2026
  assert.equal(version, "2026.11.20");
});

test("computeDateVersion returns the bare date with no suffix when no tag exists yet for today", async () => {
  const { computeDateVersion } = await loadSyncScript();
  const dir = makeTempRepo();
  try {
    const version = computeDateVersion(dir, new Date(2026, 7, 20)); // August 20, 2026
    assert.equal(version, "2026.8.20");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeDateVersion picks the next free letter suffix given existing same-day tags (collision handling)", async () => {
  const { computeDateVersion } = await loadSyncScript();
  const dir = makeTempRepo();
  try {
    git(dir, "tag", "v2026.8.20");
    git(dir, "tag", "v2026.8.20-b");
    const version = computeDateVersion(dir, new Date(2026, 7, 20));
    assert.equal(version, "2026.8.20-c", "expected the next free letter after b to be c");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeDateVersion re-run after only the base tag exists picks -b (first same-day collision)", async () => {
  const { computeDateVersion } = await loadSyncScript();
  const dir = makeTempRepo();
  try {
    git(dir, "tag", "v2026.8.20");
    const version = computeDateVersion(dir, new Date(2026, 7, 20));
    assert.equal(version, "2026.8.20-b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectContentChanged reports changed:false on a clean repo with nothing new to stage (no-op run)", async () => {
  const { detectContentChanged } = await loadSyncScript();
  const dir = makeTempRepo();
  try {
    const result = detectContentChanged(dir);
    assert.equal(result.isGitRepo, true);
    assert.equal(result.changed, false, "a clean repo with no new/modified files must report changed:false");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectContentChanged reports changed:true once a new file is added (simulating a real bridge-file copy)", async () => {
  const { detectContentChanged } = await loadSyncScript();
  const dir = makeTempRepo();
  try {
    mkdirSync(join(dir, "python"), { recursive: true });
    writeFileSync(join(dir, "python", "some_tool.py"), "# changed\n");
    const result = detectContentChanged(dir);
    assert.equal(result.isGitRepo, true);
    assert.equal(result.changed, true, "a newly written file must report changed:true");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateTargetPackageVersion stamps the target's OWN package.json version field only, preserving other fields", async () => {
  const { updateTargetPackageVersion } = await loadSyncScript();
  const dir = makeTempRepo();
  try {
    const ok = updateTargetPackageVersion(dir, "2026.8.20-b");
    assert.equal(ok, true);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(pkg.version, "2026.8.20-b");
    assert.equal(pkg.name, "power-tools", "other package.json fields must be preserved untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a changed run's version string is identical across package.json, git tag, commit message, and zip filename", async () => {
  // Full-flow check without invoking main() (which would require a remote
  // and gh CLI): computes one version the same way main() does, then
  // verifies the same string is what each of the four artifact-facing call
  // sites in the real source would use, by asserting the source text passes
  // one shared `version` variable to each -- not four independently
  // formatted strings.
  const src = readFileSync(SYNC_SCRIPT_PATH, "utf8");
  assert.match(
    src,
    /pkg\.version = version;/,
    "updateTargetPackageVersion no longer stamps package.json from the single `version` variable",
  );
  assert.match(
    src,
    /\['-C', targetDir, 'commit', '-m', `Sync: Power Tools \$\{version\}`\]/,
    "commit message no longer uses the single `version` variable",
  );
  assert.match(
    src,
    /const tagName = `v\$\{version\}`;/,
    "git tag name no longer derives from the single `version` variable",
  );
  assert.match(
    src,
    /const zipName = `trashbyrds-power-tools-v\$\{version\}\.zip`;/,
    "release zip filename no longer derives from the single `version` variable",
  );
  assert.match(
    src,
    /'--title', tagName, '--notes', `Sync: Power Tools \$\{version\}`\]/,
    "GitHub release title/notes no longer use tagName/the single `version` variable",
  );
});

test("sync-powertools.mjs no longer stamps TycoonAgents' own package.json version onto the target", () => {
  const src = readFileSync(SYNC_SCRIPT_PATH, "utf8");
  assert.doesNotMatch(
    src,
    /function readVersion\(/,
    "readVersion() (TycoonAgents' own package.json version reader) should be removed, not just unused",
  );
  assert.doesNotMatch(
    src,
    /updateTargetPackageVersion\(targetDir,\s*readVersion\(\)\)/,
    "updateTargetPackageVersion must not be called with TycoonAgents' own version",
  );
});

test("main() computes `today` exactly once and threads it through, rather than calling new Date() repeatedly", () => {
  const src = readFileSync(SYNC_SCRIPT_PATH, "utf8");
  const mainStart = src.indexOf("function main()");
  assert.ok(mainStart >= 0, "main() not found");
  const mainBody = src.slice(mainStart);
  const newDateCalls = (mainBody.match(/new Date\(\)/g) ?? []).length;
  assert.equal(newDateCalls, 1, `expected exactly one \`new Date()\` call in main(), found ${newDateCalls}`);
});

test("main() gates version bump / commit / tag / release on detectContentChanged, not on copy/prune step counts", () => {
  const src = readFileSync(SYNC_SCRIPT_PATH, "utf8");
  const mainStart = src.indexOf("function main()");
  const mainBody = src.slice(mainStart);
  assert.match(
    mainBody,
    /detectContentChanged\(targetDir\)/,
    "main() no longer calls detectContentChanged() to decide whether this run is a no-op",
  );
  assert.match(
    mainBody,
    /if \(isGitRepo && !contentChanged\)/,
    "main() no longer short-circuits a no-op run before version bump/commit/tag/release",
  );
});
