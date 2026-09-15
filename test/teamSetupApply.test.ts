/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Integration tests for applyTeamSetup (plan task p49-t2). Exercises the
// real host binder (applyTeamSetupHost, src/host/vscode/teamSetupHost.ts)
// against exportTeamSetup-produced fixtures, proving the export->apply
// round trip on a fresh clone plus the idempotency/security/local-field
// preservation guarantees src/core/teamSetupApply.ts documents.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { exportTeamSetup } from "../src/host/vscode/teamSetupHost";
import { applyTeamSetupHost } from "../src/host/vscode/teamSetupHost";

function tmpRoot(prefix = "team-setup-apply-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeAgent(root: string, id: string, name: string, extraFrontmatter: string[] = []): void {
  const dir = path.join(root, ".claude", "agents");
  fs.mkdirSync(dir, { recursive: true });
  const fm = ["name: " + name, ...extraFrontmatter].join("\n");
  const content = `---\n${fm}\n---\n\n# ${name}\n\n## Role\nDoes things.\n`;
  fs.writeFileSync(path.join(dir, `${id}.md`), content, "utf8");
}

function seedFixtureProject(root: string): void {
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
          "coding-specialist": {
            vendor: "anthropic",
            model: "sonnet",
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

  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { codex: { command: "codex", args: ["mcp-server"] } } }, null, 2),
    "utf8",
  );

  const skillDir = path.join(root, ".claude", "skills", "git");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# git skill\n", "utf8");

  fs.writeFileSync(
    root + "/CLAUDE.md",
    "# Project Instructions\n\n## Execution Settings\n\n- **Parallel agent limit**: 2 — run at most 2 workers.\n",
    "utf8",
  );
}

const HOOK_SOURCE_DIR = path.join(__dirname, "..", "hooks");

function apply(rootB: string) {
  return applyTeamSetupHost({ root: rootB, env: process.env, version: "0.0.1", hookSourceDir: HOOK_SOURCE_DIR });
}

