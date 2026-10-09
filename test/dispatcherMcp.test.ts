/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Tests hooks/tycoon-dispatcher-mcp.cjs (plan p23-t1) offline: explicit-name
// / keyword / fallback routing, nested-delegation denial, adapter selection
// by vendor (env var names asserted, never values), activity.jsonl
// PreToolUse/SubagentStop/ProviderError records, and a real child-process
// MCP handshake (initialize/tools.list/tools.call) over stdio using
// TYCOON_DISPATCH_ADAPTER=stub so no network/CLI calls happen.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, spawnSync } from "node:child_process";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const dispatcherAdapters = require("../../hooks/dispatcherAdapters.cjs") as {
  adapterKeyForVendor: (vendor: string | undefined) => string;
  resolveAdapter: (vendor: string | undefined) => { key: string; fn: (task: string, agentInfo: unknown) => Promise<{ text?: string; usage?: unknown; error?: string }> };
  anthropicAdapter: (task: string, agentInfo: unknown) => Promise<{ text?: string; usage?: unknown; error?: string }>;
};

function makeProjectDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-dispatcher-test-"));
  fs.mkdirSync(path.join(dir, ".claude", "agents"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude", "tycoon"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".claude", "tycoon", "agent-keywords.json"),
    JSON.stringify({
      fallback_agent: "primary-agent",
      agents: {
        "coding-specialist": { pattern: "implement|code|fix|bug|refactor" },
        "testing-specialist": { pattern: "test|spec|vitest|coverage" },
      },
    }),
  );
  fs.writeFileSync(path.join(dir, ".claude", "agents", "coding-specialist.md"), "---\nmodel: sonnet\n---\nbody");
  fs.writeFileSync(path.join(dir, ".claude", "agents", "testing-specialist.md"), "---\nmodel: sonnet\n---\nbody");
  fs.writeFileSync(path.join(dir, ".claude", "agents", "primary-agent.md"), "---\nmodel: sonnet\n---\nbody");
  fs.writeFileSync(
    path.join(dir, ".claude", "agents", "kimi-reviewer.md"),
    "---\nbackend:\n  vendor: moonshot\n  model: kimi-k2\n  costModelClass: local\n---\nbody",
  );
  fs.writeFileSync(
    path.join(dir, ".claude", "agents", "codex-reviewer.md"),
    "---\nbackend:\n  vendor: openai\n  model: gpt-6-astra\n  costModelClass: subscription\n---\nbody",
  );
  fs.writeFileSync(
    path.join(dir, ".claude", "agents", "claude-worker.md"),
    "---\nbackend:\n  vendor: anthropic\n  model: claude-sonnet-4-6\n  costModelClass: subscription\n---\nbody",
  );
  return dir;
}

function loadDispatcherModule(projectDir: string) {
  const modPath = require.resolve("../../hooks/tycoon-dispatcher-mcp.cjs");
  delete require.cache[modPath];
  const prevProjectDir = process.env.TYCOON_PROJECT_DIR;
  const prevAdapter = process.env.TYCOON_DISPATCH_ADAPTER;
  process.env.TYCOON_PROJECT_DIR = projectDir;
  process.env.TYCOON_DISPATCH_ADAPTER = "stub";
  const mod = require(modPath) as {
    handleDelegateTool: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }>; structuredContent?: unknown }>;
    resolveActivityFile: () => string;
    isNestedDelegation: (projectDir: string) => boolean;
  };
  return { mod, restore: () => {
    if (prevProjectDir === undefined) delete process.env.TYCOON_PROJECT_DIR; else process.env.TYCOON_PROJECT_DIR = prevProjectDir;
    if (prevAdapter === undefined) delete process.env.TYCOON_DISPATCH_ADAPTER; else process.env.TYCOON_DISPATCH_ADAPTER = prevAdapter;
  } };
}

function readActivityRecords(activityFile: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(activityFile)) return [];
  return fs
    .readFileSync(activityFile, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

test("dispatcherAdapters: vendor -> adapter key mapping", () => {
  assert.equal(dispatcherAdapters.adapterKeyForVendor("anthropic"), "anthropic");
  assert.equal(dispatcherAdapters.adapterKeyForVendor("moonshot"), "openai-compatible");
  assert.equal(dispatcherAdapters.adapterKeyForVendor("local"), "openai-compatible");
  assert.equal(dispatcherAdapters.adapterKeyForVendor("openai-compatible"), "openai-compatible");
  assert.equal(dispatcherAdapters.adapterKeyForVendor("google"), "google");
  assert.equal(dispatcherAdapters.adapterKeyForVendor("openai"), "openai");
  assert.equal(dispatcherAdapters.adapterKeyForVendor("bogus"), "unsupported");
});

test("dispatcherAdapters: openai-compatible adapter reads env var NAMES (not values) and errors cleanly when unset", async () => {
  const prevBase = process.env.OPENAI_COMPAT_BASE_URL;
  const prevKey = process.env.OPENAI_COMPAT_API_KEY;
  const prevDataDir = process.env.TYCOON_STANDALONE_DATA_DIR;
  delete process.env.OPENAI_COMPAT_BASE_URL;
  delete process.env.OPENAI_COMPAT_API_KEY;
  // Isolate the local env store to an empty temp dir so this assertion
  // never depends on values a real user has saved on this machine (p23-t10).
  process.env.TYCOON_STANDALONE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-dispatcher-envstore-empty-"));
  try {
    const { fn } = dispatcherAdapters.resolveAdapter("openai-compatible");
    // stub adapter not engaged here (no TYCOON_DISPATCH_ADAPTER set) — assert the
    // real adapter's error message names OPENAI_COMPAT_BASE_URL and both
    // sources checked (process env + the local env store), never a value.
    const result = await fn("hello", { vendor: "openai-compatible" });
    assert.equal(result.error, "OPENAI_COMPAT_BASE_URL is not set in the Codex process environment or the TycoonAgents local env store.");
  } finally {
    if (prevBase !== undefined) process.env.OPENAI_COMPAT_BASE_URL = prevBase;
    if (prevKey !== undefined) process.env.OPENAI_COMPAT_API_KEY = prevKey;
    if (prevDataDir === undefined) delete process.env.TYCOON_STANDALONE_DATA_DIR;
    else process.env.TYCOON_STANDALONE_DATA_DIR = prevDataDir;
  }
});

test("dispatcherAdapters: openai vendor is an explicit error, never a substitution", async () => {
  const { fn } = dispatcherAdapters.resolveAdapter("openai");
  const result = await fn("hello", { vendor: "openai" });
  assert.equal(result.error, "use Codex native agents");
});

test("dispatcherAdapters: google vendor without GEMINI_API_KEY errors explicitly", async () => {
  const prev = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const { fn } = dispatcherAdapters.resolveAdapter("google");
    const result = await fn("hello", { vendor: "google" });
    assert.ok(result.error && result.error.includes("GEMINI_API_KEY"));
  } finally {
    if (prev !== undefined) process.env.GEMINI_API_KEY = prev;
  }
});

