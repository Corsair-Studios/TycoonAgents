/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AGENT_KEYWORDS,
  seedMissingAgentKeywords,
  parseAgentKeywords,
  reconcileAgentKeywords,
  type ReconcileAgentInput,
} from "../src/host/vscode/agentKeywordDefaults";

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

// ---------------------------------------------------------------------------
// parseAgentKeywords()
// ---------------------------------------------------------------------------

test("parseAgentKeywords extracts the pattern from '## Keywords (for task routing)'", () => {
  const markdown = [
    "# coding-specialist",
    "",
    "## Keywords (for task routing)",
    "implement|code|fix|bug|refactor",
    "",
    "## Other Section",
    "irrelevant",
  ].join("\n");
  assert.equal(parseAgentKeywords(markdown), "implement|code|fix|bug|refactor");
});

test("parseAgentKeywords tolerates a bare '## Keywords' header", () => {
  const markdown = ["# some-agent", "", "## Keywords", "foo|bar|baz"].join("\n");
  assert.equal(parseAgentKeywords(markdown), "foo|bar|baz");
});

test("parseAgentKeywords returns null when the section is absent", () => {
  const markdown = ["# some-agent", "", "## Description", "no keywords section here"].join("\n");
  assert.equal(parseAgentKeywords(markdown), null);
});

test("parseAgentKeywords returns null when the section is present but empty/whitespace-only", () => {
  const markdown = ["# some-agent", "", "## Keywords", "   ", "", "## Next Section", "content"].join("\n");
  assert.equal(parseAgentKeywords(markdown), null);
});

test("parseAgentKeywords stops at the next '##' header and ignores content after it", () => {
  const markdown = [
    "# some-agent",
    "## Keywords (for task routing)",
    "alpha|beta",
    "## Description",
    "this must not be included",
  ].join("\n");
  assert.equal(parseAgentKeywords(markdown), "alpha|beta");
});

test("parseAgentKeywords trims whitespace on the extracted content", () => {
  const markdown = ["## Keywords", "   spaced|out|values   "].join("\n");
  assert.equal(parseAgentKeywords(markdown), "spaced|out|values");
});

// ---------------------------------------------------------------------------
// reconcileAgentKeywords()
// ---------------------------------------------------------------------------

test("reconcileAgentKeywords drops a phantom config key not present in agents[]", () => {
  const config = {
    agents: {
      "coding-specialist": { pattern: "existing" },
      "deleted-agent": { pattern: "phantom" },
    },
  };
  const agents: ReconcileAgentInput[] = [{ id: "coding-specialist", keywords: null }];
  const { config: out, dropped, added } = reconcileAgentKeywords(config, agents, {});
  assert.deepEqual(dropped, ["deleted-agent"]);
  assert.deepEqual(added, []);
  assert.equal("deleted-agent" in out.agents, false);
  assert.equal(out.agents["coding-specialist"].pattern, "existing");
});

test("reconcileAgentKeywords adds a missing agent using its own body keywords when provided", () => {
  const config = { agents: {} };
  const agents: ReconcileAgentInput[] = [{ id: "new-agent", keywords: "custom|body|keywords" }];
  const { config: out, dropped, added } = reconcileAgentKeywords(config, agents, {});
  assert.deepEqual(dropped, []);
  assert.deepEqual(added, ["new-agent"]);
  assert.deepEqual(out.agents["new-agent"], { pattern: "custom|body|keywords" });
});

test("reconcileAgentKeywords falls back to defaults[id] when body keywords is null", () => {
  const config = { agents: {} };
  const agents: ReconcileAgentInput[] = [{ id: "new-agent", keywords: null }];
  const customDefaults = { "new-agent": "default|pattern" };
  const { config: out, added } = reconcileAgentKeywords(config, agents, customDefaults);
  assert.deepEqual(added, ["new-agent"]);
  assert.deepEqual(out.agents["new-agent"], { pattern: "default|pattern" });
});

test("reconcileAgentKeywords skips an id when body keywords is null and no default exists", () => {
  const config = { agents: {} };
  const agents: ReconcileAgentInput[] = [{ id: "orphan-agent", keywords: null }];
  const { config: out, dropped, added } = reconcileAgentKeywords(config, agents, {});
  assert.deepEqual(dropped, []);
  assert.deepEqual(added, []);
  assert.equal("orphan-agent" in out.agents, false);
});

test("reconcileAgentKeywords never overwrites an existing entry, even one with an empty pattern", () => {
  const existingEntry = { pattern: "" };
  const config = { agents: { "coding-specialist": existingEntry } };
  const agents: ReconcileAgentInput[] = [
    { id: "coding-specialist", keywords: "would-be-new-value" },
  ];
  const { config: out, dropped, added } = reconcileAgentKeywords(config, agents, {});
  assert.deepEqual(dropped, []);
  assert.deepEqual(added, []);
  assert.deepEqual(out.agents["coding-specialist"], existingEntry);
});

test("reconcileAgentKeywords is idempotent across a second reconcile pass", () => {
  const config = {
    agents: {
      "coding-specialist": { pattern: "existing" },
      "deleted-agent": { pattern: "phantom" },
    },
  };
  const agents: ReconcileAgentInput[] = [
    { id: "coding-specialist", keywords: null },
    { id: "new-agent", keywords: "fresh|keywords" },
  ];
  const first = reconcileAgentKeywords(config, agents, {});
  assert.deepEqual(first.dropped, ["deleted-agent"]);
  assert.deepEqual(first.added, ["new-agent"]);

  const second = reconcileAgentKeywords(first.config, agents, {});
  assert.deepEqual(second.dropped, []);
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.config, first.config);
});

test("reconcileAgentKeywords returns the original config reference unchanged when nothing changed", () => {
  const config = { agents: { "coding-specialist": { pattern: "existing" } } };
  const agents: ReconcileAgentInput[] = [{ id: "coding-specialist", keywords: null }];
  const { config: out, dropped, added } = reconcileAgentKeywords(config, agents, {});
  assert.deepEqual(dropped, []);
  assert.deepEqual(added, []);
  assert.equal(out, config, "config reference must be unchanged when nothing was dropped/added");
});

test("reconcileAgentKeywords preserves existing key order and appends new keys in agents[] order", () => {
  const config = {
    agents: {
      zeta: { pattern: "z" },
      alpha: { pattern: "a" },
      "deleted-agent": { pattern: "phantom" },
    },
  };
  const agents: ReconcileAgentInput[] = [
    { id: "zeta", keywords: null },
    { id: "alpha", keywords: null },
    { id: "beta", keywords: "beta-keywords" },
    { id: "gamma", keywords: "gamma-keywords" },
  ];
  const { config: out, dropped, added } = reconcileAgentKeywords(config, agents, {});
  assert.deepEqual(dropped, ["deleted-agent"]);
  assert.deepEqual(added, ["beta", "gamma"]);
  assert.deepEqual(Object.keys(out.agents), ["zeta", "alpha", "beta", "gamma"]);
});

test("reconcileAgentKeywords added entry shape is exactly { pattern }", () => {
  const config = { agents: {} };
  const agents: ReconcileAgentInput[] = [{ id: "new-agent", keywords: "only|these|keywords" }];
  const { config: out } = reconcileAgentKeywords(config, agents, {});
  assert.deepEqual(Object.keys(out.agents["new-agent"]), ["pattern"]);
  assert.equal(out.agents["new-agent"].pattern, "only|these|keywords");
});
