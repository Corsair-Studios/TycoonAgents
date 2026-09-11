/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Tests hooks/codexRouting.cjs's pure resolveCodexSpecialist against the
// four acceptance-criteria cases from plan p22-t5: explicit-name routing,
// keyword routing, fallback selection, and nested-delegation blocking under
// Codex — plus the vendor gate producing a ProviderError instead of
// silently substituting another model.

import { test } from "node:test";
import assert from "node:assert/strict";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const codexRouting = require("../../hooks/codexRouting.cjs") as {
  resolveCodexSpecialist: (ctx: {
    toolInput: Record<string, unknown>;
    activeAgentStack?: Array<{ agentId: string }>;
    keywordsConfig?: { agents: Record<string, { pattern: string }>; fallback_agent?: string };
    knownAgentIds?: Set<string>;
    vendorOf?: (id: string) => { vendor?: string; model?: string } | undefined;
    dispatcherConfigured?: boolean;
  }) => {
    workerId: string | null;
    source: string;
    denied: boolean;
    reason?: string;
    message?: string;
    matchedKeyword?: string;
    providerError?: Record<string, unknown>;
  };
  matchAgentFromKeywords: (
    description: string,
    keywordsConfig: { agents: Record<string, { pattern: string }> },
    promptText?: string,
  ) => { agentId: string; matchedKeyword: string } | null;
};

const KNOWN_AGENT_IDS = new Set([
  "coding-specialist",
  "testing-specialist",
  "search-retrieval",
  "codex-reviewer",
  "gemini-reviewer",
  "primary-agent",
]);

const KEYWORDS_CONFIG = {
  fallback_agent: "primary-agent",
  agents: {
    "coding-specialist": { pattern: "implement|code|fix|bug|refactor" },
    "testing-specialist": { pattern: "test|spec|vitest|coverage" },
    "codex-reviewer": { pattern: "codex|foreign-review|cross-vendor" },
  },
};

const VENDOR_MAP: Record<string, { vendor: string; model: string }> = {
  "coding-specialist": { vendor: "anthropic", model: "sonnet" },
  "testing-specialist": { vendor: "anthropic", model: "sonnet" },
  "search-retrieval": { vendor: "anthropic", model: "haiku" },
  "codex-reviewer": { vendor: "openai", model: "gpt-6-astra" },
  "gemini-reviewer": { vendor: "google", model: "gemini-2.5-pro" },
  "primary-agent": { vendor: "anthropic", model: "haiku" },
};

function baseCtx(overrides: Record<string, unknown> = {}) {
  return {
    toolInput: {},
    activeAgentStack: [],
    keywordsConfig: KEYWORDS_CONFIG,
    knownAgentIds: KNOWN_AGENT_IDS,
    vendorOf: (id: string) => VENDOR_MAP[id],
    dispatcherConfigured: false,
    ...overrides,
  };
}

test("explicit-name routing: toolInput.name exact match wins outright", () => {
  const result = codexRouting.resolveCodexSpecialist(
    baseCtx({ toolInput: { name: "codex-reviewer", description: "run a test suite" } }),
  );
  assert.equal(result.denied, false);
  assert.equal(result.workerId, "codex-reviewer");
  assert.equal(result.source, "explicit");
});

test("explicit-name routing: description prefix 'agent-id:' wins over keyword content in the same description", () => {
  const result = codexRouting.resolveCodexSpecialist(
    baseCtx({
      toolInput: { description: "coding-specialist: run the test suite and fix bugs" },
      dispatcherConfigured: true,
    }),
  );
  assert.equal(result.denied, false);
  assert.equal(result.workerId, "coding-specialist");
  assert.equal(result.source, "explicit");
});

test("explicit-name routing: AGENT:<id> marker in the full prompt", () => {
  const result = codexRouting.resolveCodexSpecialist(
    baseCtx({
      toolInput: { description: "generic task", prompt: "do the work. AGENT:testing-specialist" },
      dispatcherConfigured: true,
    }),
  );
  assert.equal(result.denied, false);
  assert.equal(result.workerId, "testing-specialist");
  assert.equal(result.source, "explicit");
});

