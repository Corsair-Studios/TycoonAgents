/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * hooks/tycoon-opencode-plugin.ts is a standalone, zero-runtime-dependency
 * file meant to load directly from .opencode/plugin/ — it is intentionally
 * NOT part of the tsc -p . build (hooks/ is outside tsconfig's include), so
 * these tests transpile it in-memory (ts.transpileModule) to a scratch .js
 * file and require() it fresh, exercising the exported `createPlugin(deps)`
 * factory the way the brief specifies. Payload literals below are taken
 * verbatim from docs/opencode-probe-findings.md.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as ts from "typescript";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLUGIN_SRC_PATH = join(process.cwd(), "hooks", "tycoon-opencode-plugin.ts");
const AGENT_BACKEND_JS_PATH = join(process.cwd(), "out", "src", "core", "agentBackend.js");
const MODEL_ALIASES_JS_PATH = join(process.cwd(), "out", "src", "core", "modelAliases.js");

interface ActivityRecord {
  event: string;
  provider?: string;
  workerId?: string;
  tool?: string;
  sessionId?: string;
  parentId?: string;
  model?: string;
  vendor?: string;
  costModelClass?: string;
  tokens?: number;
  cacheReadTokens?: number;
  agentDescription?: string;
  error?: string;
  at?: number;
  [key: string]: unknown;
}

interface ActiveAgentFile {
  version: number;
  agentId: string;
  timestamp: number;
  stack: Array<Record<string, unknown>>;
}

// Compile hooks/tycoon-opencode-plugin.ts to CJS into a fresh scratch dir so
// each test gets an isolated require() cache entry, and (for the mcp-backend
// test) so agentBackend.js can be dropped next to it exactly like the real
// installer copies it next to hooks/tycoon-claude-hook.cjs.
function compilePlugin(): { modulePath: string; moduleDir: string } {
  const moduleDir = mkdtempSync(join(tmpdir(), "tycoon-opencode-plugin-"));
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
  return { modulePath, moduleDir };
}

function requireFreshPlugin(): { modulePath: string; moduleDir: string; mod: any } {
  const { modulePath, moduleDir } = compilePlugin();
  delete require.cache[require.resolve(modulePath)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(modulePath);
  return { modulePath, moduleDir, mod };
}

function readActivity(activityFile: string): ActivityRecord[] {
  if (!existsSync(activityFile)) return [];
  return readFileSync(activityFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ActivityRecord);
}

function readActiveAgent(activeAgentFile: string): ActiveAgentFile | null {
  if (!existsSync(activeAgentFile)) return null;
  return JSON.parse(readFileSync(activeAgentFile, "utf8")) as ActiveAgentFile;
}

function setupDirectory(): string {
  return mkdtempSync(join(tmpdir(), "tycoon-opencode-dir-"));
}

// ---------------------------------------------------------------------------
// (d) UserPromptSubmit: session.created with no parentID
// ---------------------------------------------------------------------------

test("session.created with no parentID maps to UserPromptSubmit", async () => {
  const { mod } = requireFreshPlugin();
  const directory = setupDirectory();
  const plugin = mod.createPlugin({ directory, now: () => 1788406058535 });

  // Literal payload from docs/opencode-probe-findings.md section (d).
  await plugin.dispatchEvent({
    type: "session.created",
    properties: {
      sessionID: "ses_f9ab131faffeHBfizi32Ds7da1",
      info: {
        id: "ses_f9ab131faffeHBfizi32Ds7da1",
        slug: "stellar-island",
        version: "1.18.27",
        directory: "D:\\ACode\\TycoonAgents",
        title: "New session - 2026-09-03T03:27:38.501Z",
        agent: "build",
        model: { id: "big-pickle", providerID: "opencode" },
      },
    },
  });

  const records = readActivity(plugin._paths.activityFile);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    event: "UserPromptSubmit",
    provider: "opencode",
    at: 1788406058535,
    sessionId: "ses_f9ab131faffeHBfizi32Ds7da1",
  });
});

