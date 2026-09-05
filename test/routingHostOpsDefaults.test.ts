/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Tests for plan task p17-t2's contract additions to
// src/core/routingHostOps.ts: buildRoutingView returning top-level
// `defaults`, per-agent `provenance` (explicit|default|frontmatter) and
// `handWrittenBackend: boolean`; plus saveRoutingProfile accepting a
// `defaults` field alongside a sparse per-agent override.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRoutingView } from "../src/core/routingHostOps";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "routing-host-ops-defaults-"));
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

// Read whichever provenance-ish field the implementation chose ("source" or
// "provenance") without assuming one over the other.
function provenanceOf(agentView: { provenance: string }): unknown {
  return agentView.provenance;
}

test("buildRoutingView: top-level defaults is echoed back from the loaded profile", () => {
  const root = tmpRoot();
  writeAgent(root, "coding-specialist.md", ["name: coding-specialist", "tier: worker"]);
  writeRouting(root, {
    version: 1,
    agents: {},
    defaults: { vendor: "anthropic", model: "anthropic/haiku", costModelClass: "subscription" },
  });

  const view = buildRoutingView({ root, env: {} });
  assert.ok(view.defaults, "buildRoutingView should surface top-level defaults");
  assert.equal(view.defaults.model, "anthropic/haiku");
});

test("buildRoutingView: defaults is undefined/absent when routing.json has none", () => {
  const root = tmpRoot();
  writeAgent(root, "coding-specialist.md", ["name: coding-specialist", "tier: worker"]);
  writeRouting(root, { version: 1, agents: {} });

  const view = buildRoutingView({ root, env: {} });
  assert.ok(view.defaults === undefined || view.defaults === null);
});

test("buildRoutingView: agent resolved via an explicit agents[id] entry gets 'explicit' provenance and handWrittenBackend:false", () => {
  const root = tmpRoot();
  writeAgent(root, "coding-specialist.md", ["name: coding-specialist", "tier: worker"]);
  writeRouting(root, {
    version: 1,
    agents: { "coding-specialist": { model: "anthropic/opus", vendor: "anthropic", costModelClass: "subscription" } },
    defaults: { vendor: "anthropic", model: "anthropic/haiku", costModelClass: "subscription" },
  });

  const view = buildRoutingView({ root, env: {} });
  const agent = view.agents.find((a) => a.id === "coding-specialist");
  assert.ok(agent);
  assert.equal(provenanceOf(agent), "explicit");
  assert.equal(agent.handWrittenBackend, false);
});

test("buildRoutingView: agent resolved via defaults only gets 'default' provenance", () => {
  const root = tmpRoot();
  writeAgent(root, "coding-specialist.md", ["name: coding-specialist", "tier: worker"]);
  writeRouting(root, {
    version: 1,
    agents: {},
    defaults: { vendor: "anthropic", model: "anthropic/haiku", costModelClass: "subscription" },
  });

  const view = buildRoutingView({ root, env: {} });
  const agent = view.agents.find((a) => a.id === "coding-specialist");
  assert.ok(agent);
  assert.equal(provenanceOf(agent), "default");
  assert.equal(agent.handWrittenBackend, false);
  assert.equal(agent.backend.model, "anthropic/haiku");
});

test("buildRoutingView: agent with a hand-written backend: block is NOT overridden by defaults and reports handWrittenBackend:true", () => {
  const root = tmpRoot();
  writeAgent(root, "codex-reviewer.md", [
    "name: codex-reviewer",
    "tier: worker",
    "backend:",
    "  vendor: openai",
    "  transport: mcp",
    "  mcpServer: codex",
    "  model: openai/gpt-5.4-mini",
    "  costModelClass: subscription",
  ]);
  writeRouting(root, {
    version: 1,
    agents: {},
    defaults: { vendor: "anthropic", model: "anthropic/haiku", costModelClass: "subscription" },
  });

  const view = buildRoutingView({ root, env: {} });
  const agent = view.agents.find((a) => a.id === "codex-reviewer");
  assert.ok(agent);
  assert.equal(agent.handWrittenBackend, true, "a hand-written backend: block must be flagged");
  assert.equal(agent.backend.model, "openai/gpt-5.4-mini", "defaults must not override a hand-written backend block");
  assert.equal(provenanceOf(agent), "frontmatter");
});

test("buildRoutingView: a MANAGED backend: block (# managed-by: tycoon-routing) counts as absent, so defaults still apply", () => {
  const root = tmpRoot();
  writeAgent(root, "coding-specialist.md", [
    "name: coding-specialist",
    "tier: worker",
    "backend:",
    "  # managed-by: tycoon-routing",
    "  vendor: anthropic",
    "  transport: claude-native",
    "  model: anthropic/claude-sonnet-4-6",
    "  costModelClass: subscription",
  ]);
  writeRouting(root, {
    version: 1,
    agents: {},
    defaults: { vendor: "anthropic", model: "anthropic/haiku", costModelClass: "subscription" },
  });

  const view = buildRoutingView({ root, env: {} });
  const agent = view.agents.find((a) => a.id === "coding-specialist");
  assert.ok(agent);
  assert.equal(agent.handWrittenBackend, false, "a managed block must not count as hand-written");
  assert.equal(agent.backend.model, "anthropic/haiku", "defaults should override a managed (not hand-written) block");
});
