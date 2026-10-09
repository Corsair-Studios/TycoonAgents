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
import {
  buildRoutingView,
  saveRoutingProfile,
  clearRoutingProfile,
  probeEnv,
  setLocalEnvValue,
  clearLocalEnvValue,
  runCodexConfigGenerator,
} from "../src/core/routingHostOps";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "routing-host-ops-"));
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

/**
 * A fake scriptsDir with tiny stand-in scripts/{apply-routing-profile,
 * generate-opencode-config}.mjs that just echo their args and exit 0
 * (or a forced non-zero code when FAKE_EXIT_CODE env is set), so save/clear
 * tests never depend on the real generators or a compiled out/ tree.
 */
function makeFakeScriptsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-fake-scripts-"));
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  const body =
    "#!/usr/bin/env node\n" +
    "console.log('ARGS:' + process.argv.slice(2).join(' '));\n" +
    "process.exit(process.env.FAKE_EXIT_CODE ? Number(process.env.FAKE_EXIT_CODE) : 0);\n";
  fs.writeFileSync(path.join(dir, "scripts", "apply-routing-profile.mjs"), body, "utf8");
  fs.writeFileSync(path.join(dir, "scripts", "generate-opencode-config.mjs"), body, "utf8");
  fs.writeFileSync(path.join(dir, "scripts", "generate-codex-config.mjs"), body, "utf8");
  return dir;
}

// ---------------------------------------------------------------------------
// buildRoutingView
// ---------------------------------------------------------------------------

test("buildRoutingView: no routing.json -> frontmatter/alias/default sources, no crash", () => {
  const root = tmpRoot();
  writeAgent(root, "with-backend.md", [
    "name: with-backend",
    "model: sonnet",
    "backend:",
    "  vendor: openai",
    "  transport: mcp",
    "  mcpServer: codex",
    "  model: openai/gpt-6-astra",
    "  costModelClass: subscription",
  ]);
  writeAgent(root, "alias-only.md", ["name: alias-only", "model: haiku"]);
  writeAgent(root, "bare.md", ["name: bare"]);

  const view = buildRoutingView({ root, env: {} });
  assert.equal(view.profile, null);
  assert.deepEqual(view.errors, []);

  const byId = new Map(view.agents.map((a) => [a.id, a]));
  assert.equal(byId.get("with-backend")?.source, "frontmatter");
  assert.equal(byId.get("with-backend")?.backend.vendor, "openai");
  assert.equal(byId.get("alias-only")?.source, "alias");
  assert.equal(byId.get("alias-only")?.backend.model, "anthropic/haiku");
  assert.equal(byId.get("bare")?.source, "default");
  assert.equal(byId.get("bare")?.backend.model, "anthropic/unknown");

  assert.equal(view.orchestrator.source, "default");
  assert.ok(view.presets.models.length > 0);
  assert.ok(view.presets.vendors.includes("anthropic"));
});

