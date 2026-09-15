/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Host-wiring tests for buildTeamReadinessHost and getTeamSetupDriftHost
// (plan task p50-t3), src/host/vscode/teamSetupHost.ts. The pure readiness
// builder (buildTeamReadiness/createDefaultProbes) lives in
// src/core/teamReadiness.ts and is exercised here only through the host
// wrapper, via an injected execSeam — no real spawns. Fixture pattern
// follows test/teamSetupExport.test.ts.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildTeamReadinessHost, getTeamSetupDriftHost } from "../src/host/vscode/teamSetupHost";
import { buildTeamManifest, serializeTeamManifest, type TeamManifestInput } from "../src/core/teamSetup";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "team-readiness-host-"));
}

/** Writes a minimal valid .claude/tycoon-team.json with two roster entries:
 *  a codex-routed agent and an anthropic-routed agent requiring FAKE_VAR. */
function seedManifest(root: string, exportedAt?: string, harness?: "claude-code" | "codex" | "opencode"): void {
  const input: TeamManifestInput = {
    roster: [
      { id: "coding-specialist", displayName: "Coding Specialist" },
      { id: "search-retrieval", displayName: "Search Retrieval" },
    ],
    routing: {
      "coding-specialist": { vendor: "codex", model: "gpt-5", fallbackChain: [] },
      "search-retrieval": { vendor: "anthropic", model: "haiku", fallbackChain: [], envNames: ["FAKE_VAR"] },
    },
    requiredEnv: [{ name: "FAKE_VAR", setAtExport: false }],
    skills: [],
    mcp: [],
    delegation: { mode: "flat", parallelLimit: 2 },
    ...(harness ? { harness } : {}),
  };
  const manifest = buildTeamManifest(input, {
    now: exportedAt ?? new Date().toISOString(),
    version: "0.0.1",
  });
  const dir = path.join(root, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "tycoon-team.json"), serializeTeamManifest(manifest), "utf8");
}

function readManifestExportedAt(root: string): string {
  const text = fs.readFileSync(path.join(root, ".claude", "tycoon-team.json"), "utf8");
  return (JSON.parse(text) as { exportedAt: string }).exportedAt;
}

const FAKE_VALUE = "totally-fake-readiness-value-8b7c6d";
const FAKE_ABS_PATH_WIN = "C:\\Users\\fakeuser\\AppData\\fake\\claude.exe";
const FAKE_ABS_PATH_POSIX = "/Users/fakeuser/.local/bin/claude";

