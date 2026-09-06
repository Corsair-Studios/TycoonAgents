/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for plan task p18-t3: src/core/agentSettingsRoute.ts.
// Same fake-scripts-dir technique as test/routingHostOps.test.ts so
// saveRoutingProfile's apply/generate step (invoked transitively by
// overrideAgentToClaudeTier) runs against temp dirs, never the real repo
// scripts or a shared machine-wide data dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeTierFromModel,
  describeAgentRoutes,
  describeRoutingVisibility,
  overrideAgentToClaudeTier,
} from "../src/core/agentSettingsRoute";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-settings-route-"));
}

function writeAgent(root: string, filename: string, frontmatterLines: string[], body = "Body text."): void {
  const dir = path.join(root, ".claude", "agents");
  fs.mkdirSync(dir, { recursive: true });
  const content = `---\n${frontmatterLines.join("\n")}\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(dir, filename), content, "utf8");
}

function writeRouting(root: string, obj: unknown): void {
  const dir = path.join(root, ".claude", "tycoon");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "routing.json"), JSON.stringify(obj, null, 2), "utf8");
}

function readRouting(root: string): unknown {
  const p = path.join(root, ".claude", "tycoon", "routing.json");
  if (!fs.existsSync(p)) return undefined;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function makeFakeScriptsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-settings-route-fake-scripts-"));
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  const body =
    "#!/usr/bin/env node\n" +
    "console.log('ARGS:' + process.argv.slice(2).join(' '));\n" +
    "process.exit(process.env.FAKE_EXIT_CODE ? Number(process.env.FAKE_EXIT_CODE) : 0);\n";
  fs.writeFileSync(path.join(dir, "scripts", "apply-routing-profile.mjs"), body, "utf8");
  fs.writeFileSync(path.join(dir, "scripts", "generate-opencode-config.mjs"), body, "utf8");
  return dir;
}

function withIsolatedStoreDirs<T>(fn: () => T): T {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-settings-route-store-"));
  const opencodeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-settings-route-opencode-"));
  const prevDataDir = process.env.TYCOON_STANDALONE_DATA_DIR;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  process.env.TYCOON_STANDALONE_DATA_DIR = dataDir;
  process.env.OPENCODE_CONFIG_DIR = opencodeConfigDir;
  try {
    return fn();
  } finally {
    if (prevDataDir === undefined) delete process.env.TYCOON_STANDALONE_DATA_DIR;
    else process.env.TYCOON_STANDALONE_DATA_DIR = prevDataDir;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
  }
}

// ---------------------------------------------------------------------------
// claudeTierFromModel
// ---------------------------------------------------------------------------

test("claudeTierFromModel: bare aliases", () => {
  assert.equal(claudeTierFromModel("opus"), "opus");
  assert.equal(claudeTierFromModel("sonnet"), "sonnet");
  assert.equal(claudeTierFromModel("haiku"), "haiku");
  assert.equal(claudeTierFromModel("fable"), "fable");
});

test("claudeTierFromModel: anthropic/<alias>", () => {
  assert.equal(claudeTierFromModel("anthropic/opus"), "opus");
  assert.equal(claudeTierFromModel("anthropic/sonnet"), "sonnet");
  assert.equal(claudeTierFromModel("anthropic/haiku"), "haiku");
  assert.equal(claudeTierFromModel("anthropic/fable"), "fable");
});

test("claudeTierFromModel: full ids with and without anthropic/ prefix", () => {
  assert.equal(claudeTierFromModel("claude-sonnet-4-6"), "sonnet");
  assert.equal(claudeTierFromModel("anthropic/claude-sonnet-4-6"), "sonnet");
  assert.equal(claudeTierFromModel("claude-fable-5-1"), "fable");
  assert.equal(claudeTierFromModel("anthropic/claude-fable-5-1"), "fable");
  assert.equal(claudeTierFromModel("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(claudeTierFromModel("anthropic/claude-haiku-4-5-20251001"), "haiku");
});

test("claudeTierFromModel: non-Claude and unrecognized models -> null", () => {
  assert.equal(claudeTierFromModel("google/gemini-2.5-pro"), null);
  assert.equal(claudeTierFromModel("ollama-windows/qwen3.8:27b"), null);
  assert.equal(claudeTierFromModel("opencode/big-pickle"), null);
  assert.equal(claudeTierFromModel(""), null);
  assert.equal(claudeTierFromModel("anthropic/unknown"), null);
});

// ---------------------------------------------------------------------------
// describeAgentRoutes
// ---------------------------------------------------------------------------

test("describeAgentRoutes: frontmatter model: sonnet -> claudeTier sonnet, routeSource frontmatter", () => {
  const root = tmpRoot();
  writeAgent(root, "coding-specialist.md", ["name: coding-specialist", "model: sonnet"]);

  const routes = describeAgentRoutes(root);
  const agent = routes["coding-specialist"];
  assert.ok(agent, "expected coding-specialist route entry");
  assert.equal(agent.claudeTier, "sonnet");
  assert.equal(agent.routeSource, "frontmatter");
  assert.equal(agent.vendor, "anthropic");
});

test("describeAgentRoutes: frontmatter model + hand-written backend block (non-Claude vendor)", () => {
  const root = tmpRoot();
  writeAgent(root, "gemini-reviewer.md", [
    "name: gemini-reviewer",
    "model: google/gemini-2.5-pro",
    "backend:",
    "  vendor: google",
    "  transport: mcp",
    "  mcpServer: gemini",
    "  model: google/gemini-2.5-pro",
    "  costModelClass: metered",
  ]);

  const routes = describeAgentRoutes(root);
  const agent = routes["gemini-reviewer"];
  assert.ok(agent, "expected gemini-reviewer route entry");
  assert.equal(agent.vendor, "google");
  assert.equal(agent.claudeTier, null);
  assert.equal(agent.handWrittenBackend, true);
  assert.equal(agent.routeSource, "frontmatter");
});

test("describeAgentRoutes: no frontmatter model/backend, routed via routing.json defaults to a local model", () => {
  const root = tmpRoot();
  writeAgent(root, "coding-specialist.md", ["name: coding-specialist"]);
  writeRouting(root, {
    version: 1,
    defaults: { vendor: "ollama-windows", transport: "openai-compatible", model: "ollama-windows/qwen3.8:27b", costModelClass: "local" },
    agents: {},
  });

  const routes = describeAgentRoutes(root);
  const agent = routes["coding-specialist"];
  assert.ok(agent, "expected coding-specialist route entry");
  assert.equal(agent.vendor, "ollama-windows");
  assert.equal(agent.claudeTier, null);
  assert.equal(agent.routeSource, "default");
});

test("describeAgentRoutes: explicit routing.json entry for the agent -> routeSource explicit", () => {
  const root = tmpRoot();
  writeAgent(root, "coding-specialist.md", ["name: coding-specialist", "model: sonnet"]);
  writeRouting(root, {
    version: 1,
    agents: {
      "coding-specialist": { vendor: "anthropic", transport: "claude-native", model: "opus", costModelClass: "subscription" },
    },
  });

  const routes = describeAgentRoutes(root);
  const agent = routes["coding-specialist"];
  assert.ok(agent, "expected coding-specialist route entry");
  assert.equal(agent.routeSource, "explicit");
  assert.equal(agent.claudeTier, "opus");
});

// ---------------------------------------------------------------------------
// describeRoutingVisibility
// ---------------------------------------------------------------------------

test("describeRoutingVisibility: harness opencode is always visible regardless of toggle", () => {
  const root = tmpRoot();
  const vFalse = describeRoutingVisibility(root, "opencode");
  assert.equal(vFalse.visible, true);
  assert.equal(vFalse.reason, "harness-opencode");
});

test("describeRoutingVisibility: harness claude, toggle off -> hidden", () => {
  const root = tmpRoot();
  const v = describeRoutingVisibility(root, "claude");
  assert.equal(v.visible, false);
  assert.equal(v.reason, "hidden");
  assert.equal(v.useMultipleLlms, false);
});

test("describeRoutingVisibility: harness claude, toggle on -> visible via toggle", () => {
  const root = tmpRoot();
  const execDir = path.join(root, ".claude", "tycoon");
  fs.mkdirSync(execDir, { recursive: true });
  fs.writeFileSync(path.join(execDir, "execution.json"), JSON.stringify({ useMultipleLlms: true }), "utf8");

  const v = describeRoutingVisibility(root, "claude");
  assert.equal(v.visible, true);
  assert.equal(v.reason, "toggle");
  assert.equal(v.useMultipleLlms, true);
});

test("describeRoutingVisibility: profileActive/routedAgentCount for no profile at all", () => {
  const root = tmpRoot();
  writeAgent(root, "coding-specialist.md", ["name: coding-specialist", "model: sonnet"]);
  const v = describeRoutingVisibility(root, "opencode");
  assert.equal(v.profileActive, false);
  assert.equal(v.routedAgentCount, 0);
});

test("describeRoutingVisibility: profileActive/routedAgentCount for defaults-only profile", () => {
  const root = tmpRoot();
  writeAgent(root, "coding-specialist.md", ["name: coding-specialist"]);
  writeAgent(root, "frontmatter-only.md", ["name: frontmatter-only", "model: sonnet"]);
  writeRouting(root, {
    version: 1,
    defaults: { vendor: "ollama-windows", transport: "openai-compatible", model: "ollama-windows/qwen3.8:27b", costModelClass: "local" },
    agents: {},
  });

  const v = describeRoutingVisibility(root, "opencode");
  assert.equal(v.profileActive, true);
  // coding-specialist has no frontmatter model/backend -> routed by defaults (routeSource "default", counted).
  // frontmatter-only carries its own model: sonnet -> routeSource "frontmatter" (not counted).
  assert.equal(v.routedAgentCount, 1);
});

test("describeRoutingVisibility: profileActive/routedAgentCount for explicit-only profile", () => {
  const root = tmpRoot();
  writeAgent(root, "coding-specialist.md", ["name: coding-specialist", "model: sonnet"]);
  writeAgent(root, "other.md", ["name: other", "model: haiku"]);
  writeRouting(root, {
    version: 1,
    agents: {
      "coding-specialist": { vendor: "anthropic", transport: "claude-native", model: "opus", costModelClass: "subscription" },
    },
  });

  const v = describeRoutingVisibility(root, "opencode");
  assert.equal(v.profileActive, true);
  assert.equal(v.routedAgentCount, 1);
});

// ---------------------------------------------------------------------------
// overrideAgentToClaudeTier
// ---------------------------------------------------------------------------

test("overrideAgentToClaudeTier: routed agent -> explicit routing.json entry, claudeTier sonnet after the call, others preserved", async () => {
  await withIsolatedStoreDirs(async () => {
    const root = tmpRoot();
    const scriptsDir = makeFakeScriptsDir();
    writeAgent(root, "coding-specialist.md", ["name: coding-specialist"]);
    writeAgent(root, "other.md", ["name: other", "model: haiku"]);
    writeRouting(root, {
      version: 1,
      defaults: { vendor: "ollama-windows", transport: "openai-compatible", model: "ollama-windows/qwen3.8:27b", costModelClass: "local" },
      agents: {},
    });

    const result = await overrideAgentToClaudeTier(root, "coding-specialist", "sonnet", { scriptsDir });
    assert.equal(result.handled, true, JSON.stringify(result));
    assert.equal(result.ok, true, JSON.stringify(result.errors));

    const routes = describeAgentRoutes(root);
    assert.equal(routes["coding-specialist"]?.claudeTier, "sonnet");
    assert.equal(routes["coding-specialist"]?.routeSource, "explicit");

    const routing = readRouting(root) as { defaults?: unknown; agents?: Record<string, unknown> };
    assert.ok(routing, "routing.json should exist after override");
    assert.deepEqual(routing.defaults, { vendor: "ollama-windows", transport: "openai-compatible", model: "ollama-windows/qwen3.8:27b", costModelClass: "local" });
    assert.ok(routing.agents && "coding-specialist" in routing.agents);
  });
});

test("overrideAgentToClaudeTier: frontmatter-only agent -> handled:false, routing.json untouched", async () => {
  await withIsolatedStoreDirs(async () => {
    const root = tmpRoot();
    const scriptsDir = makeFakeScriptsDir();
    writeAgent(root, "frontmatter-only.md", ["name: frontmatter-only", "model: sonnet"]);

    const result = await overrideAgentToClaudeTier(root, "frontmatter-only", "opus", { scriptsDir });
    assert.equal(result.handled, false, JSON.stringify(result));
    assert.equal(fs.existsSync(path.join(root, ".claude", "tycoon", "routing.json")), false);
  });
});
