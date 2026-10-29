/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { resyncAgentFrontmatterFields, buildAgentMarkdown, FOREIGN_LLM_AGENTS, agentMarkdownHasTycoonMarker } from "../src/host/vscode/packCatalog";
import { readAgentFrontmatter, parseAgentBackend } from "../src/core/agentBackend";
import { DEFAULT_AGENT_KEYWORDS } from "../src/host/vscode/agentKeywordDefaults";

const EXPECTED_BACKEND: Record<string, { vendor: string; transport: string; model: string; costModelClass: string }> = {
  "codex-reviewer": { vendor: "openai", transport: "mcp", model: "openai/gpt-6.1-sol", costModelClass: "subscription" },
  "gemini-reviewer": { vendor: "google", transport: "mcp", model: "google/gemini-4-argon", costModelClass: "metered" },
  "kimi-reviewer": { vendor: "moonshot", transport: "openai-compatible", model: "moonshot/kimi-k2.6", costModelClass: "metered" },
  "grok-reviewer": { vendor: "xai", transport: "openai-compatible", model: "xai/grok-build-0.1", costModelClass: "metered" },
  "mistral-reviewer": { vendor: "mistral", transport: "openai-compatible", model: "mistral/mistral-large-latest", costModelClass: "metered" },
  "claude-worker": { vendor: "anthropic", transport: "mcp", model: "anthropic/sonnet", costModelClass: "subscription" },
};

test("FOREIGN_LLM_AGENTS has exactly the 6 expected ids", () => {
  const ids = FOREIGN_LLM_AGENTS.map((a) => a.id).sort();
  assert.deepEqual(ids, ["claude-worker", "codex-reviewer", "gemini-reviewer", "grok-reviewer", "kimi-reviewer", "mistral-reviewer"]);
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
  assert.deepEqual(ids, ["claude-worker", "codex-reviewer", "gemini-reviewer", "grok-reviewer", "kimi-reviewer", "mistral-reviewer"]);
  for (const a of pack.agents) {
    const md = buildAgentMarkdown(a, pack.id);
    const backend = parseAgentBackend(readAgentFrontmatter(md));
    const expected = EXPECTED_BACKEND[a.id];
    assert.equal(backend.vendor, expected.vendor);
    assert.equal(backend.model, expected.model);
  }
});

// Plan p99-t3: foreign reviewers call the dispatcher `delegate` tool. These
// phrases are the pre-existing delegation/orchestration/verdict language that
// must survive the rewrite; the check guards against any later trim.
const REVIEWER_IDS = ["codex-reviewer", "gemini-reviewer", "kimi-reviewer", "grok-reviewer", "mistral-reviewer"];
const RETAINED_LINES = [
  "It must never review a change it authored itself (project rule: a change is always verified by someone other than its author).",
  "the orchestrator (or a wiring layer) owns any retry policy.",
  "## Recognizing a provider failure vs. a review outcome",
  "## Structured verdict shape",
  "verdict: approve | changes-requested | provider-unavailable",
  "`findings` is empty when `verdict` is `approve`.",
  "never silently upgrade an unreachable or quota-exhausted",
  "Under 250 words. Do not invite a follow-up review round — this is one pass.",
];

for (const id of REVIEWER_IDS) {
  test(`${id} body calls mcp__tycoon__delegate with a documented fallback and keeps its verdict/failure sections`, () => {
    const agent = FOREIGN_LLM_AGENTS.find((a) => a.id === id)!;
    const md = buildAgentMarkdown(agent, "multi-llm");
    assert.ok(md.includes("## Calling through the dispatcher (when available)"));
    assert.ok(md.includes("`mcp__tycoon__delegate`"));
    assert.ok(md.includes(`\`specialist: "${id}"\``), "must pass its own id as specialist");
    assert.ok(md.includes("`task`"), "must carry the review request in task");
    assert.ok(md.includes("is not available in this session (dispatcher not installed)"), "documented fallback to the vendor tool");
    assert.ok(md.includes("never calls reviewer MCP tools directly"), "orchestrator rule stated");
    for (const status of ["provider_error", "timeout", "empty", "chain_exhausted"]) {
      assert.ok(md.includes(status), `failure section must name ${status}`);
    }
    assert.ok(md.includes("never re-dispatch"), "must forbid re-dispatch after the chain was exhausted");
    assert.ok(md.includes("Delegate result is final - no direct call after delegate."), "delegate-result-is-final rule");
    assert.ok(md.includes('"Not available" means ONLY that the `mcp__tycoon__delegate` tool is absent'), "unavailable defined narrowly");
    assert.ok(md.includes("make NO further model calls (no direct vendor tool, no retry, no second delegate)"), "no direct call after delegate");
    for (const line of RETAINED_LINES) {
      assert.ok(md.includes(line), `retained delegation/verdict language missing: ${line}`);
    }
    // Hook attribution (hooks/tycoon-claude-hook.cjs isDispatcherRoutedAgent) reads this file.
    assert.ok(/mcp__tycoon(?:-dispatcher)?__delegate/.test(md));
    // Direct-tool backend frontmatter stays valid for the fallback path.
    const backend = parseAgentBackend(readAgentFrontmatter(md));
    assert.equal(backend.vendor, EXPECTED_BACKEND[id].vendor);
  });
}

test("codex-reviewer keeps the explicit read-only sandbox and approval-policy requirement on the direct path", () => {
  const agent = FOREIGN_LLM_AGENTS.find((a) => a.id === "codex-reviewer")!;
  const md = buildAgentMarkdown(agent, "multi-llm");
  assert.ok(md.includes('- `sandbox: "read-only"`'));
  assert.ok(md.includes('- `approval-policy: "never"`'));
});

