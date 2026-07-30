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
 * Coverage for scripts/release.mjs's handbook crumb version-stamp loop
 * (~lines 83-112): CRUMB_VERSION_RE, the per-file stamp-and-fail-loud logic,
 * and the shipped media/handbook/*.html content that loop stamps.
 *
 * This is a pure-data suite: no vscode stub needed, nothing under test runs
 * at module scope with side effects. It works off the REAL files on disk —
 * package.json, scripts/release.mjs, and every media/handbook/*.html page —
 * not a reimplementation of any of them.
 */

const ROOT = process.cwd();
const PKG_PATH = join(ROOT, "package.json");
const RELEASE_SCRIPT_PATH = join(ROOT, "scripts", "release.mjs");
const HANDBOOK_DIR = join(ROOT, "media", "handbook");

function requireAnchorOnce(fullSource: string, label: string, needle: string): number {
  const idx = fullSource.indexOf(needle);
  assert.ok(idx >= 0, `scripts/release.mjs layout changed: could not find "${label}" anchor — update it in this test`);
  const count = fullSource.split(needle).length - 1;
  assert.equal(count, 1, `scripts/release.mjs layout changed: "${label}" anchor expected exactly once, found ${count}`);
  return idx;
}

function readPkgVersion(): string {
  const raw = readFileSync(PKG_PATH, "utf8");
  const match = /"version"\s*:\s*"(\d+\.\d+\.\d+)"/.exec(raw);
  assert.ok(match, "package.json: could not find a \"version\": \"x.y.z\" field");
  return match![1];
}

function listHandbookFiles(): string[] {
  const files = readdirSync(HANDBOOK_DIR).filter((f) => f.endsWith(".html"));
  assert.ok(files.length > 0, `no .html files found under ${HANDBOOK_DIR}`);
  return files;
}

function readHandbookFile(file: string): string {
  return readFileSync(join(HANDBOOK_DIR, file), "utf8");
}

// ── CRUMB_VERSION_RE extracted from the real release script, not hand-copied ──

const CRUMB_CONST_START = "const CRUMB_VERSION_RE = ";

function extractCrumbVersionRegex(): RegExp {
  const fullSource = readFileSync(RELEASE_SCRIPT_PATH, "utf8");
  const startIdx = requireAnchorOnce(fullSource, "CRUMB_CONST_START", CRUMB_CONST_START);
  const lineEndIdx = fullSource.indexOf(";", startIdx);
  assert.ok(lineEndIdx > startIdx, "could not find end of CRUMB_VERSION_RE declaration — release.mjs layout changed");
  const literalText = fullSource.slice(startIdx + CRUMB_CONST_START.length, lineEndIdx).trim();
  assert.ok(
    literalText.startsWith("/") && literalText.lastIndexOf("/") > 0,
    `CRUMB_VERSION_RE literal doesn't look like a regex literal: ${literalText}`,
  );
  // Evaluate the REAL literal text pulled from the source (not an
  // independently hand-copied pattern in this test) so a future edit to the
  // regex in release.mjs is exercised here automatically.
  // eslint-disable-next-line no-eval
  const regex = (0, eval)(literalText);
  assert.ok(regex instanceof RegExp, "extracted CRUMB_VERSION_RE literal did not evaluate to a RegExp");
  return regex as RegExp;
}

test("CRUMB_VERSION_RE extracted from scripts/release.mjs is a usable RegExp", () => {
  const regex = extractCrumbVersionRegex();
  assert.ok(regex.source.length > 0);
});

// ── 1. Stamp parity: every handbook file's crumb equals v<package.json version> ──

test("every media/handbook/*.html has exactly one crumb version stamp", () => {
  const pkgVersion = readPkgVersion();
  const stampRe = /<(?:div|p) class="crumb">[^<]*?v(\d+\.\d+\.\d+)/g;
  for (const file of listHandbookFiles()) {
    const content = readHandbookFile(file);
    const matches = [...content.matchAll(stampRe)];
    assert.equal(
      matches.length,
      1,
      `${file}: expected exactly one class="crumb" ... vX.Y.Z stamp, found ${matches.length}`,
    );
    assert.equal(
      matches[0][1],
      pkgVersion,
      `${file}: crumb stamp is v${matches[0][1]} but package.json version is ${pkgVersion} — release stamping drifted`,
    );
  }
});