test("buildRoutingView: a slashed model: alias with no backend block is kept verbatim, never double-prefixed", () => {
  const root = tmpRoot();
  writeAgent(root, "claude-worker.md", ["name: claude-worker", "model: anthropic/claude-sonnet-4-6"]);
  writeAgent(root, "codex-reviewer.md", ["name: codex-reviewer", "model: openai/gpt-6-astra"]);

  const view = buildRoutingView({ root, env: {} });
  const byId = new Map(view.agents.map((a) => [a.id, a]));

  const claudeWorker = byId.get("claude-worker");
  assert.equal(claudeWorker?.backend.model, "anthropic/claude-sonnet-4-6");
  assert.equal(claudeWorker?.backend.vendor, "anthropic");

  const codexReviewer = byId.get("codex-reviewer");
  assert.equal(codexReviewer?.backend.model, "openai/gpt-6-astra");
  assert.equal(codexReviewer?.backend.vendor, "openai");

  // No agent (or the orchestrator) should ever surface a double-slashed
  // model id like "anthropic/anthropic/claude-sonnet-4-6".
  const allModels = view.agents.map((a) => a.backend.model).concat([view.orchestrator.backend.model]);
  allModels.forEach((m) => {
    assert.equal((m.match(/\//g) || []).length <= 1, true, `model id should never carry two slashes: ${m}`);
  });
});

test("buildRoutingView: routing.json entry wins outright over frontmatter/alias", () => {
  const root = tmpRoot();
  writeAgent(root, "coding-specialist.md", ["name: coding-specialist", "model: sonnet"]);
  writeRouting(root, {
    version: 1,
    agents: {
      "coding-specialist": { vendor: "google", transport: "mcp", mcpServer: "gemini", model: "google/gemini-2.5-pro", costModelClass: "metered" },
    },
  });

  const view = buildRoutingView({ root, env: {} });
  assert.equal(view.errors.length, 0);
  const agent = view.agents.find((a) => a.id === "coding-specialist");
  assert.equal(agent?.source, "routing");
  assert.equal(agent?.backend.vendor, "google");
});

test("buildRoutingView: orchestrator resolved from role:/tier: orchestrator frontmatter", () => {
  const root = tmpRoot();
  writeAgent(root, "orchestrator.md", ["name: orchestrator", "role: orchestrator", "model: opus"]);
  const view = buildRoutingView({ root, env: {} });
  assert.equal(view.orchestrator.id, "orchestrator");
  assert.equal(view.orchestrator.source, "alias");
  assert.equal(view.orchestrator.backend.model, "anthropic/opus");
});

test("buildRoutingView: envProbe reflects only names actually referenced by a resolved backend, split by env/stored", () => {
  const root = tmpRoot();
  writeAgent(root, "kimi.md", [
    "name: kimi",
    "backend:",
    "  vendor: moonshot",
    "  transport: openai-compatible",
    "  mcpServer: openai-compatible",
    "  model: moonshot/kimi-k2",
    "  costModelClass: local",
    "  endpointEnv: OPENAI_COMPAT_BASE_URL",
    "  apiKeyEnv: OPENAI_COMPAT_API_KEY",
  ]);
  const view = buildRoutingView({ root, env: { OPENAI_COMPAT_API_KEY: "set" } });
  assert.deepEqual(view.envProbe, {
    OPENAI_COMPAT_BASE_URL: { env: false, stored: false },
    OPENAI_COMPAT_API_KEY: { env: true, stored: false },
  });
});

test("buildRoutingView: presets include xai vendor and its Grok models", () => {
  const root = tmpRoot();
  const view = buildRoutingView({ root, env: {} });
  assert.ok(view.presets.vendors.includes("xai"));
  const xaiModels = view.presets.models.filter((m) => m.vendor === "xai");
  assert.ok(xaiModels.some((m) => m.id === "xai/grok-4.7"));
  assert.ok(xaiModels.some((m) => m.id === "xai/grok-build-0.1"));
  xaiModels.forEach((m) => assert.equal(m.costModelClass, "metered"));
});

test("buildRoutingView: envProbe surfaces XAI_API_KEY when a resolved backend references it", () => {
  const root = tmpRoot();
  writeAgent(root, "grok-agent.md", [
    "name: grok-agent",
    "backend:",
    "  vendor: xai",
    "  transport: claude-native",
    "  model: xai/grok-4.7",
    "  costModelClass: metered",
    "  apiKeyEnv: XAI_API_KEY",
  ]);
  const view = buildRoutingView({ root, env: { XAI_API_KEY: "set" } });
  assert.deepEqual(view.envProbe, {
    XAI_API_KEY: { env: true, stored: false },
  });
});

// ---------------------------------------------------------------------------
// probeEnv / setLocalEnvValue / clearLocalEnvValue
//
// These probe/mutate localEnvStore, which resolves its dir from
// process.env.TYCOON_STANDALONE_DATA_DIR (never the `env` object passed to
// probeEnv itself) — see src/core/localEnvStore.ts's resolveStoreDir(). So
// every test here scopes process.env.TYCOON_STANDALONE_DATA_DIR to a fresh
// temp dir and restores it afterward, to guarantee nothing touches this
// machine's real per-user app-data directory.
// ---------------------------------------------------------------------------

function withIsolatedStoreDir<T>(fn: () => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-host-ops-store-"));
  const prev = process.env.TYCOON_STANDALONE_DATA_DIR;
  process.env.TYCOON_STANDALONE_DATA_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TYCOON_STANDALONE_DATA_DIR;
    else process.env.TYCOON_STANDALONE_DATA_DIR = prev;
  }
}

test("probeEnv: rejects malformed names, probes only well-formed ones, never reads values into output", () => {
  withIsolatedStoreDir(() => {
    const result = probeEnv(["GOOD_NAME", "bad-name", "1BAD", "", "OK2"], {
      GOOD_NAME: "secret-value",
      OK2: "",
    });
    assert.deepEqual(result, {
      GOOD_NAME: { env: true, stored: false },
      OK2: { env: false, stored: false },
    });
    assert.ok(!("bad-name" in result));
    assert.ok(!("1BAD" in result));
    assert.ok(!JSON.stringify(result).includes("secret-value"));
  });
});

test("setLocalEnvValue/clearLocalEnvValue: round-trip through probeEnv's `stored` flag, value never in the reply", () => {
  withIsolatedStoreDir(() => {
    const setEntry = setLocalEnvValue("MY_ENDPOINT_URL", "https://secret.example/v1", {});
    assert.deepEqual(setEntry, { env: false, stored: true });
    assert.ok(!JSON.stringify(setEntry).includes("secret.example"));

    const probed = probeEnv(["MY_ENDPOINT_URL"], {});
    assert.deepEqual(probed, { MY_ENDPOINT_URL: { env: false, stored: true } });

    const clearEntry = clearLocalEnvValue("MY_ENDPOINT_URL", {});
    assert.deepEqual(clearEntry, { env: false, stored: false });

    const probedAfterClear = probeEnv(["MY_ENDPOINT_URL"], {});
    assert.deepEqual(probedAfterClear, { MY_ENDPOINT_URL: { env: false, stored: false } });
  });
});

// ---------------------------------------------------------------------------
// codex generator wiring (codex-doctrine-gap follow-up)
// ---------------------------------------------------------------------------

test("runCodexConfigGenerator: spawns generate-codex-config.mjs with the project root", () => {
  const root = tmpRoot();
  const scriptsDir = makeFakeScriptsDir();
  const result = runCodexConfigGenerator(root, scriptsDir);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.ok(result.output.includes("--root"));
  assert.ok(result.output.includes(root));
});

test("runCodexConfigGenerator: missing script never throws, returns a non-zero result with a clear message", () => {
  const root = tmpRoot();
  const emptyScriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-empty-scripts-"));
  const result = runCodexConfigGenerator(root, emptyScriptsDir);
  assert.notEqual(result.code, 0);
  assert.ok(result.output.includes("generate-codex-config.mjs"));
});

test("saveRoutingProfile: runs the codex generator only when effectiveHarness is codex", () => {
  const root = tmpRoot();
  const scriptsDir = makeFakeScriptsDir();
  const profile = { version: 1, agents: {} };

  const claudeResult = saveRoutingProfile({ root, profile, scriptsDir, effectiveHarness: "claude-code" });
  assert.equal(claudeResult.codex, undefined);

  const codexResult = saveRoutingProfile({ root, profile, scriptsDir, effectiveHarness: "codex" });
  assert.ok(codexResult.codex !== undefined, JSON.stringify(codexResult));
  assert.equal(codexResult.codex!.code, 0);
});

test("saveRoutingProfile: a codex-generator failure never flips `ok` false (routing.json still saved)", () => {
  const root = tmpRoot();
  const scriptsDir = makeFakeScriptsDir();
  // Only the codex script fails — claude/opencode stay healthy, so `ok`
  // (which tracks just those two) must stay true.
  const failingBody =
    "#!/usr/bin/env node\n" +
    "console.log('ARGS:' + process.argv.slice(2).join(' '));\n" +
    "process.exit(1);\n";
  fs.writeFileSync(path.join(scriptsDir, "scripts", "generate-codex-config.mjs"), failingBody, "utf8");
  const profile = { version: 1, agents: {} };

  const result = saveRoutingProfile({ root, profile, scriptsDir, effectiveHarness: "codex" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.codex?.code, 1);
  const written = JSON.parse(fs.readFileSync(path.join(root, ".claude", "tycoon", "routing.json"), "utf8"));
  assert.deepEqual(written, profile);
});

test("setLocalEnvValue: rejects a malformed name", () => {
  withIsolatedStoreDir(() => {
    assert.throws(() => setLocalEnvValue("not-valid", "x", {}));
  });
});

// ---------------------------------------------------------------------------
// saveRoutingProfile
// ---------------------------------------------------------------------------

test("saveRoutingProfile: writes file + runs check-then-write on both generators, in order", () => {
  const root = tmpRoot();
  const scriptsDir = makeFakeScriptsDir();
  const profile = { version: 1, agents: {} };

  const result = saveRoutingProfile({ root, profile, scriptsDir });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.errors.length, 0);
  const written = JSON.parse(fs.readFileSync(path.join(root, ".claude", "tycoon", "routing.json"), "utf8"));
  assert.deepEqual(written, profile);

  assert.equal(result.check.claude.code, 0);
  assert.ok(result.check.claude.output.includes("--check"));
  assert.equal(result.write.claude.code, 0);
  assert.ok(!result.write.claude.output.includes("--check"));
  assert.equal(result.check.opencode.code, 0);
  assert.equal(result.write.opencode.code, 0);
});

// p25-t2: defaultFallback round-trip — set via saveRoutingProfile, read
// back via buildRoutingView, and verify routing.json on disk holds it.
test("saveRoutingProfile + buildRoutingView: defaultFallback round-trips through both write and read", () => {
  const root = tmpRoot();
  const scriptsDir = makeFakeScriptsDir();
  const defaultFallback = {
    vendor: "openai",
    transport: "openai-compatible",
    model: "openai/gpt-5.4-mini",
    costModelClass: "metered",
    endpointEnv: "OPENAI_ENDPOINT",
  };
  const profile = { version: 1, agents: {}, defaultFallback };

  const result = saveRoutingProfile({ root, profile, scriptsDir });
  assert.equal(result.ok, true, JSON.stringify(result));

  const written = JSON.parse(fs.readFileSync(path.join(root, ".claude", "tycoon", "routing.json"), "utf8"));
  assert.deepEqual(written.defaultFallback, defaultFallback);

  const view = buildRoutingView({ root, env: {} });
  assert.deepEqual(view.defaultFallback, defaultFallback);
});

test("saveRoutingProfile: a profile containing an apiKey-shaped field is rejected and nothing is written", () => {
  const root = tmpRoot();
  const scriptsDir = makeFakeScriptsDir();
  const profile = { version: 1, agents: { foo: { vendor: "openai", apiKey: "sk-should-not-be-here" } } };

  const result = saveRoutingProfile({ root, profile, scriptsDir });

  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.some((e) => /secret/i.test(e)));
  assert.equal(fs.existsSync(path.join(root, ".claude", "tycoon", "routing.json")), false);
});

test("saveRoutingProfile: an undefined profile is rejected up front with a named error, never written as literal 'undefined' JSON", () => {
  // Regression guard: JSON.stringify(undefined) returns the bare JS value
  // `undefined`, and string-concatenating that with "\n" silently coerces
  // to the text "undefined\n" instead of throwing — the old naive
  // serialization check let that sail through as if it were valid JSON. A
  // caller passing through a mis-wired transport (profile read off the
  // wrong message field) should get an explicit, named error instead of an
  // opaque "validation failed" JSON-parse error much later.
  const root = tmpRoot();
  const scriptsDir = makeFakeScriptsDir();

  const result = saveRoutingProfile({ root, profile: undefined as any, scriptsDir });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /missing or not an object/i.test(e)), JSON.stringify(result.errors));
  assert.equal(fs.existsSync(path.join(root, ".claude", "tycoon", "routing.json")), false);
});

