/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFeedbackContext, buildFeedbackPayload } from "../src/host/vscode/feedbackSubmit";
import { setValue as setLocalEnvValue } from "../src/core/localEnvStore";

/*
 * Coverage for buildFeedbackContext()/buildFeedbackPayload() context
 * spreading (docs/FEEDBACK-PIPELINE-SPEC.md). Uses the same temp-project +
 * fake-agents-dir isolation pattern as test/routingHostOps.test.ts and
 * test/agentSettingsRoute.test.ts (TYCOON_STANDALONE_DATA_DIR override for
 * the secret store).
 */

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "feedback-context-"));
}

function writeAgent(root: string, filename: string, frontmatterLines: string[], body = "Body text.\n"): void {
  const dir = path.join(root, ".claude", "agents");
  fs.mkdirSync(dir, { recursive: true });
  const content = `---\n${frontmatterLines.join("\n")}\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(dir, filename), content, "utf8");
}

function writeRouting(root: string, obj: Record<string, unknown>): void {
  const dir = path.join(root, ".claude", "tycoon");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "routing.json"), JSON.stringify({ version: 1, ...obj }, null, 2), "utf8");
}

function writeAgentKeywords(root: string, agents: Record<string, string>): void {
  const dir = path.join(root, ".claude", "tycoon");
  fs.mkdirSync(dir, { recursive: true });
  const obj = { agents: Object.fromEntries(Object.entries(agents).map(([id, pattern]) => [id, { pattern }])) };
  fs.writeFileSync(path.join(dir, "agent-keywords.json"), JSON.stringify(obj, null, 2), "utf8");
}

/** Runs `fn` with TYCOON_STANDALONE_DATA_DIR pointed at a scratch dir, then restores it. */
function withScratchDataDir<T>(fn: (dataDir: string) => T): T {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-context-data-"));
  const prev = process.env.TYCOON_STANDALONE_DATA_DIR;
  process.env.TYCOON_STANDALONE_DATA_DIR = dataDir;
  try {
    return fn(dataDir);
  } finally {
    if (prev === undefined) delete process.env.TYCOON_STANDALONE_DATA_DIR;
    else process.env.TYCOON_STANDALONE_DATA_DIR = prev;
  }
}

// ---------------------------------------------------------------------------
// host / harness echoing
// ---------------------------------------------------------------------------

test("buildFeedbackContext: echoes host for vscode and standalone", () => {
  const root = tmpRoot();
  const vscodeCtx = buildFeedbackContext(root, { host: "vscode" });
  const standaloneCtx = buildFeedbackContext(root, { host: "standalone" });
  assert.equal(vscodeCtx.host, "vscode");
  assert.equal(standaloneCtx.host, "standalone");
  assert.doesNotThrow(() => JSON.stringify(vscodeCtx));
});

test("buildFeedbackContext: harness fields carried from options", () => {
  const root = tmpRoot();
  const ctx = buildFeedbackContext(root, {
    host: "vscode",
    effectiveHarness: "claude-code",
    harnessSource: "detected",
    running: "claude-code",
  });
  assert.equal(ctx.harness?.effective, "claude-code");
  assert.equal(ctx.harness?.source, "detected");
  assert.equal(ctx.harness?.running, "claude-code");
});

// ---------------------------------------------------------------------------
// agents: claudeTier / routeSource / handWrittenBackend
// ---------------------------------------------------------------------------

test("buildFeedbackContext: frontmatter-only sonnet agent -> claudeTier sonnet, routeSource frontmatter", () => {
  const root = tmpRoot();
  writeAgent(root, "plain-sonnet.md", ["name: plain-sonnet", "model: sonnet"]);

  const ctx = buildFeedbackContext(root, { host: "vscode" });
  const agent = ctx.agents?.find((a) => a.id === "plain-sonnet");
  assert.ok(agent, "expected plain-sonnet agent in context");
  assert.equal(agent!.claudeTier, "sonnet");
  assert.equal(agent!.routeSource, "frontmatter");
});

test("buildFeedbackContext: hand-written backend agent -> handWrittenBackend true", () => {
  const root = tmpRoot();
  writeAgent(root, "codex-reviewer.md", [
    "name: codex-reviewer",
    "model: sonnet",
    "backend:",
    "  vendor: openai",
    "  transport: mcp",
    "  mcpServer: codex",
    "  model: openai/gpt-5.4-mini",
    "  costModelClass: subscription",
  ]);

  const ctx = buildFeedbackContext(root, { host: "vscode" });
  const agent = ctx.agents?.find((a) => a.id === "codex-reviewer");
  assert.ok(agent, "expected codex-reviewer agent in context");
  assert.equal(agent!.handWrittenBackend, true);
});

test("buildFeedbackContext: routing.json-routed agent exposes endpointEnv/credentialEnv NAMES only", () => {
  const root = tmpRoot();
  writeAgent(root, "gemini-reviewer.md", ["name: gemini-reviewer", "model: sonnet"]);
  writeRouting(root, {
    agents: {
      "gemini-reviewer": {
        vendor: "google",
        transport: "openai-compatible",
        model: "google/gemini-2.5-pro",
        costModelClass: "metered",
        endpointEnv: "GEMINI_ENDPOINT_URL",
        credentialEnv: "GEMINI_API_KEY",
      },
    },
  });

  const ctx = buildFeedbackContext(root, { host: "vscode" });
  const agent = ctx.agents?.find((a) => a.id === "gemini-reviewer");
  assert.ok(agent, "expected gemini-reviewer agent in context");
  assert.equal(agent!.endpointEnv, "GEMINI_ENDPOINT_URL");
  assert.equal(agent!.credentialEnv, "GEMINI_API_KEY");
});

test("buildFeedbackContext: JSON never contains secret values, URLs, or the temp root's absolute path", () => {
  withScratchDataDir((dataDir) => {
    const root = tmpRoot();
    writeAgent(root, "gemini-reviewer.md", ["name: gemini-reviewer", "model: sonnet"]);
    writeRouting(root, {
      agents: {
        "gemini-reviewer": {
          vendor: "google",
          transport: "mcp",
          model: "google/gemini-2.5-pro",
          costModelClass: "metered",
          endpointEnv: "GEMINI_ENDPOINT_URL",
          credentialEnv: "GEMINI_API_KEY",
        },
      },
    });

    // Seed the local secret store with a value that must NEVER leak into
    // the context/payload — only the env var NAME may appear.
    setLocalEnvValue("GEMINI_API_KEY", "sk-test-123");
    setLocalEnvValue("GEMINI_ENDPOINT_URL", "https://gemini.example.com/v1/chat");

    const ctx = buildFeedbackContext(root, { host: "vscode" });
    const json = JSON.stringify(ctx);

    assert.ok(!json.includes("sk-test-123"), "secret value leaked into feedback context JSON");
    assert.ok(!/https?:\/\//i.test(json), "a URL leaked into feedback context JSON");
    assert.ok(!json.includes(root.replace(/\\/g, "\\\\")), "temp root absolute path leaked into feedback context JSON");
    assert.ok(!json.includes(root), "temp root absolute path leaked into feedback context JSON");
    assert.ok(!json.includes(dataDir), "scratch data dir absolute path leaked into feedback context JSON");
  });
});

// ---------------------------------------------------------------------------
// keywords
// ---------------------------------------------------------------------------

test("buildFeedbackContext: keywords array populated from agent-keywords.json's pattern for the agent", () => {
  const root = tmpRoot();
  writeAgent(root, "search-retrieval.md", ["name: search-retrieval", "model: haiku"]);
  writeAgentKeywords(root, { "search-retrieval": "search|retrieval|find|look|where" });

  const ctx = buildFeedbackContext(root, { host: "vscode" });
  const agent = ctx.agents?.find((a) => a.id === "search-retrieval");
  assert.ok(agent, "expected search-retrieval agent in context");
  assert.ok(Array.isArray(agent!.keywords));
  assert.ok(agent!.keywords.length > 0, "expected at least one parsed keyword");
  assert.ok(
    agent!.keywords.some((k) => k.toLowerCase().includes("search")),
    "expected 'search' among parsed keywords"
  );
});

// ---------------------------------------------------------------------------
// routing.defaults presence
// ---------------------------------------------------------------------------

test("buildFeedbackContext: routing.defaults present when routing.json declares defaults", () => {
  const root = tmpRoot();
  writeAgent(root, "plain-sonnet.md", ["name: plain-sonnet", "model: sonnet"]);
  writeRouting(root, {
    agents: {},
    defaults: { vendor: "anthropic", model: "sonnet", costModelClass: "subscription" },
  });

  const ctx = buildFeedbackContext(root, { host: "vscode" });
  assert.ok(ctx.routing?.defaults, "expected routing.defaults to be present");
  assert.equal(ctx.routing?.defaults!.vendor, "anthropic");
});

test("buildFeedbackContext: routing.defaults absent when routing.json has no defaults", () => {
  const root = tmpRoot();
  writeAgent(root, "plain-sonnet.md", ["name: plain-sonnet", "model: sonnet"]);

  const ctx = buildFeedbackContext(root, { host: "vscode" });
  assert.equal(ctx.routing?.defaults, undefined);
});

// ---------------------------------------------------------------------------
// never throws
// ---------------------------------------------------------------------------

test("buildFeedbackContext: never throws on a root with no .claude dir", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-context-empty-"));
  let ctx: ReturnType<typeof buildFeedbackContext> | undefined;
  assert.doesNotThrow(() => {
    ctx = buildFeedbackContext(root, { host: "vscode" });
  });
  assert.ok(ctx);
  assert.equal(ctx!.host, "vscode");
  assert.deepEqual(ctx!.agents, []);
  assert.ok(Array.isArray(ctx!.contextErrors) || ctx!.contextErrors === undefined);
});

test("buildFeedbackContext: never throws on a totally missing root path", () => {
  const missing = path.join(os.tmpdir(), "feedback-context-does-not-exist-" + Date.now());
  let ctx: ReturnType<typeof buildFeedbackContext> | undefined;
  assert.doesNotThrow(() => {
    ctx = buildFeedbackContext(missing, { host: "standalone" });
  });
  assert.ok(ctx);
  assert.equal(ctx!.host, "standalone");
});

test("buildFeedbackContext: contextErrors never contain an absolute filesystem path", () => {
  const root = tmpRoot();
  writeAgent(root, "plain-sonnet.md", ["name: plain-sonnet", "model: sonnet"]);
  // Make routing.json a DIRECTORY (not a file) so reading it as JSON throws
  // EISDIR — this is the failure buildFeedbackContext's routing try/catch
  // must degrade into a contextErrors entry, never a raw thrown error, and
  // the error message it records must not leak the absolute root path.
  const tycoonDir = path.join(root, ".claude", "tycoon");
  fs.mkdirSync(path.join(tycoonDir, "routing.json"), { recursive: true });

  let ctx: ReturnType<typeof buildFeedbackContext> | undefined;
  assert.doesNotThrow(() => {
    ctx = buildFeedbackContext(root, { host: "vscode" });
  });
  assert.ok(ctx);

  const absolutePathPattern = /[A-Za-z]:\\|\/(Users|home|tmp)\//;
  const errors = ctx!.contextErrors ?? [];
  for (const err of errors) {
    assert.ok(!err.includes(root), `contextErrors entry leaked the temp root path: ${err}`);
    assert.ok(!absolutePathPattern.test(err), `contextErrors entry looks like an absolute path: ${err}`);
  }
});

// ---------------------------------------------------------------------------
// buildFeedbackPayload context spreading + byte-identity invariant
// ---------------------------------------------------------------------------

function input() {
  return {
    category: "bug" as const,
    userDescription: "The build never finishes.",
  };
}

function payloadCtx() {
  return {
    roots: {},
    extensionVersion: "0.0.585",
    platform: "win32",
    hostAppName: "Visual Studio Code",
  };
}

test("buildFeedbackPayload: spreads ctx.context fields and keeps schemaVersion 1", () => {
  const root = tmpRoot();
  writeAgent(root, "plain-sonnet.md", ["name: plain-sonnet", "model: sonnet"]);
  const fc = buildFeedbackContext(root, { host: "vscode" });

  const payload = buildFeedbackPayload(input(), { ...payloadCtx(), context: fc } as any);

  assert.equal(payload.schemaVersion, 1);
  const anyPayload = payload as unknown as Record<string, unknown>;
  assert.equal(anyPayload.host, fc.host);
  assert.ok(anyPayload.harness);
  assert.ok(anyPayload.routing);
  assert.ok(Array.isArray(anyPayload.agents));
});

test("buildFeedbackPayload: byte-identity invariant holds with context spread (deterministic JSON of the same object)", () => {
  const root = tmpRoot();
  writeAgent(root, "plain-sonnet.md", ["name: plain-sonnet", "model: sonnet"]);
  const fc = buildFeedbackContext(root, { host: "vscode" });

  const payload = buildFeedbackPayload(input(), { ...payloadCtx(), context: fc } as any);
  const bodyStringA = JSON.stringify(payload, null, 2);
  const bodyStringB = JSON.stringify(payload, null, 2);
  assert.equal(bodyStringA, bodyStringB);
});

test("buildFeedbackPayload: without ctx.context, payload has no host/harness/routing/agents fields", () => {
  const payload = buildFeedbackPayload(input(), payloadCtx() as any);
  const anyPayload = payload as unknown as Record<string, unknown>;
  assert.equal(payload.schemaVersion, 1);
  assert.equal(anyPayload.host, undefined);
  assert.equal(anyPayload.harness, undefined);
  assert.equal(anyPayload.routing, undefined);
  assert.equal(anyPayload.agents, undefined);
});
