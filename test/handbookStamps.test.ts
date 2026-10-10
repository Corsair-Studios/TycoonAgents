/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/*
 * Coverage for scripts/release.mjs's tag/push/GitHub-Release steps, as
 * source-text anchor checks only (see the "Tag + best-effort GitHub Release
 * anchors" section below), and HTML sanity/content-smoke checks on the
 * shipped media/handbook/*.html pages.
 *
 * The handbook pages no longer carry a version stamp — the release script
 * used to rewrite every page's `class="crumb"` element on every version
 * bump (via a `CRUMB_VERSION_RE` regex) purely to update a version number
 * nobody relied on, which meant a diff across all 14 pages on every single
 * release. That stamping loop was removed; the handbook is now
 * version-agnostic and untouched by `npm run release`.
 *
 * This is a pure-data suite: no vscode stub needed, nothing under test runs
 * at module scope with side effects. It works off the REAL files on disk —
 * scripts/release.mjs and every media/handbook/*.html page — not a
 * reimplementation of either. It does NOT invoke git or gh, so it cannot
 * verify actual tag/push/release behavior end-to-end — see the task report
 * for the list of behaviors that remain unverified by automation.
 */

const ROOT = process.cwd();
const RELEASE_SCRIPT_PATH = join(ROOT, "scripts", "release.mjs");
const HANDBOOK_DIR = join(ROOT, "media", "handbook");

function requireAnchorOnce(fullSource: string, label: string, needle: string): number {
  const idx = fullSource.indexOf(needle);
  assert.ok(idx >= 0, `scripts/release.mjs layout changed: could not find "${label}" anchor — update it in this test`);
  const count = fullSource.split(needle).length - 1;
  assert.equal(count, 1, `scripts/release.mjs layout changed: "${label}" anchor expected exactly once, found ${count}`);
  return idx;
}

function listHandbookFiles(): string[] {
  const files = readdirSync(HANDBOOK_DIR).filter((f) => f.endsWith(".html"));
  assert.ok(files.length > 0, `no .html files found under ${HANDBOOK_DIR}`);
  return files;
}

function readHandbookFile(file: string): string {
  return readFileSync(join(HANDBOOK_DIR, file), "utf8");
}

test("scripts/release.mjs no longer stamps a version into the handbook pages", () => {
  const fullSource = readFileSync(RELEASE_SCRIPT_PATH, "utf8");
  assert.doesNotMatch(
    fullSource,
    /CRUMB_VERSION_RE/,
    "release.mjs still references CRUMB_VERSION_RE — the handbook version-stamping loop should have been removed",
  );
  assert.doesNotMatch(
    fullSource,
    /HANDBOOK_DIR/,
    "release.mjs still references HANDBOOK_DIR — the handbook version-stamping loop should have been removed",
  );
});

test("no media/handbook/*.html page contains a vX.Y.Z-style version stamp", () => {
  const versionStampRe = /\bv\d+\.\d+\.\d+\b/;
  for (const file of listHandbookFiles()) {
    const content = readHandbookFile(file);
    assert.doesNotMatch(
      content,
      versionStampRe,
      `${file}: still contains a vX.Y.Z-style version stamp — the handbook should no longer carry a version`,
    );
  }
});

// ── Tag + best-effort GitHub Release anchors (added alongside the tag/gh
// steps in scripts/release.mjs). This is a pure-data suite with no
// spawnSync/execFileSync stubbing, so it cannot exercise git/gh behavior —
// these tests assert the SOURCE TEXT contains the specific commands/guards
// the feature depends on, the same anchor style used above for the crumb
// regex. A future edit that silently drops `--follow-tags`, the annotated
// tag flag, the existing-tag guard, or the vsixPath reuse will fail here. ──

test("release.mjs creates an ANNOTATED tag (git tag -a), not a lightweight one", () => {
  const fullSource = readFileSync(RELEASE_SCRIPT_PATH, "utf8");
  assert.match(
    fullSource,
    /git tag -a/,
    "release.mjs no longer creates an annotated tag — `--follow-tags` only pushes annotated tags",
  );
});

test("release.mjs guards tag creation against a pre-existing tag via git rev-parse --verify", () => {
  const fullSource = readFileSync(RELEASE_SCRIPT_PATH, "utf8");
  assert.match(
    fullSource,
    /git rev-parse -q --verify "refs\/tags\/\$\{tagName\}"/,
    "release.mjs no longer detects an existing tag before creating one",
  );
  requireAnchorOnce(fullSource, "tagExists warning", "already exists — skipping tag creation");
});