test("user message.updated within 1s of session.created is deduped", async () => {
  const { mod } = requireFreshPlugin();
  const directory = setupDirectory();
  let now = 1788406058535;
  const plugin = mod.createPlugin({ directory, now: () => now });

  await plugin.dispatchEvent({
    type: "session.created",
    properties: { info: { id: "ses_root", parentID: undefined } },
  });

  now += 200; // within the 1s dedupe window
  // Literal shape from findings section (d).
  await plugin.dispatchEvent({
    type: "message.updated",
    properties: {
      sessionID: "ses_root",
      info: {
        id: "msg_0654ece27001G0X7wf9qcCrMc4",
        role: "user",
        sessionID: "ses_root",
        time: { created: 1788406058535 },
        agent: "build",
        model: { providerID: "opencode", modelID: "big-pickle" },
      },
    },
  });

  const records = readActivity(plugin._paths.activityFile);
  assert.equal(records.filter((r) => r.event === "UserPromptSubmit").length, 1);
});

// ---------------------------------------------------------------------------
// (a) Task-tool spawn: tool.execute.before -> PreToolUse; push active-agent
// ---------------------------------------------------------------------------

test("tool.execute.before for task maps to PreToolUse and pushes the stack", async () => {
  const { mod } = requireFreshPlugin();
  const directory = setupDirectory();
  const plugin = mod.createPlugin({ directory, now: () => 1788406063414 });

  // Literal payload[0]/[1] from findings section (a).
  await plugin.toolExecuteBefore({
    tool: "task",
    sessionID: "ses_f9ab131faffeHBfizi32Ds7da1",
    callID: "call_c262d5015ae24e1c8354fe21",
    args: { subagent_type: "probe-sub", description: "Probe sub hello", prompt: "The user sent: @probe-sub hello..." },
  });

  const records = readActivity(plugin._paths.activityFile);
  assert.equal(records.length, 1);
  assert.equal(records[0].event, "PreToolUse");
  assert.equal(records[0].tool, "Task");
  assert.equal(records[0].workerId, "probe-sub");
  assert.equal(records[0].agentDescription, "Probe sub hello");
  assert.equal(records[0].sessionId, "ses_f9ab131faffeHBfizi32Ds7da1");
  assert.equal(records[0].parentId, "ses_f9ab131faffeHBfizi32Ds7da1");

  const active = readActiveAgent(plugin._paths.activeAgentFile);
  assert.ok(active);
  assert.equal(active!.stack.length, 1);
  assert.equal(active!.stack[0].agentId, "probe-sub");
});

// ---------------------------------------------------------------------------
// (a)+(b) Task-tool completion: tool.execute.after -> SubagentStop w/ tokens
// ---------------------------------------------------------------------------

