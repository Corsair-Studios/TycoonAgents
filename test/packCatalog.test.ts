/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildAgentMarkdown,
  agentMarkdownTier,
  agentMarkdownHasTycoonMarker,
  WORKING_DISCIPLINE_BODY,
  resyncAgentDisciplineSection,
  resyncAgentFrontmatterFields,
  workerAgentFingerprintMatches,
  REGULAR_AGENTS,
  LEAD_AGENTS,
  REVIEWER_AGENTS,
  FOREIGN_LLM_AGENTS,
  workerAgentsForProject,
  UEFN_CONFLICT_AGENT_IDS,
  conflictingUefnAgents,
  type PackAgent,
} from "../src/host/vscode/packCatalog";
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
    md.startsWith(`---\nname: ${agent.id}\ndescription: ${JSON.stringify(agent.role)}\nmodel: ${agent.model}\ndisallowedTools: Agent\n---`),
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
    `---\nname: ${agent.id}\ndescription: ${JSON.stringify(agent.role)}\nmodel: ${agent.model}\ndisallowedTools: Agent\n---\n\n# ${agent.name}\n\n## Role\n${agent.role}\n\n## Keywords (for task routing)\n${agent.keywords}\n\n## Working discipline\n${WORKING_DISCIPLINE_BODY}\n`
  );
  assert.ok(!md.includes("tier:"), "regular agents must not emit a tier line");
});

test("a lead-tier agent emits a `tier: lead` frontmatter line after name/description/model", () => {
  const leadAgent = { ...agent, id: "some-lead", name: "Some Lead", tier: "lead" as const };
  const md = buildAgentMarkdown(leadAgent);
  assert.ok(
    md.startsWith(`---\nname: ${leadAgent.id}\ndescription: ${JSON.stringify(leadAgent.role)}\nmodel: ${leadAgent.model}\ndisallowedTools: Agent\ntier: lead\n---`),
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
    md.startsWith(`---\nname: ${agent.id}\ndescription: ${JSON.stringify(agent.role)}\nmodel: ${agent.model}\ndisallowedTools: Agent\ntycoon_pack: uefn\n---`),
    "tycoon_pack must follow model directly when there is no tier"
  );
});

