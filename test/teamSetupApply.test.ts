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

    // Exported artifacts (manifest + CLAUDE.md) are shared/committed and must
    // stay portable: no machine-specific absolute path from A leaks into them.
    // Handles both raw filesystem paths (single backslash) and JSON-escaped
    // text read from a settings file (doubled backslash).
    const norm = (p: string): string => p.replace(/\\+/g, "/").toLowerCase();
    const claudeMdText = fs.readFileSync(path.join(rootB, "CLAUDE.md"), "utf8");
    for (const sharedText of [manifestText, claudeMdText]) {
      assert.ok(!/^[a-zA-Z]:[\\/]/m.test(sharedText), "exported artifact must not contain a drive letter absolute path");
      assert.ok(!sharedText.includes("/Users/"), "exported artifact must not contain a /Users/ path");
      assert.ok(!sharedText.includes("/home/"), "exported artifact must not contain a /home/ path");
      assert.ok(!norm(sharedText).includes(norm(rootA)), "exported artifact must not contain A's absolute root path");
    }

    // The hook command written into B is machine-specific by design: it is an
    // absolute path into B's own root, written only to the gitignored
    // settings.local.json — never shared, never pointing at A.
    const settingsPath = path.join(rootB, ".claude", "settings.local.json");
    assert.ok(fs.existsSync(settingsPath), "settings.local.json must exist (hook entry)");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const hookCommands: string[] = [];
    for (const entries of Object.values<any>(settings.hooks ?? {})) {
      for (const entry of entries) {
        for (const hook of entry.hooks ?? []) {
          if (typeof hook.command === "string") hookCommands.push(hook.command);
        }
      }
    }
    assert.ok(hookCommands.length > 0, "settings.local.json must contain at least one hook command");
    for (const command of hookCommands) {
      assert.ok(norm(command).includes(norm(rootB)), `hook command must be absolute and rooted in B: ${command}`);
      const needle = norm(path.join(".claude", "tycoon", "tycoon-claude-hook.cjs"));
      assert.ok(
        norm(command).endsWith(needle) || norm(command).endsWith(needle + '"'),
        `hook command must end with .claude/tycoon/tycoon-claude-hook.cjs: ${command}`,
      );
      assert.ok(!norm(command).includes(norm(rootA)), `hook command must not contain A's absolute root path: ${command}`);
    }

    const settingsSharedPath = path.join(rootB, ".claude", "settings.json");
    if (fs.existsSync(settingsSharedPath)) {
      const sharedSettings = JSON.parse(fs.readFileSync(settingsSharedPath, "utf8"));
      const sharedHookCommands: string[] = [];
      for (const entries of Object.values<any>(sharedSettings.hooks ?? {})) {
        for (const entry of entries) {
          for (const hook of entry.hooks ?? []) {
            if (typeof hook.command === "string") sharedHookCommands.push(hook.command);
          }
        }
      }
      for (const command of sharedHookCommands) {
        assert.ok(
          !command.includes("tycoon-claude-hook.cjs") || !norm(command).includes(norm(rootB)),
          `settings.json (shared) must not carry an absolute-path Tycoon hook command: ${command}`,
        );
      }
    }

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

