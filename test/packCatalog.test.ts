/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentMarkdown, agentMarkdownTier, agentMarkdownHasTycoonMarker, REGULAR_AGENTS, LEAD_AGENTS, REVIEWER_AGENTS } from "../src/host/vscode/packCatalog";
import { parseAgentMarkdown } from "../src/providers/claude-code/agentRoster";

const agent = {
  id: "web-qa",
  name: "Web QA",
  model: "claude-sonnet-4-6",
  role: "Drives a real browser to QA web UIs — screenshots and accessibility.",
  keywords: "playwright|browser|ui|qa|screenshot",
};

test("output starts with frontmatter containing name, description, and model", () => {
  const md = buildAgentMarkdown(agent);
  assert.ok(
    md.startsWith(`---\nname: ${agent.id}\ndescription: ${JSON.stringify(agent.role)}\nmodel: ${agent.model}\n---`),
    "must start with frontmatter + name + description + model"
  );
});

test("frontmatter name is the kebab-case id, not the Title Case display name", () => {
  const md = buildAgentMarkdown(agent);
  assert.ok(md.includes(`name: ${agent.id}\n`), "name: must equal agent.id");
  assert.ok(!md.includes(`name: ${agent.name}\n`), "name: must NOT equal the Title Case display name");
});

test("output contains the H1 name heading", () => {
  const md = buildAgentMarkdown(agent);
  assert.ok(md.includes(`# ${agent.name}`), "must contain H1 with name");
});

