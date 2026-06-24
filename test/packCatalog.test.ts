/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentMarkdown } from "../src/host/vscode/packCatalog";
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