test("release.mjs best-effort fetches remote tags before the existing-tag check, so a remote-only tag isn't a false negative", () => {
  const fullSource = readFileSync(RELEASE_SCRIPT_PATH, "utf8");
  const fetchIdx = requireAnchorOnce(fullSource, "git fetch --tags call", "execSync('git fetch --tags'");
  const verifyIdx = fullSource.indexOf('git rev-parse -q --verify "refs/tags/${tagName}"');
  assert.ok(verifyIdx > fetchIdx, "release.mjs: `git fetch --tags` must run BEFORE the existing-tag rev-parse check");

  // Best-effort: the fetch failure path must warn, not exit — a fetch
  // failure (offline, auth) must never make the release itself fail.
  const fetchBlockEnd = fullSource.indexOf("const tagName = ", fetchIdx);
  assert.ok(fetchBlockEnd > fetchIdx, "release.mjs: could not bound the fetch-tags block");
  const fetchBlock = fullSource.slice(fetchIdx, fetchBlockEnd);
  assert.match(fetchBlock, /console\.warn/, "release.mjs: `git fetch --tags` failure no longer warns");
  assert.doesNotMatch(
    fetchBlock,
    /process\.exit/,
    "release.mjs: `git fetch --tags` must be best-effort — it must never call process.exit",
  );
});

test("release.mjs runs a reachability pre-flight (git ls-remote) before bumping the version, and aborts hard on failure", () => {
  const fullSource = readFileSync(RELEASE_SCRIPT_PATH, "utf8");
  const preflightIdx = requireAnchorOnce(fullSource, "ls-remote pre-flight call", "execSync('git ls-remote --exit-code origin HEAD'");
  const versionBumpIdx = fullSource.indexOf("const newVersion = bumpVersion(");
  assert.ok(
    versionBumpIdx > preflightIdx,
    "release.mjs: the ls-remote pre-flight must run BEFORE the version bump so a bad connection doesn't burn a version number",
  );

  const pkgReadIdx = fullSource.indexOf("const pkgRaw = readFileSync(PKG_PATH");
  const preflightBlock = fullSource.slice(preflightIdx, pkgReadIdx > 0 ? pkgReadIdx : versionBumpIdx);
  assert.match(preflightBlock, /process\.exit\(1\)/, "release.mjs: a failed reachability pre-flight must abort hard (process.exit(1))");
});

test("release.mjs rolls back only a tag it created THIS run when the push fails, never a pre-existing tag", () => {
  const fullSource = readFileSync(RELEASE_SCRIPT_PATH, "utf8");
  requireAnchorOnce(fullSource, "tagCreatedThisRun declaration", "let tagCreatedThisRun = false;");
  requireAnchorOnce(fullSource, "tagCreatedThisRun set on successful tag creation", "tagCreatedThisRun = true;");

  const pushCatchIdx = fullSource.indexOf("pushed = false;");
  assert.ok(pushCatchIdx >= 0, "release.mjs: could not locate the push-failure catch block");
  const ghBlockIdx = fullSource.indexOf("if (pushed) {");
  assert.ok(ghBlockIdx > pushCatchIdx, "release.mjs: could not bound the push-failure catch block");
  const pushCatchBlock = fullSource.slice(pushCatchIdx, ghBlockIdx);

  assert.match(
    pushCatchBlock,
    /if \(tagCreatedThisRun\)/,
    "release.mjs: the push-failure path no longer gates tag rollback on tagCreatedThisRun — it could delete a pre-existing tag",
  );
  assert.match(
    pushCatchBlock,
    /git tag -d "\$\{tagName\}"/,
    "release.mjs: the push-failure path no longer deletes the orphaned tag it created",
  );

  // Rollback must be its own try/catch so a delete failure can't mask the
  // original push error, and the original push-failure message must still
  // be logged (kept fatal, unchanged) before any rollback is attempted.
  const rollbackTryIdx = pushCatchBlock.indexOf("if (tagCreatedThisRun)");
  const beforeRollback = pushCatchBlock.slice(0, rollbackTryIdx);
  assert.match(beforeRollback, /git push failed/, "release.mjs: the original push-failure message must still be logged before rollback");
  const rollbackSection = pushCatchBlock.slice(rollbackTryIdx);
  assert.match(rollbackSection, /catch \(deleteErr\)/, "release.mjs: tag rollback must have its own catch so a delete failure can't mask the push error");
});

