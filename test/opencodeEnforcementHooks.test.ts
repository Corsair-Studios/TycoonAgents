/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Plan task p15-t0: coverage for the two enforcement mechanisms confirmed
 * live against OpenCode 1.18.27 (see docs/opencode-probe-findings.md
 * "Enforcement mechanisms"):
 *   (1) throwing a BlockingToolCallError from tool.execute.before aborts the
 *       `task` call for a leaf-worker spawn-guard deny.
 *   (2) experimental.chat.system.transform delivers a queued direct-tool-call
 *       nudge into the model's own system prompt.
 *
 * Same transpile-and-require idiom as test/opencodePlugin.test.ts, since
 * hooks/tycoon-opencode-plugin.ts is intentionally outside tsc -p .'s
 * include set.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as ts from "typescript";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLUGIN_SRC_PATH = join(process.cwd(), "hooks", "tycoon-opencode-plugin.ts");
const DELEGATION_ENFORCEMENT_JS = join(process.cwd(), "out", "src", "core", "delegationEnforcement.js");

function compilePlugin(): string {
  const moduleDir = mkdtempSync(join(tmpdir(), "tycoon-opencode-enforce-"));
  const source = readFileSync(PLUGIN_SRC_PATH, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
    fileName: "tycoon-opencode-plugin.ts",
  });
  const modulePath = join(moduleDir, "tycoon-opencode-plugin.js");
  writeFileSync(modulePath, output.outputText, "utf8");
  // The plugin resolves delegationEnforcement.js relative to its own
  // directory (see hooks/tycoon-opencode-plugin.ts's getDelegationEnforcementModule)
  // — copy the real compiled module next to the scratch plugin file, exactly
  // as scripts/copy-hook-runtime.mjs does for a real install.
  writeFileSync(join(moduleDir, "delegationEnforcement.js"), readFileSync(DELEGATION_ENFORCEMENT_JS, "utf8"), "utf8");
  return modulePath;
}

function requireFreshPlugin(): any {
  const modulePath = compilePlugin();
  delete require.cache[require.resolve(modulePath)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(modulePath);
}

function readActivity(activityFile: string): Array<Record<string, unknown>> {
  if (!existsSync(activityFile)) return [];
  return readFileSync(activityFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function setupDirectory(): string {
  return mkdtempSync(join(tmpdir(), "tycoon-opencode-enforce-dir-"));
}

// ---------------------------------------------------------------------------
// Mechanism (1): spawn-guard deny now structurally blocks via throw.
// ---------------------------------------------------------------------------

test("leaf-worker spawn is blocked: tool.execute.before throws with LEAF_WORKER_DENY_MESSAGE and no PreToolUse record is written for the denied call", async () => {
  const mod = requireFreshPlugin();
  const directory = setupDirectory();
  const plugin = mod.createPlugin({ directory, now: () => 1 });

  // Push a worker onto the active-agent stack so the next task call is
  // treated as originating from a non-empty (leaf) spawner.
  await plugin.toolExecuteBefore({
    tool: "task",
    sessionID: "parent-session",
    args: { subagent_type: "coding-specialist", description: "top-level task" },
  });

  let thrown: unknown;
  try {
    await plugin.toolExecuteBefore({
      tool: "task",
      sessionID: "leaf-session",
      args: { subagent_type: "coding-specialist", description: "leaf tries to spawn" },
    });
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown instanceof Error, "expected tool.execute.before to throw for a leaf spawn attempt");
  assert.match((thrown as Error).message, /leaf worker/i);

  const records = readActivity(plugin._paths.activityFile);
  assert.ok(records.some((r) => r.event === "SpawnDenied"), "expected a SpawnDenied activity record");
  assert.equal(
    records.some((r) => r.event === "PreToolUse" && r.tool === "Task" && r.sessionId === "leaf-session"),
    false,
    "a denied spawn must not also produce a normal PreToolUse/Task record"
  );
});

test("orchestrator (empty active-agent stack) is never spawn-blocked", async () => {
  const mod = requireFreshPlugin();
  const directory = setupDirectory();
  const plugin = mod.createPlugin({ directory, now: () => 1 });

  await assert.doesNotReject(
    plugin.toolExecuteBefore({
      tool: "task",
      sessionID: "root-session",
      args: { subagent_type: "coding-specialist", description: "orchestrator delegates" },
    })
  );
  const records = readActivity(plugin._paths.activityFile);
  assert.ok(records.some((r) => r.event === "PreToolUse" && r.tool === "Task"));
});

// ---------------------------------------------------------------------------
// Mechanism (2): direct-tool-call nudges are queued and delivered via
// chatSystemTransform.
// ---------------------------------------------------------------------------

test("a direct Grep call by the orchestrator queues a nudge delivered by chatSystemTransform", async () => {
  const mod = requireFreshPlugin();
  const directory = setupDirectory();
  const plugin = mod.createPlugin({ directory, now: () => 1 });

  await plugin.toolExecuteBefore({ tool: "grep", sessionID: "sess-1", args: {} });

  const output: { system: string[] } = { system: ["base system prompt"] };
  await plugin.chatSystemTransform({ sessionID: "sess-1" }, output);

  assert.equal(output.system.length, 2);
  assert.match(output.system[1], /\[TycoonAgents delegation nudge\]/);
  assert.match(output.system[1], /Grep ran directly on the orchestrator/);
});

test("chatSystemTransform drains the nudge queue so it is delivered exactly once", async () => {
  const mod = requireFreshPlugin();
  const directory = setupDirectory();
  const plugin = mod.createPlugin({ directory, now: () => 1 });

  await plugin.toolExecuteBefore({ tool: "grep", sessionID: "sess-2", args: {} });

  const first: { system: string[] } = { system: [] };
  await plugin.chatSystemTransform({ sessionID: "sess-2" }, first);
  assert.equal(first.system.length, 1);

  const second: { system: string[] } = { system: [] };
  await plugin.chatSystemTransform({ sessionID: "sess-2" }, second);
  assert.equal(second.system.length, 0, "the queue must be empty after the first drain");
});

test("chatSystemTransform with no pending nudge and no output.system array is a safe no-op", async () => {
  const mod = requireFreshPlugin();
  const directory = setupDirectory();
  const plugin = mod.createPlugin({ directory, now: () => 1 });

  await assert.doesNotReject(plugin.chatSystemTransform({ sessionID: "unknown-session" }, {} as any));
  await assert.doesNotReject(plugin.chatSystemTransform({}, { system: [] }));
});

test("a leaf worker's direct Read call is never nudged (mirrors the Claude hook's own guard)", async () => {
  const mod = requireFreshPlugin();
  const directory = setupDirectory();
  const plugin = mod.createPlugin({ directory, now: () => 1 });

  // Push a worker so the stack is non-empty (this call is from a leaf).
  await plugin.toolExecuteBefore({
    tool: "task",
    sessionID: "parent-session-2",
    args: { subagent_type: "coding-specialist", description: "top-level task" },
  });
  await plugin.toolExecuteBefore({ tool: "grep", sessionID: "leaf-session-2", args: {} });

  const output: { system: string[] } = { system: [] };
  await plugin.chatSystemTransform({ sessionID: "leaf-session-2" }, output);
  assert.equal(output.system.length, 0, "a leaf's own direct tool calls must not be nudged");
});