test("readiness: codex fails, anthropic missing env -> 0 of 2; setting FAKE_VAR -> 1 of 2; no value leak", async () => {
  const root = tmpRoot();
  try {
    seedManifest(root);

    // Fails only for codex discovery; succeeds for the "claude" CLI probe
    // (standalone hostKind checks anthropic availability via execSeam too),
    // so the anthropic agent's readiness turns only on FAKE_VAR below.
    const failingExecSeam = (command: string): string => {
      if (command.includes("codex")) throw new Error("codex not found");
      return "1.0.0";
    };

    const baseEnv: NodeJS.ProcessEnv = { ...process.env };
    delete baseEnv.FAKE_VAR;

    const r1 = await buildTeamReadinessHost({
      root,
      env: baseEnv,
      hostKind: "standalone",
      execSeam: failingExecSeam,
    });
    assert.equal(r1.ok, true, r1.error);
    assert.ok(r1.report);
    assert.equal(r1.report!.summary.text, "0 of 2 agents ready · harness ok");
    const byId1 = new Map(r1.report!.agents.map((a) => [a.id, a]));
    assert.equal(byId1.get("coding-specialist")!.status, "not_ready");
    assert.equal(byId1.get("search-retrieval")!.status, "not_ready");
    assert.deepEqual(byId1.get("search-retrieval")!.missingEnv, ["FAKE_VAR"]);

    const envWithVar: NodeJS.ProcessEnv = { ...baseEnv, FAKE_VAR: FAKE_VALUE };
    const r2 = await buildTeamReadinessHost({
      root,
      env: envWithVar,
      hostKind: "standalone",
      execSeam: failingExecSeam,
    });
    assert.equal(r2.ok, true, r2.error);
    assert.equal(r2.report!.summary.text, "1 of 2 agents ready · harness ok");

    const payloadText = JSON.stringify(r2.report);
    assert.ok(!payloadText.includes(FAKE_VALUE), "env var value must never appear in the readiness payload");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readiness: manifest.harness codex on a machine with only claude-code installed reports harness.ok false and names claude-code installed", async () => {
  const root = tmpRoot();
  try {
    seedManifest(root, undefined, "codex");
    const execSeam = (command: string): string => {
      if (command.includes("codex")) throw new Error("codex not found");
      return "1.0.0"; // claude --version succeeds
    };
    const result = await buildTeamReadinessHost({
      root,
      env: { ...process.env, FAKE_VAR: "x" },
      hostKind: "standalone",
      execSeam,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.report!.harness.team, "codex");
    assert.equal(result.report!.harness.ok, false);
    assert.equal(result.report!.harness.installed["claude-code"].installed, true);
    assert.equal(result.report!.harness.installed.codex.installed, false);
    assert.ok(result.text!.startsWith("Harness: codex NOT installed here (installed: "));
    assert.ok(result.text!.split("\n")[0].includes("claude-code"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readiness: manifest with no harness field reports harness.ok true and no Harness line", async () => {
  const root = tmpRoot();
  try {
    seedManifest(root);
    const execSeam = (): string => "1.0.0";
    const result = await buildTeamReadinessHost({
      root,
      env: { ...process.env, FAKE_VAR: "x" },
      hostKind: "standalone",
      execSeam,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.report!.harness.team, undefined);
    assert.equal(result.report!.harness.ok, true);
    assert.ok(!result.text!.startsWith("Harness:"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readiness sanitization: an absolute path in a probe failure detail is scrubbed from the payload", async () => {
  const root = tmpRoot();
  try {
    seedManifest(root);

    const pathLeakingExecSeam = (_command: string): string => {
      throw new Error(`spawn failed: ${FAKE_ABS_PATH_WIN} not found, tried ${FAKE_ABS_PATH_POSIX}`);
    };

    const result = await buildTeamReadinessHost({
      root,
      env: { ...process.env, FAKE_VAR: "x" },
      hostKind: "standalone",
      execSeam: pathLeakingExecSeam,
    });
    assert.equal(result.ok, true, result.error);
    const payloadText = JSON.stringify(result.report);
    assert.ok(!/[A-Za-z]:[\\/]/.test(payloadText), "no drive-letter absolute path may appear in the payload");
    assert.ok(!payloadText.includes("/Users/"), "no /Users/ absolute path may appear in the payload");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("drift: no stamp -> drift true, hasManifest true; matching stamp -> drift false; edited exportedAt -> drift true; no manifest -> hasManifest false", () => {
  const root = tmpRoot();
  try {
    // No manifest at all.
    const noManifest = getTeamSetupDriftHost(root);
    assert.equal(noManifest.hasManifest, false);
    assert.equal(noManifest.drift, false);

    seedManifest(root);
    const exportedAt = readManifestExportedAt(root);

    // Manifest present, no stamp yet.
    const noStamp = getTeamSetupDriftHost(root);
    assert.equal(noStamp.hasManifest, true);
    assert.equal(noStamp.drift, true);
    assert.equal(noStamp.manifestExportedAt, exportedAt);

    // Stamp matches.
    const stampDir = path.join(root, ".claude", "tycoon");
    fs.mkdirSync(stampDir, { recursive: true });
    fs.writeFileSync(
      path.join(stampDir, "team-setup-applied.json"),
      JSON.stringify({ exportedAt, appliedAt: new Date().toISOString(), schemaVersion: 1 }),
      "utf8",
    );
    const matched = getTeamSetupDriftHost(root);
    assert.equal(matched.hasManifest, true);
    assert.equal(matched.drift, false);
    assert.equal(matched.appliedExportedAt, exportedAt);

    // Edit manifest's exportedAt so it no longer matches the stamp.
    const manifestPath = path.join(root, ".claude", "tycoon-team.json");
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    parsed.exportedAt = new Date(Date.now() + 1000).toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(parsed, null, 2), "utf8");

    const driftedAgain = getTeamSetupDriftHost(root);
    assert.equal(driftedAgain.hasManifest, true);
    assert.equal(driftedAgain.drift, true);
    assert.equal(driftedAgain.appliedExportedAt, exportedAt);
    assert.equal(driftedAgain.manifestExportedAt, parsed.exportedAt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
