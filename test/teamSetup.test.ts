/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TEAM_MANIFEST_SCHEMA_VERSION,
  buildTeamManifest,
  validateTeamManifest,
  serializeTeamManifest,
  parseTeamManifest,
  type TeamManifestInput,
  type TeamManifest,
} from "../src/core/teamSetup";

function sampleInput(): TeamManifestInput {
  return {
    roster: [
      { id: "coding-specialist", displayName: "Coding Specialist" },
      { id: "search-retrieval", displayName: "Search Retrieval" },
    ],
    routing: {
      "coding-specialist": {
        vendor: "anthropic",
        model: "sonnet",
        fallbackChain: ["anthropic/sonnet", "anthropic/haiku"],
        costClass: "subscription",
      },
      "search-retrieval": {
        vendor: "anthropic",
        model: "haiku",
        fallbackChain: [],
        costClass: "subscription",
      },
    },
    requiredEnv: [
      { name: "ANTHROPIC_API_KEY", setAtExport: true },
      { name: "OPENAI_API_KEY", setAtExport: false },
    ],
    skills: ["git", "project-plan"],
    mcp: ["codex"],
    delegation: { mode: "direct", parallelLimit: 2 },
    planPointer: ".claude/tycoon/plan.json",
  };
}

test("buildTeamManifest re-export is byte-identical except exportedAt", () => {
  const input = sampleInput();
  const m1 = buildTeamManifest(input, { now: "2026-09-15T00:00:00.000Z", version: "0.0.618" });
  const m2 = buildTeamManifest(input, { now: "2026-09-16T12:00:00.000Z", version: "0.0.618" });

  const s1 = serializeTeamManifest(m1).replace(m1.exportedAt, "STAMP");
  const s2 = serializeTeamManifest(m2).replace(m2.exportedAt, "STAMP");
  assert.equal(s1, s2);
  assert.notEqual(m1.exportedAt, m2.exportedAt);
});

test("buildTeamManifest sorts roster/routing/requiredEnv/skills/mcp deterministically", () => {
  const input: TeamManifestInput = {
    roster: [
      { id: "zeta", displayName: "Z" },
      { id: "alpha", displayName: "A" },
    ],
    routing: {
      zeta: { fallbackChain: [] },
      alpha: { fallbackChain: [] },
    },
    requiredEnv: [
      { name: "ZVAR", setAtExport: false },
      { name: "AVAR", setAtExport: true },
    ],
    skills: ["zskill", "askill"],
    mcp: ["zmcp", "amcp"],
    delegation: { mode: "direct", parallelLimit: 2 },
  };
  const m = buildTeamManifest(input, { now: "2026-09-15T00:00:00.000Z", version: "1.0.0" });
  assert.deepEqual(m.roster.map((r) => r.id), ["alpha", "zeta"]);
  assert.deepEqual(Object.keys(m.routing), ["alpha", "zeta"]);
  assert.deepEqual(m.requiredEnv.map((e) => e.name), ["AVAR", "ZVAR"]);
  assert.deepEqual(m.skills, ["askill", "zskill"]);
  assert.deepEqual(m.mcp, ["amcp", "zmcp"]);
});

test("validateTeamManifest accepts a clean manifest", () => {
  const m = buildTeamManifest(sampleInput(), { now: "2026-09-15T00:00:00.000Z", version: "0.0.618" });
  const result = validateTeamManifest(m);
  assert.equal(result.ok, true);
});

test("validateTeamManifest rejects absolute Windows path without echoing value", () => {
  const input = sampleInput();
  input.planPointer = "C:\\Users\\majes\\secret\\plan.json";
  const m = buildTeamManifest(input, { now: "2026-09-15T00:00:00.000Z", version: "0.0.618" });
  const result = validateTeamManifest(m);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.field, "planPointer");
    assert.doesNotMatch(result.reason, /C:\\Users/);
  }
});

test("validateTeamManifest rejects /Users/ absolute path", () => {
  const input = sampleInput();
  input.routing["coding-specialist"].model = "/Users/majes/models/sonnet";
  const m = buildTeamManifest(input, { now: "2026-09-15T00:00:00.000Z", version: "0.0.618" });
  const result = validateTeamManifest(m);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.doesNotMatch(result.reason, /\/Users\/majes/);
  }
});

test("validateTeamManifest rejects UNC path", () => {
  const input = sampleInput();
  input.planPointer = "\\\\SERVER\\share\\plan.json";
  const m = buildTeamManifest(input, { now: "2026-09-15T00:00:00.000Z", version: "0.0.618" });
  const result = validateTeamManifest(m);
  assert.equal(result.ok, false);
});

