/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// End-to-end loop test for plan task p51-t2: export -> copy manifest to a
// fresh root -> drift -> apply -> drift clears -> readiness -> re-export ->
// drift again. Exercises the committed host wiring in
// src/host/vscode/teamSetupHost.ts (exportTeamSetup / applyTeamSetupHost /
// buildTeamReadinessHost / getTeamSetupDriftHost) end to end against real
// fixture project roots. Asserts structure (roster count, drift booleans,
// no leaked absolute paths/secret values) rather than exact summary text,
// since src/core/teamSetup*.ts / teamReadiness.ts / teamSetupHost.ts are
// under concurrent edit elsewhere in this plan task.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  exportTeamSetup,
  applyTeamSetupHost,
  buildTeamReadinessHost,
  getTeamSetupDriftHost,
} from "../src/host/vscode/teamSetupHost";

// Repo hooks/ dir, resolved relative to this test file (test/ -> ..).
const HOOK_SOURCE_DIR = path.resolve(__dirname, "..", "hooks");

function tmpRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeAgent(root: string, id: string, name: string): void {
  const dir = path.join(root, ".claude", "agents");
  fs.mkdirSync(dir, { recursive: true });
  const content = `---\nname: ${name}\n---\n\n# ${name}\n\n## Role\nDoes things.\n`;
  fs.writeFileSync(path.join(dir, `${id}.md`), content, "utf8");
}

const ROSTER_IDS = ["coding-specialist", "search-retrieval"];

function seedFixtureProject(root: string, extraSkill?: string): void {
  writeAgent(root, "coding-specialist", "Coding Specialist");
  writeAgent(root, "search-retrieval", "Search Retrieval");

  const routingDir = path.join(root, ".claude", "tycoon");
  fs.mkdirSync(routingDir, { recursive: true });
  fs.writeFileSync(
    path.join(routingDir, "routing.json"),
    JSON.stringify(
      {
        version: 1,
        agents: {
          "coding-specialist": { vendor: "anthropic", model: "sonnet" },
          "search-retrieval": { vendor: "anthropic", model: "haiku" },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: {} }, null, 2),
    "utf8",
  );

  const skillDir = path.join(root, ".claude", "skills", extraSkill ?? "git");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# skill\n", "utf8");

  fs.writeFileSync(
    root + "/CLAUDE.md",
    "# Project Instructions\n\n## Execution Settings\n\n- **Parallel agent limit**: 2 — run at most 2 workers.\n",
    "utf8",
  );
}

/** Copies only the two files the applied side needs from A to B: the manifest and CLAUDE.md. */
function copyManifestOnly(fromRoot: string, toRoot: string): void {
  const manifestRel = path.join(".claude", "tycoon-team.json");
  fs.mkdirSync(path.join(toRoot, ".claude"), { recursive: true });
  fs.copyFileSync(path.join(fromRoot, manifestRel), path.join(toRoot, manifestRel));
  fs.copyFileSync(path.join(fromRoot, "CLAUDE.md"), path.join(toRoot, "CLAUDE.md"));
}

function assertNoLeaks(payload: unknown, roots: string[]): void {
  const text = JSON.stringify(payload);
  for (const root of roots) {
    assert.ok(!text.includes(root), `payload leaked absolute root path: ${root}`);
  }
  assert.ok(!text.includes(FAKE_ENV_VALUE), "payload leaked injected fake env value");
}

const FAKE_ENV_VALUE = "totally-fake-loop-secret-9f8e7d6c";

test("export -> drift -> apply -> readiness -> re-export -> drift, end to end (p51-t2)", async () => {
  const rootA = tmpRoot("team-setup-loop-a-");
  const rootB = tmpRoot("team-setup-loop-b-");
  try {
    seedFixtureProject(rootA);

    const env: NodeJS.ProcessEnv = { ...process.env, FIXTURE_SECRET: FAKE_ENV_VALUE };

    // 1. Export from A.
    const exportResult1 = exportTeamSetup({ root: rootA, env, version: "0.0.1" });
    assert.equal(exportResult1.ok, true, `export A failed: ${(exportResult1 as { error?: string }).error}`);

    // 2. Copy ONLY the manifest + CLAUDE.md to a fresh root B.
    copyManifestOnly(rootA, rootB);

    // 3. B has never been applied: drift must be true, no stamp yet.
    const driftBefore = getTeamSetupDriftHost(rootB);
    assert.equal(driftBefore.hasManifest, true);
    assert.equal(driftBefore.drift, true);
    assert.equal(driftBefore.appliedExportedAt, undefined);
    assertNoLeaks(driftBefore, [rootA, rootB]);

    // 4. Apply on B.
    const applyResult = applyTeamSetupHost({
      root: rootB,
      env,
      version: "0.0.1",
      hookSourceDir: HOOK_SOURCE_DIR,
    });
    assert.equal(applyResult.ok, true, `apply B failed: ${JSON.stringify(applyResult)}`);
    assertNoLeaks(applyResult, [rootA, rootB]);

    // 5. Drift clears after apply.
    const driftAfter = getTeamSetupDriftHost(rootB);
    assert.equal(driftAfter.hasManifest, true);
    assert.equal(driftAfter.drift, false);
    assert.equal(driftAfter.appliedExportedAt, driftAfter.manifestExportedAt);

    // 6. Readiness on B with an execSeam that always fails (no vendor CLIs
    // reachable) — one entry per roster id regardless of status, and
    // summary.total equals the roster size.
    const failingExecSeam = (): string => {
      throw new Error("no CLI available in this sandbox");
    };
    const readinessResult = await buildTeamReadinessHost({
      root: rootB,
      env,
      hostKind: "standalone",
      execSeam: failingExecSeam,
    });
    assert.equal(readinessResult.ok, true, `readiness failed: ${readinessResult.error}`);
    const report = readinessResult.report!;
    assert.equal(report.agents.length, ROSTER_IDS.length);
    assert.deepEqual(
      report.agents.map((a) => a.id).sort(),
      [...ROSTER_IDS].sort(),
    );
    assert.equal(report.summary.total, ROSTER_IDS.length);
    assertNoLeaks(report, [rootA, rootB]);
    assertNoLeaks(readinessResult.text, [rootA, rootB]);

    // 7. Edit A (add a second skill), re-export, copy the fresh manifest to
    // B -> drift must flip true again (exportedAt changed).
    fs.mkdirSync(path.join(rootA, ".claude", "skills", "godot"), { recursive: true });
    fs.writeFileSync(path.join(rootA, ".claude", "skills", "godot", "SKILL.md"), "# godot\n", "utf8");

    const exportResult2 = exportTeamSetup({ root: rootA, env, version: "0.0.2" });
    assert.equal(exportResult2.ok, true, `re-export A failed: ${(exportResult2 as { error?: string }).error}`);

    fs.copyFileSync(
      path.join(rootA, ".claude", "tycoon-team.json"),
      path.join(rootB, ".claude", "tycoon-team.json"),
    );

    const driftFinal = getTeamSetupDriftHost(rootB);
    assert.equal(driftFinal.hasManifest, true);
    assert.equal(driftFinal.drift, true);
    assert.notEqual(driftFinal.manifestExportedAt, driftAfter.manifestExportedAt);
    assertNoLeaks(driftFinal, [rootA, rootB]);
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});
