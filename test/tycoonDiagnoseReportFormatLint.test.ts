/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for .claude/skills/tycoon-diagnose/checkReportFormat.mjs (p21-t8):
// the tycoon-diagnose skill's "missing ## Report Format section" lint.
// Read-only — asserts the scan never writes to the fixture files it reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPT_PATH = join(process.cwd(), ".claude", "skills", "tycoon-diagnose", "checkReportFormat.mjs");
const SCRIPT_URL = pathToFileURL(SCRIPT_PATH).href;

// .claude/ is blanket-gitignored (see .gitignore:45), so this shipped skill
// script (referenced as a CORE_SKILL_ID in src/host/vscode/panel.ts, same
// as the tracked .claude/skills/update-pricing/SKILL.md sibling) is absent
// on a clean clone/CI checkout until it is force-added with:
//   git add -f .claude/skills/tycoon-diagnose/SKILL.md .claude/skills/tycoon-diagnose/checkReportFormat.mjs
// Skip (not fail) in that environment rather than erroring on module
// resolution, so CI stays green until that force-add lands.
const SCRIPT_PRESENT = existsSync(SCRIPT_PATH);
const skipMsg = "checkReportFormat.mjs not present (.claude/ is gitignored) — run `git add -f " +
  ".claude/skills/tycoon-diagnose/SKILL.md .claude/skills/tycoon-diagnose/checkReportFormat.mjs` to ship it";

// This test file compiles to CommonJS; go through `new Function` so the
// dynamic `import()` of an ESM .mjs module isn't downleveled to `require`.
// (Same idiom as test/checkNoAbsolutePaths.test.ts.)
const dynamicImport = new Function("specifier", "return import(specifier);") as (
  specifier: string
) => Promise<{
  hasReportFormatSection: (content: string) => boolean;
  findAgentsMissingReportFormat: (agentsDir: string) => string[];
}>;

test("hasReportFormatSection detects a ## Report Format heading", async (t) => {
  if (!SCRIPT_PRESENT) return t.skip(skipMsg);
  const { hasReportFormatSection } = await dynamicImport(SCRIPT_URL);
  assert.equal(hasReportFormatSection("# Some Agent\n\n## Report Format\n\nUnder 250 words.\n"), true);
  assert.equal(hasReportFormatSection("# Some Agent\n\n## Other Section\n\nNo such heading here.\n"), false);
});

test("findAgentsMissingReportFormat lists a fixture agent lacking the section and not one with it", async (t) => {
  if (!SCRIPT_PRESENT) return t.skip(skipMsg);
  const { findAgentsMissingReportFormat } = await dynamicImport(SCRIPT_URL);
  const root = mkdtempSync(join(tmpdir(), "tycoon-diagnose-lint-"));
  const agentsDir = join(root, "agents");
  mkdirSync(agentsDir, { recursive: true });

  const withSection = "# has-format.md fixture\n\nSome intro text.\n\n## Report Format\n\nUnder 250 words, plain prose.\n";
  const withoutSection = "# missing-format.md fixture\n\nSome intro text.\n\n## Verification\n\nHow this agent verifies work.\n";

  writeFileSync(join(agentsDir, "has-format.md"), withSection, "utf8");
  writeFileSync(join(agentsDir, "missing-format.md"), withoutSection, "utf8");

  const beforeWith = readFileSync(join(agentsDir, "has-format.md"), "utf8");
  const beforeWithout = readFileSync(join(agentsDir, "missing-format.md"), "utf8");

  try {
    const missing = findAgentsMissingReportFormat(agentsDir);
    assert.deepEqual(missing, ["missing-format.md"], "must list only the fixture lacking the section");
    assert.ok(!missing.includes("has-format.md"), "must NOT list the fixture that has the section");

    // Read-only: the scan must not have modified either fixture file.
    assert.equal(readFileSync(join(agentsDir, "has-format.md"), "utf8"), beforeWith);
    assert.equal(readFileSync(join(agentsDir, "missing-format.md"), "utf8"), beforeWithout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findAgentsMissingReportFormat fails open (returns []) on a missing agents directory", async (t) => {
  if (!SCRIPT_PRESENT) return t.skip(skipMsg);
  const { findAgentsMissingReportFormat } = await dynamicImport(SCRIPT_URL);
  const missing = findAgentsMissingReportFormat(join(tmpdir(), "tycoon-diagnose-lint-does-not-exist"));
  assert.deepEqual(missing, []);
});