test("buildAgentMarkdown(agent) without packId omits tycoon_pack but still has name/description/model", () => {
  const md = buildAgentMarkdown(agent);
  assert.equal(
    md,
    `---\nname: ${agent.id}\ndescription: ${JSON.stringify(agent.role)}\nmodel: ${agent.model}\ndisallowedTools: Agent\n---\n\n# ${agent.name}\n\n## Role\n${agent.role}\n\n## Keywords (for task routing)\n${agent.keywords}\n\n## Working discipline\n${WORKING_DISCIPLINE_BODY}\n`
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

test("buildAgentMarkdown appends the Working discipline section for a non-orchestrator agent", () => {
  const md = buildAgentMarkdown(agent);
  assert.ok(md.includes("## Working discipline\n"), "a worker gets a Working discipline section");
  assert.ok(md.includes(WORKING_DISCIPLINE_BODY), "section carries the canonical discipline body");
  assert.ok(md.trimEnd().endsWith(WORKING_DISCIPLINE_BODY), "discipline is the trailing section");
});

test("buildAgentMarkdown omits the Working discipline section for the orchestrator", () => {
  const orch = { ...agent, id: "orchestrator", name: "Orchestrator" };
  const md = buildAgentMarkdown(orch);
  assert.ok(!md.includes("## Working discipline"), "the orchestrator delegates — it carries no leaf-worker discipline");
});

test("buildAgentMarkdown emits disallowedTools: Agent for a worker but never for the orchestrator", () => {
  const workerMd = buildAgentMarkdown(agent);
  assert.ok(
    workerMd.includes("disallowedTools: Agent\n"),
    "a worker must be config-level blocked from spawning its own sub-agents"
  );

  const orch = { ...agent, id: "orchestrator", name: "Orchestrator" };
  const orchMd = buildAgentMarkdown(orch);
  assert.ok(
    !orchMd.includes("disallowedTools"),
    "the orchestrator must retain the ability to delegate via the Agent tool"
  );
});

test("resyncAgentDisciplineSection inserts the section when absent, then is idempotent", () => {
  const legacy = `---\nname: ${agent.id}\ndescription: "x"\nmodel: ${agent.model}\n---\n\n# ${agent.name}\n\n## Role\n${agent.role}\n\n## Keywords (for task routing)\n${agent.keywords}\n`;
  const inserted = resyncAgentDisciplineSection(legacy);
  assert.ok(inserted.includes("## Working discipline\n"), "section is appended when missing");
  assert.ok(inserted.endsWith(`## Working discipline\n${WORKING_DISCIPLINE_BODY}\n`), "appended as the trailing section");
  assert.equal(resyncAgentDisciplineSection(inserted), inserted, "a second resync is a no-op");
});

test("resyncAgentDisciplineSection refreshes a stale discipline body", () => {
  const stale = `# ${agent.name}\n\n## Working discipline\n- old outdated bullet\n`;
  const fixed = resyncAgentDisciplineSection(stale);
  assert.ok(!fixed.includes("old outdated bullet"), "stale body is replaced");
  assert.ok(fixed.includes(WORKING_DISCIPLINE_BODY), "canonical body is written");
  assert.equal(resyncAgentDisciplineSection(fixed), fixed, "idempotent after refresh");
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

// ---------------------------------------------------------------------------
// workerAgentsForProject — trims the worker roster spawned by a project based
// on whether it's a UEFN project (search-only) or a general project (search +
// coding + design). Entries must be the real REGULAR_AGENTS objects, not
// stubs, so model/keywords/role stay in sync with the roster of record.
// ---------------------------------------------------------------------------

test("workerAgentsForProject(true) returns exactly search-retrieval and primary-agent (the Wildcard Agent)", () => {
  const result = workerAgentsForProject(true);
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((a) => a.id),
    ["search-retrieval", "primary-agent"]
  );
});

test("workerAgentsForProject(false) returns search-retrieval, primary-agent, coding-specialist, ux-ui-designer in that exact order", () => {
  const result = workerAgentsForProject(false);
  assert.equal(result.length, 4);
  assert.deepEqual(
    result.map((a) => a.id),
    ["search-retrieval", "primary-agent", "coding-specialist", "ux-ui-designer"]
  );
});

test("workerAgentsForProject includes primary-agent (the Wildcard Agent) for BOTH UEFN and non-UEFN projects, matching search-retrieval's project-agnostic install", () => {
  for (const isUefn of [true, false]) {
    const result = workerAgentsForProject(isUefn);
    assert.ok(
      result.some((a) => a.id === "primary-agent"),
      `isUefn=${isUefn} must include primary-agent`
    );
  }
});

test("workerAgentsForProject(true)'s search-retrieval entry carries model: haiku", () => {
  const result = workerAgentsForProject(true);
  assert.equal(result[0].model, "haiku");
});

test("workerAgentsForProject(false)'s entries carry the expected models (search-retrieval=haiku, others=sonnet)", () => {
  const result = workerAgentsForProject(false);
  const byId = new Map(result.map((a) => [a.id, a]));
  assert.equal(byId.get("search-retrieval")!.model, "haiku");
  assert.ok(byId.get("coding-specialist")!.model, "coding-specialist must have a truthy model");
  assert.ok(byId.get("ux-ui-designer")!.model, "ux-ui-designer must have a truthy model");
  assert.equal(byId.get("coding-specialist")!.model, "sonnet");
  assert.equal(byId.get("ux-ui-designer")!.model, "sonnet");
});

test("workerAgentsForProject returns the real REGULAR_AGENTS objects (not stubs/clones)", () => {
  for (const isUefn of [true, false]) {
    const result = workerAgentsForProject(isUefn);
    for (const returned of result) {
      const canonical = REGULAR_AGENTS.find((a) => a.id === returned.id);
      assert.ok(canonical, `${returned.id} must exist in REGULAR_AGENTS`);
      assert.deepEqual(returned, canonical, `${returned.id} must match its REGULAR_AGENTS entry field-for-field`);
    }
  }
});

// ---------------------------------------------------------------------------
// Wildcard Agent (primary-agent) install semantics: create-if-absent, never
// overwrite. Mirrors panel.ts's `_installWorkerAgents` write loop exactly
// (existsSync -> write; else leave untouched) since that private method
// isn't independently exported/testable — this proves the exact algorithm
// panel.ts runs, applied to the now-updated `workerAgentsForProject` roster,
// both creates a missing primary-agent.md AND never clobbers a
// user-customized one. This is the auto-heal rail that self-heals a project
// installed at an earlier version (e.g. one with no Wildcard Agent on disk)
// on every panel open, gated on hooks-installed, same as the doctrine and
// keyword auto-heal rails.
// ---------------------------------------------------------------------------

/** Mirrors panel.ts's `_installWorkerAgents` per-file write loop exactly. */
function simulateInstallWorkerAgents(agentsDir: string, agents: PackAgent[]): void {
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const a of agents) {
    const agentPath = path.join(agentsDir, `${a.id}.md`);
    if (!fs.existsSync(agentPath)) {
      fs.writeFileSync(agentPath, buildAgentMarkdown(a));
    }
    // else: never overwritten — strictly create-if-absent.
  }
}

test("simulated _installWorkerAgents creates a missing primary-agent.md (Wildcard Agent) for a non-UEFN project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workerAgents-"));
  try {
    const agentsDir = path.join(root, ".claude", "agents");
    simulateInstallWorkerAgents(agentsDir, workerAgentsForProject(false));
    const primaryAgentPath = path.join(agentsDir, "primary-agent.md");
    assert.ok(fs.existsSync(primaryAgentPath), "primary-agent.md must be created when absent");
    const content = fs.readFileSync(primaryAgentPath, "utf8");
    const expected = REGULAR_AGENTS.find((a) => a.id === "primary-agent")!;
    assert.equal(content, buildAgentMarkdown(expected), "created content must match buildAgentMarkdown output");
    assert.ok(/model:\s*sonnet/.test(content), "Wildcard Agent must be seeded on the sonnet model");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("primary-agent template writes 'Wildcard Agent' heading and the new catch-all description", () => {
  const agent = REGULAR_AGENTS.find((a) => a.id === "primary-agent")!;
  assert.equal(agent.name, "Wildcard Agent");
  const content = buildAgentMarkdown(agent);
  assert.match(content, /^# Wildcard Agent$/m, "H1 heading must read 'Wildcard Agent'");
  assert.match(
    content,
    /description: "Handles tasks that don't match any other agent's keywords\."/,
    "description frontmatter must carry the new catch-all wording"
  );
});

test("simulated _installWorkerAgents NEVER overwrites an existing primary-agent.md, even a user-customized one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workerAgents-"));
  try {
    const agentsDir = path.join(root, ".claude", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    const customized = "---\nname: primary-agent\ndescription: \"my own customization\"\nmodel: opus\n---\n\n# Mine\n";
    fs.writeFileSync(path.join(agentsDir, "primary-agent.md"), customized);

    simulateInstallWorkerAgents(agentsDir, workerAgentsForProject(false));

    const content = fs.readFileSync(path.join(agentsDir, "primary-agent.md"), "utf8");
    assert.equal(content, customized, "an existing primary-agent.md must be left byte-for-byte untouched");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("simulated _installWorkerAgents creates primary-agent.md for a UEFN project too (project-agnostic like search-retrieval)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workerAgents-"));
  try {
    const agentsDir = path.join(root, ".claude", "agents");
    simulateInstallWorkerAgents(agentsDir, workerAgentsForProject(true));
    assert.ok(fs.existsSync(path.join(agentsDir, "primary-agent.md")), "primary-agent.md must be created for UEFN projects too");
    assert.ok(fs.existsSync(path.join(agentsDir, "search-retrieval.md")), "search-retrieval.md must still be created");
    assert.equal(fs.existsSync(path.join(agentsDir, "coding-specialist.md")), false, "coding-specialist must NOT be installed for UEFN projects");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resyncAgentFrontmatterFields — frontmatter repair for a worker agent file
// installed before buildAgentMarkdown emitted the `name`/`description`
// fields Claude Code requires to register a custom subagent, or one whose
// top-level `model:` is a vendor-prefixed id (e.g. `anthropic/haiku`). Only
// the frontmatter block may change; the body is preserved byte-for-byte.
// ---------------------------------------------------------------------------

test("resyncAgentFrontmatterFields adds missing name/description and fixes a vendor-prefixed model, preserving the body", () => {
  const agent = REGULAR_AGENTS.find((a) => a.id === "search-retrieval")!;
  const legacy =
    "---\nmodel: anthropic/haiku\ndisallowedTools: Agent\n---\n\n# Search & Retrieval Agent\n\n## Role\nCustom user-edited role text.\n";
  const repaired = resyncAgentFrontmatterFields(legacy, agent);
  assert.notEqual(repaired, null, "must report a change for a legacy file");
  assert.match(repaired!, /^name: search-retrieval$/m, "name: must be inserted");
  assert.match(repaired!, /^description: "/m, "description: must be inserted");
  assert.match(repaired!, /^model: haiku$/m, "vendor-prefixed model must be rewritten to the canonical alias");
  assert.ok(!/anthropic\/haiku/.test(repaired!), "the vendor-prefixed value must not remain anywhere in the file");
  assert.ok(
    repaired!.endsWith("# Search & Retrieval Agent\n\n## Role\nCustom user-edited role text.\n"),
    "body below the frontmatter must be preserved byte-for-byte"
  );
});

test("resyncAgentFrontmatterFields never touches a nested backend.model line", () => {
  const agent = REGULAR_AGENTS.find((a) => a.id === "coding-specialist")!;
  const legacy =
    "---\nmodel: anthropic/sonnet\nbackend:\n  vendor: openai\n  model: openai/gpt-5\n---\n\nbody\n";
  const repaired = resyncAgentFrontmatterFields(legacy, agent);
  assert.notEqual(repaired, null);
  assert.match(repaired!, /^model: sonnet$/m, "top-level model fixed");
  assert.match(repaired!, /^\s{2}model: openai\/gpt-5$/m, "nested backend.model left untouched");
});

test("resyncAgentFrontmatterFields: top-level model:openai/gpt-6-astra with backend.vendor:openai and no backend.model is forced to a Claude alias, stranded slug moved to backend.model", () => {
  const agent = FOREIGN_LLM_AGENTS.find((a) => a.id === "codex-reviewer")!;
  const legacy =
    `---\nname: codex-reviewer\ndescription: "x"\nmodel: openai/gpt-6-astra\nbackend:\n  vendor: openai\n  transport: mcp\n  mcpServer: codex\n---\n\n## Keywords (for task routing)\n${agent.keywords}\n`;
  const repaired = resyncAgentFrontmatterFields(legacy, agent);
  assert.notEqual(repaired, null);
  assert.match(repaired!, /^model: haiku$/m, "top-level model must become the Claude alias");
  assert.match(repaired!, /^\s{2}model: openai\/gpt-6-astra$/m, "stranded vendor slug must be preserved under backend.model");
  assert.ok(repaired!.endsWith(`## Keywords (for task routing)\n${agent.keywords}\n`), "body must be preserved byte-for-byte");
  assert.ok(workerAgentFingerprintMatches(repaired!, agent), "repaired file must be recognized as ours so activation does not loop");
});

test("resyncAgentFrontmatterFields: an existing explicit backend.model is preserved untouched, not overwritten by the stranded top-level slug", () => {
  const agent = FOREIGN_LLM_AGENTS.find((a) => a.id === "codex-reviewer")!;
  const legacy =
    "---\nname: codex-reviewer\ndescription: \"x\"\nmodel: openai/gpt-5-old\nbackend:\n  vendor: openai\n  transport: mcp\n  mcpServer: codex\n  model: openai/gpt-6-astra\n---\n\nBody.\n";
  const repaired = resyncAgentFrontmatterFields(legacy, agent);
  assert.notEqual(repaired, null);
  assert.match(repaired!, /^model: haiku$/m);
  assert.match(repaired!, /^\s{2}model: openai\/gpt-6-astra$/m, "the pre-existing backend.model must survive unchanged");
  assert.equal((repaired!.match(/^\s{2}model:/gm) || []).length, 1, "no duplicate backend.model line must be inserted");
});

test("resyncAgentFrontmatterFields: a top-level model that is already a valid Claude alias is left untouched (no-op) for a foreign backend, and fingerprint still matches", () => {
  const agent = FOREIGN_LLM_AGENTS.find((a) => a.id === "codex-reviewer")!;
  const current = buildAgentMarkdown(agent);
  assert.equal(resyncAgentFrontmatterFields(current, agent), null, "already-current file (valid alias, backend.model set) must be a no-op");
  assert.ok(workerAgentFingerprintMatches(current, agent), "an already-current file must still be recognized as ours");
});

test("workerAgentFingerprintMatches: a legacy unmarked reviewer file with model: sonnet is still managed; an unrelated file is not", () => {
  const agent = FOREIGN_LLM_AGENTS.find((a) => a.id === "codex-reviewer")!;
  const legacy = buildAgentMarkdown(agent).replace(/^model: haiku$/m, "model: sonnet");
  assert.match(legacy, /^model: sonnet$/m);
  assert.ok(workerAgentFingerprintMatches(legacy, agent), "legacy sonnet reviewer must still fingerprint as ours");
  const unrelated = `---\nname: my-agent\nmodel: sonnet\n---\n\n## Keywords (for task routing)\nsomething|else\n`;
  assert.equal(workerAgentFingerprintMatches(unrelated, agent), false);
  const otherModel = legacy.replace(/^model: sonnet$/m, "model: opus");
  assert.equal(workerAgentFingerprintMatches(otherModel, agent), false, "an unrelated model value is not accepted");
});

test("resyncAgentFrontmatterFields is a no-op (returns null) when frontmatter is already current", () => {
  const agent = REGULAR_AGENTS.find((a) => a.id === "search-retrieval")!;
  const current = buildAgentMarkdown(agent);
  assert.equal(resyncAgentFrontmatterFields(current, agent), null, "an already-current file must not be reported changed");
});

test("resyncAgentFrontmatterFields returns null for a file with no recognizable frontmatter block", () => {
  const agent = REGULAR_AGENTS.find((a) => a.id === "search-retrieval")!;
  assert.equal(resyncAgentFrontmatterFields("no frontmatter here\n", agent), null);
});

// ---------------------------------------------------------------------------
// Installer-level repair path: mirrors panel.ts's
// `_ensureWorkerAgentRoleTextCurrent` write loop exactly (managed-check via
// agentMarkdownHasTycoonMarker/workerAgentFingerprintMatches, then
// resyncAgentFrontmatterFields, then write-if-different) since that private
// method isn't independently exported/testable. Proves: an old-format file
// we recognize as ours gets repaired with its body preserved, and a
// same-named file we cannot prove is ours is left byte-for-byte untouched.
// ---------------------------------------------------------------------------

function simulateFrontmatterRepair(agentsDir: string, agents: PackAgent[]): void {
  for (const a of agents) {
    const agentPath = path.join(agentsDir, `${a.id}.md`);
    let content: string;
    try {
      content = fs.readFileSync(agentPath, "utf8");
    } catch {
      continue;
    }
    const managed = agentMarkdownHasTycoonMarker(content) || workerAgentFingerprintMatches(content, a);
    if (!managed) continue;
    const updated = resyncAgentFrontmatterFields(content, a);
    if (updated !== null && updated !== content) {
      fs.writeFileSync(agentPath, updated);
    }
  }
}

test("simulated frontmatter repair fixes an old-format file we recognize as ours, preserving its user-edited body", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontmatterRepair-"));
  try {
    const agentsDir = path.join(root, ".claude", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    const agent = REGULAR_AGENTS.find((a) => a.id === "coding-specialist")!;
    const bodyMarker = `## Role\nMy own hand-edited notes for this agent.\n\n## Keywords (for task routing)\n${agent.keywords}\n`;
    const legacy = `---\nmodel: anthropic/sonnet\ndisallowedTools: Agent\n---\n\n# Coding Specialist\n\n${bodyMarker}`;
    fs.writeFileSync(path.join(agentsDir, "coding-specialist.md"), legacy);

    simulateFrontmatterRepair(agentsDir, [agent]);

    const repaired = fs.readFileSync(path.join(agentsDir, "coding-specialist.md"), "utf8");
    assert.match(repaired, /^name: coding-specialist$/m);
    assert.match(repaired, /^description: "/m);
    assert.match(repaired, /^model: sonnet$/m);
    assert.ok(repaired.endsWith(bodyMarker), "user-edited body must survive the repair untouched");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("simulated frontmatter repair never touches a same-named file it cannot prove is ours", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontmatterRepair-"));
  try {
    const agentsDir = path.join(root, ".claude", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    const agent = REGULAR_AGENTS.find((a) => a.id === "coding-specialist")!;
    // Different model and no tycoon marker/keywords fingerprint -> not ours.
    const foreign = "---\nmodel: opus\n---\n\n# Someone else's agent\n\n## Role\nUnrelated content.\n";
    fs.writeFileSync(path.join(agentsDir, "coding-specialist.md"), foreign);

    simulateFrontmatterRepair(agentsDir, [agent]);

    const content = fs.readFileSync(path.join(agentsDir, "coding-specialist.md"), "utf8");
    assert.equal(content, foreign, "a file we cannot identify as ours must be left byte-for-byte untouched");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Non-worker repair paths: `_installAgentFiles` (LEAD_AGENTS/REVIEWER_AGENTS,
// panel.ts) and `_handleInstallPack` (pack-shipped agents, e.g. the
// multi-llm pack's FOREIGN_LLM_AGENTS, panel.ts). Both previously
// recognized "ours" only via an exact `tier:`/tycoon_pack-marker match, so
// an old-format file predating `name:`/`description:`/a valid `model:`
// alias (and thus lacking that marker) fell into the "foreign, never
// overwritten" branch and never healed. Both now also try
// `workerAgentFingerprintMatches` + `resyncAgentFrontmatterFields` before
// giving up on a file as foreign. These simulate functions mirror the
// exact new branch order in panel.ts.
// ---------------------------------------------------------------------------

/** Mirrors panel.ts's `_installAgentFiles` per-file branch exactly, including the new fingerprint-repair fallback. */
function simulateInstallAgentFiles(agentsDir: string, agents: PackAgent[]): void {
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const a of agents) {
    const agentPath = path.join(agentsDir, `${a.id}.md`);
    if (!fs.existsSync(agentPath)) {
      fs.writeFileSync(agentPath, buildAgentMarkdown(a));
      continue;
    }
    const existing = fs.readFileSync(agentPath, "utf8");
    let existingTier: string | undefined;
    try {
      existingTier = agentMarkdownTier(existing);
    } catch {
      existingTier = undefined;
    }
    if (existingTier === a.tier) {
      const desired = buildAgentMarkdown(a);
      if (existing !== desired) fs.writeFileSync(agentPath, desired);
    } else if (workerAgentFingerprintMatches(existing, a)) {
      const repaired = resyncAgentFrontmatterFields(existing, a);
      if (repaired !== null) fs.writeFileSync(agentPath, repaired);
    }
    // else: foreign/legacy same-named file — never overwritten.
  }
}

test("simulated _installAgentFiles repairs an old-format REVIEWER_AGENTS file (no tier: line) via fingerprint match, preserving body", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installAgentFiles-"));
  try {
    const agentsDir = path.join(root, ".claude", "agents");
    const agent = REVIEWER_AGENTS.find((a) => a.id === "reviewer")!;
    fs.mkdirSync(agentsDir, { recursive: true });
    const bodyMarker = `## Role\nMy own customized review notes.\n\n## Keywords (for task routing)\n${agent.keywords}\n`;
    const legacy = `---\nmodel: anthropic/sonnet\ndisallowedTools: Agent\n---\n\n# Reviewer\n\n${bodyMarker}`;
    fs.writeFileSync(path.join(agentsDir, "reviewer.md"), legacy);

    simulateInstallAgentFiles(agentsDir, [agent]);

    const repaired = fs.readFileSync(path.join(agentsDir, "reviewer.md"), "utf8");
    assert.match(repaired, /^name: reviewer$/m);
    assert.match(repaired, /^description: "/m);
    assert.match(repaired, /^model: sonnet$/m);
    assert.equal(/^tier:/m.test(repaired), false, "repair must not fabricate a tier: line — only name/description/model");
    assert.ok(repaired.endsWith(bodyMarker), "user-edited body must survive the repair untouched");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("simulated _installAgentFiles never touches a same-named file that fails the fingerprint check", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installAgentFiles-"));
  try {
    const agentsDir = path.join(root, ".claude", "agents");
    const agent = REVIEWER_AGENTS.find((a) => a.id === "reviewer")!;
    fs.mkdirSync(agentsDir, { recursive: true });
    // Different model, no keywords fingerprint, no tier: line -> not ours.
    const foreign = "---\nmodel: opus\n---\n\n# Someone else's reviewer\n\n## Role\nUnrelated.\n";
    fs.writeFileSync(path.join(agentsDir, "reviewer.md"), foreign);

    simulateInstallAgentFiles(agentsDir, [agent]);

    const content = fs.readFileSync(path.join(agentsDir, "reviewer.md"), "utf8");
    assert.equal(content, foreign, "a file we cannot identify as ours must be left byte-for-byte untouched");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Mirrors panel.ts's `_handleInstallPack` per-agent branch exactly, including the new fingerprint-repair fallback. */
function simulateHandleInstallPack(agentsDir: string, packId: string, agents: PackAgent[]): void {
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const a of agents) {
    const agentPath = path.join(agentsDir, `${a.id}.md`);
    const generated = buildAgentMarkdown(a, packId);
    if (!fs.existsSync(agentPath)) {
      fs.writeFileSync(agentPath, generated);
      continue;
    }
    const existingContent = fs.readFileSync(agentPath, "utf8");
    if (agentMarkdownHasTycoonMarker(existingContent)) {
      if (existingContent !== generated) fs.writeFileSync(agentPath, generated);
    } else if (workerAgentFingerprintMatches(existingContent, a)) {
      const repaired = resyncAgentFrontmatterFields(existingContent, a);
      if (repaired !== null) fs.writeFileSync(agentPath, repaired);
    } else {
      const backupPath = `${agentPath}.bak`;
      if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, existingContent);
      fs.writeFileSync(agentPath, generated);
    }
  }
}

test("simulated _handleInstallPack repairs an old-format FOREIGN_LLM_AGENTS file (no tycoon_pack marker) via fingerprint match, preserving body", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installPack-"));
  try {
    const agentsDir = path.join(root, ".claude", "agents");
    const agent = FOREIGN_LLM_AGENTS.find((a) => a.id === "codex-reviewer")!;
    fs.mkdirSync(agentsDir, { recursive: true });
    const bodyMarker = `## Role\nMy own customized Codex notes.\n\n## Keywords (for task routing)\n${agent.keywords}\n`;
    const legacy = `---\nmodel: ${agent.backend!.model}\ndisallowedTools: Agent\n---\n\n# Codex Reviewer\n\n${bodyMarker}`;
    fs.writeFileSync(path.join(agentsDir, "codex-reviewer.md"), legacy);

    simulateHandleInstallPack(agentsDir, "multi-llm", [agent]);

    const repaired = fs.readFileSync(path.join(agentsDir, "codex-reviewer.md"), "utf8");
    assert.match(repaired, /^name: codex-reviewer$/m);
    assert.match(repaired, /^description: "/m);
    assert.match(repaired, /^model: haiku$/m, "top-level model must become the canonical alias, not the vendor id");
    assert.equal(/^tycoon_pack:/m.test(repaired), false, "a fingerprint-repair must not fabricate the tycoon_pack marker");
    assert.ok(fs.existsSync(path.join(agentsDir, "codex-reviewer.md.bak")) === false, "no backup file must be created for a repaired (not replaced) file");
    assert.ok(repaired.endsWith(bodyMarker), "user-edited body must survive the repair untouched");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("simulated _handleInstallPack never touches a same-named file that fails the fingerprint check (backs up and replaces instead)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installPack-"));
  try {
    const agentsDir = path.join(root, ".claude", "agents");
    const agent = FOREIGN_LLM_AGENTS.find((a) => a.id === "codex-reviewer")!;
    fs.mkdirSync(agentsDir, { recursive: true });
    const foreign = "---\nmodel: opus\n---\n\n# A user's own codex-reviewer\n\n## Role\nUnrelated content, no keywords section.\n";
    fs.writeFileSync(path.join(agentsDir, "codex-reviewer.md"), foreign);

    simulateHandleInstallPack(agentsDir, "multi-llm", [agent]);

    // Not ours by fingerprint -> falls to the true-foreign branch, which
    // backs the original up and replaces it (existing, unchanged behavior
    // for a genuinely foreign file) rather than leaving it untouched.
    assert.ok(fs.existsSync(path.join(agentsDir, "codex-reviewer.md.bak")), "the original foreign content must be preserved in a .bak file");
    assert.equal(fs.readFileSync(path.join(agentsDir, "codex-reviewer.md.bak"), "utf8"), foreign);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// UEFN_CONFLICT_AGENT_IDS / conflictingUefnAgents — the UEFN pack install
// conflict gate (panel.ts's _handleInstallPack) uses this pure helper to
// decide which generic agents (reviewer, coding-specialist) must be warned
// about and removed before the pack's own uefn-auditor/verse-expert agents
// are written. ux-ui-designer is deliberately excluded (no competing UEFN
// design agent), so it must never appear in the conflict set.
// ---------------------------------------------------------------------------

test("UEFN_CONFLICT_AGENT_IDS is exactly reviewer, coding-specialist, in that order", () => {
  assert.deepEqual(UEFN_CONFLICT_AGENT_IDS, ["reviewer", "coding-specialist"]);
});

test("conflictingUefnAgents([]) returns an empty array", () => {
  assert.deepEqual(conflictingUefnAgents([]), []);
});

test("conflictingUefnAgents(['reviewer']) returns ['reviewer']", () => {
  assert.deepEqual(conflictingUefnAgents(["reviewer"]), ["reviewer"]);
});

test("conflictingUefnAgents(['coding-specialist']) returns ['coding-specialist']", () => {
  assert.deepEqual(conflictingUefnAgents(["coding-specialist"]), ["coding-specialist"]);
});

test("conflictingUefnAgents preserves UEFN_CONFLICT_AGENT_IDS' canonical order regardless of input order", () => {
  assert.deepEqual(
    conflictingUefnAgents(["coding-specialist", "reviewer", "search-retrieval"]),
    ["reviewer", "coding-specialist"]
  );
});

test("conflictingUefnAgents ignores unrelated ids, including ux-ui-designer", () => {
  assert.deepEqual(conflictingUefnAgents(["ux-ui-designer", "search-retrieval", "vscode-integration"]), []);
});

test("conflictingUefnAgents is pure — repeated calls with the same input return equal results", () => {
  const input = ["coding-specialist", "reviewer"];
  assert.deepEqual(conflictingUefnAgents(input), conflictingUefnAgents(input));
});

// ---------------------------------------------------------------------------
// Leaf-spawn guard doctrine package: WORKING_DISCIPLINE_BODY additions.
//
// NOTE: only the batch-split sanctioned-alternative line and the
// honest-sample-size-reporting line are actually present in
// WORKING_DISCIPLINE_BODY (verified against the real source above) — there
// is no "delete-only-after-verified-capture" line here. That specific rule
// lives in src/host/vscode/delegationDoctrine.ts's renderWorkerLeafSection
// (see delegationDoctrine.test.ts) but was never added to this file's
// WORKING_DISCIPLINE_BODY constant.
// ---------------------------------------------------------------------------

test("WORKING_DISCIPLINE_BODY states the batch-splitting sanctioned alternative (chunk in-turn, never wait or spawn a helper)", () => {
  assert.ok(
    WORKING_DISCIPLINE_BODY.includes(
      "split it into bounded sequential calls run to completion in this same turn"
    ),
    "missing the batch-split sanctioned-alternative line"
  );
  assert.ok(
    WORKING_DISCIPLINE_BODY.includes('never end the turn to "wait" and never spawn a helper to do it'),
    "missing the never-wait/never-spawn-a-helper framing"
  );
});

test("WORKING_DISCIPLINE_BODY states honest-sample-size reporting (overclaiming is a failure)", () => {
  assert.ok(
    WORKING_DISCIPLINE_BODY.includes(
      "State your actual sample size or coverage limit when it differs from what was asked"
    ),
    "missing the honest-sample-size-reporting line"
  );
  assert.ok(
    WORKING_DISCIPLINE_BODY.includes("an honest smaller result is acceptable; an overclaimed one is a failure"),
    "missing the honest-vs-overclaimed framing"
  );
});

test("every REGULAR_AGENTS/LEAD_AGENTS/REVIEWER_AGENTS worker markdown carries the batch-split and honesty lines", () => {
  // REGULAR_AGENTS includes the "orchestrator" id itself (the only entry
  // buildAgentMarkdown never appends a Working discipline section for) —
  // excluded here since this test is specifically about WORKER markdown;
  // the orchestrator's own (lack of) content is covered by the dedicated
  // test right below.
  for (const a of [...REGULAR_AGENTS, ...LEAD_AGENTS, ...REVIEWER_AGENTS].filter((x) => x.id !== "orchestrator")) {
    const md = buildAgentMarkdown(a);
    assert.ok(
      md.includes("split it into bounded sequential calls run to completion in this same turn"),
      `${a.id}: missing the batch-split sanctioned-alternative line`
    );
    assert.ok(
      md.includes("an honest smaller result is acceptable; an overclaimed one is a failure"),
      `${a.id}: missing the honest-sample-size-reporting line`
    );
  }
});

test("the orchestrator's markdown carries neither the Working discipline section nor the batch-split/honesty lines", () => {
  const orchMd = buildAgentMarkdown({
    id: "orchestrator",
    name: "Orchestrator",
    model: "claude-opus-4-1",
    role: "Coordinates the team.",
    keywords: "n/a",
  });
  assert.equal(orchMd.includes("## Working discipline"), false, "orchestrator must carry no Working discipline section at all");
  assert.equal(
    orchMd.includes("split it into bounded sequential calls run to completion in this same turn"),
    false,
    "orchestrator must not carry the batch-split line"
  );
  assert.equal(
    orchMd.includes("an honest smaller result is acceptable"),
    false,
    "orchestrator must not carry the honesty line"
  );
});

// NOTE: the disallowedTools frontmatter comment's claim ("this only binds
// named-agent spawns; the PreToolUse hook guard is the real enforcement for
// general-purpose spawns") and the underlying "disallowedTools: Agent for a
// worker, never for the orchestrator" behavior it documents are ALREADY
// covered by the pre-existing test above,
// "buildAgentMarkdown emits disallowedTools: Agent for a worker but never
// for the orchestrator" — not duplicated here.

// ---------------------------------------------------------------------------
// Report-shape directives (answer-first opening, no-decoration plain prose,
// worker-side scope discipline) — WORKING_DISCIPLINE_BODY:80-82. Each bullet
// is a single unbroken JS string-literal line (no hard-wrap concern at the
// source level, unlike delegationDoctrine.ts's template-literal prose), but
// the same short "bullet-theater" / "widen into cleanup" fragments are reused
// here for consistency with the delegationDoctrine.test.ts pins.
// ---------------------------------------------------------------------------

test("WORKING_DISCIPLINE_BODY states the three report-shape directives (answer-first, no decoration, scope discipline)", () => {
  assert.ok(WORKING_DISCIPLINE_BODY.includes("Open with the outcome"), "missing the answer-first opening line");
  assert.ok(WORKING_DISCIPLINE_BODY.includes("bullet-theater"), "missing the no-decoration line");
  assert.ok(WORKING_DISCIPLINE_BODY.includes("widen into cleanup"), "missing the worker-scope-discipline line");
});

test("every REGULAR_AGENTS (minus orchestrator)/LEAD_AGENTS/REVIEWER_AGENTS worker markdown carries the three report-shape directives; the orchestrator's markdown carries none", () => {
  for (const a of [...REGULAR_AGENTS, ...LEAD_AGENTS, ...REVIEWER_AGENTS].filter((x) => x.id !== "orchestrator")) {
    const md = buildAgentMarkdown(a);
    assert.ok(md.includes("Open with the outcome"), `${a.id}: missing the answer-first opening line`);
    assert.ok(md.includes("bullet-theater"), `${a.id}: missing the no-decoration line`);
    assert.ok(md.includes("widen into cleanup"), `${a.id}: missing the worker-scope-discipline line`);
  }

  const orchMd = buildAgentMarkdown({
    id: "orchestrator",
    name: "Orchestrator",
    model: "claude-opus-4-1",
    role: "Coordinates the team.",
    keywords: "n/a",
  });
  assert.equal(orchMd.includes("Open with the outcome"), false, "orchestrator must not carry the answer-first line");
  assert.equal(orchMd.includes("bullet-theater"), false, "orchestrator must not carry the no-decoration line");
  assert.equal(orchMd.includes("widen into cleanup"), false, "orchestrator must not carry the scope-discipline line");
});