test("handleDelegateTool: explicit specialist name routing selects correct workerId + adapter, writes PreToolUse+SubagentStop", async () => {
  const dir = makeProjectDir();
  const { mod, restore } = loadDispatcherModule(dir);
  try {
    const result = await mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes("stub:anthropic:"));

    const records = readActivityRecords(mod.resolveActivityFile());
    const pre = records.find((r) => r.event === "PreToolUse");
    const stop = records.find((r) => r.event === "SubagentStop");
    assert.ok(pre, "expected a PreToolUse record");
    assert.equal(pre!.provider, "codex");
    assert.equal(pre!.tool, "Task");
    assert.equal(pre!.workerId, "coding-specialist");
    assert.equal(pre!.vendor, "anthropic");
    assert.equal(pre!.costModelClass, "subscription");
    assert.ok(stop, "expected a SubagentStop record");
    assert.equal(stop!.workerId, "coding-specialist");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleDelegateTool: keyword routing (no explicit specialist) matches on description", async () => {
  const dir = makeProjectDir();
  const { mod, restore } = loadDispatcherModule(dir);
  try {
    const result = await mod.handleDelegateTool({ task: "please write vitest coverage", description: "test spec coverage" });
    assert.equal(result.isError, undefined);
    const records = readActivityRecords(mod.resolveActivityFile());
    const pre = records.find((r) => r.event === "PreToolUse");
    assert.equal(pre!.workerId, "testing-specialist");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleDelegateTool: fallback routing when nothing matches", async () => {
  const dir = makeProjectDir();
  const { mod, restore } = loadDispatcherModule(dir);
  try {
    const result = await mod.handleDelegateTool({ task: "zzz unrelated nonsense qqq" });
    assert.equal(result.isError, undefined);
    const records = readActivityRecords(mod.resolveActivityFile());
    const pre = records.find((r) => r.event === "PreToolUse");
    assert.equal(pre!.workerId, "primary-agent");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleDelegateTool: nested delegation via TYCOON_DISPATCH_DEPTH is denied with the leaf message", async () => {
  const dir = makeProjectDir();
  const { mod, restore } = loadDispatcherModule(dir);
  const prevDepth = process.env.TYCOON_DISPATCH_DEPTH;
  process.env.TYCOON_DISPATCH_DEPTH = "1";
  try {
    const result = await mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("leaf worker"));
    const records = readActivityRecords(mod.resolveActivityFile());
    assert.equal(records.length, 0, "denied dispatch must not write a PreToolUse/SubagentStop record");
  } finally {
    if (prevDepth === undefined) delete process.env.TYCOON_DISPATCH_DEPTH; else process.env.TYCOON_DISPATCH_DEPTH = prevDepth;
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleDelegateTool: nested delegation via active-agent-codex.json stack is denied", async () => {
  const dir = makeProjectDir();
  fs.writeFileSync(
    path.join(dir, ".claude", "tycoon", "active-agent-codex.json"),
    JSON.stringify({ stack: [{ threadId: "thread-1", agentId: "coding-specialist", at: Date.now() }] }),
  );
  const { mod, restore } = loadDispatcherModule(dir);
  const prevThread = process.env.TYCOON_CODEX_THREAD_ID;
  process.env.TYCOON_CODEX_THREAD_ID = "thread-1";
  try {
    const result = await mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("leaf worker"));
  } finally {
    if (prevThread === undefined) delete process.env.TYCOON_CODEX_THREAD_ID; else process.env.TYCOON_CODEX_THREAD_ID = prevThread;
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleDelegateTool: vendor selects openai-compatible adapter for a moonshot specialist", async () => {
  const dir = makeProjectDir();
  const { mod, restore } = loadDispatcherModule(dir);
  try {
    const result = await mod.handleDelegateTool({ specialist: "kimi-reviewer", task: "review this" });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes("stub:moonshot:"));
    const records = readActivityRecords(mod.resolveActivityFile());
    const pre = records.find((r) => r.event === "PreToolUse");
    assert.equal(pre!.vendor, "moonshot");
    assert.equal(pre!.costModelClass, "local");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleDelegateTool: openai vendor specialist under the real (non-stub) adapter path fails with ProviderError, never substitutes a model", async () => {
  const dir = makeProjectDir();
  const modPath = require.resolve("../../hooks/tycoon-dispatcher-mcp.cjs");
  delete require.cache[modPath];
  const prevProjectDir = process.env.TYCOON_PROJECT_DIR;
  const prevAdapter = process.env.TYCOON_DISPATCH_ADAPTER;
  process.env.TYCOON_PROJECT_DIR = dir;
  delete process.env.TYCOON_DISPATCH_ADAPTER; // real adapter path, not stub
  try {
    const mod = require(modPath) as { handleDelegateTool: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>; resolveActivityFile: () => string };
    const result = await mod.handleDelegateTool({ specialist: "codex-reviewer", task: "review this" });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("use Codex native agents"));
    const records = readActivityRecords(mod.resolveActivityFile());
    const err = records.find((r) => r.event === "ProviderError");
    assert.ok(err, "expected a ProviderError record");
    assert.equal(err!.reason, "dispatch-failed");
    assert.equal(err!.vendor, "openai");
    const pre = records.find((r) => r.event === "PreToolUse");
    assert.equal(pre!.costModelClass, "subscription");
  } finally {
    if (prevProjectDir === undefined) delete process.env.TYCOON_PROJECT_DIR; else process.env.TYCOON_PROJECT_DIR = prevProjectDir;
    if (prevAdapter === undefined) delete process.env.TYCOON_DISPATCH_ADAPTER; else process.env.TYCOON_DISPATCH_ADAPTER = prevAdapter;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleDelegateTool: missing TYCOON_PROJECT_DIR and unusable cwd surfaces an explicit error, not a silent drop", async () => {
  // Contract: TYCOON_PROJECT_DIR -> cwd walk-up to `.claude/tycoon/` -> copied-hook location
  // -> explicit throw. Environment-independent: cwd is always a fresh temp dir.
  const modPath = require.resolve("../../hooks/tycoon-dispatcher-mcp.cjs");
  const prevEnv = process.env.TYCOON_PROJECT_DIR;
  const prevCwd = process.cwd();
  const hasMarkedAncestor = (start: string): boolean => {
    for (let d = path.resolve(start); ; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, ".claude", "tycoon"))) return true;
      if (path.dirname(d) === d) return false;
    }
  };
  const unmarked = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-nomarker-"));
  const marked = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-marker-"));
  delete process.env.TYCOON_PROJECT_DIR;
  try {
    fs.mkdirSync(path.join(marked, ".claude", "tycoon"), { recursive: true });

    // (b) marker present -> resolves to that project's activity file.
    process.chdir(marked);
    delete require.cache[modPath];
    const modB = require(modPath) as { resolveActivityFile: () => string };
    const fileB = modB.resolveActivityFile();
    assert.equal(path.basename(fileB), "activity.jsonl");
    assert.equal(fs.realpathSync(path.dirname(fileB)), fs.realpathSync(path.join(marked, ".claude", "tycoon")));

    // (a) no marker anywhere up the tree -> explicit error, not a silent fallback.
    if (hasMarkedAncestor(unmarked)) {
      console.log("skipping no-marker assertion: os.tmpdir() has a .claude/tycoon ancestor");
    } else {
      process.chdir(unmarked);
      delete require.cache[modPath];
      const modA = require(modPath) as { resolveActivityFile: () => string };
      assert.throws(() => modA.resolveActivityFile(), /couldn't tell which project this Codex session is in/);
    }
  } finally {
    process.chdir(prevCwd);
    delete require.cache[modPath];
    if (prevEnv === undefined) delete process.env.TYCOON_PROJECT_DIR; else process.env.TYCOON_PROJECT_DIR = prevEnv;
    fs.rmSync(unmarked, { recursive: true, force: true });
    fs.rmSync(marked, { recursive: true, force: true });
  }
});

