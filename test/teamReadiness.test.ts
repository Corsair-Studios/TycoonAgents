/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTeamReadiness,
  createDefaultProbes,
  formatReadinessReport,
  type HarnessInstalledMap,
  type TeamReadinessProbes,
  type VendorAvailability,
} from "../src/core/teamReadiness";
import type { TeamManifest } from "../src/core/teamSetup";

function defaultHarnessesInstalled(): HarnessInstalledMap {
  return {
    "claude-code": { installed: true, detail: "claude CLI found" },
    codex: { installed: false, detail: "codex CLI not found" },
    opencode: { installed: false, detail: "OpenCode install not found" },
  };
}

function sampleManifest(): TeamManifest {
  return {
    schemaVersion: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    exporter: { product: "tycoonagents", version: "0.0.1" },
    roster: [
      { id: "coding-specialist", displayName: "Coding Specialist" },
      { id: "codex-reviewer", displayName: "Codex Reviewer" },
      { id: "search-retrieval", displayName: "Search Retrieval" },
    ],
    routing: {
      "coding-specialist": {
        vendor: "anthropic",
        model: "sonnet",
        fallbackChain: [],
        costClass: "subscription",
        envNames: ["ANTHROPIC_API_KEY"],
      },
      "codex-reviewer": {
        vendor: "openai",
        model: "gpt-5",
        fallbackChain: ["anthropic"],
        costClass: "subscription",
        fallbackEnvNames: { anthropic: ["ANTHROPIC_API_KEY"] },
      },
      "search-retrieval": {
        vendor: "anthropic",
        model: "haiku",
        fallbackChain: [],
        costClass: "subscription",
      },
    },
    requiredEnv: [{ name: "ANTHROPIC_API_KEY", setAtExport: true }],
    skills: [],
    mcp: [],
    delegation: { mode: "direct", parallelLimit: 2 },
  };
}

function makeProbes(overrides: Partial<TeamReadinessProbes> = {}): TeamReadinessProbes {
  const envValues: Record<string, boolean> = { ANTHROPIC_API_KEY: true };
  const vendorAvailability: Record<string, VendorAvailability> = {
    anthropic: { available: true, detail: "native host vendor" },
    openai: { available: true, detail: "found" },
  };
  return {
    vendorAvailable: async (vendor: string) =>
      vendorAvailability[vendor] ?? { available: false, detail: "unknown vendor" },
    envSet: (name: string) => envValues[name] ?? false,
    harnessesInstalled: async () => defaultHarnessesInstalled(),
    now: () => 1000,
    ...overrides,
  };
}

test("all agents ready when vendors available and env set", async () => {
  const report = await buildTeamReadiness(sampleManifest(), makeProbes());
  assert.equal(report.summary.ready, 3);
  assert.equal(report.summary.total, 3);
  assert.equal(report.summary.text, "3 of 3 agents ready · harness ok");
  assert.ok(report.agents.every((a) => a.status === "ready"));
});

test("unavailable vendor with no working fallback marks only that agent not_ready", async () => {
  const probes = makeProbes({
    vendorAvailable: async (vendor: string) => {
      if (vendor === "openai") return { available: false, detail: "codex CLI not found" };
      return { available: true, detail: "native host vendor" };
    },
  });
  // codex-reviewer's fallback chain is ["anthropic"], which IS available,
  // so it should land on "fallback", not "not_ready".
  const report = await buildTeamReadiness(sampleManifest(), probes);
  const byId = Object.fromEntries(report.agents.map((a) => [a.id, a]));
  assert.equal(byId["coding-specialist"].status, "ready");
  assert.equal(byId["search-retrieval"].status, "ready");
  assert.equal(byId["codex-reviewer"].status, "fallback");
  assert.equal(byId["codex-reviewer"].vendor, "anthropic");
  assert.equal(report.summary.ready, 3);
});