test("output has a ## Role section with the role text", () => {
  const md = buildAgentMarkdown(agent);
  assert.match(md, /^##\s+Role\s*\n/m);
  assert.ok(md.includes(agent.role), "must contain the role text");
});

test("output has a ## Keywords section with the keywords", () => {
  const md = buildAgentMarkdown(agent);
  assert.match(md, /^##\s+Keywords/m);
  assert.ok(md.includes(agent.keywords), "must contain the keywords");
});

test("output ends with a trailing newline", () => {
  const md = buildAgentMarkdown(agent);
  assert.ok(md.endsWith("\n"), "must end with a trailing newline");
});

test("round-trips through parseAgentMarkdown to same model and name", () => {
  const md = buildAgentMarkdown(agent);
  const parsed = parseAgentMarkdown(agent.id, md);
  assert.equal(parsed.model, agent.model);
  assert.equal(parsed.name, agent.name);
});

test("a regular agent (no tier) renders full expected frontmatter — no tier line", () => {
  const md = buildAgentMarkdown(agent);
  assert.equal(
    md,
    `---\nname: ${agent.id}\ndescription: ${JSON.stringify(agent.role)}\nmodel: ${agent.model}\n---\n\n# ${agent.name}\n\n## Role\n${agent.role}\n\n## Keywords (for task routing)\n${agent.keywords}\n`
  );
  assert.ok(!md.includes("tier:"), "regular agents must not emit a tier line");
});

test("a lead-tier agent emits a `tier: lead` frontmatter line after name/description/model", () => {
  const leadAgent = { ...agent, id: "some-lead", name: "Some Lead", tier: "lead" as const };
  const md = buildAgentMarkdown(leadAgent);
  assert.ok(
    md.startsWith(`---\nname: ${leadAgent.id}\ndescription: ${JSON.stringify(leadAgent.role)}\nmodel: ${leadAgent.model}\ntier: lead\n---`),
    "must emit tier: lead right after model"
  );
});

test("LEAD_AGENTS contains exactly build-lead and quality-lead, both tier: lead, both sonnet", () => {
  assert.equal(LEAD_AGENTS.length, 2);
  const ids = LEAD_AGENTS.map((a) => a.id).sort();
  assert.deepEqual(ids, ["build-lead", "quality-lead"]);
  for (const a of LEAD_AGENTS) {
    assert.equal(a.tier, "lead");
    assert.equal(a.model, "sonnet");
  }
  const names = LEAD_AGENTS.map((a) => a.name).sort();
  assert.deepEqual(names, ["Build Lead", "Quality Lead"]);
});

test("quality-lead and reviewer keywords are disjoint and drop the dead 'test plan' multi-word token", () => {
  const qualityLead = LEAD_AGENTS.find((a) => a.id === "quality-lead");
  const reviewer = REVIEWER_AGENTS.find((a) => a.id === "reviewer");
  assert.ok(qualityLead, "quality-lead must exist in LEAD_AGENTS");
  assert.ok(reviewer, "reviewer must exist in REVIEWER_AGENTS");
  assert.equal(qualityLead!.keywords, "quality|verify|acceptance|audit");
  assert.equal(reviewer!.keywords, "review|approve|correctness|regression");

  const qualityLeadTokens = qualityLead!.keywords.split("|");
  const reviewerTokens = reviewer!.keywords.split("|");
  const overlap = qualityLeadTokens.filter((t) => reviewerTokens.includes(t));
  assert.deepEqual(overlap, [], "quality-lead and reviewer keyword tokens must not overlap");
  assert.ok(!qualityLeadTokens.includes("test plan"), "dead multi-word 'test plan' token must be removed");
});

test("REGULAR_AGENTS has exactly 8 entries, all without a tier, all unique ids/names", () => {
  assert.equal(REGULAR_AGENTS.length, 8);
  for (const a of REGULAR_AGENTS) {
    assert.equal(a.tier, undefined, `${a.id} must not have a tier`);
  }
  const ids = REGULAR_AGENTS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
  const names = REGULAR_AGENTS.map((a) => a.name);
  assert.equal(new Set(names).size, names.length, "names must be unique");
});

test("REGULAR_AGENTS and LEAD_AGENTS share no ids (leads are not double-counted as regulars)", () => {
  const regularIds = new Set(REGULAR_AGENTS.map((a) => a.id));
  for (const lead of LEAD_AGENTS) {
    assert.ok(!regularIds.has(lead.id), `${lead.id} must not appear in REGULAR_AGENTS`);
  }
});

test("every REGULAR_AGENTS and LEAD_AGENTS entry builds valid markdown that round-trips", () => {
  for (const a of [...REGULAR_AGENTS, ...LEAD_AGENTS]) {
    const md = buildAgentMarkdown(a);
    const parsed = parseAgentMarkdown(a.id, md);
    assert.equal(parsed.model, a.model);
    assert.equal(parsed.name, a.name);
  }
});

// ---------------------------------------------------------------------------
// REVIEWER_AGENTS — the optional Review-pass agent (on by default via
// execution.json's reviewEnabled). It is NOT a team lead: no `tier: lead`,
// so the ready-test skill (which excludes only `tier: lead`) spawns it like
// any other worker. It carries `tier: "reviewer"` solely as the safety
// marker install/remove uses to identify TycoonAgents-owned files.
// ---------------------------------------------------------------------------

test("REVIEWER_AGENTS contains exactly one 'reviewer' entry, tier 'reviewer' (not 'lead'), sonnet", () => {
  assert.equal(REVIEWER_AGENTS.length, 1);
  const reviewer = REVIEWER_AGENTS[0];
  assert.equal(reviewer.id, "reviewer");
  assert.equal(reviewer.model, "sonnet");
  assert.equal(reviewer.tier, "reviewer");
  assert.notEqual(reviewer.tier, "lead", "reviewer must not carry tier: lead (would hide it from the ready-test skill)");
});

test("REVIEWER_AGENTS shares no id with REGULAR_AGENTS or LEAD_AGENTS", () => {
  const otherIds = new Set([...REGULAR_AGENTS, ...LEAD_AGENTS].map((a) => a.id));
  for (const r of REVIEWER_AGENTS) {
    assert.ok(!otherIds.has(r.id), `${r.id} must not collide with an existing regular/lead agent id`);
  }
});

test("every REVIEWER_AGENTS entry builds valid markdown that round-trips", () => {
  for (const a of REVIEWER_AGENTS) {
    const md = buildAgentMarkdown(a);
    const parsed = parseAgentMarkdown(a.id, md);
    assert.equal(parsed.model, a.model);
    assert.equal(parsed.name, a.name);
  }
});

test("agentMarkdownTier reads back 'reviewer' from REVIEWER_AGENTS' rendered markdown", () => {
  for (const a of REVIEWER_AGENTS) {
    const md = buildAgentMarkdown(a);
    assert.equal(agentMarkdownTier(md), "reviewer", `${a.id} must round-trip tier: reviewer`);
  }
});

test("a lead-tier and a reviewer-tier agent are distinguishable via agentMarkdownTier (install/remove never confuses the two)", () => {
  const leadMd = buildAgentMarkdown(LEAD_AGENTS[0]);
  const reviewerMd = buildAgentMarkdown(REVIEWER_AGENTS[0]);
  assert.equal(agentMarkdownTier(leadMd), "lead");
  assert.equal(agentMarkdownTier(reviewerMd), "reviewer");
  assert.notEqual(agentMarkdownTier(leadMd), agentMarkdownTier(reviewerMd));
});

// ---------------------------------------------------------------------------
// agentMarkdownTier — the safety predicate the Phase 2 downgrade path
// (setDelegationMode) uses before deleting a .claude/agents/<id>.md file.
// ---------------------------------------------------------------------------

test("agentMarkdownTier reads back 'lead' from every LEAD_AGENTS entry's rendered markdown", () => {
  for (const a of LEAD_AGENTS) {
    const md = buildAgentMarkdown(a);
    assert.equal(agentMarkdownTier(md), "lead", `${a.id} must round-trip tier: lead`);
  }
});

test("agentMarkdownTier returns undefined for a regular (non-tiered) agent's markdown", () => {
  for (const a of REGULAR_AGENTS) {
    const md = buildAgentMarkdown(a);
    assert.equal(agentMarkdownTier(md), undefined, `${a.id} must have no tier`);
  }
});

test("agentMarkdownTier returns undefined for content with no frontmatter at all", () => {
  assert.equal(agentMarkdownTier("# Just a heading\n\nSome body text."), undefined);
});

test("agentMarkdownTier returns undefined for a user's own file with a tier-like id but no tier line", () => {
  // A user could name their own agent file build-lead.md without ever having
  // gone through TycoonAgents' install — this must never look like tier: lead.
  const userFile = "---\nmodel: sonnet\n---\n\n# My Own Build Lead\n\nHand-written, not ours.\n";
  assert.equal(agentMarkdownTier(userFile), undefined);
});

test("agentMarkdownTier finds tier: lead regardless of position within the frontmatter block", () => {
  const md = "---\nname: foo\ntier: lead\nmodel: sonnet\n---\nBody.";
  assert.equal(agentMarkdownTier(md), "lead");
});

test("agentMarkdownTier does not match a 'tier:' mention in the document body (outside frontmatter)", () => {
  const md = "---\nmodel: sonnet\n---\n\nThis agent has no tier: lead in the body.\n";
  assert.equal(agentMarkdownTier(md), undefined);
});

// ---------------------------------------------------------------------------
// tycoon_pack provenance marker — buildAgentMarkdown(agent, packId) and its
// inverse agentMarkdownHasTycoonMarker. Used by _handleInstallPack (panel.ts)
// to tell "ours, safe to refresh" apart from a legacy/foreign file that
// happens to share the same agent id.
// ---------------------------------------------------------------------------

test("buildAgentMarkdown(agent, packId) emits a tycoon_pack frontmatter line and keeps model + body sections", () => {
  const md = buildAgentMarkdown(agent, "uefn");
  assert.ok(md.includes("tycoon_pack: uefn\n"), "must contain the tycoon_pack frontmatter line");
  assert.ok(md.includes(`model: ${agent.model}\n`), "must still contain the model line");
  assert.match(md, /^##\s+Keywords/m, "must still contain the ## Keywords section");
  assert.match(md, /^##\s+Role\s*\n/m, "must still contain the ## Role section");
});

test("buildAgentMarkdown(agent, packId) places tycoon_pack after model (and after tier, if present)", () => {
  const md = buildAgentMarkdown(agent, "uefn");
  assert.ok(
    md.startsWith(`---\nname: ${agent.id}\ndescription: ${JSON.stringify(agent.role)}\nmodel: ${agent.model}\ntycoon_pack: uefn\n---`),
    "tycoon_pack must follow model directly when there is no tier"
  );
});

test("buildAgentMarkdown(agent) without packId omits tycoon_pack but still has name/description/model", () => {
  const md = buildAgentMarkdown(agent);
  assert.equal(
    md,
    `---\nname: ${agent.id}\ndescription: ${JSON.stringify(agent.role)}\nmodel: ${agent.model}\n---\n\n# ${agent.name}\n\n## Role\n${agent.role}\n\n## Keywords (for task routing)\n${agent.keywords}\n`
  );
  assert.ok(!md.includes("tycoon_pack"), "no packId means no tycoon_pack line");
});

test("agentMarkdownHasTycoonMarker returns true for buildAgentMarkdown output with a packId (round-trip)", () => {
  assert.equal(agentMarkdownHasTycoonMarker(buildAgentMarkdown(agent, "uefn")), true);
  assert.equal(agentMarkdownHasTycoonMarker(buildAgentMarkdown(agent, "godot")), true);
});

test("agentMarkdownHasTycoonMarker returns false for buildAgentMarkdown output with no packId", () => {
  assert.equal(agentMarkdownHasTycoonMarker(buildAgentMarkdown(agent)), false);
});

test("agentMarkdownHasTycoonMarker returns false for a hand-written legacy agent file with no marker", () => {
  const legacy = "---\nmodel: sonnet\n---\n\n# Verse Auditor\n\nHand-written, not ours.\n";
  assert.equal(agentMarkdownHasTycoonMarker(legacy), false);
});

test("agentMarkdownHasTycoonMarker returns false for an empty string", () => {
  assert.equal(agentMarkdownHasTycoonMarker(""), false);
});

test("buildAgentMarkdown(agent, packId) is deterministic across repeated calls", () => {
  const first = buildAgentMarkdown(agent, "uefn");
  const second = buildAgentMarkdown(agent, "uefn");
  assert.equal(first, second);
});

// ---------------------------------------------------------------------------
// Claude Code subagent registration requires `name:` and `description:` in
// frontmatter — without them a generated agent file never registers, so
// `subagent_type` can never spawn it (the bug this fix addresses).
// ---------------------------------------------------------------------------

/** Minimal frontmatter-block parser: splits `key: value` lines between the
 * two `---` fences into a map, so tests can assert on parsed keys instead
 * of raw substring matches (guards against a key merely appearing in the
 * body). Handles a JSON-double-quoted value (our `description:` encoding)
 * by unescaping it back to the original string. */
function parseFrontmatter(md: string): Record<string, string> {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, "content must have a --- frontmatter block");
  const out: Record<string, string> = {};
  for (const line of match![1].split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m;
    out[key] = rawValue.startsWith('"') ? JSON.parse(rawValue) : rawValue;
  }
  return out;
}

test("a lead agent with a packId produces valid, parseable frontmatter with name (kebab id), description, and model", () => {
  const leadAgent = LEAD_AGENTS[0];
  const md = buildAgentMarkdown(leadAgent, "uefn");
  const fm = parseFrontmatter(md);
  assert.equal(fm.name, leadAgent.id, "name: must be the kebab-case id");
  assert.notEqual(fm.name, leadAgent.name, "name: must not be the Title Case display name");
  assert.equal(fm.description, leadAgent.role, "description: must round-trip the exact role text");
  assert.equal(fm.model, leadAgent.model);
  assert.equal(fm.tier, "lead");
  assert.equal(fm.tycoon_pack, "uefn");
});

test("a core agent with no packId produces valid, parseable frontmatter with name (kebab id), description, and model", () => {
  const coreAgent = REGULAR_AGENTS.find((a) => a.id === "coding-specialist")!;
  const md = buildAgentMarkdown(coreAgent);
  const fm = parseFrontmatter(md);
  assert.equal(fm.name, coreAgent.id, "name: must be the kebab-case id");
  assert.equal(fm.description, coreAgent.role, "description: must round-trip the exact role text");
  assert.equal(fm.model, coreAgent.model);
  assert.equal(fm.tier, undefined);
  assert.equal(fm.tycoon_pack, undefined);
});

test("every REGULAR_AGENTS/LEAD_AGENTS/REVIEWER_AGENTS entry has a non-empty role and generates name === id in frontmatter", () => {
  for (const a of [...REGULAR_AGENTS, ...LEAD_AGENTS, ...REVIEWER_AGENTS]) {
    assert.ok(a.role && a.role.trim() !== "", `${a.id} must have a non-empty role`);
    const fm = parseFrontmatter(buildAgentMarkdown(a));
    assert.equal(fm.name, a.id, `${a.id}: name: must equal the agent's kebab-case id`);
    assert.equal(fm.description, a.role, `${a.id}: description: must round-trip the role text`);
  }
});

test("description is YAML-safe (JSON-quoted) even when role contains a colon and a double quote", () => {
  const trickyAgent = { ...agent, id: "tricky-agent", role: 'Handles "special" cases: colons, quotes, and stuff.' };
  const md = buildAgentMarkdown(trickyAgent);
  const fm = parseFrontmatter(md);
  assert.equal(fm.description, trickyAgent.role, "description must round-trip exactly despite colons/quotes");
  // The raw frontmatter line itself must be a valid double-quoted YAML scalar.
  assert.ok(md.includes(`description: ${JSON.stringify(trickyAgent.role)}\n`));
});