test("validateTeamManifest rejects requiredEnv entry carrying a value property", () => {
  const m = buildTeamManifest(sampleInput(), { now: "2026-09-15T00:00:00.000Z", version: "0.0.618" });
  const tampered = {
    ...m,
    requiredEnv: [...m.requiredEnv, { name: "LEAKED", setAtExport: true, value: "sk-abcdefghijklmnopqrstuvwx" }],
  } as unknown as TeamManifest;
  const result = validateTeamManifest(tampered);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.field, "requiredEnv");
    assert.doesNotMatch(result.reason, /sk-/);
  }
});

test("validateTeamManifest rejects sk- style secret shape", () => {
  const input = sampleInput();
  input.routing["coding-specialist"].vendor = "sk-abcdefghijklmnopqrstuvwxyz123456";
  const m = buildTeamManifest(input, { now: "2026-09-15T00:00:00.000Z", version: "0.0.618" });
  const result = validateTeamManifest(m);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.doesNotMatch(result.reason, /sk-abc/);
  }
});

test("validateTeamManifest rejects AIza-style Google key shape", () => {
  const input = sampleInput();
  input.skills = ["AIza" + "a".repeat(35)];
  const m = buildTeamManifest(input, { now: "2026-09-15T00:00:00.000Z", version: "0.0.618" });
  const result = validateTeamManifest(m);
  assert.equal(result.ok, false);
});

test("validateTeamManifest rejects ghp_ token shape", () => {
  const input = sampleInput();
  input.mcp = ["ghp_abcdefghijklmnopqrstuvwxyz0123456789"];
  const m = buildTeamManifest(input, { now: "2026-09-15T00:00:00.000Z", version: "0.0.618" });
  const result = validateTeamManifest(m);
  assert.equal(result.ok, false);
});

test("validateTeamManifest rejects Bearer token shape", () => {
  const input = sampleInput();
  input.skills = ["Bearer abcdef123456"];
  const m = buildTeamManifest(input, { now: "2026-09-15T00:00:00.000Z", version: "0.0.618" });
  const result = validateTeamManifest(m);
  assert.equal(result.ok, false);
});

test("validateTeamManifest rejects long hex run", () => {
  const input = sampleInput();
  input.skills = ["a".repeat(32)];
  const m = buildTeamManifest(input, { now: "2026-09-15T00:00:00.000Z", version: "0.0.618" });
  const result = validateTeamManifest(m);
  assert.equal(result.ok, false);
});

test("validateTeamManifest rejects unknown schemaVersion", () => {
  const m = buildTeamManifest(sampleInput(), { now: "2026-09-15T00:00:00.000Z", version: "0.0.618" });
  const tampered = { ...m, schemaVersion: 999 } as unknown as TeamManifest;
  const result = validateTeamManifest(tampered);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.field, "schemaVersion");
});

test("serializeTeamManifest produces stable 2-space JSON with trailing newline", () => {
  const m = buildTeamManifest(sampleInput(), { now: "2026-09-15T00:00:00.000Z", version: "0.0.618" });
  const s = serializeTeamManifest(m);
  assert.match(s, /\n$/);
  assert.equal(s, `${JSON.stringify(m, null, 2)}\n`);
});

test("parseTeamManifest round-trips a serialized manifest", () => {
  const m = buildTeamManifest(sampleInput(), { now: "2026-09-15T00:00:00.000Z", version: "0.0.618" });
  const text = serializeTeamManifest(m);
  const result = parseTeamManifest(text);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.manifest, m);
  }
});

test("parseTeamManifest rejects invalid JSON", () => {
  const result = parseTeamManifest("{not json");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.field, "(root)");
});

test("parseTeamManifest rejects unknown schemaVersion", () => {
  const m = buildTeamManifest(sampleInput(), { now: "2026-09-15T00:00:00.000Z", version: "0.0.618" });
  const tampered = { ...m, schemaVersion: 2 };
  const result = parseTeamManifest(JSON.stringify(tampered));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.field, "schemaVersion");
});

test("parseTeamManifest rejects malformed routing slot (missing fallbackChain)", () => {
  const m = buildTeamManifest(sampleInput(), { now: "2026-09-15T00:00:00.000Z", version: "0.0.618" });
  const obj: Record<string, unknown> = JSON.parse(JSON.stringify(m));
  delete (obj.routing as Record<string, unknown>)["coding-specialist"];
  (obj.routing as Record<string, unknown>)["coding-specialist"] = { vendor: "anthropic" };
  const result = parseTeamManifest(JSON.stringify(obj));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.field, "routing.coding-specialist");
});

test("TEAM_MANIFEST_SCHEMA_VERSION is 1", () => {
  assert.equal(TEAM_MANIFEST_SCHEMA_VERSION, 1);
});