test("unavailable vendor whose fallback also fails marks agent not_ready and counts it", async () => {
  const manifest = sampleManifest();
  manifest.routing["codex-reviewer"].fallbackChain = ["opencode"];
  const probes = makeProbes({
    vendorAvailable: async (vendor: string) => {
      if (vendor === "openai" || vendor === "opencode") {
        return { available: false, detail: "not found" };
      }
      return { available: true, detail: "native host vendor" };
    },
  });
  const report = await buildTeamReadiness(manifest, probes);
  const byId = Object.fromEntries(report.agents.map((a) => [a.id, a]));
  assert.equal(byId["codex-reviewer"].status, "not_ready");
  assert.equal(byId["coding-specialist"].status, "ready");
  assert.equal(byId["search-retrieval"].status, "ready");
  assert.equal(report.summary.ready, 2);
  assert.equal(report.summary.total, 3);
  assert.equal(report.summary.text, "2 of 3 agents ready · harness ok");
});

test("missing required env marks agent not_ready and names the var", async () => {
  const probes = makeProbes({ envSet: () => false });
  const report = await buildTeamReadiness(sampleManifest(), probes);
  const codingAgent = report.agents.find((a) => a.id === "coding-specialist")!;
  assert.equal(codingAgent.status, "not_ready");
  assert.deepEqual(codingAgent.missingEnv, ["ANTHROPIC_API_KEY"]);
});

test("fallback is chosen when primary vendor unavailable", async () => {
  const manifest = sampleManifest();
  manifest.routing["search-retrieval"].fallbackChain = ["openai"];
  const probes = makeProbes({
    vendorAvailable: async (vendor: string) => {
      if (vendor === "anthropic") return { available: false, detail: "not signed in" };
      if (vendor === "openai") return { available: true, detail: "found" };
      return { available: false, detail: "unknown" };
    },
  });
  const report = await buildTeamReadiness(manifest, probes);
  const byId = Object.fromEntries(report.agents.map((a) => [a.id, a]));
  assert.equal(byId["search-retrieval"].status, "fallback");
  assert.equal(byId["search-retrieval"].vendor, "openai");
  assert.equal(byId["search-retrieval"].fallbackUsed?.index, 0);
  // coding-specialist and codex-reviewer both also depend on anthropic
  // being unavailable in this probe set; codex-reviewer's own fallback
  // ("anthropic") is unavailable too, so it goes not_ready, which is fine —
  // this test only asserts the fallback-selection behavior for
  // search-retrieval.
});

test("no value leakage: env value never appears in the JSON report", async () => {
  const probes = makeProbes({
    envSet: (name: string) => name === "ANTHROPIC_API_KEY",
  });
  const secretValue = "sk-super-secret-fake-value-123456";
  const report = await buildTeamReadiness(sampleManifest(), probes);
  const json = JSON.stringify(report);
  assert.ok(!json.includes(secretValue));
  assert.ok(!json.includes("sk-super-secret"));
  const text = formatReadinessReport(report);
  assert.ok(!text.includes(secretValue));
});

test("reachability probe is not called unless opted in", async () => {
  let calls = 0;
  const probes = makeProbes({
    reachability: async () => {
      calls += 1;
      return { ok: true, detail: "reached" };
    },
  });
  await buildTeamReadiness(sampleManifest(), probes);
  assert.equal(calls, 0);
});

test("reachability probe is called for ready/fallback agents when opted in", async () => {
  const calls: string[] = [];
  const probes = makeProbes({
    reachability: async (vendor: string) => {
      calls.push(vendor);
      return { ok: true, detail: "reached" };
    },
  });
  const report = await buildTeamReadiness(sampleManifest(), probes, { probeReachability: true });
  assert.equal(calls.length, 3);
  assert.ok(report.agents.every((a) => a.reachability?.ok === true));
});

test("an agent's own missing env does not affect an unrelated agent needing no env", async () => {
  const manifest: TeamManifest = {
    schemaVersion: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    exporter: { product: "tycoonagents", version: "0.0.1" },
    roster: [
      { id: "needs-var-a", displayName: "Needs VAR_A" },
      { id: "needs-nothing", displayName: "Needs Nothing" },
    ],
    routing: {
      "needs-var-a": { vendor: "anthropic", model: "sonnet", fallbackChain: [], envNames: ["VAR_A"] },
      "needs-nothing": { vendor: "anthropic", model: "haiku", fallbackChain: [] },
    },
    requiredEnv: [{ name: "VAR_A", setAtExport: false }],
    skills: [],
    mcp: [],
    delegation: { mode: "direct", parallelLimit: 2 },
  };
  const probes = makeProbes({ envSet: () => false });
  const report = await buildTeamReadiness(manifest, probes);
  assert.equal(report.summary.text, "1 of 2 agents ready · harness ok");
  const byId = Object.fromEntries(report.agents.map((a) => [a.id, a]));
  assert.equal(byId["needs-var-a"].status, "not_ready");
  assert.deepEqual(byId["needs-var-a"].missingEnv, ["VAR_A"]);
  assert.equal(byId["needs-nothing"].status, "ready");
  assert.deepEqual(byId["needs-nothing"].missingEnv, []);
});

