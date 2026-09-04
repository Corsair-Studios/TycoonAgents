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

test("buildRoutingView: envProbe reflects only names actually referenced by a resolved backend", () => {
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
  assert.deepEqual(view.envProbe, { OPENAI_COMPAT_BASE_URL: false, OPENAI_COMPAT_API_KEY: true });
});

// ---------------------------------------------------------------------------
// probeEnv
// ---------------------------------------------------------------------------

test("probeEnv: rejects malformed names, probes only well-formed ones, never reads values into output", () => {
  const result = probeEnv(["GOOD_NAME", "bad-name", "1BAD", "", "OK2"], {
    GOOD_NAME: "secret-value",
    OK2: "",
  });
  assert.deepEqual(result, { GOOD_NAME: true, OK2: false });
  assert.ok(!("bad-name" in result));
  assert.ok(!("1BAD" in result));
  assert.ok(!JSON.stringify(result).includes("secret-value"));
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