test("handleDelegateTool: claude-worker (explicit backend.costModelClass: subscription) records costModelClass subscription, never metered", async () => {
  const dir = makeProjectDir();
  const { mod, restore } = loadDispatcherModule(dir);
  try {
    const result = await mod.handleDelegateTool({ specialist: "claude-worker", task: "do a thing" });
    assert.equal(result.isError, undefined);
    const records = readActivityRecords(mod.resolveActivityFile());
    const pre = records.find((r) => r.event === "PreToolUse");
    assert.equal(pre!.vendor, "anthropic");
    assert.equal(pre!.costModelClass, "subscription");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Plan p25-t3: fallback chain execution on the stub-adapter path ---

function withStubFailure<T>(errorText: string, failCount: number, fn: () => Promise<T>): Promise<T> {
  const prevText = process.env.TYCOON_STUB_ERROR_TEXT;
  const prevCount = process.env.TYCOON_STUB_FAIL_COUNT;
  process.env.TYCOON_STUB_ERROR_TEXT = errorText;
  process.env.TYCOON_STUB_FAIL_COUNT = String(failCount);
  return fn().finally(() => {
    if (prevText === undefined) delete process.env.TYCOON_STUB_ERROR_TEXT; else process.env.TYCOON_STUB_ERROR_TEXT = prevText;
    if (prevCount === undefined) delete process.env.TYCOON_STUB_FAIL_COUNT; else process.env.TYCOON_STUB_FAIL_COUNT = prevCount;
  });
}

function writeRoutingJson(dir: string, doc: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, ".claude", "tycoon", "routing.json"), JSON.stringify(doc));
}

test("handleDelegateTool: usage-limit adapter failure advances through the specialist's own routing.json fallback chain, then succeeds", async () => {
  const dir = makeProjectDir();
  writeRoutingJson(dir, {
    version: 1,
    agents: {
      "coding-specialist": {
        fallback: [{ vendor: "moonshot", model: "moonshot/kimi-k2" }],
      },
    },
  });
  const { mod, restore } = loadDispatcherModule(dir);
  try {
    const result = await withStubFailure("usage limit reached", 1, () =>
      mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" }),
    );
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes("stub:moonshot:"));

    const records = readActivityRecords(mod.resolveActivityFile());
    const errorRec = records.find((r) => r.event === "ProviderError");
    const fallbackPre = records.find((r) => r.event === "PreToolUse" && r.fallbackDepth === 1);
    const failedStop = records.find((r) => r.event === "SubagentStop" && r.fallbackDepth === undefined);
    const stop = records.find((r) => r.event === "SubagentStop" && r.fallbackDepth === 1);
    assert.ok(errorRec, "expected a ProviderError for the failed first attempt");
    assert.equal(errorRec!.vendor, "anthropic");
    assert.ok(fallbackPre, "expected a fallback PreToolUse");
    assert.equal(fallbackPre!.fallbackOf, "coding-specialist");
    assert.equal(fallbackPre!.vendor, "moonshot");
    assert.equal(fallbackPre!.model, "moonshot/kimi-k2");
    assert.equal(fallbackPre!.fallbackIsDefault, false);
    assert.ok(failedStop, "expected a SubagentStop closing out the failed first attempt's spawnId");
    assert.equal(failedStop!.usageReported, false);
    assert.ok(stop, "expected a SubagentStop after the fallback succeeded");
    assert.equal(stop!.fallbackOf, "coding-specialist");
    assert.equal(stop!.fallbackDepth, 1);
    assert.equal(stop!.fallbackIsDefault, false);
    assert.notEqual(failedStop!.spawnId, fallbackPre!.spawnId, "the retry must get a new spawnId, not reuse the failed attempt's");
    assert.equal(fallbackPre!.spawnId, stop!.spawnId, "the retry's PreToolUse and its SubagentStop share the new spawnId");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleDelegateTool: defaultFallback is used when the specialist has no chain of its own", async () => {
  const dir = makeProjectDir();
  writeRoutingJson(dir, {
    version: 1,
    agents: {},
    defaultFallback: { vendor: "moonshot", model: "moonshot/kimi-k2" },
  });
  const { mod, restore } = loadDispatcherModule(dir);
  try {
    const result = await withStubFailure("429 rate limit", 1, () =>
      mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" }),
    );
    assert.equal(result.isError, undefined);
    const records = readActivityRecords(mod.resolveActivityFile());
    const fallbackPre = records.find((r) => r.event === "PreToolUse" && r.fallbackDepth === 1);
    assert.ok(fallbackPre, "expected defaultFallback to be used as the fallback entry");
    assert.equal(fallbackPre!.vendor, "moonshot");
    assert.equal(fallbackPre!.model, "moonshot/kimi-k2");
    assert.equal(fallbackPre!.fallbackIsDefault, true);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// p31-t1: defaultFallback now fires at the bottom of an EXPLICIT chain too,
// once it's exhausted — not only when the specialist has no chain at all.

test("handleDelegateTool: defaultFallback fires once the specialist's own explicit chain is exhausted", async () => {
  const dir = makeProjectDir();
  writeRoutingJson(dir, {
    version: 1,
    agents: {
      "coding-specialist": { fallback: [{ vendor: "moonshot", model: "moonshot/kimi-k2" }] },
    },
    defaultFallback: { vendor: "google", model: "google/gemini-2.5-pro" },
  });
  const { mod, restore } = loadDispatcherModule(dir);
  try {
    // Primary fails, its one explicit fallback entry also fails, so the
    // third attempt must be the defaultFallback.
    const result = await withStubFailure("429 rate limit", 2, () =>
      mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" }),
    );
    assert.equal(result.isError, undefined);
    const records = readActivityRecords(mod.resolveActivityFile());
    const fallbackPre = records.find((r) => r.event === "PreToolUse" && r.fallbackDepth === 2);
    assert.ok(fallbackPre, "expected a second-level fallback (the default) to be attempted");
    assert.equal(fallbackPre!.vendor, "google");
    assert.equal(fallbackPre!.model, "google/gemini-2.5-pro");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleDelegateTool: useDefaultFallback:false on the specialist's slot suppresses the default once its chain is exhausted", async () => {
  const dir = makeProjectDir();
  writeRoutingJson(dir, {
    version: 1,
    agents: {
      "coding-specialist": {
        fallback: [{ vendor: "moonshot", model: "moonshot/kimi-k2" }],
        useDefaultFallback: false,
      },
    },
    defaultFallback: { vendor: "google", model: "google/gemini-2.5-pro" },
  });
  const { mod, restore } = loadDispatcherModule(dir);
  try {
    const result = await withStubFailure("429 rate limit", 2, () =>
      mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" }),
    );
    // Both the primary and its one explicit fallback fail; with the
    // default suppressed there is nothing left, so the call must error.
    assert.ok(result.isError, "expected the delegate call to fail once fallback is exhausted");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleDelegateTool: a non-failure adapter error does not trigger fallback, even with a chain configured", async () => {
  const dir = makeProjectDir();
  writeRoutingJson(dir, {
    version: 1,
    agents: {
      "coding-specialist": { fallback: [{ vendor: "moonshot", model: "moonshot/kimi-k2" }] },
    },
  });
  const { mod, restore } = loadDispatcherModule(dir);
  try {
    const result = await withStubFailure("Invalid model \"bogus\"", 1, () =>
      mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" }),
    );
    assert.equal(result.isError, true);
    const records = readActivityRecords(mod.resolveActivityFile());
    const errorRecs = records.filter((r) => r.event === "ProviderError");
    const fallbackPre = records.find((r) => r.event === "PreToolUse" && typeof r.fallbackDepth === "number");
    assert.equal(errorRecs.length, 1, "only the single non-fallback ProviderError should be written");
    assert.equal(fallbackPre, undefined, "no fallback dispatch should have been attempted");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleDelegateTool: fallback chain exhaustion returns the last error, never selecting a model outside the chain", async () => {
  const dir = makeProjectDir();
  writeRoutingJson(dir, {
    version: 1,
    agents: {
      "coding-specialist": { fallback: [{ vendor: "moonshot", model: "moonshot/kimi-k2" }] },
    },
  });
  const { mod, restore } = loadDispatcherModule(dir);
  try {
    // Fail every attempt (primary + the single chain entry) — chain exhausts after 1 fallback hop.
    const result = await withStubFailure("usage limit reached", 5, () =>
      mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" }),
    );
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("usage limit reached"));

    const records = readActivityRecords(mod.resolveActivityFile());
    const errorRecs = records.filter((r) => r.event === "ProviderError");
    const vendorsSeen = new Set(errorRecs.map((r) => r.vendor));
    assert.equal(errorRecs.length, 2, "primary attempt + the one chain entry, then exhausted — no more attempts");
    assert.deepEqual([...vendorsSeen].sort(), ["anthropic", "moonshot"]);
    // Every failed attempt (including the terminal one) still gets its own
    // SubagentStop to close out that attempt's spawnId — otherwise the
    // final failed attempt's liveSpawns entry would leak forever.
    const stopRecs = records.filter((r) => r.event === "SubagentStop");
    assert.equal(stopRecs.length, 2, "both the primary and the exhausted fallback attempt get a closing SubagentStop");
    assert.ok(stopRecs.every((r) => r.usageReported === false));
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleDelegateTool: the dispatcher's own missing-endpoint-env message triggers fallback the same as a provider-failure pattern", async () => {
  const dir = makeProjectDir();
  writeRoutingJson(dir, {
    version: 1,
    agents: {
      "kimi-reviewer": { fallback: [{ vendor: "anthropic", model: "anthropic/claude-sonnet-4-6" }] },
    },
  });
  const { mod, restore } = loadDispatcherModule(dir);
  try {
    const result = await withStubFailure(
      "OPENAI_COMPAT_BASE_URL is not set in the Codex process environment or the TycoonAgents local env store.",
      1,
      () => mod.handleDelegateTool({ specialist: "kimi-reviewer", task: "do a thing" }),
    );
    assert.equal(result.isError, undefined);
    const records = readActivityRecords(mod.resolveActivityFile());
    const fallbackPre = records.find((r) => r.event === "PreToolUse" && r.fallbackDepth === 1);
    assert.ok(fallbackPre, "expected the missing-endpoint message to trigger fallback dispatch");
    assert.equal(fallbackPre!.vendor, "anthropic");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Plan p23-t9: linking dispatcher records to the live Codex session ---

function makeCodexHomeWithRollout(cwd: string, threadId: string, threadSource?: string, sessionId?: string): string {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-codex-home-"));
  const sessionsDir = path.join(codexHome, "sessions", "2026", "09", "09");
  fs.mkdirSync(sessionsDir, { recursive: true });
  // session_id intentionally distinct from id by default: on a child (forked)
  // rollout, session_id equals the PARENT thread's id, not this thread's own —
  // the resolver must key off `id`, never fall back to `session_id`.
  const payload: Record<string, unknown> = { id: threadId, session_id: sessionId ?? `parent-of-${threadId}`, cwd, timestamp: "2026-09-09T00:00:00.000Z" };
  if (threadSource !== undefined) payload.thread_source = threadSource;
  const line = JSON.stringify({ timestamp: "2026-09-09T00:00:00.000Z", ordinal: 0, type: "session_meta", payload }) + "\n";
  fs.writeFileSync(path.join(sessionsDir, `rollout-2026-09-09T00-00-00-${threadId}.jsonl`), line);
  return codexHome;
}

test("handleDelegateTool: no TYCOON_CODEX_THREAD_ID, matching user-thread rollout -> sessionId + parentId set to that thread id", async () => {
  const dir = makeProjectDir();
  const threadId = "01a08436-0127-7e42-9ddd-3fa757a819ed";
  const codexHome = makeCodexHomeWithRollout(dir, threadId, "user");
  const { mod, restore } = loadDispatcherModule(dir);
  const prevThread = process.env.TYCOON_CODEX_THREAD_ID;
  const prevHome = process.env.CODEX_HOME;
  delete process.env.TYCOON_CODEX_THREAD_ID;
  process.env.CODEX_HOME = codexHome;
  try {
    const result = await mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" });
    assert.equal(result.isError, undefined);
    const records = readActivityRecords(mod.resolveActivityFile());
    const pre = records.find((r) => r.event === "PreToolUse");
    assert.equal(pre!.sessionId, threadId);
    assert.equal(pre!.parentId, threadId);
  } finally {
    if (prevThread === undefined) delete process.env.TYCOON_CODEX_THREAD_ID; else process.env.TYCOON_CODEX_THREAD_ID = prevThread;
    if (prevHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevHome;
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("handleDelegateTool: child-rollout session_id (parent's id) is never used — resolved sessionId/parentId equals the rollout's own `id`", async () => {
  const dir = makeProjectDir();
  const threadId = "01a08437-3da8-78e3-93c8-4a12d9bdd11d";
  const parentId = "01a08436-0127-7e42-9ddd-3fa757a819ed";
  const codexHome = makeCodexHomeWithRollout(dir, threadId, "user", parentId);
  const { mod, restore } = loadDispatcherModule(dir);
  const prevThread = process.env.TYCOON_CODEX_THREAD_ID;
  const prevHome = process.env.CODEX_HOME;
  delete process.env.TYCOON_CODEX_THREAD_ID;
  process.env.CODEX_HOME = codexHome;
  try {
    const result = await mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" });
    assert.equal(result.isError, undefined);
    const records = readActivityRecords(mod.resolveActivityFile());
    const pre = records.find((r) => r.event === "PreToolUse");
    assert.equal(pre!.sessionId, threadId);
    assert.equal(pre!.parentId, threadId);
    assert.notEqual(pre!.sessionId, parentId);
  } finally {
    if (prevThread === undefined) delete process.env.TYCOON_CODEX_THREAD_ID; else process.env.TYCOON_CODEX_THREAD_ID = prevThread;
    if (prevHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevHome;
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("handleDelegateTool: no TYCOON_CODEX_THREAD_ID and no matching rollout -> sessionId 'dispatcher', no parentId, warns on stderr, never throws", async () => {
  const dir = makeProjectDir();
  const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-other-cwd-"));
  const codexHome = makeCodexHomeWithRollout(otherCwd, "01a08436-0127-7e42-9ddd-3fa757a819ed", "user");
  const { mod, restore } = loadDispatcherModule(dir);
  const prevThread = process.env.TYCOON_CODEX_THREAD_ID;
  const prevHome = process.env.CODEX_HOME;
  delete process.env.TYCOON_CODEX_THREAD_ID;
  process.env.CODEX_HOME = codexHome;
  const originalWrite = process.stderr.write.bind(process.stderr);
  let sawWarning = false;
  (process.stderr.write as unknown) = (chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string" && chunk.includes("could not resolve a live Codex parent thread")) sawWarning = true;
    return originalWrite(chunk as never, ...(rest as []));
  };
  try {
    const result = await mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" });
    assert.equal(result.isError, undefined);
    const records = readActivityRecords(mod.resolveActivityFile());
    const pre = records.find((r) => r.event === "PreToolUse");
    assert.equal(pre!.sessionId, "dispatcher");
    assert.equal(pre!.parentId, undefined);
    assert.ok(sawWarning, "expected a stderr warning when no rollout matches");
  } finally {
    process.stderr.write = originalWrite;
    if (prevThread === undefined) delete process.env.TYCOON_CODEX_THREAD_ID; else process.env.TYCOON_CODEX_THREAD_ID = prevThread;
    if (prevHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevHome;
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(otherCwd, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

// --- MCP handshake over stdio, in a real child process ---

function sendAndCollect(child: ReturnType<typeof spawn>, messages: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const responses: Array<Record<string, unknown>> = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP handshake test timed out; got: ${JSON.stringify(responses)}`));
    }, 15000);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          responses.push(JSON.parse(line));
        } catch {
          // ignore non-JSON lines
        }
        if (responses.length >= messages.length) {
          clearTimeout(timer);
          child.kill();
          resolve(responses);
          return;
        }
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    for (const m of messages) {
      child.stdin!.write(JSON.stringify(m) + "\n");
    }
  });
}

test("MCP handshake: initialize/tools.list/tools.call round-trip over stdio in a child process", async () => {
  const dir = makeProjectDir();
  try {
    const scriptPath = require.resolve("../../hooks/tycoon-dispatcher-mcp.cjs");
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, TYCOON_PROJECT_DIR: dir, TYCOON_DISPATCH_ADAPTER: "stub" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // notifications/initialized has no id and produces no response line — it is
    // sent (mirroring a real client's handshake) but excluded from the 3
    // response lines sendAndCollect waits for (init, tools/list, tools/call).
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "delegate", arguments: { specialist: "coding-specialist", task: "hello" } } },
    ];
    void messages[1]; // notifications/initialized: legacy handshake allows omitting it since this server never gates on it
    const responses = await sendAndCollect(child, [messages[0], messages[2], messages[3]]);

    const initResp = responses.find((r) => r.id === 1);
    assert.ok(initResp, "expected an initialize response");
    assert.equal((initResp as any).result.serverInfo.name, "tycoon-dispatcher-mcp");

    const listResp = responses.find((r) => r.id === 2);
    assert.ok(listResp, "expected a tools/list response");
    const tools = (listResp as any).result.tools;
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "delegate");

    const callResp = responses.find((r) => r.id === 3);
    assert.ok(callResp, "expected a tools/call response");
    assert.equal((callResp as any).result.isError, undefined);
    assert.ok((callResp as any).result.content[0].text.includes("stub:anthropic:"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("anthropicAdapter: exit-1 error includes stderr tail and argv, never the prompt text", async () => {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-fake-claude-"));
  const secretPrompt = "SECRET-PROMPT-MARKER-should-never-appear-in-error";
  const IS_WIN = process.platform === "win32";
  const fakeClaudeBody = [
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    "  process.stderr.write('fake claude: simulated failure, out of budget\\n');",
    "  process.exit(1);",
    "});",
  ].join("\n");
  let claudeBin: string;
  if (IS_WIN) {
    // Mirrors an npm .cmd shim: dispatcherAdapters' resolveCmdShimJsEntry
    // parses a quoted *.js path out of the .cmd file and spawns it with node
    // directly — this rung of resolveSpawnTarget only fires on win32 for a
    // .cmd/.bat path, so this shape is win32-only.
    const jsEntryPath = path.join(fakeDir, "fake-claude.js").replace(/\\/g, "\\\\");
    fs.writeFileSync(path.join(fakeDir, "fake-claude.cmd"), `@echo off\r\nnode "${jsEntryPath}" %*\r\n`);
    fs.writeFileSync(path.join(fakeDir, "fake-claude.js"), fakeClaudeBody);
    claudeBin = path.join(fakeDir, "fake-claude.cmd");
  } else {
    // On posix, resolveSpawnTarget spawns CLAUDE_CLI_BIN directly (no shim
    // resolution) — a chmod'd #!/usr/bin/env node script, never a compiled
    // or renamed executable.
    claudeBin = path.join(fakeDir, "fake-claude");
    fs.writeFileSync(claudeBin, `#!/usr/bin/env node\n${fakeClaudeBody}\n`, "utf8");
    fs.chmodSync(claudeBin, 0o755);
  }
  const prevBin = process.env.CLAUDE_CLI_BIN;
  process.env.CLAUDE_CLI_BIN = claudeBin;
  try {
    const result = await dispatcherAdapters.anthropicAdapter(secretPrompt, { model: "sonnet" });
    assert.ok(result.error, "expected an error result");
    assert.match(result.error as string, /fake claude: simulated failure, out of budget/);
    assert.match(result.error as string, /argv:/);
    assert.doesNotMatch(result.error as string, /SECRET-PROMPT-MARKER/);
  } finally {
    if (prevBin === undefined) delete process.env.CLAUDE_CLI_BIN; else process.env.CLAUDE_CLI_BIN = prevBin;
    fs.rmSync(fakeDir, { recursive: true, force: true });
  }
});

test("anthropicAdapter: strips a leading anthropic/ so the CLI gets --model sonnet / --model claude-sonnet-5-5", async () => {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-fake-claude-model-"));
  const fakeClaudeBody = "process.stdin.resume();\nprocess.stdin.on('end', () => { process.stderr.write('fail'); process.exit(1); });";
  let claudeBin: string;
  if (process.platform === "win32") {
    const jsEntryPath = path.join(fakeDir, "fake-claude.js").replace(/\\/g, "\\\\");
    fs.writeFileSync(path.join(fakeDir, "fake-claude.cmd"), `@echo off\r\nnode "${jsEntryPath}" %*\r\n`);
    fs.writeFileSync(path.join(fakeDir, "fake-claude.js"), fakeClaudeBody);
    claudeBin = path.join(fakeDir, "fake-claude.cmd");
  } else {
    claudeBin = path.join(fakeDir, "fake-claude");
    fs.writeFileSync(claudeBin, `#!/usr/bin/env node\n${fakeClaudeBody}\n`, "utf8");
    fs.chmodSync(claudeBin, 0o755);
  }
  const prevBin = process.env.CLAUDE_CLI_BIN;
  process.env.CLAUDE_CLI_BIN = claudeBin;
  try {
    const alias = await dispatcherAdapters.anthropicAdapter("p", { model: "anthropic/sonnet" });
    assert.match(alias.error as string, /--model sonnet --permission-mode/);
    const concrete = await dispatcherAdapters.anthropicAdapter("p", { model: "anthropic/claude-sonnet-5-5" });
    assert.match(concrete.error as string, /--model claude-sonnet-5-5 --permission-mode/);
  } finally {
    if (prevBin === undefined) delete process.env.CLAUDE_CLI_BIN; else process.env.CLAUDE_CLI_BIN = prevBin;
    fs.rmSync(fakeDir, { recursive: true, force: true });
  }
});

// --- anthropic adapter permission mode: builders acceptEdits, read-only roles plan ---

async function runAnthropicWithFake(
  agents: Record<string, string>,
  workerId: string,
  env: Record<string, string> = {},
): Promise<{ mode: string; cwd: string; args: string[]; projectDir: string; bridge?: string; stdin?: string }> {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-fake-claude-perm-"));
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-perm-project-")));
  fs.mkdirSync(path.join(projectDir, ".claude", "agents"), { recursive: true });
  for (const [name, body] of Object.entries(agents)) {
    fs.writeFileSync(path.join(projectDir, ".claude", "agents", `${name}.md`), body);
  }
  const body = [
    "let stdin = '';",
    "process.stdin.on('data', (c) => { stdin += c; });",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(JSON.stringify({ result: JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), bridge: process.env.TYCOON_BRIDGE_CHILD, stdin }) }));",
    "});",
  ].join("\n");
  let claudeBin: string;
  if (process.platform === "win32") {
    const jsEntryPath = path.join(fakeDir, "fake-claude.js").replace(/\\/g, "\\\\");
    fs.writeFileSync(path.join(fakeDir, "fake-claude.cmd"), `@echo off\r\nnode "${jsEntryPath}" %*\r\n`);
    fs.writeFileSync(path.join(fakeDir, "fake-claude.js"), body);
    claudeBin = path.join(fakeDir, "fake-claude.cmd");
  } else {
    claudeBin = path.join(fakeDir, "fake-claude");
    fs.writeFileSync(claudeBin, `#!/usr/bin/env node\n${body}\n`, "utf8");
    fs.chmodSync(claudeBin, 0o755);
  }
  const keys = ["CLAUDE_CLI_BIN", "CLAUDE_CLI_PERMISSION_MODE", "CLAUDE_CLI_CWD", "TYCOON_DISPATCH_HOST"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  delete process.env.CLAUDE_CLI_PERMISSION_MODE;
  delete process.env.CLAUDE_CLI_CWD;
  delete process.env.TYCOON_DISPATCH_HOST;
  process.env.CLAUDE_CLI_BIN = claudeBin;
  Object.assign(process.env, env);
  try {
    const res = await dispatcherAdapters.anthropicAdapter("task", { model: "sonnet", workerId, projectDir });
    assert.ok(!res.error, `unexpected error: ${res.error}`);
    const parsed = JSON.parse(res.text as string);
    const args: string[] = parsed.args;
    return { mode: args[args.indexOf("--permission-mode") + 1], cwd: fs.realpathSync(parsed.cwd), args, projectDir, bridge: parsed.bridge, stdin: parsed.stdin };
  } finally {
    for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    fs.rmSync(fakeDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

const BUILDER_MD = "---\nname: coding-specialist\ntools: Read, Edit, Write, Bash\n---\nbody\n";

test("anthropicAdapter permission mode: builder gets acceptEdits, cwd is the project, no --add-dir", async () => {
  const r = await runAnthropicWithFake({ "coding-specialist": BUILDER_MD }, "coding-specialist");
  assert.equal(r.mode, "acceptEdits");
  assert.equal(r.cwd, r.projectDir);
  assert.ok(!r.args.includes("--add-dir"));
});

const WRAPPER_FM = (name: string) =>
  `---
name: ${name}
disallowedTools: Agent, Read, Write, Edit, MultiEdit, NotebookEdit, Glob, Grep, Bash, PowerShell, WebFetch, WebSearch
backend:
  vendor: anthropic
  transport: mcp
  mcpServer: claude-cli
  tools: [claude]
  model: anthropic/sonnet
---
Use the \`claude\` tool WRAPPER-BODY-MARKER
`;

test("bridge wrapper builder (claude-worker): acceptEdits in the project, leaf preamble, wrapper body never sent", async () => {
  const r = await runAnthropicWithFake({ "claude-worker": WRAPPER_FM("claude-worker") }, "claude-worker");
  assert.equal(r.mode, "acceptEdits");
  assert.equal(r.cwd, r.projectDir);
  assert.equal(r.bridge, "1");
  assert.ok(r.args.includes("--append-system-prompt"));
  assert.equal(r.args[r.args.indexOf("--disallowedTools") + 1], "Task,Agent");
  assert.ok(!r.args.includes("--add-dir"));
  assert.doesNotMatch(r.stdin as string, /WRAPPER-BODY-MARKER/);
});

test("bridge wrapper reviewer (gemini-reviewer): plan, scratch cwd, project readable via --add-dir", async () => {
  const r = await runAnthropicWithFake({ "gemini-reviewer": WRAPPER_FM("gemini-reviewer") }, "gemini-reviewer");
  assert.equal(r.mode, "plan");
  assert.notEqual(r.cwd, r.projectDir);
  assert.equal(r.args[r.args.indexOf("--add-dir") + 1], r.projectDir);
});

test("bridge wrapper with a non-claude-cli mcpServer (second-opinion) stays plan", async () => {
  const fm = WRAPPER_FM("second-opinion").replace("mcpServer: claude-cli", "mcpServer: other-bridge");
  const r = await runAnthropicWithFake({ "second-opinion": fm }, "second-opinion");
  assert.equal(r.mode, "plan");
});

test("non-wrapper agent with disallowedTools Edit stays plan (wrapper rule does not apply)", async () => {
  const r = await runAnthropicWithFake({ "coding-specialist": "---\ndisallowedTools: Edit, Write\nbackend:\n  vendor: anthropic\n---\n" }, "coding-specialist");
  assert.equal(r.mode, "plan");
});

test("anthropicAdapter permission mode: builder without a tools line (inherits all) gets acceptEdits", async () => {
  const r = await runAnthropicWithFake({ "coding-specialist": "---\nname: coding-specialist\n---\nbody\n" }, "coding-specialist");
  assert.equal(r.mode, "acceptEdits");
});

test("anthropicAdapter permission mode: reviewer, search and codex-reviewer stay plan", async () => {
  for (const name of ["testing-reviewer", "search-retrieval", "codex-reviewer"]) {
    const r = await runAnthropicWithFake({ [name]: BUILDER_MD }, name);
    assert.equal(r.mode, "plan", name);
  }
});

test("anthropicAdapter permission mode: unknown agent (no file) is plan", async () => {
  const r = await runAnthropicWithFake({}, "coding-specialist");
  assert.equal(r.mode, "plan");
});

test("anthropicAdapter permission mode: tools without an edit tool, or disallowedTools Edit, is plan", async () => {
  const noEdit = await runAnthropicWithFake({ "coding-specialist": "---\ntools: Read, Grep, Bash\n---\n" }, "coding-specialist");
  assert.equal(noEdit.mode, "plan");
  const disallowed = await runAnthropicWithFake({ "coding-specialist": "---\ndisallowedTools: Edit, Write\n---\n" }, "coding-specialist");
  assert.equal(disallowed.mode, "plan");
});

test("anthropicAdapter permission mode: frontmatter permissionMode overrides role; bypassPermissions ignored", async () => {
  const plan = await runAnthropicWithFake({ "coding-specialist": "---\npermissionMode: plan\ntools: Edit\n---\n" }, "coding-specialist");
  assert.equal(plan.mode, "plan");
  const bypass = await runAnthropicWithFake({ "coding-specialist": "---\npermissionMode: bypassPermissions\ntools: Edit\n---\n" }, "coding-specialist");
  assert.equal(bypass.mode, "acceptEdits");
  const bypassReviewer = await runAnthropicWithFake({ "code-reviewer": "---\npermissionMode: bypassPermissions\n---\n" }, "code-reviewer");
  assert.equal(bypassReviewer.mode, "plan");
});

test("anthropicAdapter permission mode: env can only downgrade; bypass values ignored", async () => {
  const stay = await runAnthropicWithFake({ "coding-specialist": BUILDER_MD }, "coding-specialist", { CLAUDE_CLI_PERMISSION_MODE: "acceptEdits" });
  assert.equal(stay.mode, "acceptEdits");
  const noUpgrade = await runAnthropicWithFake({ "search-retrieval": BUILDER_MD }, "search-retrieval", { CLAUDE_CLI_PERMISSION_MODE: "acceptEdits" });
  assert.equal(noUpgrade.mode, "plan");
  const noUpgradeDefault = await runAnthropicWithFake({ "code-reviewer": BUILDER_MD }, "code-reviewer", { CLAUDE_CLI_PERMISSION_MODE: "default" });
  assert.equal(noUpgradeDefault.mode, "plan");
  const toPlan = await runAnthropicWithFake({ "coding-specialist": BUILDER_MD }, "coding-specialist", { CLAUDE_CLI_PERMISSION_MODE: "plan" });
  assert.equal(toPlan.mode, "plan");
  for (const bad of ["bypassPermissions", "dontAsk", "nonsense"]) {
    const r = await runAnthropicWithFake({ "coding-specialist": BUILDER_MD }, "coding-specialist", { CLAUDE_CLI_PERMISSION_MODE: bad });
    assert.equal(r.mode, "acceptEdits", bad);
  }
});

test("anthropicAdapter classifier: no frontmatter is plan; frontmatter with only disallowedTools: Agent stays a builder", async () => {
  const none = await runAnthropicWithFake({ "coding-specialist": "just a body, no frontmatter" }, "coding-specialist");
  assert.equal(none.mode, "plan");
  const builder = await runAnthropicWithFake({ "coding-specialist": ["---", "name: coding-specialist", "disallowedTools: Agent", "---", "body", ""].join("\n") }, "coding-specialist");
  assert.equal(builder.mode, "acceptEdits");
});

test("anthropicAdapter acceptEdits child: leaf preamble, Task/Agent disallowed, TYCOON_BRIDGE_CHILD=1, CLAUDE_CLI_CWD ignored", async () => {
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-perm-elsewhere-")));
  try {
    const r = await runAnthropicWithFake({ "coding-specialist": BUILDER_MD }, "coding-specialist", { CLAUDE_CLI_CWD: elsewhere });
    assert.equal(r.mode, "acceptEdits");
    assert.equal(r.cwd, r.projectDir);
    assert.equal(r.bridge, "1");
    assert.match(r.args[r.args.indexOf("--append-system-prompt") + 1], /leaf worker.*Do not delegate/);
    assert.equal(r.args[r.args.indexOf("--disallowedTools") + 1], "Task,Agent");
  } finally {
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("anthropicAdapter plan child: scratch dir (not the project), CLAUDE_CLI_CWD honoured, no leaf flags", async () => {
  const plan = await runAnthropicWithFake({ "code-reviewer": BUILDER_MD }, "code-reviewer");
  assert.equal(plan.mode, "plan");
  assert.notEqual(plan.cwd, plan.projectDir);
  assert.ok(!plan.args.includes("--append-system-prompt"));
  assert.ok(!plan.args.includes("--disallowedTools"));
  assert.equal(plan.bridge, "1");
  const custom = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-perm-custom-cwd-")));
  try {
    const r = await runAnthropicWithFake({ "code-reviewer": BUILDER_MD }, "code-reviewer", { CLAUDE_CLI_CWD: custom });
    assert.equal(r.cwd, custom);
  } finally {
    fs.rmSync(custom, { recursive: true, force: true });
  }
});

// --- Plan p25-t5: dispatcher reads the MERGED routing.resolved.json (defaults
// inheritance), not the raw source routing.json ---

// Generates routing.resolved.json through the REAL script (not a hand-written
// fixture) so these tests exercise the actual merge/conversion path,
// including scripts/apply-routing-profile.mjs's defaultFallback -> Backend
// conversion (plan p25-t5 review follow-up).
const APPLY_ROUTING_PROFILE_SCRIPT = path.resolve(__dirname, "..", "..", "scripts", "apply-routing-profile.mjs");

function generateRoutingResolvedJson(dir: string, profile: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, ".claude", "tycoon", "routing.json"), JSON.stringify(profile, null, 2));
  const result = spawnSync("node", [APPLY_ROUTING_PROFILE_SCRIPT, "--root", dir], { encoding: "utf8" });
  assert.equal(result.status, 0, `apply-routing-profile.mjs failed: ${result.stderr}`);
}

test("handleDelegateTool: agent with no fallback of its own inherits defaults.fallback from routing.resolved.json when vendors match", async () => {
  const dir = makeProjectDir();
  // routing.resolved.json is generated by the REAL script from a profile
  // where coding-specialist has no vendor/fallback of its own (an empty
  // slot) and defaults carries both — mergeSlots() (src/core/routingProfile.ts)
  // inherits defaults.fallback since the agent's vendor is unset (matches).
  generateRoutingResolvedJson(dir, {
    version: 1,
    defaults: {
      vendor: "anthropic",
      fallback: [{ vendor: "moonshot", model: "moonshot/kimi-k2" }],
    },
    agents: { "coding-specialist": {} },
  });
  const { mod, restore } = loadDispatcherModule(dir);
  try {
    const result = await withStubFailure("usage limit reached", 1, () =>
      mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" }),
    );
    assert.equal(result.isError, undefined);
    const records = readActivityRecords(mod.resolveActivityFile());
    const fallbackPre = records.find((r) => r.event === "PreToolUse" && r.fallbackDepth === 1);
    assert.ok(fallbackPre, "expected the inherited defaults.fallback chain to be walked");
    assert.equal(fallbackPre!.vendor, "moonshot");
    assert.equal(fallbackPre!.model, "moonshot/kimi-k2");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleDelegateTool: agent on a different vendor than defaults does not inherit defaults.fallback, only top-level defaultFallback applies", async () => {
  const dir = makeProjectDir();
  // Vendor mismatch (agent is moonshot, defaults are anthropic): mergeSlots
  // never inherits defaults.fallback here, so the real script's merged
  // routing.resolved.json has an empty per-agent fallback; only the
  // top-level defaultFallback (converted via routingSlotToBackend, a
  // separate resolve-time mechanism per routingProfile.ts) can still supply
  // a chain.
  generateRoutingResolvedJson(dir, {
    version: 1,
    defaultFallback: { vendor: "google", model: "google/gemini-2.5-pro" },
    defaults: { vendor: "anthropic", fallback: [{ vendor: "moonshot", model: "moonshot/kimi-k2" }] },
    agents: { "coding-specialist": { vendor: "moonshot" } },
  });
  const { mod, restore } = loadDispatcherModule(dir);
  try {
    const result = await withStubFailure("usage limit reached", 1, () =>
      mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" }),
    );
    assert.equal(result.isError, undefined);
    const records = readActivityRecords(mod.resolveActivityFile());
    const fallbackPre = records.find((r) => r.event === "PreToolUse" && r.fallbackDepth === 1);
    assert.ok(fallbackPre, "expected the top-level defaultFallback to be used");
    assert.equal(fallbackPre!.vendor, "google");
    assert.equal(fallbackPre!.model, "google/gemini-2.5-pro");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Per-call spawnId (parity with hooks/tycoon-claude-hook.cjs's generateSpawnId)
// ---------------------------------------------------------------------------

test("handleDelegateTool: PreToolUse and SubagentStop of one delegate call share a spawnId", async () => {
  const dir = makeProjectDir();
  const { mod, restore } = loadDispatcherModule(dir);
  try {
    const result = await mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" });
    assert.equal(result.isError, undefined);

    const records = readActivityRecords(mod.resolveActivityFile());
    const pre = records.find((r) => r.event === "PreToolUse");
    const stop = records.find((r) => r.event === "SubagentStop");
    assert.ok(pre, "expected a PreToolUse record");
    assert.ok(stop, "expected a SubagentStop record");
    assert.equal(typeof pre!.spawnId, "string");
    assert.ok((pre!.spawnId as string).length > 0, "spawnId must be a non-empty string");
    assert.equal(stop!.spawnId, pre!.spawnId, "PreToolUse and SubagentStop of the same dispatch call must share one spawnId");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleDelegateTool: two separate delegate calls get distinct spawnIds", async () => {
  const dir = makeProjectDir();
  const { mod, restore } = loadDispatcherModule(dir);
  try {
    await mod.handleDelegateTool({ specialist: "coding-specialist", task: "first thing" });
    await mod.handleDelegateTool({ specialist: "coding-specialist", task: "second thing" });

    const records = readActivityRecords(mod.resolveActivityFile());
    const pres = records.filter((r) => r.event === "PreToolUse");
    assert.equal(pres.length, 2);
    assert.notEqual(pres[0].spawnId, pres[1].spawnId, "each dispatch call must get its own spawnId");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Provider-limit policy on the Codex host (hooks/bridge-result.cjs shortRetryDelayMs).

test("handleDelegateTool: a Claude Code weekly limit falls back (the old text backstop missed this wording)", async () => {
  const dir = makeProjectDir();
  writeRoutingJson(dir, { version: 1, agents: { "coding-specialist": { fallback: [{ vendor: "moonshot", model: "moonshot/kimi-k2" }] } } });
  const { mod, restore } = loadDispatcherModule(dir);
  try {
    const result = await withStubFailure("You've hit your weekly limit · resets 12am (America/Los_Angeles)", 1, () =>
      mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" }),
    );
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes("stub:moonshot:"));
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleDelegateTool: rate_limit naming a short wait is retried once on the same slot, no fallback", async () => {
  const dir = makeProjectDir();
  writeRoutingJson(dir, { version: 1, agents: { "coding-specialist": { fallback: [{ vendor: "moonshot", model: "moonshot/kimi-k2" }] } } });
  const { mod, restore } = loadDispatcherModule(dir);
  try {
    const result = await withStubFailure("Rate limit exceeded. Please retry after 0 seconds.", 1, () =>
      mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" }),
    );
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes("stub:anthropic:"), "the retry on the primary answered");
    const records = readActivityRecords(mod.resolveActivityFile());
    assert.equal(records.filter((r) => r.event === "ProviderError").length, 0);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleDelegateTool: a short-wait rate_limit that fails again is retried only once, then falls back", async () => {
  const dir = makeProjectDir();
  writeRoutingJson(dir, { version: 1, agents: { "coding-specialist": { fallback: [{ vendor: "moonshot", model: "moonshot/kimi-k2" }] } } });
  const { mod, restore } = loadDispatcherModule(dir);
  try {
    const result = await withStubFailure("Rate limit exceeded. Please retry after 0 seconds.", 2, () =>
      mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" }),
    );
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes("stub:moonshot:"));
    const records = readActivityRecords(mod.resolveActivityFile());
    assert.equal(records.filter((r) => r.event === "ProviderError").length, 1, "one failed slot after its single retry");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleDelegateTool: no same-slot retry when the wait plus a retry run would overrun Codex's MCP tool timeout", async () => {
  const dir = makeProjectDir();
  writeRoutingJson(dir, { version: 1, agents: { "coding-specialist": { fallback: [{ vendor: "moonshot", model: "moonshot/kimi-k2" }] } } });
  const { mod, restore } = loadDispatcherModule(dir);
  const prev = process.env.TYCOON_CODEX_TOOL_TIMEOUT_MS;
  process.env.TYCOON_CODEX_TOOL_TIMEOUT_MS = "500";
  try {
    const result = await withStubFailure("Rate limit exceeded. Please retry after 0 seconds.", 1, () =>
      mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" }),
    );
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes("stub:moonshot:"), "fell back instead of retrying past the tool timeout");
  } finally {
    if (prev === undefined) delete process.env.TYCOON_CODEX_TOOL_TIMEOUT_MS;
    else process.env.TYCOON_CODEX_TOOL_TIMEOUT_MS = prev;
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
