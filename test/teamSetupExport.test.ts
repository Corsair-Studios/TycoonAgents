/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Integration tests for exportTeamSetup (plan task p48-t4), src/host/vscode/
// teamSetupHost.ts — the full assemble->build->validate->write chain against
// a fixture project root (agents, routing.json, .mcp.json, skills, CLAUDE.md,
// plan.json). teamSetup.ts's builder/validator/serializer are already unit
// tested in test/teamSetup.test.ts; this file exercises the host wiring that
// reads real files (loadAgentRoster, buildRoutingView, readExecutionConfig,
// listSkillIds/listMcpIds/planPointerIfExists) and writes tycoon-team.json.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { exportTeamSetup } from "../src/host/vscode/teamSetupHost";
import { parseTeamManifest } from "../src/core/teamSetup";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "team-setup-export-"));
}

function writeAgent(root: string, id: string, name: string, extraFrontmatter: string[] = []): void {
  const dir = path.join(root, ".claude", "agents");
  fs.mkdirSync(dir, { recursive: true });
  const fm = ["name: " + name, ...extraFrontmatter].join("\n");
  const content = `---\n${fm}\n---\n\n# ${name}\n\n## Role\nDoes things.\n`;
  fs.writeFileSync(path.join(dir, `${id}.md`), content, "utf8");
}