test("saveRoutingProfile: missing generator scripts fails loudly, listing the paths tried, no writes", () => {
  const root = tmpRoot();
  const missingScriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-empty-scripts-"));
  const profile = { version: 1, agents: {} };

  const result = saveRoutingProfile({ root, profile, scriptsDir: missingScriptsDir });

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].includes("apply-routing-profile.mjs"));
  assert.equal(fs.existsSync(path.join(root, ".claude", "tycoon", "routing.json")), false);
});

test("saveRoutingProfile: propagates a nonzero real-write exit code as ok:false without failing structurally", () => {
  const root = tmpRoot();
  const scriptsDir = makeFakeScriptsDir();
  const profile = { version: 1, agents: {} };
  const prevExit = process.env.FAKE_EXIT_CODE;
  process.env.FAKE_EXIT_CODE = "1";
  try {
    const result = saveRoutingProfile({ root, profile, scriptsDir });
    assert.equal(result.ok, false);
    assert.equal(result.write.claude.code, 1);
  } finally {
    if (prevExit === undefined) delete process.env.FAKE_EXIT_CODE;
    else process.env.FAKE_EXIT_CODE = prevExit;
  }
});

// ---------------------------------------------------------------------------
// saveRoutingProfile: effectiveHarness orchestrator guard (p20-t1)
// ---------------------------------------------------------------------------