test("release.mjs pushes the commit and tag together with --follow-tags", () => {
  const fullSource = readFileSync(RELEASE_SCRIPT_PATH, "utf8");
  // Matched with a plain assertion (not requireAnchorOnce) because the
  // string legitimately appears more than once: the actual `execSync` call,
  // plus the top-of-file doc comment and the manual-recovery message in the
  // push failure branch, both of which intentionally echo the same command.
  assert.match(
    fullSource,
    /execSync\('git push origin main --follow-tags'/,
    "release.mjs no longer pushes with --follow-tags — the tag would never reach the remote",
  );
});

test("release.mjs publishes a GitHub Release only after a successful push, gated on `pushed`", () => {
  const fullSource = readFileSync(RELEASE_SCRIPT_PATH, "utf8");
  const ghBlockStart = fullSource.indexOf("if (pushed) {");
  assert.ok(ghBlockStart >= 0, "release.mjs: no `if (pushed) {` gate found ahead of the GitHub Release step");
  const ghCreateIdx = fullSource.indexOf("'release', 'create'", ghBlockStart);
  const sizeKbIdx = fullSource.indexOf("const sizeKb =", ghBlockStart);
  assert.ok(sizeKbIdx > ghBlockStart, "release.mjs: could not find the post-release-block anchor (`const sizeKb =`)");
  assert.ok(
    ghCreateIdx >= 0 && ghCreateIdx < sizeKbIdx,
    "release.mjs: `gh release create` must run inside the `if (pushed)` block",
  );
});

test("release.mjs's gh release create reuses the already-computed vsixPath, not a re-built filename", () => {
  const fullSource = readFileSync(RELEASE_SCRIPT_PATH, "utf8");
  const ghCallStart = fullSource.indexOf("'release', 'create', tagName, vsixPath");
  assert.ok(
    ghCallStart >= 0,
    "release.mjs: gh release create's argv no longer passes the vsixPath variable directly — " +
      "it must reuse the same path the script already computed for the .vsix, not re-build a filename string",
  );
});

test("release.mjs's GitHub Release step is best-effort: try/catch + console.warn, no process.exit in that block", () => {
  const fullSource = readFileSync(RELEASE_SCRIPT_PATH, "utf8");
  const ghBlockStart = fullSource.indexOf("if (pushed) {");
  const sizeKbIdx = fullSource.indexOf("const sizeKb =", ghBlockStart);
  assert.ok(ghBlockStart >= 0 && sizeKbIdx > ghBlockStart, "release.mjs: could not locate the GitHub Release block");
  const ghBlock = fullSource.slice(ghBlockStart, sizeKbIdx);
  assert.match(ghBlock, /console\.warn/, "release.mjs: GitHub Release failure path no longer warns");
  assert.doesNotMatch(
    ghBlock,
    /process\.exit/,
    "release.mjs: the GitHub Release step must never call process.exit — it is best-effort and must not fail the release",
  );
});

// ── 1. HTML sanity: balanced tags, unique ids, no duplicate step numbers ──

function countOccurrences(haystack: string, needle: RegExp): number {
  return (haystack.match(needle) ?? []).length;
}

function assertBalanced(content: string, file: string, tag: string): void {
  const openCount = countOccurrences(content, new RegExp(`<${tag}(?:[\\s>])`, "gi"));
  const closeCount = countOccurrences(content, new RegExp(`</${tag}\\s*>`, "gi"));
  assert.equal(
    openCount,
    closeCount,
    `${file}: unbalanced <${tag}> tags — ${openCount} open vs ${closeCount} close`,
  );
}

test("every media/handbook/*.html has balanced div/table/thead/tbody tags", () => {
  for (const file of listHandbookFiles()) {
    const content = readHandbookFile(file);
    for (const tag of ["div", "table", "thead", "tbody"]) {
      assertBalanced(content, file, tag);
    }
  }
});

test("every media/handbook/*.html has unique id attributes within the file", () => {
  const idRe = /\bid="([^"]*)"/g;
  for (const file of listHandbookFiles()) {
    const content = readHandbookFile(file);
    const ids = [...content.matchAll(idRe)].map((m) => m[1]);
    const unique = new Set(ids);
    assert.equal(
      unique.size,
      ids.length,
      `${file}: duplicate id attribute(s) found — ids: ${ids.join(", ")}`,
    );
  }
});