for (const id of ["codex-reviewer", "gemini-reviewer", "kimi-reviewer"]) {
  test(`.claude/agents/${id}.md (when present) references the delegate tool and keeps retained language`, (t) => {
    const p = path.join(REPO_ROOT, ".claude", "agents", `${id}.md`);
    if (!fs.existsSync(p)) {
      t.skip(".claude/ is gitignored; local agent file absent");
      return;
    }
    const md = fs.readFileSync(p, "utf8");
    assert.ok(md.includes("`mcp__tycoon__delegate`"));
    for (const line of RETAINED_LINES) {
      assert.ok(md.includes(line), `retained language missing in ${id}.md: ${line}`);
    }
  });
}

const WRAPPER_CLASS: Record<string, { cls: "relay" | "judge"; model: string }> = {
  "codex-reviewer": { cls: "relay", model: "haiku" },
  "gemini-reviewer": { cls: "relay", model: "haiku" },
  "kimi-reviewer": { cls: "relay", model: "haiku" },
  "grok-reviewer": { cls: "relay", model: "haiku" },
  "mistral-reviewer": { cls: "relay", model: "haiku" },
  "claude-worker": { cls: "judge", model: "sonnet" },
};

test("every foreign wrapper agent records a relay/judge classification and its wrapper model matches it", () => {
  for (const agent of FOREIGN_LLM_AGENTS) {
    const expected = WRAPPER_CLASS[agent.id];
    assert.ok(expected, `unclassified foreign agent ${agent.id}`);
    assert.equal(agent.model, expected.model, `${agent.id} wrapper model`);
    assert.ok(
      (agent.body ?? "").includes(`<!-- wrapper-class: ${expected.cls} - `),
      `${agent.id} body missing wrapper-class: ${expected.cls} comment`
    );
  }
});

const LEGACY_DENYLIST = "Agent, Read, Write, Edit, MultiEdit, NotebookEdit, Glob, Grep, Bash, PowerShell, WebFetch, WebSearch";

test("claude-worker frontmatter disallows only Agent (no tools allowlist), like every other agent", () => {
  for (const a of FOREIGN_LLM_AGENTS) {
    const front = buildAgentMarkdown(a, "multi-llm").split("---")[1];
    assert.match(front, /^disallowedTools: Agent$/m, a.id);
    assert.doesNotMatch(front, /^tools:/m, a.id);
  }
});

test("resyncAgentFrontmatterFields migrates the legacy denylist to Agent only for marked claude-worker files with the Which route body", () => {
  const worker = FOREIGN_LLM_AGENTS.find((a) => a.id === "claude-worker")!;
  const current = buildAgentMarkdown(worker, "multi-llm");
  assert.match(current, /^## Which route/m);
  const old = current.replace(/^disallowedTools: .*$/m, "disallowedTools: " + LEGACY_DENYLIST);
  const fixed = resyncAgentFrontmatterFields(old, worker);
  assert.ok(fixed);
  assert.match(fixed!, /^disallowedTools: Agent$/m);
  assert.equal(resyncAgentFrontmatterFields(fixed!, worker), null);
  // A user-edited old body (no "## Which route") keeps its denylist.
  const oldBody = old.replace(/^## Which route\r?\n[\s\S]*?(?=^## )/m, "");
  assert.equal(resyncAgentFrontmatterFields(oldBody, worker), null);
  const unmarked = old.replace(/^tycoon_pack: .*\r?\n/m, "");
  assert.equal(resyncAgentFrontmatterFields(unmarked, worker), null);
});

test("kimi-reviewer uses the dedicated MOONSHOT_* env names, never OPENAI_COMPAT_*", () => {
  const kimi = FOREIGN_LLM_AGENTS.find((a) => a.id === "kimi-reviewer")!;
  assert.equal(kimi.backend!.endpointEnv, "MOONSHOT_BASE_URL");
  assert.equal(kimi.backend!.apiKeyEnv, "MOONSHOT_API_KEY");
});

test("resyncAgentFrontmatterFields: customized or block-list disallowedTools is left alone; the legacy denylist upgrades to Agent for claude-worker only", () => {
  const worker = FOREIGN_LLM_AGENTS.find((a) => a.id === "claude-worker")!;
  const base = buildAgentMarkdown(worker, "multi-llm");
  const custom = base.replace(/^disallowedTools: .*$/m, "disallowedTools: Agent, Bash");
  assert.equal(resyncAgentFrontmatterFields(custom, worker), null);
  const block = base.replace(/^disallowedTools: .*$/m, "disallowedTools:\n  - Agent\n  - Bash");
  assert.equal(resyncAgentFrontmatterFields(block, worker), null);
  const legacy = base.replace(/^disallowedTools: .*$/m, "disallowedTools: " + LEGACY_DENYLIST);
  assert.match(resyncAgentFrontmatterFields(legacy, worker)!, /^disallowedTools: Agent$/m);
  assert.equal(resyncAgentFrontmatterFields(base, worker), null);
  const kimi = FOREIGN_LLM_AGENTS.find((a) => a.id === "kimi-reviewer")!;
  const kimiMd = buildAgentMarkdown(kimi, "multi-llm").replace(/^disallowedTools: .*$/m, "disallowedTools: Agent, Bash");
  assert.equal(resyncAgentFrontmatterFields(kimiMd, kimi), null);
  const kimiLegacy = buildAgentMarkdown(kimi, "multi-llm").replace(/^disallowedTools: .*\r?\n/m, "");
  assert.equal(resyncAgentFrontmatterFields(kimiLegacy, kimi), null);
});