test("fresh clone: export from A, copy manifest+CLAUDE.md to empty root B, apply seeds agents/routing/hooks/stamp", () => {
  const rootA = tmpRoot("team-setup-apply-a-");
  const rootB = tmpRoot("team-setup-apply-b-");
  try {
    seedFixtureProject(rootA);
    const exportResult = exportTeamSetup({ root: rootA, env: process.env, version: "0.0.1" });
    assert.equal(exportResult.ok, true, `export failed: ${(exportResult as { error?: string }).error}`);

    // Copy only the manifest + CLAUDE.md into an empty root B.
    fs.mkdirSync(path.join(rootB, ".claude"), { recursive: true });
    fs.copyFileSync(
      path.join(rootA, ".claude", "tycoon-team.json"),
      path.join(rootB, ".claude", "tycoon-team.json"),
    );
    fs.copyFileSync(path.join(rootA, "CLAUDE.md"), path.join(rootB, "CLAUDE.md"));
    assert.ok(!fs.existsSync(path.join(rootB, ".claude", "agents")));
    assert.ok(!fs.existsSync(path.join(rootB, ".claude", "tycoon")));

    const manifestText = fs.readFileSync(path.join(rootB, ".claude", "tycoon-team.json"), "utf8");
    const manifest = JSON.parse(manifestText);

    const report = apply(rootB);
    assert.equal(report.ok, true, `apply failed: ${report.error}`);
    assert.equal(report.changed, true);
    assert.deepEqual(report.missingAgents, []);

    for (const id of ["coding-specialist", "search-retrieval"]) {
      assert.ok(fs.existsSync(path.join(rootB, ".claude", "agents", `${id}.md`)), `${id}.md must exist`);
    }

    const routing = JSON.parse(fs.readFileSync(path.join(rootB, ".claude", "tycoon", "routing.json"), "utf8"));
    for (const [id, managed] of Object.entries<{ vendor?: string; model?: string; fallbackChain: string[] }>(
      manifest.routing,
    )) {
      const slot = id === "orchestrator" ? routing.orchestrator : routing.agents[id];
      assert.ok(slot, `routing slot for ${id} must exist`);
      if (managed.vendor !== undefined) assert.equal(slot.vendor, managed.vendor);
      if (managed.model !== undefined) assert.equal(slot.model, managed.model);
    }

    const settingsPath = path.join(rootB, ".claude", "settings.local.json");
    assert.ok(fs.existsSync(settingsPath), "settings.local.json must exist (hook entry)");
    const settingsText = fs.readFileSync(settingsPath, "utf8");
    assert.ok(settingsText.includes(".claude/tycoon/tycoon-claude-hook.cjs"), "hook command must be project-relative");
    assert.ok(!settingsText.includes(rootB), "settings.local.json must not contain the project's absolute root path");

    const stampPath = path.join(rootB, ".claude", "tycoon", "team-setup-applied.json");
    assert.ok(fs.existsSync(stampPath));
    const stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
    assert.equal(stamp.exportedAt, manifest.exportedAt);
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test("bumped major schemaVersion: apply refused, error names the version, no routing/stamp/agents written", () => {
  const rootB = tmpRoot();
  try {
    fs.mkdirSync(path.join(rootB, ".claude"), { recursive: true });
    const manifest = {
      schemaVersion: 999,
      exportedAt: "2026-01-01T00:00:00.000Z",
      exporter: { product: "tycoonagents", version: "0.0.1" },
      roster: [{ id: "coding-specialist", displayName: "Coding Specialist" }],
      routing: {},
      requiredEnv: [],
      skills: [],
      mcp: [],
      delegation: { mode: "flat", parallelLimit: 2 },
    };
    fs.writeFileSync(path.join(rootB, ".claude", "tycoon-team.json"), JSON.stringify(manifest, null, 2), "utf8");

    const report = apply(rootB);
    assert.equal(report.ok, false);
    assert.match(report.error ?? "", /version/i);

    assert.ok(!fs.existsSync(path.join(rootB, ".claude", "tycoon", "routing.json")));
    assert.ok(!fs.existsSync(path.join(rootB, ".claude", "tycoon", "team-setup-applied.json")));
    assert.ok(!fs.existsSync(path.join(rootB, ".claude", "agents", "coding-specialist.md")));
  } finally {
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test("apply twice: second run reports changed:false and files unchanged", () => {
  const rootA = tmpRoot();
  const rootB = tmpRoot();
  try {
    seedFixtureProject(rootA);
    exportTeamSetup({ root: rootA, env: process.env, version: "0.0.1" });
    fs.mkdirSync(path.join(rootB, ".claude"), { recursive: true });
    fs.copyFileSync(path.join(rootA, ".claude", "tycoon-team.json"), path.join(rootB, ".claude", "tycoon-team.json"));
    fs.copyFileSync(path.join(rootA, "CLAUDE.md"), path.join(rootB, "CLAUDE.md"));

    const first = apply(rootB);
    assert.equal(first.ok, true);
    assert.equal(first.changed, true);

    const agentPath = path.join(rootB, ".claude", "agents", "coding-specialist.md");
    const routingPath = path.join(rootB, ".claude", "tycoon", "routing.json");
    const contentBefore = fs.readFileSync(agentPath, "utf8");
    const routingBefore = fs.readFileSync(routingPath, "utf8");
    const mtimeBefore = fs.statSync(agentPath).mtimeMs;

    const second = apply(rootB);
    assert.equal(second.ok, true);
    assert.equal(second.changed, false);

    assert.equal(fs.readFileSync(agentPath, "utf8"), contentBefore);
    assert.equal(fs.readFileSync(routingPath, "utf8"), routingBefore);
    assert.equal(fs.statSync(agentPath).mtimeMs, mtimeBefore);
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test("local-only routing fields survive apply: custom field kept, managed model updated", () => {
  const rootA = tmpRoot();
  const rootB = tmpRoot();
  try {
    seedFixtureProject(rootA);
    exportTeamSetup({ root: rootA, env: process.env, version: "0.0.1" });
    fs.mkdirSync(path.join(rootB, ".claude", "tycoon"), { recursive: true });
    fs.copyFileSync(path.join(rootA, ".claude", "tycoon-team.json"), path.join(rootB, ".claude", "tycoon-team.json"));
    fs.copyFileSync(path.join(rootA, "CLAUDE.md"), path.join(rootB, "CLAUDE.md"));

    fs.writeFileSync(
      path.join(rootB, ".claude", "tycoon", "routing.json"),
      JSON.stringify(
        {
          version: 1,
          agents: {
            "coding-specialist": {
              vendor: "anthropic",
              model: "some-old-local-model",
              mcpServer: "local-custom-tool",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const report = apply(rootB);
    assert.equal(report.ok, true, report.error);

    const routing = JSON.parse(fs.readFileSync(path.join(rootB, ".claude", "tycoon", "routing.json"), "utf8"));
    assert.equal(routing.agents["coding-specialist"].model, "sonnet");
    assert.equal(routing.agents["coding-specialist"].mcpServer, "local-custom-tool");
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test("malicious roster id (path traversal): apply refused, no file written outside .claude/agents", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "teamsetup-parent-"));
  const rootB = path.join(parent, "rootB");
  fs.mkdirSync(rootB, { recursive: true });
  try {
    fs.mkdirSync(path.join(rootB, ".claude"), { recursive: true });
    const manifest = {
      schemaVersion: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      exporter: { product: "tycoonagents", version: "0.0.1" },
      roster: [{ id: "../evil", displayName: "Evil" }],
      routing: {},
      requiredEnv: [],
      skills: [],
      mcp: [],
      delegation: { mode: "flat", parallelLimit: 2 },
    };
    fs.writeFileSync(path.join(rootB, ".claude", "tycoon-team.json"), JSON.stringify(manifest, null, 2), "utf8");

    const parentBefore = fs.readdirSync(parent);
    const report = apply(rootB);
    assert.equal(report.ok, false);
    const parentAfter = fs.readdirSync(parent);
    assert.deepEqual(parentAfter, parentBefore, "no file must be created outside root B");
    assert.deepEqual(parentAfter, ["rootB"], "parent must contain only root B");
    assert.ok(!fs.existsSync(path.join(rootB, ".claude", "agents")));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("no env values leak: fake secret in env passed to apply appears in no written file or report", () => {
  const rootA = tmpRoot();
  const rootB = tmpRoot();
  const FAKE_SECRET = "totally-fake-secret-value-should-never-appear-4d3c2b1a";
  try {
    seedFixtureProject(rootA);
    exportTeamSetup({ root: rootA, env: process.env, version: "0.0.1" });
    fs.mkdirSync(path.join(rootB, ".claude"), { recursive: true });
    fs.copyFileSync(path.join(rootA, ".claude", "tycoon-team.json"), path.join(rootB, ".claude", "tycoon-team.json"));
    fs.copyFileSync(path.join(rootA, "CLAUDE.md"), path.join(rootB, "CLAUDE.md"));

    const env = { ...process.env, TYCOON_TEST_FAKE_SECRET: FAKE_SECRET };
    const report = applyTeamSetupHost({ root: rootB, env, version: "0.0.1", hookSourceDir: HOOK_SOURCE_DIR });
    assert.equal(report.ok, true, report.error);
    assert.ok(!JSON.stringify(report).includes(FAKE_SECRET), "report must not contain the fake secret value");

    for (const rel of [
      [".claude", "tycoon", "routing.json"],
      [".claude", "settings.local.json"],
      [".claude", "tycoon", "team-setup-applied.json"],
    ]) {
      const p = path.join(rootB, ...rel);
      if (fs.existsSync(p)) {
        assert.ok(!fs.readFileSync(p, "utf8").includes(FAKE_SECRET), `${rel.join("/")} must not contain the fake secret`);
      }
    }
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});
