/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p21-t8: deterministic aid for the tycoon-diagnose skill's "missing
// ## Report Format section" lint (see SKILL.md Step 2). Read-only — this
// module never writes to any agent file, it only reports which ones lack
// the section so the skill's Markdown report can list them by name.
//
// Exported for testing (see test/tycoonDiagnoseReportFormatLint.test.ts);
// the disk-walking main() below only runs when this file is executed
// directly, mirroring scripts/check-no-absolute-paths.mjs's same guard.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Matches a "## Report Format" heading (any heading level 1-6, case-insensitive,
// tolerant of surrounding whitespace) anywhere in the file.
const REPORT_FORMAT_HEADING = /^#{1,6}\s+report format\s*$/im;

/**
 * Returns true iff `content` (an agent .md file's full text) contains a
 * "## Report Format" section heading.
 */
export function hasReportFormatSection(content) {
  return REPORT_FORMAT_HEADING.test(content);
}

/**
 * Scans every `*.md` file directly under `agentsDir` and returns the
 * filenames (not full paths) of those missing a Report Format section.
 * Read-only: never modifies any file. Fails open (returns []) if the
 * directory doesn't exist or can't be read — the skill's broader Step 2
 * enumeration already handles reporting a missing/unreadable agents dir.
 */
export function findAgentsMissingReportFormat(agentsDir) {
  let entries;
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return [];
  }
  const missing = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    let content;
    try {
      content = readFileSync(join(agentsDir, entry), "utf8");
    } catch {
      continue; // unreadable file — skip, don't fail the whole scan
    }
    if (!hasReportFormatSection(content)) missing.push(entry);
  }
  return missing.sort();
}

// Guard: only run the disk-walking CLI path when executed directly, so
// `import` (as the test file does) never triggers filesystem side effects
// beyond the pure functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const agentsDir = join(process.cwd(), ".claude", "agents");
  const missing = findAgentsMissingReportFormat(agentsDir);
  if (missing.length === 0) {
    console.log("All agent files have a ## Report Format section.");
  } else {
    console.log("Agent files missing a ## Report Format section:");
    for (const name of missing) console.log(`  - ${name}`);
  }
}