test("tool.execute.after for task maps to SubagentStop, fetches tokens, and pops the stack", async () => {
  const { mod } = requireFreshPlugin();
  const directory = setupDirectory();

  // Fake client returning the literal PROBE_CHILD_USAGE assistantInfos entry
  // from findings section (b), plus a second entry to prove summation.
  const fakeClient = {
    session: {
      messages: async () => ({
        data: [
          {
            info: {
              id: "msg_0654ee1a6001upngGU7nzMvcvG",
              role: "assistant",
              modelID: "big-pickle",
              providerID: "opencode",
              tokens: { total: 11781, input: 11667, output: 114, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0,
              time: { created: 1788406063526, completed: 1788406068081 },
            },
          },
          {
            info: {
              id: "msg_second",
              role: "assistant",
              modelID: "big-pickle",
              providerID: "opencode",
              tokens: { input: 1000, output: 500, cache: { read: 250, write: 0 } },
            },
          },
        ],
      }),
    },
  };

  const pluginWithClient = mod.createPlugin({
    directory,
    now: () => 1788406085036,
    client: fakeClient,
  });

  // Literal payload[1] (.after) shape from findings section (a).
  await pluginWithClient.toolExecuteBefore({
    tool: "task",
    sessionID: "ses_f9ab131faffeHBfizi32Ds7da1",
    args: { subagent_type: "probe-sub" },
  });
  await pluginWithClient.toolExecuteAfter(
    {
      tool: "task",
      sessionID: "ses_f9ab131faffeHBfizi32Ds7da1",
      callID: "call_c262d5015ae24e1c8354fe21",
      args: { subagent_type: "probe-sub" },
    },
    {
      title: "Probe sub hello",
      metadata: {
        parentSessionId: "ses_f9ab131faffeHBfizi32Ds7da1",
        sessionId: "ses_f9ab11ec3ffe6teMMEqORyrFMr",
        model: { modelID: "big-pickle", providerID: "opencode" },
        truncated: false,
      },
      output: "<task id=\"ses_f9ab11ec3ffe6teMMEqORyrFMr\" state=\"completed\">...</task>",
    }
  );

  const records = readActivity(pluginWithClient._paths.activityFile);
  const stop = records.find((r) => r.event === "SubagentStop");
  assert.ok(stop, "expected a SubagentStop record");
  assert.equal(stop!.workerId, "probe-sub");
  assert.equal(stop!.model, "opencode/big-pickle");
  assert.equal(stop!.tokens, 11667 + 114 + 1000 + 500);
  assert.equal(stop!.cacheReadTokens, 0 + 250);
  assert.equal(stop!.sessionId, "ses_f9ab131faffeHBfizi32Ds7da1");

  const active = readActiveAgent(pluginWithClient._paths.activeAgentFile);
  assert.ok(active);
  assert.equal(active!.stack.length, 0);
});

test("tool.execute.after for task omits tokens (never fabricates) when the SDK call fails", async () => {
  const { mod } = requireFreshPlugin();
  const directory = setupDirectory();
  const failingClient = {
    session: {
      messages: async () => {
        throw new Error("network down");
      },
    },
  };
  const plugin = mod.createPlugin({ directory, now: () => 1, client: failingClient });

  await plugin.toolExecuteBefore({
    tool: "task",
    sessionID: "ses_parent",
    args: { subagent_type: "probe-sub" },
  });
  await plugin.toolExecuteAfter(
    { tool: "task", sessionID: "ses_parent", args: { subagent_type: "probe-sub" } },
    {
      metadata: { parentSessionId: "ses_parent", sessionId: "ses_child", model: { modelID: "big-pickle", providerID: "opencode" } },
    }
  );

  const records = readActivity(plugin._paths.activityFile);
  const stop = records.find((r) => r.event === "SubagentStop");
  assert.ok(stop);
  assert.equal("tokens" in stop!, false);
  assert.equal("cacheReadTokens" in stop!, false);
});

// ---------------------------------------------------------------------------
// Other-tool PreToolUse: name mapping + active-agent attribution
// ---------------------------------------------------------------------------

test("tool.execute.before for a non-task tool maps its name and attributes to the active agent", async () => {
  const { mod } = requireFreshPlugin();
  const directory = setupDirectory();
  const plugin = mod.createPlugin({ directory, now: () => 100 });

  await plugin.toolExecuteBefore({ tool: "read", sessionID: "ses_root" });
  let records = readActivity(plugin._paths.activityFile);
  assert.equal(records[0].tool, "Read");
  assert.equal(records[0].workerId, "orchestrator");

  // Register the spawned worker's session as a real OpenCode child session
  // (parentID known) — attribution is derived from OpenCode's own session
  // tree, not from merely having pushed a task spawn.
  await plugin.dispatchEvent({
    type: "session.created",
    properties: { info: { id: "ses_child", parentID: "ses_root", agent: "probe-sub" } },
  });
  await plugin.toolExecuteBefore({
    tool: "task",
    sessionID: "ses_root",
    args: { subagent_type: "probe-sub" },
  });
  await plugin.toolExecuteBefore({ tool: "edit", sessionID: "ses_child" });

  records = readActivity(plugin._paths.activityFile);
  const editRecord = records.find((r) => r.tool === "Edit");
  assert.ok(editRecord);
  assert.equal(editRecord!.workerId, "probe-sub");
});

// ---------------------------------------------------------------------------
// session.idle (root session, no parentID) -> Stop
// ---------------------------------------------------------------------------

test("session.idle on a root session maps to Stop", async () => {
  const { mod } = requireFreshPlugin();
  const directory = setupDirectory();
  const plugin = mod.createPlugin({ directory, now: () => 1788406090000 });

  await plugin.dispatchEvent({ type: "session.created", properties: { info: { id: "ses_root" } } });
  // Literal shape from findings section (event catalogue: event:session.idle).
  await plugin.dispatchEvent({ type: "session.idle", properties: { sessionID: "ses_root" } });

  const records = readActivity(plugin._paths.activityFile);
  const stop = records.find((r) => r.event === "Stop");
  assert.ok(stop);
  assert.equal(stop!.sessionId, "ses_root");
});

test("session.idle evicts the session-tree tracking maps for the idle session and its children", async () => {
  const { mod } = requireFreshPlugin();
  const directory = setupDirectory();
  const plugin = mod.createPlugin({ directory, now: () => 1 });

  await plugin.dispatchEvent({
    type: "session.created",
    properties: { info: { id: "ses_parent3", agent: "build" } },
  });
  await plugin.dispatchEvent({
    type: "session.created",
    properties: { info: { id: "ses_child3", parentID: "ses_parent3", agent: "coding-specialist" } },
  });

  const before = plugin._debugSessionMapSizes();
  assert.equal(before.sessionParent, 2);
  assert.equal(before.sessionAgentName, 2);

  // The parent going idle must evict both itself and its tracked child.
  await plugin.dispatchEvent({ type: "session.idle", properties: { sessionID: "ses_parent3" } });

  const after = plugin._debugSessionMapSizes();
  assert.equal(after.sessionParent, 0, "expected the parent and child to be evicted from sessionParent");
  assert.equal(after.sessionAgentName, 0, "expected the parent and child to be evicted from sessionAgentName");
});

// ---------------------------------------------------------------------------
// PluginError on a throwing handler
// ---------------------------------------------------------------------------

test("a throwing handler yields a PluginError activity line instead of crashing", async () => {
  const { mod } = requireFreshPlugin();
  const directory = setupDirectory();
  const plugin = mod.createPlugin({ directory, now: () => 42 });

  const evilEvent = new Proxy(
    {},
    {
      get() {
        throw new Error("boom");
      },
    }
  );

  await plugin.dispatchEvent(evilEvent as any);

  const records = readActivity(plugin._paths.activityFile);
  assert.equal(records.length, 1);
  assert.equal(records[0].event, "PluginError");
  assert.equal(records[0].provider, "opencode");
  assert.equal(records[0].error, "boom");
});

// ---------------------------------------------------------------------------
// mcp__codex__codex routing with vendor/costModelClass from an agent backend
// ---------------------------------------------------------------------------

test("an mcp__codex__codex call is routed with vendor/costModelClass from codex-reviewer.md's backend block", async () => {
  if (!existsSync(AGENT_BACKEND_JS_PATH)) {
    // agentBackend.js is compiled from src/core/agentBackend.ts by `tsc -p .`
    // (the main build) — skip gracefully if this test runs before that build
    // step rather than failing on an unrelated missing artifact.
    return;
  }

  const { mod, moduleDir } = requireFreshPlugin();
  copyFileSync(AGENT_BACKEND_JS_PATH, join(moduleDir, "agentBackend.js"));
  if (existsSync(MODEL_ALIASES_JS_PATH)) {
    copyFileSync(MODEL_ALIASES_JS_PATH, join(moduleDir, "modelAliases.js"));
  }

  const directory = setupDirectory();
  const agentsDir = join(directory, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "codex-reviewer.md"),
    [
      "---",
      "description: Cross-vendor Codex review.",
      "model: gpt-5.4-mini",
      "backend:",
      "  vendor: openai",
      "  transport: mcp",
      "  mcpServer: codex",
      "  tools: [codex]",
      "  model: openai/gpt-5.4-mini",
      "  costModelClass: subscription",
      "---",
      "Body.",
    ].join("\n"),
    "utf8"
  );

  const plugin = mod.createPlugin({ directory, now: () => 7 });
  await plugin.toolExecuteBefore({ tool: "mcp__codex__codex", sessionID: "ses_root", args: {} });

  const records = readActivity(plugin._paths.activityFile);
  assert.equal(records.length, 1);
  assert.equal(records[0].tool, "mcp__codex__codex");
  assert.equal(records[0].vendor, "openai");
  assert.equal(records[0].costModelClass, "subscription");
  assert.equal(records[0].model, "openai/gpt-5.4-mini");
});

// ---------------------------------------------------------------------------
// Every activity line carries provider + at
// ---------------------------------------------------------------------------

test("every activity line carries provider:'opencode' and a numeric at", async () => {
  const { mod } = requireFreshPlugin();
  const directory = setupDirectory();
  const plugin = mod.createPlugin({ directory, now: () => 999 });

  await plugin.dispatchEvent({ type: "session.created", properties: { info: { id: "ses_a" } } });
  await plugin.toolExecuteBefore({ tool: "bash", sessionID: "ses_a" });

  const records = readActivity(plugin._paths.activityFile);
  assert.ok(records.length >= 2);
  for (const r of records) {
    assert.equal(r.provider, "opencode");
    assert.equal(typeof r.at, "number");
  }
});
