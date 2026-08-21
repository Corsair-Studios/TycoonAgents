/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Source-anchor coverage for the "Routing: our bridge vs. Epic's official
// UEFN MCP" section of media/skills/uefn-bridge/SKILL.md (~118-166).
//
// Tests ONLY the tracked copy under media/skills/uefn-bridge/SKILL.md.
// .claude/skills/uefn-bridge/SKILL.md is gitignored and does not exist on a
// fresh clone or in CI, so it is intentionally not read here.
//
// Lesson from two brittle-test incidents in this repo (a git stash/pop that
// converted the tree to CRLF, and unrelated line insertions): normalize
// newlines before asserting, and assert on the PRESENCE of substantive
// phrases only — never on line numbers, exact whitespace, or line counts.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const SKILL_PATH = path.join(ROOT, "media", "skills", "uefn-bridge", "SKILL.md");
const COMPARISON_DOC_PATH = path.join(ROOT, "docs", "UEFN-MCP-COMPARISON.md");

function readSkillSource(): string {
  const raw = fs.readFileSync(SKILL_PATH, "utf8");
  return raw.replace(/\r\n/g, "\n");
}

function assertContains(source: string, needle: string, label: string): void {
  assert.ok(
    source.includes(needle),
    `media/skills/uefn-bridge/SKILL.md routing section changed: could not find ${label} — ` +
      `expected to find: ${JSON.stringify(needle)}`,
  );
}

test("media/skills/uefn-bridge/SKILL.md exists and is readable", () => {
  assert.ok(fs.existsSync(SKILL_PATH), `expected file at ${SKILL_PATH}`);
  const source = readSkillSource();
  assert.ok(source.length > 0, "SKILL.md must not be empty");
});

test("routing section heading is present", () => {
  const source = readSkillSource();
  assertContains(
    source,
    "## Routing: `uefn-bridge` (ours) vs. `unreal-engine-mcp` (Epic's official server)",
    "the routing section heading",
  );
});

test("routing section heading names both server ids literally", () => {
  const source = readSkillSource();
  assertContains(source, "`uefn-bridge`", "the literal server id uefn-bridge");
  assertContains(source, "`unreal-engine-mcp`", "the literal server id unreal-engine-mcp");
});

test("classic-actor queries are routed to our bridge", () => {
  const source = readSkillSource();
  assertContains(source, "Classic actors in the level", "the classic-actors bullet lead-in");
  assertContains(
    source,
    "reads/queries/analysis at scale → ALWAYS\n  `uefn-bridge`.",
    "classic actors routed to our uefn-bridge server",
  );
});

test("moderation scanning is routed to uefn-bridge with no choice to present", () => {
  const source = readSkillSource();
  assertContains(
    source,
    "**Moderation scanning and reporting → ALWAYS `uefn-bridge`**",
    "moderation routed to uefn-bridge",
  );
  assertContains(
    source,
    "there is no choice\n  to present here.",
    "the no-choice-to-present statement for moderation routing",
  );
});

test("the never-ask rule is present", () => {
  const source = readSkillSource();
  assertContains(
    source,
    "never stop to ask the user which\nserver to use",
    "the never-ask-the-user-which-server rule",
  );
});

test("Scene Graph entities are routed to Epic's EntityToolset", () => {
  const source = readSkillSource();
  assertContains(source, "Scene Graph entities", "the Scene Graph entities bullet lead-in");
  assertContains(
    source,
    "`ValkyrieToolset.EntityToolset`",
    "Scene Graph entities routed to Epic's ValkyrieToolset.EntityToolset",
  );
});

test("authoring / write operations are routed to Epic, naming BuildAll and PushChanges", () => {
  const source = readSkillSource();
  assertContains(
    source,
    "**Authoring / write operations we do not implement → ALWAYS\n  `unreal-engine-mcp`.**",
    "the authoring/write-operations-to-Epic claim",
  );
  assertContains(source, "VerseToolset.BuildAll", "BuildAll named as an Epic-only authoring tool");
  assertContains(
    source,
    "SessionToolset.PushChanges",
    "PushChanges named as an Epic-only authoring tool",
  );
});

test("the short-tool-name gotcha is recorded", () => {
  const source = readSkillSource();
  assertContains(
    source,
    "`call_tool` takes the **short** tool name",
    "the short-tool-name gotcha for Epic's call_tool",
  );
  assertContains(source, '"Unknown tool"', "the Unknown tool failure mode for fully-qualified names");
});

test("the 44,753-actor evidence figure is present", () => {
  const source = readSkillSource();
  const occurrences = source.split("44,753").length - 1;
  assert.ok(
    occurrences > 0,
    "media/skills/uefn-bridge/SKILL.md routing section changed: the 44,753-actor evidence figure is missing — " +
      "this is the number that makes the routing rule persuasive rather than arbitrary",
  );
});

test("the routing section links to docs/UEFN-MCP-COMPARISON.md and that target exists on disk", () => {
  const source = readSkillSource();
  assertContains(
    source,
    "../../../docs/UEFN-MCP-COMPARISON.md",
    "the relative link to docs/UEFN-MCP-COMPARISON.md",
  );

  // Resolve the link the way a reader (or a renderer) would: relative to
  // the directory containing SKILL.md. If media/skills/uefn-bridge/SKILL.md
  // ever moves, this catches a dead cross-reference instead of letting it
  // silently rot.
  const resolvedTarget = path.resolve(
    path.dirname(SKILL_PATH),
    "../../../docs/UEFN-MCP-COMPARISON.md",
  );
  assert.equal(
    resolvedTarget,
    COMPARISON_DOC_PATH,
    "the relative link ../../../docs/UEFN-MCP-COMPARISON.md no longer resolves to docs/UEFN-MCP-COMPARISON.md " +
      "from media/skills/uefn-bridge/ — SKILL.md or the doc may have moved",
  );
  assert.ok(
    fs.existsSync(resolvedTarget),
    `dead cross-reference: docs/UEFN-MCP-COMPARISON.md does not exist at ${resolvedTarget}`,
  );
});
