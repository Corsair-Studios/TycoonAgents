/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_AGENT_KEYWORDS, seedMissingAgentKeywords } from "../src/host/vscode/agentKeywordDefaults";

test("seedMissingAgentKeywords fills only missing/empty ids that have a default", () => {
  const config = {
    fallback_agent: "primary-agent",
    agents: {
      "coding-specialist": { pattern: "" },
      // "testing-specialist" entry absent entirely
    },
  };
  const { config: out, changed } = seedMissingAgentKeywords(
    config,
    ["coding-specialist", "testing-specialist"]
  );
  assert.equal(changed, true);
  assert.equal(out.agents["coding-specialist"].pattern, DEFAULT_AGENT_KEYWORDS["coding-specialist"]);
  assert.equal(out.agents["testing-specialist"].pattern, DEFAULT_AGENT_KEYWORDS["testing-specialist"]);
});

test("seedMissingAgentKeywords never overwrites a non-empty existing value", () => {
  const config = {
    fallback_agent: "primary-agent",
    agents: {
      "coding-specialist": { pattern: "my-custom-keyword|another" },
    },
  };
  const { config: out, changed } = seedMissingAgentKeywords(config, ["coding-specialist"]);
  assert.equal(changed, false);
  assert.equal(out.agents["coding-specialist"].pattern, "my-custom-keyword|another");
});

test("seedMissingAgentKeywords treats whitespace-only patterns as empty and fills them", () => {
  const config = { agents: { "coding-specialist": { pattern: "   " } } };
  const { config: out, changed } = seedMissingAgentKeywords(config, ["coding-specialist"]);
  assert.equal(changed, true);
  assert.equal(out.agents["coding-specialist"].pattern, DEFAULT_AGENT_KEYWORDS["coding-specialist"]);
});

test("seedMissingAgentKeywords leaves ids with no default untouched", () => {
  const config = { agents: {} };
  const { config: out, changed } = seedMissingAgentKeywords(config, ["my-custom-agent"]);
  assert.equal(changed, false);
  assert.equal("my-custom-agent" in out.agents, false);
});

test("seedMissingAgentKeywords reports changed=false when nothing to fill", () => {
  const config = {
    agents: {
      "coding-specialist": { pattern: "already-set" },
    },
  };
  const { config: out, changed } = seedMissingAgentKeywords(config, ["coding-specialist"]);
  assert.equal(changed, false);
  assert.deepEqual(out, config);
});

test("seedMissingAgentKeywords reports changed=false for an empty installed-agent list", () => {
  const config = { agents: {} };
  const { changed } = seedMissingAgentKeywords(config, []);
  assert.equal(changed, false);
});

test("seedMissingAgentKeywords preserves fallback_agent and other agent entries", () => {
  const config = {
    fallback_agent: "primary-agent",
    agents: {
      "workspace-monitor": { pattern: "custom|kept" },
    },
  };
  const { config: out } = seedMissingAgentKeywords(config, ["coding-specialist", "workspace-monitor"]);
  assert.equal(out.fallback_agent, "primary-agent");
  assert.equal(out.agents["workspace-monitor"].pattern, "custom|kept");
  assert.equal(out.agents["coding-specialist"].pattern, DEFAULT_AGENT_KEYWORDS["coding-specialist"]);
});

test("seedMissingAgentKeywords does not mutate the input config object", () => {
  const config = { agents: { "coding-specialist": { pattern: "" } } };
  const clonedBefore = structuredClone(config);
  seedMissingAgentKeywords(config, ["coding-specialist"]);
  assert.deepEqual(config, clonedBefore, "input must not be mutated");
});

test("seedMissingAgentKeywords tolerates a malformed/missing agents map", () => {
  const { config: out, changed } = seedMissingAgentKeywords({}, ["coding-specialist"]);
  assert.equal(changed, true);
  assert.equal(out.agents["coding-specialist"].pattern, DEFAULT_AGENT_KEYWORDS["coding-specialist"]);
});

test("DEFAULT_AGENT_KEYWORDS covers every core roster + capability-pack agent id", () => {
  const expectedIds = [
    "orchestrator",
    "primary-agent",
    "search-retrieval",
    "coding-specialist",
    "testing-specialist",
    "vscode-integration",
    "ux-ui-designer",
    "workspace-monitor",
    "build-lead",
    "quality-lead",
    "reviewer",
    "verse-expert",
    "uefn-auditor",
    "web-qa",
    "godot",
    "unity",
    "roblox",
    "blender",
  ];
  for (const id of expectedIds) {
    assert.equal(typeof DEFAULT_AGENT_KEYWORDS[id], "string", `missing default for ${id}`);
    assert.ok(DEFAULT_AGENT_KEYWORDS[id].trim() !== "", `empty default for ${id}`);
  }
});
