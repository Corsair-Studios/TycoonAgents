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
  DELEGATION_MODES,
  DELEGATION_SECTION_START,
  DELEGATION_SECTION_END,
  renderDelegationDoctrine,
  upsertDelegationSection,
  readExecutionConfig,
  writeExecutionConfig,
  type DoctrineRosterAgent,
} from "../src/host/vscode/delegationDoctrine";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "delegationDoctrine-"));
}

// ---------------------------------------------------------------------------
// upsertDelegationSection
// ---------------------------------------------------------------------------

test("upsertDelegationSection: null existing content produces a minimal new file with markers", () => {
  const out = upsertDelegationSection(null, "Body text.");
  assert.ok(out.includes(DELEGATION_SECTION_START), "must contain start marker");
  assert.ok(out.includes(DELEGATION_SECTION_END), "must contain end marker");
  assert.ok(out.includes("Body text."), "must contain the section body");
  assert.ok(out.startsWith("# "), "should start with a heading for a fresh file");
});

test("upsertDelegationSection: empty string existing content also produces a minimal new file", () => {
  const out = upsertDelegationSection("", "Body text.");
  assert.ok(out.includes(DELEGATION_SECTION_START));
  assert.ok(out.includes("Body text."));
});

test("upsertDelegationSection: existing content with no markers is preserved byte-for-byte, section appended", () => {
  const existing = "# My Project\n\nSome user-written instructions.\nMore lines here.\n";
  const out = upsertDelegationSection(existing, "New section body.");
  assert.ok(out.startsWith(existing), "original content must be preserved byte-for-byte at the start");
  const appended = out.slice(existing.length);
  assert.ok(appended.includes(DELEGATION_SECTION_START));
  assert.ok(appended.includes(DELEGATION_SECTION_END));
  assert.ok(appended.includes("New section body."));
});