test("saveRoutingProfile: a CHANGED orchestrator slot under harness claude is rejected with the guidance error, nothing written", () => {
  const root = tmpRoot();
  const scriptsDir = makeFakeScriptsDir();
  const profile = { version: 1, orchestrator: { vendor: "anthropic", transport: "claude-native", model: "opus", costModelClass: "subscription" }, agents: {} };

  const result = saveRoutingProfile({ root, profile, scriptsDir, effectiveHarness: "claude" });

  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => /Orchestrator routing applies only when OpenCode runs your agents/.test(e)),
    JSON.stringify(result.errors),
  );
  assert.equal(fs.existsSync(path.join(root, ".claude", "tycoon", "routing.json")), false);
});

test("saveRoutingProfile: an UNCHANGED orchestrator slot carried through under harness claude is allowed", () => {
  const root = tmpRoot();
  const scriptsDir = makeFakeScriptsDir();
  const orchestrator = { vendor: "anthropic", transport: "claude-native", model: "opus", costModelClass: "subscription" };
  writeRouting(root, { version: 1, orchestrator, agents: {} });

  const profile = { version: 1, orchestrator, agents: { foo: { vendor: "anthropic", transport: "claude-native", model: "sonnet", costModelClass: "subscription" } } };
  const result = saveRoutingProfile({ root, profile, scriptsDir, effectiveHarness: "claude" });

  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const written = JSON.parse(fs.readFileSync(path.join(root, ".claude", "tycoon", "routing.json"), "utf8"));
  assert.deepEqual(written.orchestrator, orchestrator);
});

