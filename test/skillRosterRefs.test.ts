/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  REGULAR_AGENTS,
  LEAD_AGENTS,
  REVIEWER_AGENTS,
  FOREIGN_LLM_AGENTS,
} from "../src/host/vscode/packCatalog";

// Source of truth for the SHIPPED agent roster: src/host/vscode/packCatalog.ts's
// REGULAR_AGENTS / LEAD_AGENTS / REVIEWER_AGENTS / FOREIGN_LLM_AGENTS exports —
// the same catalog panel.ts's `_installAgentFiles`/`_installWorkerAgents` use to
// write `.claude/agents/<id>.md` on install (see test/panelAgentFileInstall.test.ts,
// which exercises the same catalog for the same purpose). This test derives the
// seeded id set from those exports at test time; it does NOT read this repo's own
// installed `.claude/agents/` or `AGENTS.md`, and does NOT hardcode the id list.
//
// Agents like `uefn-auditor`/`verse-expert` are seeded by a separate UEFN pack
// install (see packCatalog.ts's own comments around line 472-492), not by this
// catalog — they are intentionally NOT part of the seeded set here.

const repoRoot = path.resolve(__dirname, "..", "..");

function seededAgentIds(): Set<string> {
  const ids = new Set<string>();
  for (const list of [REGULAR_AGENTS, LEAD_AGENTS, REVIEWER_AGENTS, FOREIGN_LLM_AGENTS]) {
    for (const agent of list) ids.add(agent.id);
  }
  return ids;
}

/** Suffixes that mark a hyphenated token as a candidate agent-id reference. */
const AGENT_ID_SUFFIXES = [
  "-specialist",
  "-retrieval",
  "-designer",
  "-integration",
  "-monitor",
  "-reviewer",
  "-worker",
  "-auditor",
  "-expert",
  "-agent",
];

/** Roster-id-shaped tokens: lowercase words joined by hyphens. */
const ID_SHAPE_RE = /\b[a-z]+(?:-[a-z]+)+\b/g;

/**
 * Pure checker: given a list of {file, content} entries and the set of known
 * seeded agent ids, return every (file, token) pair referencing an id-shaped,
 * suffix-matching token that is NOT in the known set. No filesystem access.
 */
export interface FileContent {
  file: string;
  content: string;
}

export interface RosterViolation {
  file: string;
  id: string;
}

export function findUnknownAgentRefs(
  files: FileContent[],
  knownIds: Set<string>,
): RosterViolation[] {
  const violations: RosterViolation[] = [];
  for (const { file, content } of files) {
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    ID_SHAPE_RE.lastIndex = 0;
    while ((m = ID_SHAPE_RE.exec(content))) {
      const token = m[0];
      if (seen.has(token)) continue;
      const hasSuffix = AGENT_ID_SUFFIXES.some((sfx) => token.endsWith(sfx));
      if (!hasSuffix) continue;
      seen.add(token);
      if (!knownIds.has(token)) {
        violations.push({ file, id: token });
      }
    }
  }
  return violations;
}

export function findForbiddenPhrase(files: FileContent[]): string[] {
  const hits: string[] = [];
  for (const { file, content } of files) {
    if (content.includes("engine specialist agent")) hits.push(file);
  }
  return hits;
}

function collectShippedSkillAndCommandFiles(): FileContent[] {
  const files: FileContent[] = [];
  const skillsDir = path.join(repoRoot, "media", "skills");
  const commandsDir = path.join(repoRoot, "media", "commands");

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push({ file: path.relative(repoRoot, full), content: fs.readFileSync(full, "utf8") });
      }
    }
  }

  walk(skillsDir);
  walk(commandsDir);
  return files;
}

test("every agent-id-shaped reference in shipped skill/command markdown is in the seeded roster", () => {
  const knownIds = seededAgentIds();
  assert.ok(knownIds.size > 0, "packCatalog.ts must export at least one seeded agent id");

  const files = collectShippedSkillAndCommandFiles();
  assert.ok(files.length > 0, "expected to find shipped skill/command markdown files under media/");

  const violations = findUnknownAgentRefs(files, knownIds);
  if (violations.length > 0) {
    const summary = violations.map((v) => `${v.file}: ${v.id}`).join("\n");
    // Reported, not asserted-fatal for ids seeded by a separate UEFN pack
    // install (uefn-auditor, verse-expert) — those are legitimately outside
    // this catalog. Anything else here is a real drift and should fail.
    // "parallel-agent" (tycoon-ready-test/SKILL.md) is prose ("sonnet
    // parallel-agent limit"), not an id reference. "verse-auditor"
    // (tycoon-diagnose/SKILL.md:109) is an illustrative example of a WRONG
    // id inside prose documenting a naming-mismatch failure mode, not a
    // roster claim. Both are confirmed false positives of the suffix regex.
    const external = new Set(["uefn-auditor", "verse-expert", "parallel-agent", "verse-auditor"]);
    const real = violations.filter((v) => !external.has(v.id));
    assert.deepEqual(
      real,
      [],
      `Unknown agent id reference(s) not in the seeded roster (and not a known external UEFN-pack id):\n${summary}`,
    );
  }
});

test("no shipped skill/command markdown contains the phrase 'engine specialist agent'", () => {
  const files = collectShippedSkillAndCommandFiles();
  const hits = findForbiddenPhrase(files);
  assert.deepEqual(hits, [], `Forbidden phrase found in: ${hits.join(", ")}`);
});

test("findUnknownAgentRefs flags a phantom agent id (fixture)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillRosterRefs-"));
  try {
    const fixturePath = path.join(tmpDir, "SKILL.md");
    const content = "Delegate this to the `phantom-specialist` agent for review.\n";
    fs.writeFileSync(fixturePath, content, "utf8");

    const files: FileContent[] = [{ file: fixturePath, content: fs.readFileSync(fixturePath, "utf8") }];
    const knownIds = seededAgentIds();
    assert.ok(!knownIds.has("phantom-specialist"), "fixture id must not collide with a real seeded id");

    const violations = findUnknownAgentRefs(files, knownIds);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].id, "phantom-specialist");
    assert.equal(violations[0].file, fixturePath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
