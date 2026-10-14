/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Regression: a user's extra section (e.g. "## Report Format") appended to an
// installed agent file must survive every panel-open heal byte-for-byte. The
// discipline heal used to replace everything from "## Working discipline" to
// EOF, wiping any section placed after it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentMarkdown,
  resyncAgentDisciplineSection,
  resyncAgentFrontmatterFields,
  resyncAgentRoleSection,
  healSupersededAgentTitle,
  refreshSupersededKeywordsBody,
  healLegacyOfficeAgentsFrontmatter,
  healClaudeWorkerBody,
  regenerateAgentMarkdownKeepingExtras,
  REGULAR_AGENTS,
  REVIEWER_AGENTS,
  SUPERSEDED_ROLES,
  SUPERSEDED_DEFAULT_KEYWORDS,
  WORKING_DISCIPLINE_BODY,
  WORKING_DISCIPLINE_READ_ONLY_BODY,
} from "../src/host/vscode/packCatalog";

const EXTRA = "## Report Format\n\nReturn: outcome, file:line, verification.\n- keep it under 200 words\n";

function allHeals(content: string, agent: (typeof REGULAR_AGENTS)[number]): string {
  let next = content;
  next = resyncAgentFrontmatterFields(next, agent) ?? next;
  next = resyncAgentRoleSection(next, agent.role, agent.id) ?? next;
  next = healSupersededAgentTitle(next, agent) ?? next;
  next = refreshSupersededKeywordsBody(next, agent.id, agent.keywords) ?? next;
  next = healLegacyOfficeAgentsFrontmatter(next, agent.id, agent.role) ?? next;
  next = healClaudeWorkerBody(next) ?? next;
  if (agent.id !== "orchestrator") next = resyncAgentDisciplineSection(next);
  return next;
}

test("every panel-open heal keeps a user's trailing section byte-for-byte", () => {
  for (const agent of [...REGULAR_AGENTS.filter((a) => a.id !== "orchestrator"), ...REVIEWER_AGENTS]) {
    const installed = buildAgentMarkdown(agent, "worker") + "\n" + EXTRA;
    const healed = allHeals(installed, agent);
    assert.equal(healed, installed, `${agent.id}: heal must not change a current file with an extra section`);
    assert.ok(healed.endsWith(EXTRA), `${agent.id}: extra section survives`);
  }
});

test("a stale shipped discipline body is refreshed without touching the section after it", () => {
  const agent = REGULAR_AGENTS.find((a) => a.id === "coding-specialist")!;
  const v2 = WORKING_DISCIPLINE_BODY.split("\n").slice(0, 5).join("\n");
  const stale = buildAgentMarkdown(agent, "worker").replace(WORKING_DISCIPLINE_BODY, v2) + "\n" + EXTRA;
  const healed = resyncAgentDisciplineSection(stale);
  assert.ok(healed.includes(WORKING_DISCIPLINE_BODY));
  assert.ok(healed.endsWith("\n" + EXTRA));
});

test("the read-only variant swap keeps the section after it", () => {
  const search = REGULAR_AGENTS.find((a) => a.id === "search-retrieval")!;
  const old = buildAgentMarkdown(search, "worker").replace(WORKING_DISCIPLINE_READ_ONLY_BODY, WORKING_DISCIPLINE_BODY) + "\n" + EXTRA;
  const healed = resyncAgentDisciplineSection(old);
  assert.ok(healed.includes(WORKING_DISCIPLINE_READ_ONLY_BODY));
  assert.ok(healed.endsWith("\n" + EXTRA));
});

test("a user section placed before the discipline section and CRLF files survive too", () => {
  const agent = REGULAR_AGENTS.find((a) => a.id === "testing-specialist")!;
  const base = buildAgentMarkdown(agent, "worker");
  const before = base.replace("## Working discipline", EXTRA + "\n## Working discipline");
  assert.equal(resyncAgentDisciplineSection(before), before);
  const crlf = (base + "\n" + EXTRA).replace(/\n/g, "\r\n");
  assert.equal(resyncAgentDisciplineSection(crlf), crlf, "CRLF file is not duplicated or rewritten");
});