test("saveRoutingProfile: a CHANGED orchestrator slot under harness opencode is allowed", () => {
  const root = tmpRoot();
  const scriptsDir = makeFakeScriptsDir();
  const profile = { version: 1, orchestrator: { vendor: "anthropic", transport: "claude-native", model: "opus", costModelClass: "subscription" }, agents: {} };

  const result = saveRoutingProfile({ root, profile, scriptsDir, effectiveHarness: "opencode" });

  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const written = JSON.parse(fs.readFileSync(path.join(root, ".claude", "tycoon", "routing.json"), "utf8"));
  assert.deepEqual(written.orchestrator, profile.orchestrator);
});

// ---------------------------------------------------------------------------
// clearRoutingProfile
// ---------------------------------------------------------------------------

test("clearRoutingProfile: deletes routing.json and reruns both generators", () => {
  const root = tmpRoot();
  const scriptsDir = makeFakeScriptsDir();
  writeRouting(root, { version: 1, agents: {} });

  const result = clearRoutingProfile({ root, scriptsDir });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fs.existsSync(path.join(root, ".claude", "tycoon", "routing.json")), false);
  assert.equal(result.check.claude.code, 0);
  assert.equal(result.write.opencode.code, 0);
});

test("clearRoutingProfile: no routing.json present is a no-op on disk, still reruns generators", () => {
  const root = tmpRoot();
  const scriptsDir = makeFakeScriptsDir();
  const result = clearRoutingProfile({ root, scriptsDir });
  assert.equal(result.ok, true, JSON.stringify(result));
});

// Real-script integration (not the fake stand-ins above): clearRoutingProfile
// must actually invoke scripts/apply-routing-profile.mjs so a previously
// applied `# managed-by: tycoon-routing` backend block is stripped from the
// agent frontmatter, and generate-opencode-config.mjs also drops the managed
// provider entry. REPO_ROOT resolves from this compiled test's own location
// (out/test/routingHostOps.test.js -> ../.. = repo root), independent of
// `root` (a throwaway fixture dir), matching apply-routing-profile.mjs's own
// script-relative core-module resolution.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// apply-routing-profile.mjs deliberately requires the shared, real
// out/src/core/{routingProfile,agentBackend}.js from REPO_ROOT for every
// invocation rather than an isolated copy (see that script's own "Resolve
// compiled core modules relative to the script's own location" comment).
// On a dev machine where some other process rebuilds `out/` at the same
// moment this test's spawned child requires it, that require can observe a
// half-written file and throw a transient "X is not a function" from deep
// inside out/src/core/*.js. That is an external race over a shared
// repo-root build artifact, not a bug in saveRoutingProfile/
// clearRoutingProfile or in this fixture's isolation (root/dataDir/
// opencodeConfigDir below are already unique per test) — retry once past it.
function isTransientCoreModuleRace(result: unknown): boolean {
  const text = JSON.stringify(result ?? {});
  return /is not a function/.test(text) && /out[\\/]src[\\/]core/.test(text);
}

function saveRoutingProfileRetrying(opts: Parameters<typeof saveRoutingProfile>[0]): ReturnType<typeof saveRoutingProfile> {
  const first = saveRoutingProfile(opts);
  if (!first.ok && isTransientCoreModuleRace(first)) return saveRoutingProfile(opts);
  return first;
}

function clearRoutingProfileRetrying(opts: Parameters<typeof clearRoutingProfile>[0]): ReturnType<typeof clearRoutingProfile> {
  const first = clearRoutingProfile(opts);
  if (!first.ok && isTransientCoreModuleRace(first)) return clearRoutingProfile(opts);
  return first;
}