function seedFixtureProject(root: string): void {
  // Two agents.
  writeAgent(root, "coding-specialist", "Coding Specialist");
  writeAgent(root, "search-retrieval", "Search Retrieval");

  // routing.json: coding-specialist has a fallback chain + an env var
  // requirement (one set, one unset — set at export-call time via `env`).
  const routingDir = path.join(root, ".claude", "tycoon");
  fs.mkdirSync(routingDir, { recursive: true });
  fs.writeFileSync(
    path.join(routingDir, "routing.json"),
    JSON.stringify(
      {
        version: 1,
        agents: {
          "coding-specialist": {
            vendor: "anthropic",
            model: "sonnet",
            endpointEnv: "FIXTURE_ENDPOINT_URL",
            credentialEnv: "FIXTURE_API_KEY",
            fallback: [{ vendor: "anthropic", model: "haiku" }],
          },
          "search-retrieval": {
            vendor: "anthropic",
            model: "haiku",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  // .mcp.json with one server.
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { codex: { command: "codex", args: ["mcp-server"] } } }, null, 2),
    "utf8",
  );

  // One skill dir.
  const skillDir = path.join(root, ".claude", "skills", "git");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# git skill\n", "utf8");

  // CLAUDE.md with a parallel limit of 3.
  fs.writeFileSync(
    root + "/CLAUDE.md",
    "# Project Instructions\n\n## Execution Settings\n\n- **Parallel agent limit**: 3 — run at most 3 workers.\n",
    "utf8",
  );

  // plan.json present.
  fs.mkdirSync(path.join(root, ".claude", "tycoon"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "tycoon", "plan.json"), JSON.stringify({ phases: [] }), "utf8");
}

const FAKE_API_KEY_VALUE = "totally-fake-value-should-never-appear-9f8e7d";

test("export from a fixture project: manifest written, parses, roster/fallback/env/limit/plan all correct, no secret value or absolute path leaks", () => {
  const root = tmpRoot();
  try {
    seedFixtureProject(root);

    const env: NodeJS.ProcessEnv = { ...process.env, FIXTURE_API_KEY: FAKE_API_KEY_VALUE };
    delete env.FIXTURE_ENDPOINT_URL; // left unset on purpose

    const result = exportTeamSetup({ root, env, version: "0.0.1" });
    assert.equal(result.ok, true, `export failed: ${(result as { error?: string }).error}`);
    assert.equal(result.path, ".claude/tycoon-team.json");

    const absPath = path.join(root, ".claude", "tycoon-team.json");
    assert.ok(fs.existsSync(absPath), "manifest file must exist");
    const text = fs.readFileSync(absPath, "utf8");

    const parsed = parseTeamManifest(text);
    assert.equal(parsed.ok, true, parsed.ok ? "" : `${parsed.field}: ${parsed.reason}`);
    if (!parsed.ok) return;
    const manifest = parsed.manifest;

    // Roster sorted by id.
    assert.deepEqual(
      manifest.roster.map((r) => r.id),
      ["coding-specialist", "search-retrieval"],
    );

    // Fallback chain populated for coding-specialist.
    assert.deepEqual(manifest.routing["coding-specialist"].fallbackChain, ["anthropic/haiku"]);

    // requiredEnv: FIXTURE_API_KEY set, FIXTURE_ENDPOINT_URL unset.
    const byName = new Map(manifest.requiredEnv.map((e) => [e.name, e.setAtExport]));
    assert.equal(byName.get("FIXTURE_API_KEY"), true);
    assert.equal(byName.get("FIXTURE_ENDPOINT_URL"), false);

    // The fake env VALUE never appears anywhere in the written file.
    assert.ok(!text.includes(FAKE_API_KEY_VALUE), "env var value must never be written to the manifest");

    assert.equal(manifest.delegation.parallelLimit, 3);
    assert.equal(manifest.planPointer, ".claude/tycoon/plan.json");
    assert.ok(manifest.skills.includes("git"));
    assert.ok(manifest.mcp.includes("codex"));

    // No absolute path substring of the temp root leaks into the file.
    assert.ok(!text.includes(root), "manifest must not contain the project's absolute root path");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("export populates harness from the caller's already-resolved value, and omits it when not passed", () => {
  const root = tmpRoot();
  try {
    seedFixtureProject(root);
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.FIXTURE_ENDPOINT_URL;

    const withHarness = exportTeamSetup({ root, env, version: "0.0.1", harness: "codex" });
    assert.equal(withHarness.ok, true);
    let manifest = parseTeamManifest(fs.readFileSync(path.join(root, ".claude", "tycoon-team.json"), "utf8"));
    assert.equal(manifest.ok, true);
    if (manifest.ok) assert.equal(manifest.manifest.harness, "codex");

    const withoutHarness = exportTeamSetup({ root, env, version: "0.0.1" });
    assert.equal(withoutHarness.ok, true);
    manifest = parseTeamManifest(fs.readFileSync(path.join(root, ".claude", "tycoon-team.json"), "utf8"));
    assert.equal(manifest.ok, true);
    if (manifest.ok) assert.equal(manifest.manifest.harness, undefined);

    const unrecognized = exportTeamSetup({ root, env, version: "0.0.1", harness: "some-other-vendor" });
    assert.equal(unrecognized.ok, true);
    manifest = parseTeamManifest(fs.readFileSync(path.join(root, ".claude", "tycoon-team.json"), "utf8"));
    assert.equal(manifest.ok, true);
    if (manifest.ok) assert.equal(manifest.manifest.harness, undefined, "an unrecognized harness string must be dropped, never written raw");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validator refusal: a secret-shaped model id is rejected and never echoed", () => {
  const root = tmpRoot();
  try {
    seedFixtureProject(root);
    // Overwrite routing.json so coding-specialist's model looks like a secret.
    const secret = "sk-" + "a".repeat(24);
    fs.writeFileSync(
      path.join(root, ".claude", "tycoon", "routing.json"),
      JSON.stringify(
        {
          version: 1,
          agents: {
            "coding-specialist": { vendor: "anthropic", model: secret },
            "search-retrieval": { vendor: "anthropic", model: "haiku" },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = exportTeamSetup({ root, env: process.env, version: "0.0.1" });
    assert.equal(result.ok, false, "export must be refused when a secret-shaped string is present");
    assert.ok(result.error, "error must be present");
    assert.ok(!result.error!.includes(secret), "error must never echo the secret value");
    assert.match(result.error!, /routing/, "error should name the offending field (routing.*)");

    assert.ok(!fs.existsSync(path.join(root, ".claude", "tycoon-team.json")), "no manifest should be written on refusal");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("determinism: exporting twice yields byte-identical files except the exportedAt line", () => {
  const root = tmpRoot();
  try {
    seedFixtureProject(root);
    const env: NodeJS.ProcessEnv = { ...process.env, FIXTURE_API_KEY: FAKE_API_KEY_VALUE };
    delete env.FIXTURE_ENDPOINT_URL;

    const r1 = exportTeamSetup({ root, env, version: "0.0.1" });
    assert.equal(r1.ok, true);
    const text1 = fs.readFileSync(path.join(root, ".claude", "tycoon-team.json"), "utf8");

    const r2 = exportTeamSetup({ root, env, version: "0.0.1" });
    assert.equal(r2.ok, true);
    const text2 = fs.readFileSync(path.join(root, ".claude", "tycoon-team.json"), "utf8");

    const stripExportedAt = (s: string) => s.replace(/"exportedAt":\s*"[^"]*"/, '"exportedAt":"STAMP"');
    assert.equal(stripExportedAt(text1), stripExportedAt(text2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing .claude/ dir: export still creates the manifest", () => {
  const root = tmpRoot();
  try {
    // Deliberately do not seed .claude/ at all — an empty project root.
    const result = exportTeamSetup({ root, env: process.env, version: "0.0.1" });
    assert.equal(result.ok, true, `export failed: ${(result as { error?: string }).error}`);
    assert.ok(fs.existsSync(path.join(root, ".claude", "tycoon-team.json")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
