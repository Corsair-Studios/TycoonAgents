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
const FALLBACK_CHAIN_JS = join(process.cwd(), "out", "src", "core", "fallbackChain.js");

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
  writeFileSync(join(moduleDir, "fallbackChain.js"), readFileSync(FALLBACK_CHAIN_JS, "utf8"), "utf8");
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

// ---------------------------------------------------------------------------
// p15-t1: provider-failure fallback dispatch.
// ---------------------------------------------------------------------------

function writeRoutingGenerated(directory: string, agentId: string, fallback: string[]): void {
  mkdirSync(join(directory, ".opencode"), { recursive: true });
  writeFileSync(
    join(directory, ".opencode", "tycoon-routing.generated.json"),
    JSON.stringify({ agents: { [agentId]: { model: "anthropic/sonnet", fallback } }, orchestrator: {} }, null, 2),
    "utf8"
  );
}

test("provider failure on a slot with a 2-deep fallback chain queues an instruction naming fallback[0], then fallback[1] on a second failure, then exhaustion on a third", async () => {
  const mod = requireFreshPlugin();
  const directory = setupDirectory();
  writeRoutingGenerated(directory, "coding-specialist", ["openai/gpt-5.4-mini", "moonshot/kimi-k2"]);
  const plugin = mod.createPlugin({ directory, now: () => 1 });

  await plugin.toolExecuteBefore({
    tool: "task",
    sessionID: "root-session",
    args: { subagent_type: "coding-specialist", description: "implement thing" },
  });

  await plugin.toolExecuteAfter(
    { tool: "task", sessionID: "root-session", args: { subagent_type: "coding-specialist" } },
    {
      metadata: {
        parentSessionId: "root-session",
        sessionId: "child-session-1",
        model: { providerID: "anthropic", modelID: "sonnet" },
      },
      output: "<task>Error: usage limit reached for this account</task>",
    }
  );

  let records = readActivity(plugin._paths.activityFile);
  let triggered = records.filter((r) => r.event === "FallbackTriggered");
  assert.equal(triggered.length, 1, "expected one FallbackTriggered record after the first failure");
  assert.equal(triggered[0].nextModel, "openai/gpt-5.4-mini");
  assert.match(String(triggered[0].message), /fallback 1 of 2/);

  const out1: { system: string[] } = { system: [] };
  await plugin.chatSystemTransform({ sessionID: "root-session" }, out1);
  assert.equal(out1.system.length, 1);
  assert.match(out1.system[0], /openai\/gpt-5\.4-mini/);

  // A second re-dispatch on the same slot fails again -> fallback[1].
  await plugin.toolExecuteBefore({
    tool: "task",
    sessionID: "root-session",
    args: { subagent_type: "coding-specialist", description: "retry implement thing" },
  });
  await plugin.toolExecuteAfter(
    { tool: "task", sessionID: "root-session", args: { subagent_type: "coding-specialist" } },
    {
      metadata: {
        parentSessionId: "root-session",
        sessionId: "child-session-2",
        model: { providerID: "openai", modelID: "gpt-5.4-mini" },
      },
      output: "<task>Error: rate limit exceeded</task>",
    }
  );
  records = readActivity(plugin._paths.activityFile);
  triggered = records.filter((r) => r.event === "FallbackTriggered");
  assert.equal(triggered.length, 2);
  assert.equal(triggered[1].nextModel, "moonshot/kimi-k2");
  assert.match(String(triggered[1].message), /fallback 2 of 2/);

  // A third failure exhausts the chain.
  await plugin.toolExecuteAfter(
    { tool: "task", sessionID: "root-session", args: { subagent_type: "coding-specialist" } },
    {
      metadata: {
        parentSessionId: "root-session",
        sessionId: "child-session-3",
        model: { providerID: "moonshot", modelID: "kimi-k2" },
      },
      output: "<task>Error: 401 Unauthorized</task>",
    }
  );
  records = readActivity(plugin._paths.activityFile);
  triggered = records.filter((r) => r.event === "FallbackTriggered");
  assert.equal(triggered.length, 3);
  assert.equal(triggered[2].nextModel, undefined);
  assert.match(String(triggered[2].message), /exhausted/i);
});

test("a successful task result produces no FallbackTriggered record and no fallback nudge", async () => {
  const mod = requireFreshPlugin();
  const directory = setupDirectory();
  writeRoutingGenerated(directory, "coding-specialist", ["openai/gpt-5.4-mini"]);
  const plugin = mod.createPlugin({ directory, now: () => 1 });

  await plugin.toolExecuteBefore({
    tool: "task",
    sessionID: "root-session-ok",
    args: { subagent_type: "coding-specialist", description: "implement thing" },
  });
  await plugin.toolExecuteAfter(
    { tool: "task", sessionID: "root-session-ok", args: { subagent_type: "coding-specialist" } },
    {
      metadata: {
        parentSessionId: "root-session-ok",
        sessionId: "child-session-ok",
        model: { providerID: "anthropic", modelID: "sonnet" },
      },
      output: "<task>Done: implemented the thing.</task>",
    }
  );

  const records = readActivity(plugin._paths.activityFile);
  assert.equal(records.some((r) => r.event === "FallbackTriggered"), false);

  const out: { system: string[] } = { system: [] };
  await plugin.chatSystemTransform({ sessionID: "root-session-ok" }, out);
  assert.equal(out.system.length, 0);
});
