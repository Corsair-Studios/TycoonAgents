/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Regression coverage for the SUGGESTED_MAX / roster-default contradiction
// (2026-08-17): media/main.js's SUGGESTED_MAX (~line 14476) used to list
// "testing-specialist": "haiku" as that agent's model floor, while
// packCatalog.ts's REGULAR_AGENTS roster (the source of truth for an
// agent's default model, and what CLAUDE.md's routing table also assigns)
// declares "testing-specialist" as "sonnet". Because recommendationFor()
// (media/main.js ~14512) suggests stepping DOWN to an agent's SUGGESTED_MAX
// floor whenever the configured model outranks it, the contradiction meant:
// a user explicitly picks Sonnet for testing-specialist (matching the
// roster's own default) and is immediately shown a "Could run on Haiku"
// recommendation with a button that reverts their pick back to Haiku. The
// write path was never broken -- the floor value was just wrong.
//
// Fix: testing-specialist was removed from SUGGESTED_MAX entirely. A second,
// identically-shaped contradiction was later found and fixed the same way
// (2026-08-17): "workspace-monitor" was floored at "haiku" in SUGGESTED_MAX
// while packCatalog.ts's roster (and CLAUDE.md's routing table) declared its
// default as "sonnet". Rather than lowering the roster to match, the
// resolution raised workspace-monitor.md's agent frontmatter to "sonnet" and
// removed its SUGGESTED_MAX entry outright, leaving "search-retrieval" (whose
// "haiku" floor matches its own "haiku" roster default) as the only surviving
// entry. This test cross-references the two sources directly so neither
// can drift back out of agreement without failing here:
//   1. SUGGESTED_MAX is extracted from the REAL media/main.js source text
//      via a targeted regex over its literal object body (main.js is a
//      plain untyped browser IIFE with no exported symbols -- see
//      test/resolveOrchestratorPrice.test.ts's header comment for why
//      source-text/vm techniques, not reimplementation, are this repo's
//      established pattern for covering that file).
//   2. REGULAR_AGENTS is imported directly from packCatalog.ts (a real
//      typed module, importable normally).
//   3. For every agent id present in BOTH, assert SUGGESTED_MAX's floor
//      does not outrank (require something cheaper than) the roster's
//      default model for that same agent -- the exact shape of the bug.
// A narrower, source-agnostic assertion is also included: testing-specialist
// must be absent from SUGGESTED_MAX outright, so even a change to how the
// object is authored (e.g. reordered/reformatted) still catches a
// regression that merely reintroduces that one entry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REGULAR_AGENTS } from "../src/host/vscode/packCatalog";

const MAIN_JS_PATH = join(process.cwd(), "media", "main.js");
const MODEL_RANK: Record<string, number> = { haiku: 0, sonnet: 1, opus: 2 };

/**
 * Extract the SUGGESTED_MAX object literal's key/value pairs from the real
 * media/main.js source text. Deliberately narrow (only matches simple
 * "id": "model" string-literal entries, which is the entire shape this
 * table has ever used) rather than a general JS object parser -- this test
 * exists to catch a reintroduced contradiction, not to validate JS syntax.
 */
function extractSuggestedMax(src: string): Record<string, string> {
  const start = src.indexOf("const SUGGESTED_MAX = {");
  assert.ok(start >= 0, "expected to find `const SUGGESTED_MAX = {` in media/main.js -- has it been renamed/restructured?");
  const end = src.indexOf("};", start);
  assert.ok(end > start, "expected a closing `};` for SUGGESTED_MAX in media/main.js");
  const body = src.slice(start, end);
  const out: Record<string, string> = {};
  const re = /["']([\w-]+)["']\s*:\s*["'](\w+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

test("SUGGESTED_MAX (media/main.js) never sets a floor below that agent's roster default model (packCatalog.ts)", () => {
  const src = readFileSync(MAIN_JS_PATH, "utf8");
  const suggestedMax = extractSuggestedMax(src);
  assert.ok(Object.keys(suggestedMax).length > 0, "SUGGESTED_MAX should not be empty (search-retrieval is expected to remain)");

  const rosterModelById = new Map(REGULAR_AGENTS.map((a) => [a.id, a.model]));

  for (const [agentId, floor] of Object.entries(suggestedMax)) {
    const rosterModel = rosterModelById.get(agentId);
    if (!rosterModel) continue; // agent id not in the static roster; nothing to cross-check
    const floorRank = MODEL_RANK[floor];
    const rosterRank = MODEL_RANK[rosterModel];
    assert.ok(
      floorRank !== undefined && rosterRank !== undefined,
      `unrecognized model name for agent "${agentId}": floor="${floor}", roster="${rosterModel}"`,
    );
    assert.ok(
      floorRank >= rosterRank,
      `SUGGESTED_MAX["${agentId}"] = "${floor}" contradicts packCatalog.ts's roster default "${rosterModel}" for the same agent -- ` +
        `a user who picks the roster's own default model would immediately see a "step down" recommendation reverting their choice.`,
    );
  }
});

test("SUGGESTED_MAX (media/main.js) does not contain a 'testing-specialist' entry (narrower, source-agnostic anchor)", () => {
  const src = readFileSync(MAIN_JS_PATH, "utf8");
  const suggestedMax = extractSuggestedMax(src);
  assert.ok(
    !("testing-specialist" in suggestedMax),
    `testing-specialist must not appear in SUGGESTED_MAX -- its roster default is "sonnet", so any floor here would contradict it. Found: "${suggestedMax["testing-specialist"]}"`,
  );
});

test("packCatalog.ts roster: testing-specialist's default model is 'sonnet' (pins the value the SUGGESTED_MAX fix depends on)", () => {
  const agent = REGULAR_AGENTS.find((a) => a.id === "testing-specialist");
  assert.ok(agent, "expected a testing-specialist entry in REGULAR_AGENTS");
  assert.equal(agent!.model, "sonnet", "testing-specialist's roster default must be sonnet, matching CLAUDE.md's routing table");
});