test("an edited discipline section is left alone", () => {
  const agent = REGULAR_AGENTS.find((a) => a.id === "vscode-integration")!;
  const edited = buildAgentMarkdown(agent, "worker").replace("- You are a LEAF", "- My own rule. You are a LEAF") + "\n" + EXTRA;
  assert.equal(resyncAgentDisciplineSection(edited), edited);
});

test("regenerateAgentMarkdownKeepingExtras re-installs the template but keeps unknown sections, idempotently", () => {
  const agent = REGULAR_AGENTS.find((a) => a.id === "ux-ui-designer")!;
  const generated = buildAgentMarkdown(agent, "worker");
  const existing = generated.replace(agent.role, "tampered role") + "\n" + EXTRA;
  const merged = regenerateAgentMarkdownKeepingExtras(existing, generated);
  assert.ok(merged.includes(agent.role));
  assert.ok(merged.endsWith("\n" + EXTRA));
  assert.equal(regenerateAgentMarkdownKeepingExtras(merged, generated), merged);
  assert.equal(regenerateAgentMarkdownKeepingExtras(generated, generated), generated);
});

test("a user-edited Role survives the role heal; a superseded shipped role is still upgraded", () => {
  const agent = REGULAR_AGENTS.find((a) => a.id === "ux-ui-designer")!;
  const base = buildAgentMarkdown(agent, "worker");
  const edited = base.replace("## Role\n" + agent.role, "## Role\nMy own role wording.");
  assert.equal(resyncAgentRoleSection(edited, agent.role, agent.id), edited);
  assert.equal(resyncAgentRoleSection(edited, agent.role), edited, "no agent id: never replaces");
  const prior = SUPERSEDED_ROLES["ux-ui-designer"][0];
  const old = base.replace("## Role\n" + agent.role, "## Role\n" + prior);
  assert.equal(resyncAgentRoleSection(old, agent.role, agent.id), base);
});

test("silent re-stage keeps an edited Keywords/Role/discipline section, and upgrades an exactly-shipped one", () => {
  const agent = REGULAR_AGENTS.find((a) => a.id === "coding-specialist")!;
  const generated = buildAgentMarkdown(agent, "worker");
  const edited = generated.replace(agent.keywords, "implement|code|my-own-word").replace(agent.role, "Custom role.") + "\n" + EXTRA;
  assert.equal(regenerateAgentMarkdownKeepingExtras(edited, generated, { silent: true }), edited);
  const v2 = WORKING_DISCIPLINE_BODY.split("\n").slice(0, 5).join("\n");
  const old = generated.replace(WORKING_DISCIPLINE_BODY, v2);
  assert.equal(regenerateAgentMarkdownKeepingExtras(old, generated, { silent: true }), generated);
  const prior = SUPERSEDED_DEFAULT_KEYWORDS["web-qa"][0];
  const web = { ...agent, id: "web-qa", keywords: "qa|web" };
  const wGen = buildAgentMarkdown(web, "worker");
  assert.equal(regenerateAgentMarkdownKeepingExtras(wGen.replace(web.keywords, prior), wGen, { silent: true }), wGen);
});

test("extras keep their position, a renamed heading is not duplicated, fenced ## is not split", () => {
  const agent = REGULAR_AGENTS.find((a) => a.id === "testing-specialist")!;
  const generated = buildAgentMarkdown(agent, "worker");
  const middle = generated.replace("## Keywords (for task routing)", EXTRA + "\n## Keywords (for task routing)");
  const merged = regenerateAgentMarkdownKeepingExtras(middle, generated);
  assert.equal(merged, middle, "extra stays between Role and Keywords");
  assert.ok(merged.indexOf("## Report Format") < merged.indexOf("## Keywords"));

  const renamed = generated.replace("## Role", "## My Role");
  const r = regenerateAgentMarkdownKeepingExtras(renamed, generated);
  assert.equal(r, renamed);
  assert.equal((r.match(/^## (My )?Role$/gm) ?? []).length, 1);

  const fenced = generated + "\n## Notes\n\n```md\n## Working discipline\nnot a heading\n```\n";
  const f = regenerateAgentMarkdownKeepingExtras(fenced, generated);
  assert.equal(f, fenced);
});
