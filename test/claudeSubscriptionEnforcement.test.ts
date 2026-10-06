/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Enforcement (not just UI) of the Claude-subscription opt-in under OpenCode:
 * pack install skip, plugin runtime gate (task + direct mcp), saveRoutingProfile
 * rejection, dispatcher adapter gate. Claude Code / Codex stay unaffected.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as ts from "typescript";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shouldSkipPackAgentForClaudeSubscription, writeClaudeSubscriptionOptIn } from "../src/core/claudeSubscriptionBridge";
import { saveRoutingProfile } from "../src/core/routingHostOps";

const ROOT = process.cwd();
const worker = { vendor: "anthropic", transport: "mcp", mcpServer: "claude-cli", costModelClass: "subscription" };

function withDataDir<T>(optIn: boolean, fn: () => T | Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sub-enf-"));
  const prev = process.env.TYCOON_STANDALONE_DATA_DIR;
  process.env.TYCOON_STANDALONE_DATA_DIR = dir;
  if (optIn) writeClaudeSubscriptionOptIn(true);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.TYCOON_STANDALONE_DATA_DIR;
      else process.env.TYCOON_STANDALONE_DATA_DIR = prev;
    });
}

test("pack skip: claude-worker skipped under opencode without opt-in; allowed when opted in, other harnesses, other agents", () => {
  assert.equal(shouldSkipPackAgentForClaudeSubscription("opencode", false, worker), true);
  assert.equal(shouldSkipPackAgentForClaudeSubscription("opencode", true, worker), false);
  assert.equal(shouldSkipPackAgentForClaudeSubscription("claude-code", false, worker), false);
  assert.equal(shouldSkipPackAgentForClaudeSubscription("codex", false, worker), false);
  assert.equal(shouldSkipPackAgentForClaudeSubscription("opencode", false, { vendor: "google", transport: "mcp", mcpServer: "gemini" }), false);
});