test("upsertDelegationSection: existing markers with surrounding user text replaces only the span", () => {
  const existing =
    "# My Project\n\n" +
    "Some user text before.\n\n" +
    `${DELEGATION_SECTION_START}\nOLD BODY\n${DELEGATION_SECTION_END}\n\n` +
    "Some user text after.\n";
  const out = upsertDelegationSection(existing, "NEW BODY");

  assert.ok(out.startsWith("# My Project\n\nSome user text before.\n\n"), "content before the markers must be preserved");
  assert.ok(out.endsWith("\n\nSome user text after.\n"), "content after the markers must be preserved");
  assert.ok(out.includes("NEW BODY"), "new body must be present");
  assert.ok(!out.includes("OLD BODY"), "old body must be gone");
  assert.equal(
    (out.match(new RegExp(DELEGATION_SECTION_START.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&"), "g")) ?? []).length,
    1,
    "exactly one start marker must remain"
  );
});

test("upsertDelegationSection is idempotent", () => {
  const existing = "# My Project\n\nUser text.\n";
  const once = upsertDelegationSection(existing, "Section body.");
  const twice = upsertDelegationSection(once, "Section body.");
  assert.equal(twice, once, "applying twice with the same body must be a no-op after the first application");

  // Also idempotent starting from null.
  const first = upsertDelegationSection(null, "Section body.");
  const second = upsertDelegationSection(first, "Section body.");
  assert.equal(second, first);
});

// ---------------------------------------------------------------------------
// renderDelegationDoctrine
// ---------------------------------------------------------------------------

test("renderDelegationDoctrine('team_leads') mentions lead names, the depth rule, and docs/plan", () => {
  const out = renderDelegationDoctrine("team_leads");
  assert.ok(out.includes("build-lead"), "must mention build-lead");
  assert.ok(out.includes("quality-lead"), "must mention quality-lead");
  assert.ok(/orchestrator.*(->|→).*(lead).*(->|→).*worker/i.test(out.replace(/\n/g, " ")), "must state the depth rule (orchestrator -> lead -> worker)");
  assert.ok(out.includes("docs/plan"), "must reference docs/plan as where contracts/specs live");
});

test("renderDelegationDoctrine('flat') does not mention leads", () => {
  const out = renderDelegationDoctrine("flat", false);
  assert.equal(/lead/i.test(out), false, "flat mode output must not mention leads at all");
});

test("DELEGATION_MODES contains exactly flat and team_leads (enum unchanged by the Direct rename)", () => {
  assert.deepEqual([...DELEGATION_MODES], ["flat", "team_leads"]);
});

test("renderDelegationDoctrine always includes the verify-on-disk section, with or without the review gate", () => {
  for (const reviewEnabled of [true, false]) {
    const out = renderDelegationDoctrine("flat", reviewEnabled);
    assert.ok(out.includes("is not proof"), "verify-on-disk section present");
    assert.ok(out.includes("re-reads a file from disk"), "re-read-before-trust guidance present");
    assert.ok(out.includes("DISJOINT"), "disjoint file-ownership guidance present");
  }
});

test("renderDelegationDoctrine caps the review fan-out when the review gate is enabled", () => {
  const withReview = renderDelegationDoctrine("flat", true);
  assert.ok(withReview.includes("not a fan-out"), "review-cap phrasing present");
  assert.ok(withReview.includes("do not spawn further sub-agents"), "no-nested-spawn guidance present");
  const noReview = renderDelegationDoctrine("flat", false);
  assert.ok(!noReview.includes("not a fan-out"), "review-cap text only appears with the review gate");
});

// ---------------------------------------------------------------------------
// renderDelegationDoctrine: hard "MUST NOT explore/edit yourself" mandate +
// review-vs-explore disambiguation (shared PREAMBLE, so present in both modes)
// ---------------------------------------------------------------------------

test("renderDelegationDoctrine states the MUST-NOT-explore-yourself mandate and the ~40x cost line, for both modes", () => {
  for (const mode of DELEGATION_MODES) {
    const out = renderDelegationDoctrine(mode, false).replace(/\s+/g, " ");
    assert.ok(out.includes("What you MUST NOT do yourself"), `mode=${mode} must include the MUST-NOT heading`);
    assert.ok(/search-retrieval agent/i.test(out), `mode=${mode} must route exploration to search-retrieval`);
    assert.ok(/40x the cost/i.test(out), `mode=${mode} must state the ~40x expensive-model cost`);
    assert.ok(
      /even when the final deliverable is only documentation or markdown/i.test(out),
      `mode=${mode} must cover doc-only deliverables explicitly`
    );
  }
});

test("renderDelegationDoctrine disambiguates 'reviewing your team's results' from exploring the codebase yourself, for both modes", () => {
  for (const mode of DELEGATION_MODES) {
    const out = renderDelegationDoctrine(mode, false).replace(/\s+/g, " ");
    assert.ok(
      /reviewing your team's results/i.test(out),
      `mode=${mode} must define "reviewing your team's results"`
    );
    assert.ok(
      /does not mean exploring or reading the codebase yourself/i.test(out),
      `mode=${mode} must explicitly rule out self-exploration as "review"`
    );
    assert.ok(
      /describe, document, review, or audit a project/i.test(out),
      `mode=${mode} must call out describe/document/review/audit as delegation-first`
    );
  }
});

// ---------------------------------------------------------------------------
// renderDelegationDoctrine: "flat" renders as "Direct" (display-only rename;
// the enum string stays "flat" — existing execution.json files are untouched)
// ---------------------------------------------------------------------------

test("renderDelegationDoctrine('flat') renders the 'Direct delegation' heading, not 'Flat delegation'", () => {
  const out = renderDelegationDoctrine("flat", false);
  assert.ok(out.includes("## Direct delegation (current mode)"), "must render the renamed Direct heading");
  assert.equal(/flat delegation/i.test(out), false, "must not render the old 'Flat delegation' heading text");
});

test("renderDelegationDoctrine('team_leads') references Direct mode, not Flat mode, in its fallback framing", () => {
  const out = renderDelegationDoctrine("team_leads", false);
  assert.ok(/stays? direct/i.test(out), "must reference 'stay(s) Direct' instead of 'stay(s) Flat'");
  assert.equal(/\bflat\b/i.test(out), false, "must not use the word 'Flat' as a display label anywhere");
});

// ---------------------------------------------------------------------------
// renderDelegationDoctrine: optional Review pass section (composes with
// either base mode; on by default)
// ---------------------------------------------------------------------------

test("renderDelegationDoctrine defaults reviewEnabled to true (2nd arg omitted) and includes the Review pass section", () => {
  const out = renderDelegationDoctrine("flat");
  assert.ok(out.includes("## Review pass (enabled)"), "review section must be present by default");
  // DEFAULT_ROSTER_ROWS (the bare-install fallback) has neither `reviewer`
  // nor `uefn-auditor` (both are deliberately excluded from the Specialist
  // roster table), so the section must fall back to the generic phrase
  // rather than hardcoding an agent id absent from the roster.
  assert.ok(
    out.includes("the review agent"),
    "must fall back to the generic review-agent phrase when neither reviewer nor uefn-auditor is in the roster"
  );
});

test("renderDelegationDoctrine(mode, true) includes the Review pass section for both base modes", () => {
  for (const mode of DELEGATION_MODES) {
    const out = renderDelegationDoctrine(mode, true);
    assert.ok(out.includes("## Review pass (enabled)"), `review section must be present for mode=${mode}`);
  }
});

test("renderDelegationDoctrine(mode, false) omits the Review pass section for both base modes", () => {
  for (const mode of DELEGATION_MODES) {
    const out = renderDelegationDoctrine(mode, false);
    assert.equal(out.includes("## Review pass"), false, `review section must be absent for mode=${mode}`);
  }
});

test("the Review pass section describes a single review gate, not an unbounded loop", () => {
  const out = renderDelegationDoctrine("flat", true);
  assert.ok(/single review gate/i.test(out), "must state it is a single gate");
  assert.ok(/not an open-ended loop|not.*unbounded/i.test(out), "must explicitly rule out an unbounded loop");
});

// ---------------------------------------------------------------------------
// renderDelegationDoctrine: roster-accurate Review-pass agent naming (mirrors
// resolveEditId's coding-specialist/verse-expert pattern for the review
// agent: `reviewer` on a normal roster, `uefn-auditor` on a UEFN-shaped
// roster, a generic phrase when neither is installed). Every case must also
// preserve the HUMAN "the user is the final reviewer" phrase untouched.
// ---------------------------------------------------------------------------

test("Review pass section names uefn-auditor (not a 'reviewer' agent) on a UEFN-shaped roster, and preserves the human 'final reviewer' phrase", () => {
  const uefnRoster: DoctrineRosterAgent[] = [
    { id: "verse-expert", taskTypes: "Verse device implementation" },
    { id: "uefn-auditor", taskTypes: "Verse audit, lint" },
    { id: "search-retrieval", taskTypes: "File searching, code lookup, grep/glob" },
  ];
  const out = renderDelegationDoctrine("flat", true, uefnRoster);
  assert.ok(out.includes("uefn-auditor"), "review section must name uefn-auditor on a UEFN roster");

  // "The user is the final reviewer" legitimately contains the substring
  // "reviewer" (it refers to the HUMAN) -> strip that exact phrase out
  // before asserting no "reviewer" AGENT reference remains.
  const withoutHumanPhrase = out.replace(/The user is the final reviewer/i, "");
  assert.equal(
    /\breviewer\b/i.test(withoutHumanPhrase),
    false,
    "must not name a 'reviewer' agent when only uefn-auditor is installed"
  );
  assert.ok(/the user is the final reviewer/i.test(out), "the human 'final reviewer' phrase must survive untouched");
});

// NOTE: in PRODUCTION, panel.ts's `_buildDoctrineRoster` deliberately
// excludes `tier: "reviewer"` rows (see its doc comment) — so `reviewer`
// NEVER appears in `rosterAgents` even when reviewer.md is installed on a
// non-UEFN project. A test that puts a synthetic `{ id: "reviewer" }` row
// into `rosterAgents` and expects it to be named exercises a roster shape
// production can never produce, and would mask the real regression (see
// panel.ts's `_resolveReviewAgentId`, which reads the FULL installed agent
// set — before that tier exclusion — and is threaded through as
// `renderDelegationDoctrine`'s explicit `reviewAgentId` argument below).

test("Review pass section names reviewer via the explicit reviewAgentId argument (production path: reviewer installed on a non-UEFN project), and preserves the human 'final reviewer' phrase", () => {
  const roster: DoctrineRosterAgent[] = [
    { id: "coding-specialist", taskTypes: "Implementation, editing, bug fixes, refactoring" },
    { id: "search-retrieval", taskTypes: "File searching, code lookup, grep/glob" },
  ];
  const out = renderDelegationDoctrine("flat", true, roster, "reviewer");
  assert.ok(/the `reviewer` agent/i.test(out), "review section must name reviewer when reviewAgentId='reviewer'");
  assert.ok(/the user is the final reviewer/i.test(out), "the human 'final reviewer' phrase must survive untouched");
});

test("Review pass section names uefn-auditor via the explicit reviewAgentId argument (production path: UEFN project), and preserves the human 'final reviewer' phrase", () => {
  const roster: DoctrineRosterAgent[] = [
    { id: "verse-expert", taskTypes: "Verse device implementation" },
    { id: "search-retrieval", taskTypes: "File searching, code lookup, grep/glob" },
  ];
  const out = renderDelegationDoctrine("flat", true, roster, "uefn-auditor");
  assert.ok(/the `uefn-auditor` agent/i.test(out), "review section must name uefn-auditor when reviewAgentId='uefn-auditor'");
  assert.ok(/the user is the final reviewer/i.test(out), "the human 'final reviewer' phrase must survive untouched");
});

test("Review pass section falls back to a generic phrase (never a dangling id) when reviewAgentId is omitted and rosterAgents has neither reviewer nor uefn-auditor", () => {
  const roster: DoctrineRosterAgent[] = [
    { id: "coding-specialist", taskTypes: "Implementation, editing, bug fixes, refactoring" },
    { id: "search-retrieval", taskTypes: "File searching, code lookup, grep/glob" },
  ];
  const out = renderDelegationDoctrine("flat", true, roster);
  assert.ok(out.includes("the review agent"), "must fall back to the generic phrase");
  assert.equal(
    /`reviewer`|`uefn-auditor`/i.test(out),
    false,
    "must not name an agent id absent from the roster"
  );
  assert.ok(/the user is the final reviewer/i.test(out), "the human 'final reviewer' phrase must survive untouched");
});

test("Review pass section: an explicit reviewAgentId wins over resolveReviewId's own rosterAgents-based guess", () => {
  // rosterAgents alone would resolve to uefn-auditor (present in rows), but
  // the caller's direct reviewAgentId ("reviewer") must take priority.
  const roster: DoctrineRosterAgent[] = [{ id: "uefn-auditor", taskTypes: "Verse audit, lint" }];
  const out = renderDelegationDoctrine("flat", true, roster, "reviewer");
  assert.ok(/the `reviewer` agent/i.test(out), "explicit reviewAgentId must win over the roster-derived guess");
  assert.equal(out.includes("`uefn-auditor`"), false, "must not also name uefn-auditor when reviewAgentId overrides it");
});

// ---------------------------------------------------------------------------
// renderDelegationDoctrine: dynamic "Specialist roster" (project-aware,
// derived from the caller-supplied agent list rather than a hardcoded table)
// ---------------------------------------------------------------------------

test("renderDelegationDoctrine with a supplied roster renders exactly those agent ids, not the hardcoded defaults", () => {
  const custom: DoctrineRosterAgent[] = [
    { id: "verse-expert", taskTypes: "Verse device implementation" },
    { id: "uefn-auditor", taskTypes: "Verse audit, lint" },
  ];
  const out = renderDelegationDoctrine("flat", false, custom);
  assert.ok(out.includes("| verse-expert | Verse device implementation |"), "must render the supplied verse-expert row");
  assert.ok(out.includes("| uefn-auditor | Verse audit, lint |"), "must render the supplied uefn-auditor row");
  // None of the hardcoded default roster ids should leak in when a real
  // roster was supplied — that would reproduce the "dangling agent name"
  // bug (a roster row naming an agent with no corresponding file on disk).
  assert.equal(out.includes("coding-specialist"), false, "hardcoded default ids must not appear alongside a supplied roster");
  assert.equal(out.includes("testing-specialist"), false, "hardcoded default ids must not appear alongside a supplied roster");
});

test("renderDelegationDoctrine falls back to the hardcoded default roster when no agents are supplied", () => {
  const out = renderDelegationDoctrine("flat", false);
  assert.ok(out.includes("| coding-specialist | Implementation, editing, bug fixes, refactoring |"));
  assert.ok(out.includes("| search-retrieval |"));
});

test("renderDelegationDoctrine falls back to the hardcoded default roster when an empty agent list is supplied", () => {
  const out = renderDelegationDoctrine("flat", false, []);
  assert.ok(out.includes("| coding-specialist | Implementation, editing, bug fixes, refactoring |"));
});

test("renderDelegationDoctrine's roster table always has a Specialist/Task types header regardless of source", () => {
  const withRoster = renderDelegationDoctrine("flat", false, [{ id: "solo-agent", taskTypes: "Everything" }]);
  const withDefault = renderDelegationDoctrine("flat", false);
  for (const out of [withRoster, withDefault]) {
    assert.ok(out.includes("## Specialist roster"));
    assert.ok(out.includes("| Specialist | Task types |"));
    assert.ok(out.includes("| --- | --- |"));
  }
});

// ---------------------------------------------------------------------------
// renderDelegationDoctrine: aggressive delegation hardening — NEVER/ALWAYS
// edit + search mandates, the narrow known-path read carve-out, the
// MANDATORY DELEGATION RULES checklist, and the Fallback Rule. Shared
// PREAMBLE, so asserted for BOTH modes.
// ---------------------------------------------------------------------------

test("renderDelegationDoctrine states the NEVER-edit and NEVER-search-yourself bold mandates, for both modes", () => {
  for (const mode of DELEGATION_MODES) {
    const out = renderDelegationDoctrine(mode, false).replace(/\s+/g, " ");
    assert.ok(
      /\*\*NEVER Edit or Write files directly.*ALWAYS delegate to coding-specialist\.\*\*/i.test(out),
      `mode=${mode} must state the bold NEVER-edit mandate naming coding-specialist`
    );
    assert.ok(
      /\*\*NEVER grep, glob, search, or read across multiple files.*ALWAYS delegate to search-retrieval \(Haiku\)\.\*\*/i.test(out),
      `mode=${mode} must state the bold NEVER-search mandate naming search-retrieval (Haiku)`
    );
  }
});

test("renderDelegationDoctrine states the narrow known-path-read carve-out and preserves the allowed-direct actions, for both modes", () => {
  for (const mode of DELEGATION_MODES) {
    const out = renderDelegationDoctrine(mode, false).replace(/\s+/g, " ");
    assert.ok(
      /single, specific, already-known\s*file path/i.test(out),
      `mode=${mode} must describe the narrow one-file-lookup carve-out`
    );
    assert.ok(
      /talking to the user, making\s*high-level architectural decisions, coordinating agents, and VERIFYING work/i.test(out),
      `mode=${mode} must still explicitly allow talking to the user, high-level decisions, coordination, and verification`
    );
  }
});

test("renderDelegationDoctrine states the MANDATORY DELEGATION RULES checklist and the Fallback Rule, for both modes", () => {
  for (const mode of DELEGATION_MODES) {
    const out = renderDelegationDoctrine(mode, false).replace(/\s+/g, " ");
    assert.ok(out.includes("### MANDATORY DELEGATION RULES"), `mode=${mode} must include the checklist heading`);
    assert.ok(/1\. Any file edit or creation.*coding-specialist\./i.test(out), `mode=${mode} checklist item 1 must route edits to coding-specialist`);
    assert.ok(/2\. Any search, grep, glob, or multi-file\/exploratory read.*search-retrieval \(Haiku\)\./i.test(out), `mode=${mode} checklist item 2 must route search to search-retrieval`);
    assert.ok(out.includes("### The Fallback Rule"), `mode=${mode} must include the Fallback Rule heading`);
    assert.ok(
      /delegate it to\s*the Fallback Agent \(Sonnet\) — do NOT do it yourself on the orchestrator/i.test(out),
      `mode=${mode} must instruct routing keyword-unmatched work to the Fallback Agent instead of the orchestrator`
    );
  }
});

test("renderDelegationDoctrine's MANDATORY DELEGATION RULES checklist omits coding-specialist by name when the supplied roster doesn't include it (no dangling agent reference)", () => {
  const custom: DoctrineRosterAgent[] = [
    { id: "verse-expert", taskTypes: "Verse device implementation" },
    { id: "uefn-auditor", taskTypes: "Verse audit, lint" },
  ];
  const out = renderDelegationDoctrine("flat", false, custom);
  assert.equal(out.includes("coding-specialist"), false, "coding-specialist must not be named when absent from the supplied roster");
  // A UEFN roster names verse-expert (its Verse-writing implementer) as the
  // edit target rather than falling back to a generic phrase.
  assert.ok(out.includes("verse-expert"), "must name verse-expert as the edit target on a UEFN-shaped roster");
  // search-retrieval is always safe to name (installed for every project type).
  assert.ok(out.includes("search-retrieval (Haiku)"), "search-retrieval is project-agnostic and may always be named");
});

test("renderDelegationDoctrine names coding-specialist for edits on a non-UEFN roster (coding-specialist present)", () => {
  const custom: DoctrineRosterAgent[] = [
    { id: "coding-specialist", taskTypes: "Implementation, editing, bug fixes, refactoring" },
    { id: "search-retrieval", taskTypes: "File searching, code lookup, grep/glob" },
  ];
  const out = renderDelegationDoctrine("flat", false, custom).replace(/\s+/g, " ");
  assert.ok(
    /\*\*NEVER Edit or Write files directly.*ALWAYS delegate to coding-specialist\.\*\*/i.test(out),
    "NEVER-edit mandate must name coding-specialist"
  );
  assert.ok(
    /1\. Any file edit or creation.*coding-specialist\./i.test(out),
    "checklist item 1 must route edits to coding-specialist"
  );
  assert.equal(out.includes("verse-expert"), false, "verse-expert must not be named when absent from the supplied roster");
});

test("renderDelegationDoctrine names verse-expert (not coding-specialist, not generic) for edits on a UEFN-shaped roster (verse-expert present, coding-specialist absent)", () => {
  const custom: DoctrineRosterAgent[] = [
    { id: "verse-expert", taskTypes: "Verse device implementation" },
    { id: "uefn-auditor", taskTypes: "Verse audit, lint" },
    { id: "search-retrieval", taskTypes: "File searching, code lookup, grep/glob" },
  ];
  const out = renderDelegationDoctrine("flat", false, custom).replace(/\s+/g, " ");
  assert.ok(
    /\*\*NEVER Edit or Write files directly.*ALWAYS delegate to verse-expert\.\*\*/i.test(out),
    "NEVER-edit mandate must name verse-expert on a UEFN roster"
  );
  assert.ok(
    /1\. Any file edit or creation.*verse-expert\./i.test(out),
    "checklist item 1 must route edits to verse-expert on a UEFN roster"
  );
  assert.equal(out.includes("coding-specialist"), false, "coding-specialist must not be named when absent from the supplied roster");
  assert.equal(
    out.includes("the appropriate specialist (see the roster below)"),
    false,
    "must not fall back to the generic phrase when verse-expert is present"
  );
});

test("renderDelegationDoctrine('team_leads') names verse-expert (not coding-specialist) in the build-lead line on a UEFN-shaped roster", () => {
  const custom: DoctrineRosterAgent[] = [
    { id: "verse-expert", taskTypes: "Verse device implementation" },
    { id: "uefn-auditor", taskTypes: "Verse audit, lint" },
    { id: "search-retrieval", taskTypes: "File searching, code lookup, grep/glob" },
  ];
  const out = renderDelegationDoctrine("team_leads", false, custom).replace(/\s+/g, " ");
  assert.ok(
    /\*\*build-lead\*\* owns the verse-expert, ux-ui-designer, and vscode-integration workers\./i.test(out),
    "build-lead line must name verse-expert on a UEFN roster"
  );
  assert.equal(out.includes("coding-specialist"), false, "coding-specialist must not be named anywhere when absent from the supplied roster");
});

test("renderDelegationDoctrine('team_leads') still names coding-specialist in the build-lead line on the default/non-UEFN roster", () => {
  const out = renderDelegationDoctrine("team_leads", false).replace(/\s+/g, " ");
  assert.ok(
    /\*\*build-lead\*\* owns the coding-specialist, ux-ui-designer, and vscode-integration workers\./i.test(out),
    "build-lead line must still name coding-specialist on the default roster"
  );
});

test("renderDelegationDoctrine falls back to the generic edit-target phrase when neither coding-specialist nor verse-expert is present", () => {
  const custom: DoctrineRosterAgent[] = [{ id: "search-retrieval", taskTypes: "File searching, code lookup, grep/glob" }];
  const out = renderDelegationDoctrine("flat", false, custom).replace(/\s+/g, " ");
  assert.ok(
    /\*\*NEVER Edit or Write files directly.*ALWAYS delegate to the appropriate specialist \(see the roster below\)\.\*\*/i.test(out),
    "must fall back to the generic edit-target phrase when neither implementer id is present"
  );
  assert.equal(out.includes("coding-specialist"), false);
  assert.equal(out.includes("verse-expert"), false);
});

// ---------------------------------------------------------------------------
// renderDelegationDoctrine: "Who 'you' means in this file" worker-leaf
// section (root-cause fix for recursive-delegation loops — every other
// section addresses the orchestrator with no signal telling a spawned
// worker it is a leaf). Inserted after the mode section, before
// VERIFICATION_SECTION, in both modes.
// ---------------------------------------------------------------------------

test("renderDelegationDoctrine (direct mode) tells spawned workers they are a LEAF and must not spawn sub-agents", () => {
  const out = renderDelegationDoctrine("flat", false);
  assert.ok(out.includes("you are a LEAF"), "direct mode must state the worker-leaf rule");
  assert.ok(out.includes("Do NOT spawn Task or sub-agents"), "direct mode must forbid nested spawning");
});

test("renderDelegationDoctrine (team_leads mode) carves out an explicitly-designated team lead", () => {
  const out = renderDelegationDoctrine("team_leads", false).replace(/\s+/g, " ");
  assert.ok(
    out.includes("UNLESS your brief explicitly designates you a TEAM LEAD"),
    "team_leads mode must carve out designated team leads from the leaf rule"
  );
});

test("renderDelegationDoctrine (direct mode) never mentions TEAM LEAD in the worker-leaf section", () => {
  const out = renderDelegationDoctrine("flat", false);
  assert.equal(out.includes("TEAM LEAD"), false, "direct mode must not reference a TEAM LEAD carve-out");
});

test("renderDelegationDoctrine's worker-leaf section lands after the mode section and before the verify-on-disk section, for both modes", () => {
  for (const mode of DELEGATION_MODES) {
    const out = renderDelegationDoctrine(mode, false);
    const modeHeadingIdx =
      mode === "team_leads"
        ? out.indexOf("## Team Leads delegation (current mode)")
        : out.indexOf("## Direct delegation (current mode)");
    const leafIdx = out.indexOf('## Who "you" means in this file');
    const verifyIdx = out.indexOf('## A "completed" notification is not proof');
    assert.ok(modeHeadingIdx !== -1 && leafIdx !== -1 && verifyIdx !== -1, `mode=${mode}: all three sections must be present`);
    assert.ok(modeHeadingIdx < leafIdx, `mode=${mode}: mode section must come before the worker-leaf section`);
    assert.ok(leafIdx < verifyIdx, `mode=${mode}: worker-leaf section must come before the verify-on-disk section`);
  }
});

// ---------------------------------------------------------------------------
// execution config round-trip
// ---------------------------------------------------------------------------

test("readExecutionConfig defaults to flat + reviewEnabled:true when no file exists", () => {
  const root = tmpRoot();
  try {
    const claudeDir = path.join(root, ".claude");
    const config = readExecutionConfig(claudeDir);
    assert.deepEqual(config, { delegation_mode: "flat", reviewEnabled: true, sessionJournalEntries: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeExecutionConfig then readExecutionConfig round-trips team_leads (reviewEnabled defaults true when not written)", () => {
  const root = tmpRoot();
  try {
    const claudeDir = path.join(root, ".claude");
    writeExecutionConfig(claudeDir, { delegation_mode: "team_leads" });
    const config = readExecutionConfig(claudeDir);
    assert.deepEqual(config, { delegation_mode: "team_leads", reviewEnabled: true, sessionJournalEntries: 0 });

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(claudeDir, "tycoon", "execution.json"), "utf8")
    );
    assert.deepEqual(onDisk, { delegation_mode: "team_leads" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readExecutionConfig tolerates invalid JSON by falling back to the default", () => {
  const root = tmpRoot();
  try {
    const claudeDir = path.join(root, ".claude");
    fs.mkdirSync(path.join(claudeDir, "tycoon"), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "tycoon", "execution.json"), "{ not valid json");
    const config = readExecutionConfig(claudeDir);
    assert.deepEqual(config, { delegation_mode: "flat", reviewEnabled: true, sessionJournalEntries: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// reviewEnabled: explicit false round-trips; absent key on disk reads as true
// ---------------------------------------------------------------------------

test("writeExecutionConfig({ reviewEnabled: false }) then readExecutionConfig round-trips false (not coerced to the true default)", () => {
  const root = tmpRoot();
  try {
    const claudeDir = path.join(root, ".claude");
    writeExecutionConfig(claudeDir, { delegation_mode: "flat", reviewEnabled: false });
    const config = readExecutionConfig(claudeDir);
    assert.deepEqual(config, { delegation_mode: "flat", reviewEnabled: false, sessionJournalEntries: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeExecutionConfig can set reviewEnabled alone (partial write) without delegation_mode already present, merging onto the default read", () => {
  const root = tmpRoot();
  try {
    const claudeDir = path.join(root, ".claude");
    // No delegation_mode has ever been written; write reviewEnabled only.
    writeExecutionConfig(claudeDir, { reviewEnabled: false });
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(claudeDir, "tycoon", "execution.json"), "utf8")
    );
    assert.deepEqual(onDisk, { reviewEnabled: false });
    // Reading back still resolves delegation_mode via the flat default.
    const config = readExecutionConfig(claudeDir);
    assert.deepEqual(config, { delegation_mode: "flat", reviewEnabled: false, sessionJournalEntries: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// writeExecutionConfig merge-safety (execution.json is shared with panel.ts's
// projectPlanEnabled flag; writeExecutionConfig must not clobber sibling keys)
// ---------------------------------------------------------------------------

test("writeExecutionConfig preserves an unrelated key (e.g. projectPlanEnabled) already on disk", () => {
  const root = tmpRoot();
  try {
    const claudeDir = path.join(root, ".claude");
    const configPath = path.join(claudeDir, "tycoon", "execution.json");

    // Simulate panel.ts's writeProjectPlanEnabled having already written the file.
    writeExecutionConfig(claudeDir, { delegation_mode: "flat" });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const before = JSON.parse(fs.readFileSync(configPath, "utf8"));
    fs.writeFileSync(configPath, JSON.stringify({ ...before, projectPlanEnabled: true }, null, 2));

    // Now writeExecutionConfig sets a new delegation_mode; projectPlanEnabled must survive.
    writeExecutionConfig(claudeDir, { delegation_mode: "team_leads" });

    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(onDisk, { delegation_mode: "team_leads", projectPlanEnabled: true });

    const config = readExecutionConfig(claudeDir);
    assert.deepEqual(config, { delegation_mode: "team_leads", reviewEnabled: true, sessionJournalEntries: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeExecutionConfig then a raw projectPlanEnabled write then readExecutionConfig: both keys present on disk", () => {
  const root = tmpRoot();
  try {
    const claudeDir = path.join(root, ".claude");
    const configPath = path.join(claudeDir, "tycoon", "execution.json");

    writeExecutionConfig(claudeDir, { delegation_mode: "team_leads" });

    const existing = JSON.parse(fs.readFileSync(configPath, "utf8"));
    fs.writeFileSync(configPath, JSON.stringify({ ...existing, projectPlanEnabled: true }, null, 2));

    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(onDisk.delegation_mode, "team_leads");
    assert.equal(onDisk.projectPlanEnabled, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Three-way merge-safety: delegation_mode + projectPlanEnabled + reviewEnabled
// must all coexist on disk regardless of write order (execution.json is
// shared by delegationDoctrine.ts's writeExecutionConfig and panel.ts's
// writeProjectPlanEnabled — a real project ends up with all three keys).
// ---------------------------------------------------------------------------

test("delegation_mode, projectPlanEnabled, and reviewEnabled all survive interleaved writes regardless of order", () => {
  const root = tmpRoot();
  try {
    const claudeDir = path.join(root, ".claude");
    const configPath = path.join(claudeDir, "tycoon", "execution.json");

    // 1. Install: writeExecutionConfig sets delegation_mode + reviewEnabled
    //    (mirrors _handleInstallHooks).
    writeExecutionConfig(claudeDir, { delegation_mode: "team_leads", reviewEnabled: true });

    // 2. Project Plan opted in: panel.ts's writeProjectPlanEnabled does a raw
    //    read-modify-write merge onto the same file (simulated here).
    const afterInstall = JSON.parse(fs.readFileSync(configPath, "utf8"));
    fs.writeFileSync(configPath, JSON.stringify({ ...afterInstall, projectPlanEnabled: true }, null, 2));

    // 3. Review pass toggled off later in Settings: writeExecutionConfig
    //    patches reviewEnabled alone (mirrors _handleSetReviewEnabled) and
    //    must not disturb delegation_mode or projectPlanEnabled.
    writeExecutionConfig(claudeDir, { reviewEnabled: false });

    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(onDisk, {
      delegation_mode: "team_leads",
      reviewEnabled: false,
      projectPlanEnabled: true,
    });

    const config = readExecutionConfig(claudeDir);
    assert.deepEqual(config, { delegation_mode: "team_leads", reviewEnabled: false, sessionJournalEntries: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// sessionJournalEntries: readExecutionConfig validation (integer 0-5, else 0)
// ---------------------------------------------------------------------------

test("readExecutionConfig accepts sessionJournalEntries at the boundaries and midpoint (0, 3, 5)", () => {
  const root = tmpRoot();
  try {
    const claudeDir = path.join(root, ".claude");
    for (const value of [0, 3, 5]) {
      writeExecutionConfig(claudeDir, { sessionJournalEntries: value });
      const config = readExecutionConfig(claudeDir);
      assert.equal(config.sessionJournalEntries, value, `value ${value} must round-trip unchanged`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readExecutionConfig coerces a missing sessionJournalEntries key to 0", () => {
  const root = tmpRoot();
  try {
    const claudeDir = path.join(root, ".claude");
    writeExecutionConfig(claudeDir, { delegation_mode: "flat" });
    assert.equal(readExecutionConfig(claudeDir).sessionJournalEntries, 0, "missing key must coerce to 0");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readExecutionConfig coerces non-integer/out-of-range sessionJournalEntries values to 0 (null, string, float, negative, >5, true)", () => {
  const root = tmpRoot();
  try {
    const claudeDir = path.join(root, ".claude");
    const configPath = path.join(claudeDir, "tycoon", "execution.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    const invalidValues: unknown[] = [null, "3", 3.5, -1, 6, true];
    for (const value of invalidValues) {
      fs.writeFileSync(configPath, JSON.stringify({ delegation_mode: "flat", sessionJournalEntries: value }));
      const config = readExecutionConfig(claudeDir);
      assert.equal(config.sessionJournalEntries, 0, `value ${JSON.stringify(value)} must coerce to 0`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readExecutionConfig coerces a NaN sessionJournalEntries to 0 (JSON has no NaN literal, so this exercises the whole-file invalid-JSON fallback, which also yields 0)", () => {
  const root = tmpRoot();
  try {
    const claudeDir = path.join(root, ".claude");
    const configPath = path.join(claudeDir, "tycoon", "execution.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // Not valid JSON (JSON.stringify would turn a real NaN into null) — this
    // is the closest on-disk analogue to "the field holds NaN" and must still
    // resolve to 0 rather than throwing.
    fs.writeFileSync(configPath, '{"delegation_mode":"flat","sessionJournalEntries":NaN}');
    const config = readExecutionConfig(claudeDir);
    assert.equal(config.sessionJournalEntries, 0, "NaN-bearing content must coerce to 0");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// sessionJournalEntries: writeExecutionConfig round-trip + merge-safety
// (mirrors the interleaved-writes test above for delegation_mode/reviewEnabled)
// ---------------------------------------------------------------------------

test("writeExecutionConfig round-trips sessionJournalEntries:4 without clobbering delegation_mode or reviewEnabled written earlier", () => {
  const root = tmpRoot();
  try {
    const claudeDir = path.join(root, ".claude");
    const configPath = path.join(claudeDir, "tycoon", "execution.json");

    // 1. delegation_mode + reviewEnabled written first (mirrors install).
    writeExecutionConfig(claudeDir, { delegation_mode: "team_leads", reviewEnabled: false });

    // 2. sessionJournalEntries patched in later (mirrors _handleSetSessionJournalEntries).
    writeExecutionConfig(claudeDir, { sessionJournalEntries: 4 });

    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(onDisk, {
      delegation_mode: "team_leads",
      reviewEnabled: false,
      sessionJournalEntries: 4,
    });

    const config = readExecutionConfig(claudeDir);
    assert.deepEqual(config, { delegation_mode: "team_leads", reviewEnabled: false, sessionJournalEntries: 4 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// renderDelegationDoctrine: optional Session Journal section (composes with
// either base mode; off by default — additive, so omitting the 5th arg must
// be byte-identical to passing 0 explicitly)
// ---------------------------------------------------------------------------

test("renderDelegationDoctrine omits the Session Journal section when entries is 0", () => {
  const out = renderDelegationDoctrine("flat", true, undefined, undefined, 0);
  assert.equal(out.includes("## Session Journal"), false, "entries=0 must omit the Session Journal section");
});

test("renderDelegationDoctrine includes the Session Journal section and mentions the count when entries is 3", () => {
  const out = renderDelegationDoctrine("flat", true, undefined, undefined, 3);
  assert.ok(out.includes("## Session Journal"), "entries=3 must include the Session Journal section");
  assert.ok(/last 3 prompts/.test(out), "section body must mention the count 3");
});

test("renderDelegationDoctrine with the 5th arg omitted is byte-identical to explicitly passing sessionJournalEntries:0 (additive regression guard)", () => {
  const omitted = renderDelegationDoctrine("flat", true, undefined, undefined);
  const explicitZero = renderDelegationDoctrine("flat", true, undefined, undefined, 0);
  assert.equal(omitted, explicitZero, "omitting the 5th arg must produce byte-identical output to entries=0");

  // Spot-check across both base modes too — the additive guarantee must hold
  // regardless of mode.
  for (const mode of DELEGATION_MODES) {
    assert.equal(
      renderDelegationDoctrine(mode),
      renderDelegationDoctrine(mode, true, undefined, undefined, 0),
      `mode=${mode}: omitted 5th arg must match explicit 0`
    );
  }
});

// ---------------------------------------------------------------------------
// Session Journal section lands inside the managed <!-- tycoon:delegation -->
// block (so it is auto-healed and removable like the rest of the doctrine)
// ---------------------------------------------------------------------------

test("renderDelegationDoctrine's Session Journal section, once spliced via upsertDelegationSection, lands between the managed sentinels", () => {
  const body = renderDelegationDoctrine("flat", true, undefined, undefined, 3);
  const out = upsertDelegationSection(null, body);

  const startIdx = out.indexOf(DELEGATION_SECTION_START);
  const endIdx = out.indexOf(DELEGATION_SECTION_END);
  assert.ok(startIdx !== -1 && endIdx !== -1 && endIdx > startIdx, "both sentinels must be present in order");

  const span = out.slice(startIdx, endIdx);
  assert.ok(span.includes("## Session Journal"), "Session Journal section must land inside the managed span");
});

// ---------------------------------------------------------------------------
// renderDelegationDoctrine: optional Project Plan routing section (composes
// with either base mode; off by default — additive, so omitting the 6th arg
// must be byte-identical to passing false explicitly). Fixes the bug where a
// large-feature/GDD/PRD request got routed to a specialist as a doc-writing
// task and produced a free-form markdown plan nothing ever reads.
// ---------------------------------------------------------------------------

test("renderDelegationDoctrine omits the Project Plan routing section when projectPlanEnabled is false (default)", () => {
  const out = renderDelegationDoctrine("flat");
  assert.equal(out.includes("## Project Plan routing"), false, "section must be absent by default");
});

test("renderDelegationDoctrine includes the Project Plan routing section when projectPlanEnabled is true, naming plan.json and the project-plan skill", () => {
  const out = renderDelegationDoctrine("flat", true, undefined, undefined, 0, true);
  assert.ok(out.includes("## Project Plan routing"), "section must be present when the flag is true");
  assert.ok(out.includes("`project-plan`"), "must name the project-plan skill");
  assert.ok(out.includes(".claude/tycoon/plan.json"), "must name the registered plan file path");
  assert.ok(
    /free-form markdown plan/i.test(out) && /panel never reads it/i.test(out),
    "must explicitly state that a free-form markdown plan is not a registered plan"
  );
  assert.ok(
    /OVERRIDES the general/i.test(out),
    "must explicitly state this routing overrides the general edit-to-specialist rule"
  );
});

test("renderDelegationDoctrine with the 6th arg omitted is byte-identical to explicitly passing projectPlanEnabled:false", () => {
  const omitted = renderDelegationDoctrine("flat", true, undefined, undefined, 0);
  const explicitFalse = renderDelegationDoctrine("flat", true, undefined, undefined, 0, false);
  assert.equal(omitted, explicitFalse, "omitting the 6th arg must produce byte-identical output to projectPlanEnabled=false");
});

test("renderDelegationDoctrine's Project Plan routing section, once spliced via upsertDelegationSection, lands between the managed sentinels", () => {
  const body = renderDelegationDoctrine("flat", true, undefined, undefined, 0, true);
  const out = upsertDelegationSection(null, body);

  const startIdx = out.indexOf(DELEGATION_SECTION_START);
  const endIdx = out.indexOf(DELEGATION_SECTION_END);
  assert.ok(startIdx !== -1 && endIdx !== -1 && endIdx > startIdx, "both sentinels must be present in order");

  const span = out.slice(startIdx, endIdx);
  assert.ok(span.includes("## Project Plan routing"), "Project Plan routing section must land inside the managed span");
});
