/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildAgentMarkdown, FOREIGN_LLM_AGENTS, agentMarkdownHasTycoonMarker } from "../src/host/vscode/packCatalog";
import { readAgentFrontmatter, parseAgentBackend } from "../src/core/agentBackend";
import { DEFAULT_AGENT_KEYWORDS } from "../src/host/vscode/agentKeywordDefaults";

const EXPECTED_BACKEND: Record<string, { vendor: string; transport: string; model: string; costModelClass: string }> = {
  "codex-reviewer": { vendor: "openai", transport: "mcp", model: "openai/gpt-6-astra", costModelClass: "subscription" },
  "gemini-reviewer": { vendor: "google", transport: "mcp", model: "google/gemini-2.5-pro", costModelClass: "metered" },
  "kimi-reviewer": { vendor: "moonshot", transport: "openai-compatible", model: "moonshot/kimi-k2", costModelClass: "local" },
  "claude-worker": { vendor: "anthropic", transport: "mcp", model: "anthropic/claude-sonnet-4-6", costModelClass: "subscription" },
};

test("FOREIGN_LLM_AGENTS has exactly the 4 expected ids", () => {
  const ids = FOREIGN_LLM_AGENTS.map((a) => a.id).sort();
  assert.deepEqual(ids, ["claude-worker", "codex-reviewer", "gemini-reviewer", "kimi-reviewer"]);
});

for (const agent of FOREIGN_LLM_AGENTS) {
  test(`buildAgentMarkdown(${agent.id}) parses via parseAgentBackend to the expected backend`, () => {
    const md = buildAgentMarkdown(agent, "multi-llm");
    const fm = readAgentFrontmatter(md);
    const backend = parseAgentBackend(fm);
    const expected = EXPECTED_BACKEND[agent.id];
    assert.equal(backend.vendor, expected.vendor);
    assert.equal(backend.transport, expected.transport);
    assert.equal(backend.model, expected.model);
    assert.equal(backend.costModelClass, expected.costModelClass);
  });

  test(`buildAgentMarkdown(${agent.id}) carries the tycoon_pack marker and full body`, () => {
    const md = buildAgentMarkdown(agent, "multi-llm");
    assert.ok(agentMarkdownHasTycoonMarker(md), "must carry tycoon_pack marker");
    assert.ok(md.includes("## Report Format"), "custom body must be rendered verbatim");
    assert.ok(md.includes(`# ${agent.name}`), "must contain H1 with name");
  });
}

const REPO_ROOT = path.resolve(__dirname, "..", "..");

test("DEFAULT_AGENT_KEYWORDS contains the 4 foreign-LLM agent ids with their catalog keywords", () => {
  const keywordsConfigPath = path.join(REPO_ROOT, ".claude", "tycoon", "agent-keywords.json");
  let fileConfig: any = null;
  try {
    fileConfig = JSON.parse(fs.readFileSync(keywordsConfigPath, "utf8"));
  } catch {
    fileConfig = null;
  }
  for (const agent of FOREIGN_LLM_AGENTS) {
    assert.equal(DEFAULT_AGENT_KEYWORDS[agent.id], agent.keywords);
    if (fileConfig && fileConfig.agents && fileConfig.agents[agent.id]) {
      assert.equal(DEFAULT_AGENT_KEYWORDS[agent.id], fileConfig.agents[agent.id].pattern);
    }
  }
});

test("media/packs/catalog.json's multi-llm pack agents render byte-identical markdown to FOREIGN_LLM_AGENTS", () => {
  const catalogPath = path.join(REPO_ROOT, "media", "packs", "catalog.json");
  const catalog: any[] = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const pack = catalog.find((p) => p.id === "multi-llm");
  assert.ok(pack, "multi-llm pack must exist in the catalog");
  const catalogIds = pack.agents.map((a: any) => a.id).sort();
  const sourceIds = FOREIGN_LLM_AGENTS.map((a) => a.id).sort();
  assert.deepEqual(catalogIds, sourceIds);
  for (const catalogAgent of pack.agents) {
    const sourceAgent = FOREIGN_LLM_AGENTS.find((a) => a.id === catalogAgent.id);
    assert.ok(sourceAgent, `FOREIGN_LLM_AGENTS must contain ${catalogAgent.id}`);
    const catalogMd = buildAgentMarkdown(catalogAgent, "multi-llm");
    const sourceMd = buildAgentMarkdown(sourceAgent!, "multi-llm");
    assert.equal(catalogMd, sourceMd, `buildAgentMarkdown output must be byte-identical for ${catalogAgent.id}`);
  }
});

test("media/packs/catalog.json ships a multi-llm pack with the 4 foreign-LLM agents", () => {
  const catalogPath = path.join(REPO_ROOT, "media", "packs", "catalog.json");
  const catalog: any[] = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const pack = catalog.find((p) => p.id === "multi-llm");
  assert.ok(pack, "multi-llm pack must exist in the catalog");
  const ids = pack.agents.map((a: any) => a.id).sort();
  assert.deepEqual(ids, ["claude-worker", "codex-reviewer", "gemini-reviewer", "kimi-reviewer"]);
  for (const a of pack.agents) {
    const md = buildAgentMarkdown(a, pack.id);
    const backend = parseAgentBackend(readAgentFrontmatter(md));
    const expected = EXPECTED_BACKEND[a.id];
    assert.equal(backend.vendor, expected.vendor);
    assert.equal(backend.model, expected.model);
  }
});