test("pack install paths (panel install + heal, standalone) call the skip helper", () => {
  const panel = fs.readFileSync(path.join(ROOT, "src", "host", "vscode", "panel.ts"), "utf8");
  const standalone = fs.readFileSync(path.join(ROOT, "standalone", "src", "server.mjs"), "utf8");
  assert.equal((panel.match(/shouldSkipPackAgentForClaudeSubscription\(/g) || []).length, 2);
  assert.match(standalone, /shouldSkipPackAgentForClaudeSubscription\(/);
});

function projectWithRouting(profile: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sub-save-"));
  if (profile) {
    fs.mkdirSync(path.join(root, ".claude", "tycoon"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "tycoon", "routing.json"), JSON.stringify(profile));
  }
  return root;
}
const bridgedProfile = {
  version: 1,
  agents: { "claude-worker": { vendor: "anthropic", model: "anthropic/sonnet", transport: "mcp", mcpServer: "claude-cli", costModelClass: "subscription" } },
};

test("saveRoutingProfile: new claude-cli slot under opencode without opt-in is rejected with a clear error", () => {
  const root = projectWithRouting(null);
  const res = saveRoutingProfile({ root, profile: bridgedProfile, scriptsDir: ROOT, effectiveHarness: "opencode", claudeSubscriptionOptIn: false });
  assert.equal(res.ok, false);
  assert.match(res.errors.join(" "), /Allow Claude subscription via the claude CLI under OpenCode/);
});

test("saveRoutingProfile: opted in, claude-code harness, and an unchanged existing slot are not blocked by the gate", () => {
  const cases: Array<[string, boolean, unknown]> = [
    ["opencode", true, null],
    ["claude-code", false, null],
    ["opencode", false, bridgedProfile],
  ];
  for (const [harness, optIn, existing] of cases) {
    const root = projectWithRouting(existing);
    const res = saveRoutingProfile({ root, profile: bridgedProfile, scriptsDir: ROOT, effectiveHarness: harness, claudeSubscriptionOptIn: optIn });
    assert.doesNotMatch(res.errors.join(" "), /Allow Claude subscription/, `${harness} optIn=${optIn}`);
  }
});

test("dispatcher: claudeSubscriptionBlock gates only host=opencode without the flag; anthropicAdapter returns the error", async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const adapters = require(path.join(ROOT, "hooks", "dispatcherAdapters.cjs"));
  await withDataDir(false, async () => {
    assert.equal(adapters.claudeSubscriptionBlock({ ...process.env, TYCOON_DISPATCH_HOST: "claude" }), null);
    assert.equal(adapters.claudeSubscriptionBlock({ ...process.env, TYCOON_DISPATCH_HOST: undefined }), null);
    assert.match(adapters.claudeSubscriptionBlock({ ...process.env, TYCOON_DISPATCH_HOST: "opencode" }), /Allow Claude subscription/);
    const prev = process.env.TYCOON_DISPATCH_HOST;
    process.env.TYCOON_DISPATCH_HOST = "opencode";
    try {
      const res = await adapters.anthropicAdapter("hi", { model: "sonnet" });
      assert.match(res.error, /Allow Claude subscription/);
    } finally {
      if (prev === undefined) delete process.env.TYCOON_DISPATCH_HOST;
      else process.env.TYCOON_DISPATCH_HOST = prev;
    }
  });
  await withDataDir(true, async () => {
    assert.equal(adapters.claudeSubscriptionBlock({ ...process.env, TYCOON_DISPATCH_HOST: "opencode" }), null);
  });
});

function loadPlugin(): any {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sub-plugin-"));
  const out = ts.transpileModule(fs.readFileSync(path.join(ROOT, "hooks", "tycoon-opencode-plugin.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: "tycoon-opencode-plugin.ts",
  });
  fs.writeFileSync(path.join(dir, "tycoon-opencode-plugin.js"), out.outputText);
  for (const f of ["delegationEnforcement.js", "fallbackChain.js", "agentBackend.js", "modelAliases.js"]) {
    const src = path.join(ROOT, "out", "src", "core", f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
  }
  fs.copyFileSync(path.join(ROOT, "hooks", "bridge-result.cjs"), path.join(dir, "bridge-result.cjs"));
  const modPath = path.join(dir, "tycoon-opencode-plugin.js");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(modPath);
}

function pluginProject(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sub-plugin-dir-"));
  fs.mkdirSync(path.join(directory, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, ".claude", "agents", "claude-worker.md"),
    "---\nname: claude-worker\nmodel: sonnet\nbackend:\n  vendor: anthropic\n  transport: mcp\n  mcpServer: claude-cli\n  tools: [claude]\n  model: anthropic/sonnet\n  costModelClass: subscription\n---\nbody\n",
  );
  return directory;
}

test("plugin: task spawn of a claude-cli agent and direct mcp__claude-cli__* are blocked without opt-in, allowed with it", async () => {
  const mod = loadPlugin();
  await withDataDir(false, async () => {
    const plugin = mod.createPlugin({ directory: pluginProject(), now: () => 1 });
    await assert.rejects(
      plugin.toolExecuteBefore({ tool: "task", sessionID: "root", args: { subagent_type: "claude-worker", description: "d" } }),
      /Allow Claude subscription via the claude CLI under OpenCode/,
    );
    await assert.rejects(
      plugin.toolExecuteBefore({ tool: "mcp__claude-cli__claude", sessionID: "root", args: { prompt: "hi" } }),
      /Allow Claude subscription via the claude CLI under OpenCode/,
    );
  });
  await withDataDir(true, async () => {
    const plugin = mod.createPlugin({ directory: pluginProject(), now: () => 1 });
    await assert.doesNotReject(
      plugin.toolExecuteBefore({ tool: "task", sessionID: "root", args: { subagent_type: "claude-worker", description: "d" } }),
    );
    await assert.doesNotReject(plugin.toolExecuteBefore({ tool: "mcp__claude-cli__claude", sessionID: "root", args: { prompt: "hi" } }));
  });
});