test("clearRoutingProfile (real scripts): strips the managed backend block and regenerates opencode.json without the managed provider", () => {
  const root = tmpRoot();
  writeAgent(root, "worker.md", ["name: worker", "description: A worker agent.", "tier: worker"]);
  writeRouting(root, {
    version: 1,
    agents: {
      worker: {
        vendor: "anthropic",
        transport: "claude-native",
        model: "sonnet",
        costModelClass: "subscription",
      },
    },
  });

  const prevDataDir = process.env.TYCOON_STANDALONE_DATA_DIR;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const dataDir = tmpRoot();
  const opencodeConfigDir = tmpRoot();
  process.env.TYCOON_STANDALONE_DATA_DIR = dataDir;
  process.env.OPENCODE_CONFIG_DIR = opencodeConfigDir;
  try {
    const saved = saveRoutingProfileRetrying({
      root,
      scriptsDir: REPO_ROOT,
      profile: { version: 1, agents: { worker: { vendor: "anthropic", transport: "claude-native", model: "sonnet", costModelClass: "subscription" } } },
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const appliedContent = fs.readFileSync(path.join(root, ".claude", "agents", "worker.md"), "utf8");
    assert.match(appliedContent, /managed-by: tycoon-routing/);
    assert.equal(fs.existsSync(path.join(root, ".claude", "tycoon", "routing.resolved.json")), true);

    const result = clearRoutingProfileRetrying({ root, scriptsDir: REPO_ROOT });
    assert.equal(result.ok, true, JSON.stringify(result));

    const clearedContent = fs.readFileSync(path.join(root, ".claude", "agents", "worker.md"), "utf8");
    assert.doesNotMatch(clearedContent, /managed-by: tycoon-routing/, "clearRoutingProfile must run apply-routing-profile.mjs to strip the managed block");
    assert.doesNotMatch(clearedContent, /backend:/);
    assert.equal(fs.existsSync(path.join(root, ".claude", "tycoon", "routing.json")), false);
    assert.equal(fs.existsSync(path.join(root, ".claude", "tycoon", "routing.resolved.json")), false, "routing.resolved.json must be removed on clear");
  } finally {
    if (prevDataDir === undefined) delete process.env.TYCOON_STANDALONE_DATA_DIR;
    else process.env.TYCOON_STANDALONE_DATA_DIR = prevDataDir;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
  }
});

// ---------------------------------------------------------------------------
// presets (p13-t4 audit fix: MODEL entries, never agent names)
// ---------------------------------------------------------------------------

test("buildRoutingView: presets are MODEL entries (id/label = model id), not FOREIGN_LLM_AGENTS agent names", () => {
  const root = tmpRoot();
  const view = buildRoutingView({ root, env: {} });

  const byId = new Map(view.presets.models.map((m) => [m.id, m]));

  // Known foreign-LLM model ids (mirrors FOREIGN_LLM_AGENTS' backend.model in
  // src/host/vscode/packCatalog.ts) must be present, labeled by their model
  // id — never an agent display name like "Claude Worker"/"Codex Reviewer".
  const claudeWorker = byId.get("anthropic/sonnet");
  assert.ok(claudeWorker, "anthropic/sonnet preset should be present");
  assert.equal(claudeWorker?.label, "anthropic/sonnet");
  assert.equal(claudeWorker?.vendor, "anthropic");

  const codex = byId.get("openai/gpt-5.6-sol");
  assert.ok(codex, "openai/gpt-5.6-sol preset should be present");
  // p101-t4: Codex-accepted models carry a friendly tier name ahead of the id.
  assert.equal(codex?.label, "Sol (openai/gpt-5.6-sol)");

  for (const m of view.presets.models) {
    assert.ok(
      !/reviewer|worker|specialist|orchestrator/i.test(m.label),
      `preset label "${m.label}" looks like an agent name, not a model id`,
    );
  }

  // No duplicate ids.
  const ids = view.presets.models.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "preset model ids should be deduplicated");

  // fable resolves to a different id than its alias -> alias shown in parens.
  const fable = byId.get("anthropic/claude-fable-5-1");
  assert.ok(fable, "anthropic/claude-fable-5-1 preset (fable alias) should be present");
  assert.equal(fable?.label, "anthropic/claude-fable-5-1 (fable)");
});

test("buildRoutingView: presets include the opencode Zen vendor and big-pickle model", () => {
  const root = tmpRoot();
  const view = buildRoutingView({ root, env: {} });

  assert.ok(view.presets.vendors.includes("opencode"), "vendors should include opencode");

  const bigPickle = view.presets.models.find((m) => m.id === "opencode/big-pickle");
  assert.ok(bigPickle, "opencode/big-pickle preset should be present");
  assert.equal(bigPickle?.vendor, "opencode");
  assert.equal(bigPickle?.costModelClass, "subscription");
  assert.equal(bigPickle?.label, "opencode/big-pickle (Zen, free)");
});

// ---------------------------------------------------------------------------
// orchestrator "default" source must never surface the literal "unknown"
// (p13 audit fix)
// ---------------------------------------------------------------------------

test("buildRoutingView: orchestrator with no orchestrator.md at all -> source default, model blank (never 'unknown')", () => {
  const root = tmpRoot();
  // No agent files at all -> orchestratorFileId stays undefined.
  const view = buildRoutingView({ root, env: {} });
  assert.equal(view.orchestrator.source, "default");
  assert.equal(view.orchestrator.backend.model, "");
});

test("buildRoutingView: orchestrator.md with neither model: nor backend: -> source default, model blank (never 'unknown')", () => {
  const root = tmpRoot();
  writeAgent(root, "orchestrator.md", ["name: orchestrator", "role: orchestrator"]);
  const view = buildRoutingView({ root, env: {} });
  assert.equal(view.orchestrator.source, "default");
  assert.equal(view.orchestrator.backend.model, "");
});

test("buildRoutingView: orchestrator.md with a bare model: alias -> resolved model surfaces, source alias", () => {
  const root = tmpRoot();
  writeAgent(root, "orchestrator.md", ["name: orchestrator", "role: orchestrator", "model: opus"]);
  const view = buildRoutingView({ root, env: {} });
  assert.equal(view.orchestrator.source, "alias");
  assert.equal(view.orchestrator.backend.model, "anthropic/opus");
});

// ---------------------------------------------------------------------------
// p25-t4: saveRoutingProfile rejects an undispatchable fallback target for
// the caller's current harness (chain entries and defaultFallback), and
// still allows a save whose targets are all valid for that harness.
// ---------------------------------------------------------------------------

test("saveRoutingProfile: rejects a defaultFallback vendor codex can't dispatch, nothing written", () => {
  const root = tmpRoot();
  const scriptsDir = makeFakeScriptsDir();
  const profile = {
    version: 1,
    agents: {},
    defaultFallback: { vendor: "mystery-vendor", model: "mystery-vendor/x" },
  };

  const result = saveRoutingProfile({ root, profile, scriptsDir, effectiveHarness: "codex" });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.startsWith("defaultFallback") && e.includes("mystery-vendor")));
  assert.equal(fs.existsSync(path.join(root, ".claude", "tycoon", "routing.json")), false);
});

