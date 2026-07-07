/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentMarkdown, REGULAR_AGENTS, LEAD_AGENTS } from "../src/host/vscode/packCatalog";
import { parseAgentMarkdown } from "../src/providers/claude-code/agentRoster";

const agent = {
  id: "web-qa",
  name: "Web QA",
  model: "claude-sonnet-4-6",
  role: "Drives a real browser to QA web UIs — screenshots and accessibility.",
  keywords: "playwright|browser|ui|qa|screenshot",
};

test("output starts with frontmatter containing the model", () => {
  const md = buildAgentMarkdown(agent);
  assert.ok(md.startsWith(`---\nmodel: ${agent.model}\n---`), "must start with frontmatter + model");
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

test("a regular agent (no tier) renders byte-identical frontmatter to before — no tier line", () => {
  const md = buildAgentMarkdown(agent);
  assert.equal(md, `---\nmodel: ${agent.model}\n---\n\n# ${agent.name}\n\n## Role\n${agent.role}\n\n## Keywords (for task routing)\n${agent.keywords}\n`);
  assert.ok(!md.includes("tier:"), "regular agents must not emit a tier line");
});

test("a lead-tier agent emits a `tier: lead` frontmatter line", () => {
  const leadAgent = { ...agent, id: "some-lead", name: "Some Lead", tier: "lead" as const };
  const md = buildAgentMarkdown(leadAgent);
  assert.ok(md.startsWith(`---\nmodel: ${leadAgent.model}\ntier: lead\n---`), "must emit tier: lead right after model");
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