// ── 2. Release-regex coverage: the real CRUMB_VERSION_RE matches every file ──

test("release.mjs CRUMB_VERSION_RE matches at least once in every handbook file (hard-fail can't trigger on current tree)", () => {
  for (const file of listHandbookFiles()) {
    const content = readHandbookFile(file);
    const regex = extractCrumbVersionRegex();
    const globalRegex = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
    const matches = [...content.matchAll(globalRegex)];
    assert.ok(
      matches.length >= 1,
      `${file}: CRUMB_VERSION_RE (from scripts/release.mjs) found 0 matches — a release would process.exit(1) on this file`,
    );
  }
});

// ── 3. HTML sanity: balanced tags, unique ids, no duplicate step numbers ──

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

test("ch-09.html's step renumbering left no duplicate <span class=\"stepno\"> values", () => {
  const content = readHandbookFile("ch-09.html");
  const stepnoRe = /<span class="stepno">(\d+)<\/span>/g;
  const stepNumbers = [...content.matchAll(stepnoRe)].map((m) => m[1]);
  assert.ok(stepNumbers.length > 0, "ch-09.html: no <span class=\"stepno\"> markers found — structural marker changed");
  const unique = new Set(stepNumbers);
  assert.equal(
    unique.size,
    stepNumbers.length,
    `ch-09.html: duplicate step numbers found after renumbering — steps: ${stepNumbers.join(", ")}`,
  );
});

// ── 4. Content smoke: cheap, stable-string checks on the new sections ──

test("ch-03.html has the Rebirth section with a 6-row tier table (sparring at tier 6, huddles at tier 2)", () => {
  const content = readHandbookFile("ch-03.html");
  assert.match(content, /Rebirth/, "ch-03.html: missing a \"Rebirth\" heading");

  const sectionStart = content.indexOf("3.7");
  assert.ok(sectionStart >= 0, "ch-03.html: missing a \"3.7\" section marker for Rebirth");
  const tableStart = content.indexOf("<table>", sectionStart);
  assert.ok(tableStart >= 0, "ch-03.html: missing a <table> after the 3.7 Rebirth section head");
  const tableEnd = content.indexOf("</table>", tableStart);
  assert.ok(tableEnd >= 0, "ch-03.html: unterminated Rebirth tier table");
  const tierTable = content.slice(tableStart, tableEnd);

  const rowCount = countOccurrences(tierTable, /<tr>/gi) - 1; // minus the header row
  assert.equal(rowCount, 6, `ch-03.html: Rebirth tier table has ${rowCount} data rows, expected 6`);

  const tier2Row = /<tr><td>2<\/td>.*?<\/tr>/s.exec(tierTable);
  assert.ok(tier2Row, "ch-03.html: no tier-2 row found in Rebirth table");
  assert.match(tier2Row![0], /huddles/i, "ch-03.html: tier-2 row doesn't mention \"huddles\"");

  const tier6Row = /<tr><td>6<\/td>.*?<\/tr>/s.exec(tierTable);
  assert.ok(tier6Row, "ch-03.html: no tier-6 row found in Rebirth table");
  assert.match(tier6Row![0], /sparring/i, "ch-03.html: tier-6 row doesn't mention \"sparring\"");
});

test("ch-12.html mentions uefn_verse_check and epic-generated", () => {
  const content = readHandbookFile("ch-12.html");
  assert.match(content, /uefn_verse_check/, "ch-12.html: missing \"uefn_verse_check\"");
  assert.match(content, /epic-generated/, "ch-12.html: missing \"epic-generated\"");
});

test("ch-13.html mentions LongPathsEnabled", () => {
  const content = readHandbookFile("ch-13.html");
  assert.match(content, /LongPathsEnabled/, "ch-13.html: missing \"LongPathsEnabled\"");
});

test("ch-09.html mentions uefn-paths.json", () => {
  const content = readHandbookFile("ch-09.html");
  assert.match(content, /uefn-paths\.json/, "ch-09.html: missing \"uefn-paths.json\"");
});