test("keyword routing: description keywords select the matching specialist when no explicit id is given", () => {
  const result = codexRouting.resolveCodexSpecialist(
    baseCtx({ toolInput: { description: "fix the bug in the login flow" }, dispatcherConfigured: true }),
  );
  assert.equal(result.denied, false);
  assert.equal(result.workerId, "coding-specialist");
  assert.equal(result.source, "keyword");
});

test("keyword routing: description weighs above prompt body so an unrelated prompt keyword can't outrank it", () => {
  const result = codexRouting.resolveCodexSpecialist(
    baseCtx({
      toolInput: {
        description: "fix a bug",
        prompt: "also run the test suite afterward, coverage matters, vitest included",
      },
    }),
  );
  assert.equal(result.workerId, "coding-specialist");
});

test("fallback selection: no explicit id, no keyword match -> keywordsConfig.fallback_agent", () => {
  const result = codexRouting.resolveCodexSpecialist(
    baseCtx({
      toolInput: { description: "do something entirely unrelated to any keyword" },
      dispatcherConfigured: true,
    }),
  );
  assert.equal(result.denied, false);
  assert.equal(result.workerId, "primary-agent");
  assert.equal(result.source, "fallback");
});

test("fallback selection: no match and no fallback_agent configured -> denied no-match", () => {
  const result = codexRouting.resolveCodexSpecialist(
    baseCtx({
      toolInput: { description: "do something entirely unrelated to any keyword" },
      keywordsConfig: { agents: KEYWORDS_CONFIG.agents },
    }),
  );
  assert.equal(result.denied, true);
  assert.equal(result.reason, "no-match");
  assert.equal(result.workerId, null);
});

test("nested-delegation blocking under Codex: a non-empty activeAgentStack always denies, regardless of explicit name", () => {
  const result = codexRouting.resolveCodexSpecialist(
    baseCtx({
      toolInput: { name: "coding-specialist" },
      activeAgentStack: [{ agentId: "coding-specialist" }],
    }),
  );
  assert.equal(result.denied, true);
  assert.equal(result.reason, "nested-delegation");
  assert.ok(result.message && /leaf worker/i.test(result.message));
});

test("vendor gate: a non-OpenAI specialist is denied with a ProviderError, never silently substituted", () => {
  const result = codexRouting.resolveCodexSpecialist(
    baseCtx({ toolInput: { name: "coding-specialist" } }),
  );
  assert.equal(result.denied, true);
  assert.equal(result.reason, "specialist-unavailable");
  assert.ok(result.providerError);
  assert.equal(result.providerError!.event, "ProviderError");
  assert.equal(result.providerError!.provider, "codex");
  assert.equal(result.providerError!.reason, "specialist-unavailable");
  assert.equal(result.providerError!.workerId, "coding-specialist");
  assert.equal(result.providerError!.vendor, "anthropic");
});

test("vendor gate: an OpenAI specialist (codex-reviewer) is allowed through", () => {
  const result = codexRouting.resolveCodexSpecialist(
    baseCtx({ toolInput: { name: "codex-reviewer" } }),
  );
  assert.equal(result.denied, false);
  assert.equal(result.workerId, "codex-reviewer");
});

test("vendor gate: dispatcherConfigured=true allows a non-OpenAI specialist through instead of denying", () => {
  const result = codexRouting.resolveCodexSpecialist(
    baseCtx({ toolInput: { name: "coding-specialist" }, dispatcherConfigured: true }),
  );
  assert.equal(result.denied, false);
  assert.equal(result.workerId, "coding-specialist");
});

test("unknown explicit name/id falls through to keyword/fallback routing rather than being accepted blind", () => {
  const result = codexRouting.resolveCodexSpecialist(
    baseCtx({ toolInput: { name: "not-a-real-agent", description: "fix a bug" }, dispatcherConfigured: true }),
  );
  assert.equal(result.workerId, "coding-specialist");
  assert.equal(result.source, "keyword");
});
