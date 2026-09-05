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
    "  model: openai/gpt-5.4-mini",
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
    const saved = saveRoutingProfile({
      root,
      scriptsDir: REPO_ROOT,
      profile: { version: 1, agents: { worker: { vendor: "anthropic", transport: "claude-native", model: "sonnet", costModelClass: "subscription" } } },
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const appliedContent = fs.readFileSync(path.join(root, ".claude", "agents", "worker.md"), "utf8");
    assert.match(appliedContent, /managed-by: tycoon-routing/);
    assert.equal(fs.existsSync(path.join(root, ".claude", "tycoon", "routing.resolved.json")), true);

    const result = clearRoutingProfile({ root, scriptsDir: REPO_ROOT });
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
  const claudeWorker = byId.get("anthropic/claude-sonnet-4-6");
  assert.ok(claudeWorker, "anthropic/claude-sonnet-4-6 preset should be present");
  assert.equal(claudeWorker?.label, "anthropic/claude-sonnet-4-6");
  assert.equal(claudeWorker?.vendor, "anthropic");

  const codex = byId.get("openai/gpt-5.4-mini");
  assert.ok(codex, "openai/gpt-5.4-mini preset should be present");
  assert.equal(codex?.label, "openai/gpt-5.4-mini");

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
  const fable = byId.get("anthropic/claude-fable-5");
  assert.ok(fable, "anthropic/claude-fable-5 preset (fable alias) should be present");
  assert.equal(fable?.label, "anthropic/claude-fable-5 (fable)");
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
