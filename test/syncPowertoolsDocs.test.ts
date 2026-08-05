/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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
