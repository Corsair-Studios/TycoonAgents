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
  const out = renderDelegationDoctrine("flat");
  assert.equal(/lead/i.test(out), false, "flat mode output must not mention leads at all");
});

test("DELEGATION_MODES contains exactly flat and team_leads", () => {
  assert.deepEqual([...DELEGATION_MODES], ["flat", "team_leads"]);
});

// ---------------------------------------------------------------------------
// execution config round-trip
// ---------------------------------------------------------------------------

test("readExecutionConfig defaults to flat when no file exists", () => {
  const root = tmpRoot();
  try {
    const claudeDir = path.join(root, ".claude");
    const config = readExecutionConfig(claudeDir);
    assert.deepEqual(config, { delegation_mode: "flat" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeExecutionConfig then readExecutionConfig round-trips team_leads", () => {
  const root = tmpRoot();
  try {
    const claudeDir = path.join(root, ".claude");
    writeExecutionConfig(claudeDir, { delegation_mode: "team_leads" });
    const config = readExecutionConfig(claudeDir);
    assert.deepEqual(config, { delegation_mode: "team_leads" });

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
    assert.deepEqual(config, { delegation_mode: "flat" });
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
    assert.deepEqual(config, { delegation_mode: "team_leads" });
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