test("routing.json already exists: apply skips routing entirely, local fields and manifest-managed fields both left untouched", () => {
  const rootA = tmpRoot();
  const rootB = tmpRoot();
  try {
    seedFixtureProject(rootA);
    exportTeamSetup({ root: rootA, env: process.env, version: "0.0.1" });
    fs.mkdirSync(path.join(rootB, ".claude", "tycoon"), { recursive: true });
    fs.copyFileSync(path.join(rootA, ".claude", "tycoon-team.json"), path.join(rootB, ".claude", "tycoon-team.json"));
    fs.copyFileSync(path.join(rootA, "CLAUDE.md"), path.join(rootB, "CLAUDE.md"));

    const localRoutingText = JSON.stringify(
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
    );
    fs.writeFileSync(path.join(rootB, ".claude", "tycoon", "routing.json"), localRoutingText, "utf8");

    const report = apply(rootB);
    assert.equal(report.ok, true, report.error);
    const routingStep = report.steps.find((s) => s.name === "routing");
    assert.equal(routingStep?.status, "skipped");
    assert.equal(routingStep?.detail, "local routing kept");

    // routing.json is byte-identical: the manifest's model ("sonnet") is
    // never written over the local value, and the local-only field survives
    // untouched because the whole step is skipped.
    const routingAfter = fs.readFileSync(path.join(rootB, ".claude", "tycoon", "routing.json"), "utf8");
    assert.equal(routingAfter, localRoutingText);

    const stamp = JSON.parse(
      fs.readFileSync(path.join(rootB, ".claude", "tycoon", "team-setup-applied.json"), "utf8"),
    );
    assert.equal(stamp.routingSeeded, false);
    assert.equal(typeof stamp.rosterHash, "string");
    assert.ok(stamp.rosterHash.length > 0);
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test("fresh clone: first apply seeds routing.json from the manifest and stamps routingSeeded:true", () => {
  const rootA = tmpRoot();
  const rootB = tmpRoot();
  try {
    seedFixtureProject(rootA);
    exportTeamSetup({ root: rootA, env: process.env, version: "0.0.1" });
    fs.mkdirSync(path.join(rootB, ".claude"), { recursive: true });
    fs.copyFileSync(path.join(rootA, ".claude", "tycoon-team.json"), path.join(rootB, ".claude", "tycoon-team.json"));
    fs.copyFileSync(path.join(rootA, "CLAUDE.md"), path.join(rootB, "CLAUDE.md"));
    assert.ok(!fs.existsSync(path.join(rootB, ".claude", "tycoon", "routing.json")));

    const report = apply(rootB);
    assert.equal(report.ok, true, report.error);
    const routingStep = report.steps.find((s) => s.name === "routing");
    assert.equal(routingStep?.status, "done");
    assert.equal(routingStep?.detail, "seeded routing from manifest");

    const routing = JSON.parse(fs.readFileSync(path.join(rootB, ".claude", "tycoon", "routing.json"), "utf8"));
    assert.equal(routing.agents["coding-specialist"].model, "sonnet");

    const stamp = JSON.parse(
      fs.readFileSync(path.join(rootB, ".claude", "tycoon", "team-setup-applied.json"), "utf8"),
    );
    assert.equal(stamp.routingSeeded, true);
    assert.equal(typeof stamp.rosterHash, "string");
    assert.ok(stamp.rosterHash.length > 0);
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test("zero-byte routing.json: treated as unreadable, seeded from manifest, routingSeeded true", () => {
  const rootA = tmpRoot();
  const rootB = tmpRoot();
  try {
    seedFixtureProject(rootA);
    exportTeamSetup({ root: rootA, env: process.env, version: "0.0.1" });
    fs.mkdirSync(path.join(rootB, ".claude", "tycoon"), { recursive: true });
    fs.copyFileSync(path.join(rootA, ".claude", "tycoon-team.json"), path.join(rootB, ".claude", "tycoon-team.json"));
    fs.copyFileSync(path.join(rootA, "CLAUDE.md"), path.join(rootB, "CLAUDE.md"));
    fs.writeFileSync(path.join(rootB, ".claude", "tycoon", "routing.json"), "", "utf8");

    const report = apply(rootB);
    assert.equal(report.ok, true, report.error);
    const routingStep = report.steps.find((s) => s.name === "routing");
    assert.equal(routingStep?.status, "done");
    assert.equal(routingStep?.detail, "seeded: local routing file was unreadable");

    const routing = JSON.parse(fs.readFileSync(path.join(rootB, ".claude", "tycoon", "routing.json"), "utf8"));
    assert.equal(routing.agents["coding-specialist"].model, "sonnet");

    const stamp = JSON.parse(
      fs.readFileSync(path.join(rootB, ".claude", "tycoon", "team-setup-applied.json"), "utf8"),
    );
    assert.equal(stamp.routingSeeded, true);
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