test("saveRoutingProfile: accepts an agent fallback-chain entry with google vendor under codex (non-blocking skip warning)", () => {
  const root = tmpRoot();
  const scriptsDir = makeFakeScriptsDir();
  const profile = {
    version: 1,
    agents: {
      "coding-specialist": {
        vendor: "anthropic",
        model: "anthropic/sonnet",
        fallback: [{ vendor: "google", model: "google/gemini" }],
      },
    },
  };

  const result = saveRoutingProfile({ root, profile, scriptsDir, effectiveHarness: "codex" });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fs.existsSync(path.join(root, ".claude", "tycoon", "routing.json")), true);
});

test("saveRoutingProfile: keeps a save whose fallback targets are all valid for the current harness (codex)", () => {
  const root = tmpRoot();
  const scriptsDir = makeFakeScriptsDir();
  const profile = {
    version: 1,
    agents: {
      "coding-specialist": {
        vendor: "anthropic",
        model: "anthropic/sonnet",
        fallback: [{ vendor: "openai-compatible", transport: "openai-compatible", model: "local/x", endpointEnv: "OPENAI_COMPAT_BASE_URL" }],
      },
    },
    defaultFallback: { vendor: "openai", model: "openai/gpt-5.4-mini" },
  };

  const result = saveRoutingProfile({ root, profile, scriptsDir, effectiveHarness: "codex" });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fs.existsSync(path.join(root, ".claude", "tycoon", "routing.json")), true);
});

test("saveRoutingProfile: same google-fallback profile is allowed under claude-code (no codex dispatcher gate)", () => {
  const root = tmpRoot();
  const scriptsDir = makeFakeScriptsDir();
  const profile = {
    version: 1,
    agents: {},
    defaultFallback: { vendor: "google", model: "google/gemini" },
  };

  const result = saveRoutingProfile({ root, profile, scriptsDir, effectiveHarness: "claude-code" });

  assert.equal(result.ok, true, JSON.stringify(result));
});

test("saveRoutingProfile: an undefined effectiveHarness skips dispatchability validation entirely", () => {
  const root = tmpRoot();
  const scriptsDir = makeFakeScriptsDir();
  const profile = {
    version: 1,
    agents: {},
    defaultFallback: { vendor: "mystery-vendor", model: "mystery-vendor/x" },
  };

  const result = saveRoutingProfile({ root, profile, scriptsDir });

  assert.equal(result.ok, true, JSON.stringify(result));
});

test("saveRoutingProfile: google defaultFallback under codex is accepted (skip warning only) when GEMINI_API_KEY is in the local env store", () => {
  withIsolatedStoreDir(() => {
    setLocalEnvValue("GEMINI_API_KEY", "test-only-value", {});
    const root = tmpRoot();
    const scriptsDir = makeFakeScriptsDir();
    const profile = { version: 1, agents: {}, defaultFallback: { vendor: "google", model: "google/gemini" } };

    const result = saveRoutingProfile({ root, profile, scriptsDir, effectiveHarness: "codex" });

    assert.equal(result.ok, true, JSON.stringify(result));
  });
});

test("saveRoutingProfile: google defaultFallback under codex is accepted when GEMINI_API_KEY is set neither in process.env nor the local env store", () => {
  withIsolatedStoreDir(() => {
    const root = tmpRoot();
    const scriptsDir = makeFakeScriptsDir();
    const profile = { version: 1, agents: {}, defaultFallback: { vendor: "google", model: "google/gemini" } };

    const result = saveRoutingProfile({ root, profile, scriptsDir, effectiveHarness: "codex" });

    assert.equal(result.ok, true, JSON.stringify(result));
  });
});

