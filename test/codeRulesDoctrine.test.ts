/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CODE_RULES_SECTION_START,
  CODE_RULES_SECTION_END,
  renderCodeRules,
  upsertCodeRulesSection,
} from "../src/host/vscode/codeRulesDoctrine";
import {
  DELEGATION_SECTION_START,
  DELEGATION_SECTION_END,
  upsertDelegationSection,
} from "../src/host/vscode/delegationDoctrine";

// ---------------------------------------------------------------------------
// renderCodeRules
// ---------------------------------------------------------------------------

test("renderCodeRules returns a non-empty string with the expected heading and a markdown table", () => {
  const out = renderCodeRules();
  assert.ok(out.length > 0, "must be non-empty");
  assert.ok(out.includes("## Coding standards by path"), "must contain the expected H2 heading");
  assert.ok(/\|.*\|.*\|/.test(out), "must contain a markdown table row");
  assert.ok(out.includes("| Area | Path patterns | Standards |"), "must contain the table header row");
});

test("renderCodeRules() defaults to the generic web/TS table (uefn param omitted)", () => {
  const out = renderCodeRules();
  assert.ok(out.includes("Gameplay / systems logic"), "generic table must include the Gameplay/systems row");
  assert.ok(out.includes("UI / HUD"), "generic table must include the UI/HUD row");
  assert.ok(out.includes("package.json"), "generic table must reference package.json");
});

// ---------------------------------------------------------------------------
// renderCodeRules(uefn): UEFN/Verse-aware table
// ---------------------------------------------------------------------------

test("renderCodeRules(true) keeps the Engine scripts (Verse) row", () => {
  const out = renderCodeRules(true);
  assert.ok(
    out.includes("Engine scripts (GDScript / C# / Verse / Python)"),
    "UEFN table must keep the existing Engine scripts row"
  );
  assert.ok(out.includes("`**/*.verse`"), "UEFN table must keep the Verse glob");
});

test("renderCodeRules(true) omits the web-only rows (Gameplay/systems, UI/HUD, package.json/tsconfig)", () => {
  const out = renderCodeRules(true);
  assert.equal(out.includes("Gameplay / systems logic"), false, "must drop the Gameplay/systems-logic row");
  assert.equal(out.includes("UI / HUD"), false, "must drop the UI/HUD row");
  assert.equal(out.includes("`**/*.tsx`"), false, "must drop the .tsx glob");
  assert.equal(out.includes("`**/*.css`"), false, "must drop the .css glob");
  assert.equal(out.includes("package.json"), false, "must drop the package.json pattern");
  assert.equal(out.includes("tsconfig*.json"), false, "must drop the tsconfig*.json pattern");
});

test("renderCodeRules(true) keeps genuinely relevant rows: Tests, Assets/data, Config", () => {
  const out = renderCodeRules(true);
  assert.ok(out.includes("Tests"), "must keep the Tests row");
  assert.ok(out.includes("Assets / data"), "must keep the Assets/data row");
  assert.ok(out.includes("Config / build"), "must keep a Config/build row");
});

test("renderCodeRules(false) is identical to renderCodeRules() with no args", () => {
  assert.equal(renderCodeRules(false), renderCodeRules());
});

// ---------------------------------------------------------------------------
// upsertCodeRulesSection
// ---------------------------------------------------------------------------

test("upsertCodeRulesSection: null existing content produces a minimal new file with markers", () => {
  const out = upsertCodeRulesSection(null, "Body text.");
  assert.ok(out.includes(CODE_RULES_SECTION_START), "must contain start marker");
  assert.ok(out.includes(CODE_RULES_SECTION_END), "must contain end marker");
  assert.ok(out.includes("Body text."), "must contain the section body");
  assert.ok(out.startsWith("# "), "should start with a heading for a fresh file");
  assert.ok(
    out.indexOf(CODE_RULES_SECTION_START) < out.indexOf(CODE_RULES_SECTION_END),
    "start marker must precede end marker"
  );
});

test("upsertCodeRulesSection: empty string existing content also produces a minimal new file", () => {
  const out = upsertCodeRulesSection("", "Body text.");
  assert.ok(out.includes(CODE_RULES_SECTION_START));
  assert.ok(out.includes("Body text."));
});