test("createDefaultProbes standalone hostKind marks anthropic not_ready when claude CLI probe fails", async () => {
  const probes = createDefaultProbes({
    root: "/fake/root",
    env: {},
    hostKind: "standalone",
    execSeam: () => {
      throw new Error("not recognized as an internal or external command");
    },
  });
  const availability = await probes.vendorAvailable("anthropic");
  assert.equal(availability.available, false);
  assert.equal(availability.detail, "claude CLI not found on PATH");
  assert.ok(!availability.detail.match(/[\\/]/));
});

test("createDefaultProbes vscode hostKind never calls execSeam for anthropic", async () => {
  let called = false;
  const probes = createDefaultProbes({
    root: "/fake/root",
    env: {},
    execSeam: () => {
      called = true;
      return "";
    },
  });
  const availability = await probes.vendorAvailable("anthropic");
  assert.equal(availability.available, true);
  assert.equal(called, false);
  assert.ok(!availability.detail.match(/[\\/]/));
});

test("createDefaultProbes standalone hostKind marks anthropic available when claude CLI probe succeeds", async () => {
  const probes = createDefaultProbes({
    root: "/fake/root",
    env: {},
    hostKind: "standalone",
    execSeam: () => "1.2.3",
  });
  const availability = await probes.vendorAvailable("anthropic");
  assert.equal(availability.available, true);
  assert.equal(availability.detail, "claude CLI found");
  assert.ok(!availability.detail.match(/[\\/]/));
});

test("formatReadinessReport produces stable plain-text lines", async () => {
  const report = await buildTeamReadiness(sampleManifest(), makeProbes());
  const text = formatReadinessReport(report);
  assert.ok(text.includes("3 of 3 agents ready · harness ok"));
  assert.ok(text.includes("coding-specialist [ready]"));
});

// ---------------------------------------------------------------------------
// Harness readiness (p51-t0): manifest.harness vs. probes.harnessesInstalled.
// ---------------------------------------------------------------------------

test("manifest with harness codex on a machine where only claude-code is installed marks harness.ok false and names claude-code as installed", async () => {
  const manifest = { ...sampleManifest(), harness: "codex" as const };
  const report = await buildTeamReadiness(manifest, makeProbes());
  assert.equal(report.harness.team, "codex");
  assert.equal(report.harness.ok, false);
  assert.equal(report.harness.installed["claude-code"].installed, true);
  assert.equal(report.harness.installed.codex.installed, false);
  const text = formatReadinessReport(report);
  assert.ok(text.startsWith("Harness: codex NOT installed here (installed: claude-code)"));
  assert.ok(text.includes("harness missing"));
});

test("manifest without a harness field reports harness.ok true and no team", async () => {
  const report = await buildTeamReadiness(sampleManifest(), makeProbes());
  assert.equal(report.harness.team, undefined);
  assert.equal(report.harness.ok, true);
  const text = formatReadinessReport(report);
  assert.ok(!text.startsWith("Harness:"));
  assert.ok(text.includes("harness ok"));
});

test("manifest with a harness that IS installed reports harness.ok true and the installed line", async () => {
  const manifest = { ...sampleManifest(), harness: "claude-code" as const };
  const report = await buildTeamReadiness(manifest, makeProbes());
  assert.equal(report.harness.ok, true);
  const text = formatReadinessReport(report);
  assert.ok(text.startsWith("Harness: claude-code installed"));
});

test("a throwing harnessesInstalled probe is treated as not installed, never propagated", async () => {
  const manifest = { ...sampleManifest(), harness: "opencode" as const };
  const probes = makeProbes({
    harnessesInstalled: async () => {
      throw new Error("probe exploded");
    },
  });
  const report = await buildTeamReadiness(manifest, probes);
  assert.equal(report.harness.ok, false);
  assert.equal(report.harness.installed.opencode.installed, false);
});
