/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Panel-side Codex harness defaults: src/core/harnessModelDefaults.ts, its
// parity with the dispatcher's hooks/harnessModelDefaults.cjs, and
// describeAgentRoutes' harnessDefault field. Display only: nothing here may
// write harness defaults into routing.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CODEX_TIER_MODELS,
  describeHarnessDefault,
  harnessModelLabel,
  resolveHarnessDefault,
} from "../src/core/harnessModelDefaults";
import { describeAgentRoutes } from "../src/core/agentSettingsRoute";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cjs = require("../../hooks/harnessModelDefaults.cjs");

test("tier table matches the user-approved Codex defaults", () => {
  assert.deepEqual(CODEX_TIER_MODELS, {
    haiku: { model: "gpt-5.6-sol", effort: "low" },
    sonnet: { model: "gpt-5.6-sol" },
    opus: { model: "gpt-6-astra" },
    fable: { model: "gpt-6-astra" },
  });
});

test("codex: Claude tier aliases and ids map to openai tier models", () => {
  assert.deepEqual(resolveHarnessDefault("codex", { frontmatterModel: "haiku" }), { vendor: "openai", model: "gpt-5.6-sol", effort: "low", source: "harness-default" });
  assert.deepEqual(resolveHarnessDefault("codex", { frontmatterModel: "sonnet" }), { vendor: "openai", model: "gpt-5.6-sol", source: "harness-default" });
  assert.equal(resolveHarnessDefault("codex", { frontmatterModel: "claude-opus-5" }).model, "gpt-6-astra");
  assert.equal(resolveHarnessDefault("codex", { frontmatterModel: "fable" }).model, "gpt-6-astra");
  assert.equal(resolveHarnessDefault("codex", { frontmatterModel: "inherit" }).model, "gpt-5.6-sol");
  assert.equal(resolveHarnessDefault("codex", {}).source, "harness-default");
});

test("codex: explicit slot, foreign vendor and claude-cli backend are kept", () => {
  assert.equal(resolveHarnessDefault("codex", { frontmatterModel: "sonnet", routingSlot: { model: "openai/gpt-6-astra" } }).source, "explicit");
  assert.equal(resolveHarnessDefault("codex", { frontmatterModel: "haiku", backendVendor: "google" }).source, "agent-vendor");
  assert.equal(resolveHarnessDefault("codex", { frontmatterModel: "sonnet", backendMcpServer: "claude-cli" }).source, "agent-vendor");
  assert.equal(resolveHarnessDefault("codex", { frontmatterModel: "gpt-5.6-sol" }).model, "gpt-5.6-sol");
});

test("non-codex harness is unchanged", () => {
  const r = resolveHarnessDefault("claude-code", { frontmatterModel: "sonnet" });
  assert.equal(r.vendor, "anthropic");
  assert.notEqual(r.source, "harness-default");
  assert.equal(describeHarnessDefault("claude-code", { frontmatterModel: "haiku" }), null);
});

test("labels", () => {
  assert.equal(harnessModelLabel("gpt-5.6-sol"), "Sol");
  assert.equal(harnessModelLabel("gpt-5.6-sol", "low"), "Sol low");
  assert.equal(harnessModelLabel("gpt-6-astra"), "Astra");
  assert.equal(describeHarnessDefault("codex", { frontmatterModel: "haiku" })?.label, "Sol low");
});

test("parity with hooks/harnessModelDefaults.cjs", () => {
  assert.deepEqual(CODEX_TIER_MODELS, cjs.CODEX_TIER_MODELS);
  const agents: any[] = [
    {}, { frontmatterModel: "haiku" }, { frontmatterModel: "sonnet" }, { frontmatterModel: "opus" }, { frontmatterModel: "fable" },
    { frontmatterModel: "claude-haiku-4-5" }, { frontmatterModel: "inherit" }, { frontmatterModel: "gpt-5.6-sol" }, { frontmatterModel: "openai/gpt-6-astra" },
    { frontmatterModel: "sonnet", backendVendor: "google" }, { frontmatterModel: "sonnet", backendVendor: "anthropic" },
    { frontmatterModel: "sonnet", backendMcpServer: "claude-cli" }, { frontmatterModel: "sonnet", backendMcpServer: "codex" },
    { frontmatterModel: "sonnet", routingSlot: { vendor: "xai", model: "grok-4.7" } }, { frontmatterModel: "haiku", routingSlot: { model: "openai/gpt-6-astra" } },
  ];
  for (const h of ["codex", "claude-code", "opencode"]) {
    for (const a of agents) {
      const ours = resolveHarnessDefault(h, a);
      const theirs = cjs.resolveHarnessDefault(h, a);
      const tag = `${h} ${JSON.stringify(a)}`;
      assert.equal(ours.vendor, theirs.vendor, `${tag} vendor`);
      assert.equal(ours.source, theirs.source, `${tag} source`);
      assert.equal(ours.effort, theirs.effort, `${tag} effort`);
      assert.equal(ours.model || undefined, theirs.model || undefined, `${tag} model`);
    }
  }
});

test("describeAgentRoutes: codex harness surfaces defaults, never for explicit choices, nothing on claude-code", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hmd-"));
  try {
    const dir = path.join(root, ".claude", "agents");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "worker-a.md"), "---\nname: worker-a\ndescription: a\nmodel: haiku\n---\nbody\n");
    fs.writeFileSync(path.join(dir, "worker-b.md"), "---\nname: worker-b\ndescription: b\nmodel: opus\n---\nbody\n");
    fs.mkdirSync(path.join(root, ".claude", "tycoon"), { recursive: true });
    const routingPath = path.join(root, ".claude", "tycoon", "routing.json");
    const routingText = JSON.stringify({ version: 1, agents: { "worker-b": { vendor: "openai", model: "openai/gpt-5.6-sol" } } });
    fs.writeFileSync(routingPath, routingText);
    const codex = describeAgentRoutes(root, { harness: "codex" });
    assert.equal(codex["worker-a"].harnessDefault?.label, "Sol low");
    assert.equal(codex["worker-a"].vendor, "openai");
    assert.equal(codex["worker-a"].costModelClass, "subscription");
    assert.equal(codex["worker-b"].harnessDefault, null);
    const claude = describeAgentRoutes(root, { harness: "claude-code" });
    assert.equal(claude["worker-a"].harnessDefault, null);
    assert.equal(claude["worker-a"].vendor, "anthropic");
    assert.equal(fs.readFileSync(routingPath, "utf8"), routingText, "routing.json untouched");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