test("ch-10.html's step renumbering left no duplicate <span class=\"stepno\"> values", () => {
  const content = readHandbookFile("ch-10.html");
  const stepnoRe = /<span class="stepno">(\d+)<\/span>/g;
  const stepNumbers = [...content.matchAll(stepnoRe)].map((m) => m[1]);
  assert.ok(stepNumbers.length > 0, "ch-10.html: no <span class=\"stepno\"> markers found — structural marker changed");
  const unique = new Set(stepNumbers);
  assert.equal(
    unique.size,
    stepNumbers.length,
    `ch-10.html: duplicate step numbers found after renumbering — steps: ${stepNumbers.join(", ")}`,
  );
});

// ── 2. Content smoke: cheap, stable-string checks on the new sections ──

test("ch-04.html has the Rebirth section with a 6-row tier table (sparring at tier 6, huddles at tier 2)", () => {
  const content = readHandbookFile("ch-04.html");
  assert.match(content, /Rebirth/, "ch-04.html: missing a \"Rebirth\" heading");

  const sectionStart = content.indexOf("4.7");
  assert.ok(sectionStart >= 0, "ch-04.html: missing a \"4.7\" section marker for Rebirth");
  const tableStart = content.indexOf("<table>", sectionStart);
  assert.ok(tableStart >= 0, "ch-04.html: missing a <table> after the 4.7 Rebirth section head");
  const tableEnd = content.indexOf("</table>", tableStart);
  assert.ok(tableEnd >= 0, "ch-04.html: unterminated Rebirth tier table");
  const tierTable = content.slice(tableStart, tableEnd);

  const rowCount = countOccurrences(tierTable, /<tr>/gi) - 1; // minus the header row
  assert.equal(rowCount, 6, `ch-04.html: Rebirth tier table has ${rowCount} data rows, expected 6`);

  const tier2Row = /<tr><td>2<\/td>.*?<\/tr>/s.exec(tierTable);
  assert.ok(tier2Row, "ch-04.html: no tier-2 row found in Rebirth table");
  assert.match(tier2Row![0], /huddles/i, "ch-04.html: tier-2 row doesn't mention \"huddles\"");

  const tier6Row = /<tr><td>6<\/td>.*?<\/tr>/s.exec(tierTable);
  assert.ok(tier6Row, "ch-04.html: no tier-6 row found in Rebirth table");
  assert.match(tier6Row![0], /sparring/i, "ch-04.html: tier-6 row doesn't mention \"sparring\"");
});

test("ch-13.html mentions uefn_verse_check and epic-generated", () => {
  const content = readHandbookFile("ch-13.html");
  assert.match(content, /uefn_verse_check/, "ch-13.html: missing \"uefn_verse_check\"");
  assert.match(content, /epic-generated/, "ch-13.html: missing \"epic-generated\"");
});

test("ch-14.html mentions LongPathsEnabled", () => {
  const content = readHandbookFile("ch-14.html");
  assert.match(content, /LongPathsEnabled/, "ch-14.html: missing \"LongPathsEnabled\"");
});

test("ch-10.html mentions uefn-paths.json", () => {
  const content = readHandbookFile("ch-10.html");
  assert.match(content, /uefn-paths\.json/, "ch-10.html: missing \"uefn-paths.json\"");
});

test("index.html and ch-01.html frame standalone + Claude Code/Codex support within their first 60 lines", () => {
  for (const file of ["index.html", "ch-01.html"]) {
    const lines = readHandbookFile(file).split("\n").slice(0, 60).join("\n");
    assert.match(lines, /standalone/i, `${file}: first 60 lines don't mention "standalone"`);
    assert.match(lines, /Claude Code/i, `${file}: first 60 lines don't mention "Claude Code"`);
    assert.match(lines, /Codex/i, `${file}: first 60 lines don't mention "Codex"`);
    for (const m of lines.matchAll(/[^.\n]*OpenCode[^.\n]*/gi)) {
      assert.match(m[0], /coming soon/i, `${file}: OpenCode mentioned without "coming soon": ${m[0].trim()}`);
    }
  }
});

test("no media/handbook/*.html claims TycoonAgents bundles, installs, or ships with Power Tools", () => {
  const bannedRe = /bundled power tools|installs power tools|ships with power tools/i;
  for (const file of listHandbookFiles()) {
    const content = readHandbookFile(file);
    assert.doesNotMatch(
      content,
      bannedRe,
      `${file}: contains language implying TycoonAgents bundles/installs/ships Power Tools`,
    );
  }
});
