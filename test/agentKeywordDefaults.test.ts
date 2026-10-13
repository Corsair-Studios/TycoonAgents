/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { workerAgentFingerprintMatches } from "../src/host/vscode/packCatalog";
import assert from "node:assert/strict";
import { matchAgentFromKeywords } from "../src/core/delegationEnforcement";
import {
  DEFAULT_AGENT_KEYWORDS,
  seedMissingAgentKeywords,
  parseAgentKeywords,
  reconcileAgentKeywords,
  migrateSupersededKeywords,
  migrateSupersededAgentBodies,
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

test("quality-lead and reviewer keyword patterns share no token (no silent-misroute overlap)", () => {
  const splitTokens = (pattern: string) => pattern.split("|").map((t) => t.trim());
  const qualityLeadTokens = splitTokens(DEFAULT_AGENT_KEYWORDS["quality-lead"]);
  const reviewerTokens = splitTokens(DEFAULT_AGENT_KEYWORDS["reviewer"]);
  const overlap = qualityLeadTokens.filter((t) => reviewerTokens.includes(t));
  assert.deepEqual(overlap, [], "quality-lead and reviewer must share zero keyword tokens");
});

test("quality-lead pattern no longer contains the dead multi-word 'test plan' token", () => {
  const tokens = DEFAULT_AGENT_KEYWORDS["quality-lead"].split("|").map((t) => t.trim());
  assert.ok(
    !tokens.includes("test plan"),
    "'test plan' is a multi-word token the single-word matcher (words.has(kw)) can never match"
  );
  for (const t of tokens) {
    assert.equal(t.includes(" "), false, `token "${t}" must be single-word for the keyword matcher to ever match it`);
  }
});

test("quality-lead and reviewer keyword tokens introduce no collision with any other agent id", () => {
  const splitTokens = (pattern: string) => pattern.split("|").map((t) => t.trim());
  const qualityLeadTokens = new Set(splitTokens(DEFAULT_AGENT_KEYWORDS["quality-lead"]));
  const reviewerTokens = new Set(splitTokens(DEFAULT_AGENT_KEYWORDS["reviewer"]));
  for (const [id, pattern] of Object.entries(DEFAULT_AGENT_KEYWORDS)) {
    if (id === "quality-lead" || id === "reviewer") continue;
    const otherTokens = splitTokens(pattern);
    for (const t of otherTokens) {
      assert.equal(qualityLeadTokens.has(t), false, `quality-lead token "${t}" collides with agent "${id}"`);
      assert.equal(reviewerTokens.has(t), false, `reviewer token "${t}" collides with agent "${id}"`);
    }
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

// ---------------------------------------------------------------------------
// migrateSupersededKeywords()
// ---------------------------------------------------------------------------

test("migrateSupersededKeywords bumps a known-prior quality-lead default forward to current", () => {
  const config = {
    agents: {
      "quality-lead": { pattern: "quality|verify|test plan|acceptance|audit" },
    },
  };
  const { config: out, changed } = migrateSupersededKeywords(config);
  assert.equal(changed, true);
  assert.equal(out.agents["quality-lead"].pattern, DEFAULT_AGENT_KEYWORDS["quality-lead"]);
});

test("migrateSupersededKeywords bumps a known-prior reviewer default forward to current", () => {
  const config = {
    agents: {
      reviewer: { pattern: "review|verify|approve|correctness|quality|regression" },
    },
  };
  const { config: out, changed } = migrateSupersededKeywords(config);
  assert.equal(changed, true);
  assert.equal(out.agents["reviewer"].pattern, DEFAULT_AGENT_KEYWORDS["reviewer"]);
});

test("migrateSupersededKeywords leaves a user's custom pattern untouched", () => {
  const config = {
    agents: {
      "quality-lead": { pattern: "my-custom-quality-pattern" },
      reviewer: { pattern: "my-custom-reviewer-pattern" },
    },
  };
  const { config: out, changed } = migrateSupersededKeywords(config);
  assert.equal(changed, false);
  assert.equal(out.agents["quality-lead"].pattern, "my-custom-quality-pattern");
  assert.equal(out.agents["reviewer"].pattern, "my-custom-reviewer-pattern");
});

test("migrateSupersededKeywords is a no-op when patterns are already current", () => {
  const config = {
    agents: {
      "quality-lead": { pattern: DEFAULT_AGENT_KEYWORDS["quality-lead"] },
      reviewer: { pattern: DEFAULT_AGENT_KEYWORDS["reviewer"] },
    },
  };
  const { config: out, changed } = migrateSupersededKeywords(config);
  assert.equal(changed, false);
  assert.equal(out, config);
});

test("migrateSupersededKeywords is idempotent across a second pass", () => {
  const config = {
    agents: {
      "quality-lead": { pattern: "quality|verify|test plan|acceptance|audit" },
      reviewer: { pattern: "review|verify|approve|correctness|quality|regression" },
    },
  };
  const first = migrateSupersededKeywords(config);
  assert.equal(first.changed, true);

  const second = migrateSupersededKeywords(first.config);
  assert.equal(second.changed, false);
  assert.deepEqual(second.config, first.config);
});

test("migrateSupersededKeywords ignores an id absent from the config and does not mutate the input", () => {
  const config = { agents: { "coding-specialist": { pattern: "existing" } } };
  const clonedBefore = structuredClone(config);
  const { changed } = migrateSupersededKeywords(config);
  assert.equal(changed, false);
  assert.deepEqual(config, clonedBefore, "input must not be mutated");
});

// ---------------------------------------------------------------------------
// uefn-auditor vs verse-expert default keywords
// ---------------------------------------------------------------------------

test("uefn-auditor and verse-expert default keywords share no token", () => {
  const split = (p: string) => p.split("|").map((t) => t.trim());
  const expert = split(DEFAULT_AGENT_KEYWORDS["verse-expert"]);
  const auditor = split(DEFAULT_AGENT_KEYWORDS["uefn-auditor"]);
  assert.deepEqual(auditor.filter((t) => expert.includes(t)), []);
  for (const t of auditor) assert.match(t, /^[a-z0-9]+$/, `"${t}" is not a single matchable word`);
});

test("uefn-auditor defaults route lint/deprecation work to the auditor and authoring to verse-expert", () => {
  const cfg = {
    agents: {
      "verse-expert": { pattern: DEFAULT_AGENT_KEYWORDS["verse-expert"] },
      "uefn-auditor": { pattern: DEFAULT_AGENT_KEYWORDS["uefn-auditor"] },
    },
  };
  assert.equal(
    matchAgentFromKeywords("lint this verse device for deprecation and compliance issues", cfg)?.agentId,
    "uefn-auditor"
  );
  assert.equal(
    matchAgentFromKeywords("add a verse device that spawns items", cfg)?.agentId,
    "verse-expert"
  );
});

test("migrateSupersededKeywords moves the exact old uefn-auditor default to the new one", () => {
  const old = "verse|uefn|fortnite|verse-audit|verse-review|verse-lint";
  const { config: out, changed } = migrateSupersededKeywords({ agents: { "uefn-auditor": { pattern: old } } });
  assert.equal(changed, true);
  assert.equal(out.agents["uefn-auditor"].pattern, DEFAULT_AGENT_KEYWORDS["uefn-auditor"]);
});

test("migrateSupersededKeywords leaves an edited uefn-auditor pattern untouched", () => {
  const config = { agents: { "uefn-auditor": { pattern: "verse|uefn|fortnite|verse-audit|verse-review|verse-lint|mine" } } };
  const { config: out, changed } = migrateSupersededKeywords(config);
  assert.equal(changed, false);
  assert.equal(out, config);
});

// ---------------------------------------------------------------------------
// Agent file Keywords body refresh
// ---------------------------------------------------------------------------

function mkAgentsDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-kwbody-"));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content, "utf8");
  return dir;
}

const OLD_AUDITOR_KW = "verse|uefn|fortnite|verse-audit|verse-review|verse-lint";

test("migrateSupersededAgentBodies rewrites only the exact old Keywords line and keeps CRLF", () => {
  const body = (kw: string, eol: string) =>
    ["---", "name: uefn-auditor", "model: sonnet", "---", "# A", "", "## Role", "r", "", "## Keywords (for task routing)", kw, "", "## Other", "x", ""].join(eol);
  const dir = mkAgentsDir({ "uefn-auditor.md": body(OLD_AUDITOR_KW, "\r\n") });
  assert.deepEqual(migrateSupersededAgentBodies(dir), ["uefn-auditor"]);
  const after = fs.readFileSync(path.join(dir, "uefn-auditor.md"), "utf8");
  assert.equal(after, body(DEFAULT_AGENT_KEYWORDS["uefn-auditor"], "\r\n"));
  assert.deepEqual(migrateSupersededAgentBodies(dir), []);
});

test("migrateSupersededAgentBodies leaves an edited Keywords line untouched", () => {
  const edited = "## Keywords (for task routing)\n" + OLD_AUDITOR_KW + "|mine\n";
  const dir = mkAgentsDir({ "uefn-auditor.md": edited });
  assert.deepEqual(migrateSupersededAgentBodies(dir), []);
  assert.equal(fs.readFileSync(path.join(dir, "uefn-auditor.md"), "utf8"), edited);
});

test("workerAgentFingerprintMatches accepts a superseded uefn-auditor Keywords line", () => {
  const agent = { id: "uefn-auditor", model: "sonnet", keywords: DEFAULT_AGENT_KEYWORDS["uefn-auditor"] } as any;
  const md = (kw: string) => `---\nmodel: sonnet\n---\n## Keywords (for task routing)\n${kw}\n`;
  assert.equal(workerAgentFingerprintMatches(md(OLD_AUDITOR_KW), agent), true);
  assert.equal(workerAgentFingerprintMatches(md("something|else"), agent), false);
});

test("web-qa default has no `ui`; the exact old default migrates and an edited one does not", () => {
  assert.ok(!DEFAULT_AGENT_KEYWORDS["web-qa"].split("|").includes("ui"));
  const old = "playwright|browser|ui|qa|screenshot|accessibility|e2e|web";
  const { config: out, changed } = migrateSupersededKeywords({ agents: { "web-qa": { pattern: old } } });
  assert.equal(changed, true);
  assert.equal(out.agents["web-qa"].pattern, DEFAULT_AGENT_KEYWORDS["web-qa"]);
  const edited = { agents: { "web-qa": { pattern: old + "|mine" } } };
  assert.equal(migrateSupersededKeywords(edited).changed, false);
});