function opencodeProvidersAfterSave(slots: Record<string, Record<string, unknown>>): Record<string, any> {
  const root = tmpRoot();
  for (const id of Object.keys(slots)) {
    writeAgent(root, `${id}.md`, [`name: ${id}`, "description: A worker agent.", "tier: worker"]);
  }
  const prevDataDir = process.env.TYCOON_STANDALONE_DATA_DIR;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevHost = process.env.TYCOON_ENDPOINT_TEST_URL;
  const opencodeConfigDir = tmpRoot();
  process.env.TYCOON_STANDALONE_DATA_DIR = tmpRoot();
  process.env.OPENCODE_CONFIG_DIR = opencodeConfigDir;
  try {
    const profile = { version: 1, agents: slots };
    writeRouting(root, profile);
    const saved = saveRoutingProfileRetrying({ root, scriptsDir: REPO_ROOT, profile, effectiveHarness: "opencode" } as never);
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const cfgPath = path.join(opencodeConfigDir, "opencode.json");
    if (!fs.existsSync(cfgPath)) return {};
    return JSON.parse(fs.readFileSync(cfgPath, "utf8")).provider ?? {};
  } finally {
    if (prevDataDir === undefined) delete process.env.TYCOON_STANDALONE_DATA_DIR;
    else process.env.TYCOON_STANDALONE_DATA_DIR = prevDataDir;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    if (prevHost === undefined) delete process.env.TYCOON_ENDPOINT_TEST_URL;
  }
}

test("opencode generator: xai/mistral openai-compatible slots without endpointEnv get no managed provider; with endpointEnv they do; custom vendors unchanged", () => {
  const providers = opencodeProvidersAfterSave({
    a: { vendor: "xai", transport: "openai-compatible", model: "xai/grok-build-0.1", costModelClass: "metered" },
    b: { vendor: "mistral", transport: "openai-compatible", model: "mistral/mistral-large-latest", costModelClass: "metered" },
    c: { vendor: "ollama-windows", transport: "openai-compatible", model: "ollama-windows/qwen3", endpointEnv: "OLLAMA_URL", costModelClass: "local" },
  });
  assert.equal(providers["xai"], undefined, "no managed provider shadowing built-in xai");
  assert.equal(providers["mistral"], undefined, "no managed provider shadowing built-in mistral");
  assert.ok(providers["ollama-windows"]?.tycoonManaged, "custom openai-compatible vendor still emitted");

  const withEnv = opencodeProvidersAfterSave({
    a: { vendor: "xai", transport: "openai-compatible", model: "xai/grok-build-0.1", endpointEnv: "MY_XAI_URL", costModelClass: "metered" },
  });
  assert.ok(withEnv["xai"]?.tycoonManaged, "user-set endpointEnv -> managed provider");
  assert.match(String(withEnv["xai"].options?.baseURL ?? ""), /MY_XAI_URL/);
});

test("saveRoutingProfile: the OpenCode generator runs only under the opencode harness (no opencode.json/.opencode on codex or claude-code)", () => {
  for (const harness of ["codex", "claude-code", "opencode"]) {
    const root = tmpRoot();
    writeAgent(root, "worker.md", ["name: worker", "description: A worker agent.", "tier: worker"]);
    const prevData = process.env.TYCOON_STANDALONE_DATA_DIR;
    const prevCfg = process.env.OPENCODE_CONFIG_DIR;
    const cfgDir = tmpRoot();
    process.env.TYCOON_STANDALONE_DATA_DIR = tmpRoot();
    process.env.OPENCODE_CONFIG_DIR = cfgDir;
    try {
      const profile = { version: 1, agents: { worker: { vendor: "anthropic", transport: "claude-native", model: "sonnet", costModelClass: "subscription" } } };
      const saved = saveRoutingProfileRetrying({ root, scriptsDir: REPO_ROOT, profile, effectiveHarness: harness } as never);
      assert.equal(saved.ok, true, JSON.stringify(saved));
      const opencodeFiles = fs.existsSync(path.join(root, "opencode.json")) || fs.existsSync(path.join(root, ".opencode"));
      const globalFile = fs.existsSync(path.join(cfgDir, "opencode.json"));
      if (harness === "opencode") {
        assert.equal(opencodeFiles || globalFile, true, "generated under opencode");
      } else {
        assert.equal(opencodeFiles, false, `no project OpenCode files under ${harness}`);
        assert.equal(globalFile, false, `no global OpenCode config under ${harness}`);
      }
    } finally {
      if (prevData === undefined) delete process.env.TYCOON_STANDALONE_DATA_DIR;
      else process.env.TYCOON_STANDALONE_DATA_DIR = prevData;
      if (prevCfg === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = prevCfg;
    }
  }
});