test("upsertCodeRulesSection: existing markers with surrounding user text replaces only the span", () => {
  const existing =
    "# My Project\n\n" +
    "Some user text before.\n\n" +
    `${CODE_RULES_SECTION_START}\nOLD BODY\n${CODE_RULES_SECTION_END}\n\n` +
    "Some user text after.\n";
  const out = upsertCodeRulesSection(existing, "NEW BODY");

  assert.ok(out.startsWith("# My Project\n\nSome user text before.\n\n"), "content before the markers must be preserved");
  assert.ok(out.endsWith("\n\nSome user text after.\n"), "content after the markers must be preserved");
  assert.ok(out.includes("NEW BODY"), "new body must be present");
  assert.ok(!out.includes("OLD BODY"), "old body must be gone");
  assert.equal(
    (out.match(new RegExp(CODE_RULES_SECTION_START.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&"), "g")) ?? []).length,
    1,
    "exactly one start marker must remain"
  );
});

test("upsertCodeRulesSection: running twice with the same body is idempotent (identical output)", () => {
  const existing =
    "# My Project\n\n" +
    `${CODE_RULES_SECTION_START}\nOLD BODY\n${CODE_RULES_SECTION_END}\n`;
  const once = upsertCodeRulesSection(existing, "NEW BODY");
  const twice = upsertCodeRulesSection(once, "NEW BODY");
  assert.equal(twice, once, "applying the same body twice must be a no-op after the first application");
});

test("upsertCodeRulesSection: changing the body on a second call updates only that span", () => {
  const existing =
    "# My Project\n\n" +
    "Preface.\n\n" +
    `${CODE_RULES_SECTION_START}\nFIRST BODY\n${CODE_RULES_SECTION_END}\n\n` +
    "Trailer.\n";
  const out = upsertCodeRulesSection(existing, "SECOND BODY");
  assert.ok(out.includes("SECOND BODY"));
  assert.ok(!out.includes("FIRST BODY"));
  assert.ok(out.includes("Preface."), "content before the section must be untouched");
  assert.ok(out.includes("Trailer."), "content after the section must be untouched");
});

test("upsertCodeRulesSection: existing content with no markers is preserved byte-for-byte, section appended", () => {
  const existing = "# My Project\n\nSome user-written instructions.\nMore lines here.\n";
  const out = upsertCodeRulesSection(existing, "New section body.");
  assert.ok(out.startsWith(existing), "original content must be preserved byte-for-byte at the start");
  const appended = out.slice(existing.length);
  assert.ok(appended.includes(CODE_RULES_SECTION_START));
  assert.ok(appended.includes(CODE_RULES_SECTION_END));
  assert.ok(appended.includes("New section body."));
  assert.equal(
    (out.match(new RegExp(CODE_RULES_SECTION_START.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&"), "g")) ?? []).length,
    1,
    "exactly one start marker must be present"
  );
});

test("upsertCodeRulesSection coexists with an existing tycoon:delegation section: delegation section preserved, coderules section added", () => {
  const base = upsertDelegationSection(null, "Delegation body.");
  const out = upsertCodeRulesSection(base, "Code rules body.");

  // Delegation section untouched.
  assert.ok(out.includes(DELEGATION_SECTION_START), "delegation start marker must remain");
  assert.ok(out.includes(DELEGATION_SECTION_END), "delegation end marker must remain");
  assert.ok(out.includes("Delegation body."), "delegation body must remain untouched");

  // Coderules section added.
  assert.ok(out.includes(CODE_RULES_SECTION_START), "coderules start marker must be present");
  assert.ok(out.includes(CODE_RULES_SECTION_END), "coderules end marker must be present");
  assert.ok(out.includes("Code rules body."), "coderules body must be present");

  // Exactly one of each marker pair.
  const escape = (s: string) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
  assert.equal((out.match(new RegExp(escape(DELEGATION_SECTION_START), "g")) ?? []).length, 1);
  assert.equal((out.match(new RegExp(escape(DELEGATION_SECTION_END), "g")) ?? []).length, 1);
  assert.equal((out.match(new RegExp(escape(CODE_RULES_SECTION_START), "g")) ?? []).length, 1);
  assert.equal((out.match(new RegExp(escape(CODE_RULES_SECTION_END), "g")) ?? []).length, 1);
});

test("upsertCodeRulesSection is idempotent: upsert(upsert(x)) === upsert(x)", () => {
  const existing = "# My Project\n\nUser text.\n";
  const once = upsertCodeRulesSection(existing, "Section body.");
  const twice = upsertCodeRulesSection(once, "Section body.");
  assert.equal(twice, once, "applying twice with the same body must be a no-op after the first application");

  // Also idempotent starting from null.
  const first = upsertCodeRulesSection(null, "Section body.");
  const second = upsertCodeRulesSection(first, "Section body.");
  assert.equal(second, first);

  // Also idempotent using the module's own rendered body.
  const rendered = renderCodeRules();
  const a = upsertCodeRulesSection(null, rendered);
  const b = upsertCodeRulesSection(a, rendered);
  assert.equal(b, a);
});
