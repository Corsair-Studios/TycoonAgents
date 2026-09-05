/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentBackend, readAgentFrontmatter } from "../src/core/agentBackend";

test("parseAgentBackend: no backend block defaults to anthropic claude-native metered, resolving the top-level model alias", () => {
  const result = parseAgentBackend({ model: "sonnet" });
  assert.deepEqual(result, {
    vendor: "anthropic",
    transport: "claude-native",
    model: "anthropic/sonnet",
    costModelClass: "metered",
  });
});

test("parseAgentBackend: no backend block, slashed top-level model (openai/gpt-5.4-mini) is kept verbatim with vendor derived from its prefix", () => {
  const result = parseAgentBackend({ model: "openai/gpt-5.4-mini" });
  assert.deepEqual(result, {
    vendor: "openai",
    transport: "claude-native",
    model: "openai/gpt-5.4-mini",
    costModelClass: "metered",
  });
});

test("parseAgentBackend: no backend block, slashed top-level model with an anthropic prefix does not double-prefix", () => {
  const result = parseAgentBackend({ model: "anthropic/claude-sonnet-4-6" });
  assert.deepEqual(result, {
    vendor: "anthropic",
    transport: "claude-native",
    model: "anthropic/claude-sonnet-4-6",
    costModelClass: "metered",
  });
});

test("parseAgentBackend: no backend block, slashed top-level model with an unrecognized vendor prefix uses that prefix as vendor", () => {
  const result = parseAgentBackend({ model: "moonshot/kimi-k2" });
  assert.equal(result.vendor, "moonshot");
  assert.equal(result.model, "moonshot/kimi-k2");
});

test("parseAgentBackend: no backend block and no model falls back to 'unknown'", () => {
  const result = parseAgentBackend({});
  assert.equal(result.model, "anthropic/unknown");
  assert.equal(result.vendor, "anthropic");
  assert.equal(result.transport, "claude-native");
  assert.equal(result.costModelClass, "metered");
});

test("parseAgentBackend: claude-native transport with explicit backend fields", () => {
  const result = parseAgentBackend({
    model: "opus",
    backend: { transport: "claude-native", costModelClass: "metered" },
  });
  assert.equal(result.transport, "claude-native");
  assert.equal(result.vendor, "anthropic");
  assert.equal(result.model, "opus");
  assert.equal(result.costModelClass, "metered");
});

test("parseAgentBackend: mcp transport with mcpServer and tools", () => {
  const result = parseAgentBackend({
    model: "gpt-5.4-mini",
    backend: {
      vendor: "openai",
      transport: "mcp",
      mcpServer: "codex",
      tools: ["chat", "review"],
      model: "openai/gpt-5.4-mini",
      costModelClass: "subscription",
    },
  });
  assert.deepEqual(result, {
    vendor: "openai",
    transport: "mcp",
    mcpServer: "codex",
    tools: ["chat", "review"],
    model: "openai/gpt-5.4-mini",
    costModelClass: "subscription",
  });
});

test("parseAgentBackend: openai-compatible transport with endpointEnv and apiKeyEnv", () => {
  const result = parseAgentBackend({
    backend: {
      vendor: "kimi",
      transport: "openai-compatible",
      model: "moonshot/kimi-k2",
      costModelClass: "metered",
      endpointEnv: "OPENAI_COMPAT_BASE_URL",
      apiKeyEnv: "OPENAI_COMPAT_API_KEY",
    },
  });
  assert.equal(result.transport, "openai-compatible");
  assert.equal(result.endpointEnv, "OPENAI_COMPAT_BASE_URL");
  assert.equal(result.apiKeyEnv, "OPENAI_COMPAT_API_KEY");
  assert.equal(result.costModelClass, "metered");
});

test("parseAgentBackend: invalid transport is rejected with a message naming the allowed values", () => {
  assert.throws(
    () =>
      parseAgentBackend({
        model: "x",
        backend: { transport: "carrier-pigeon", costModelClass: "metered" },
      }),
    /Invalid backend\.transport.*claude-native, mcp, openai-compatible/s,
  );
});

test("parseAgentBackend: invalid costModelClass is rejected with a message naming the allowed values", () => {
  assert.throws(
    () =>
      parseAgentBackend({
        model: "x",
        backend: { transport: "claude-native", costModelClass: "free-forever" },
      }),
    /Invalid backend\.costModelClass.*metered, subscription, local/s,
  );
});

test("parseAgentBackend: mcp transport without mcpServer is rejected", () => {
  assert.throws(
    () =>
      parseAgentBackend({
        model: "x",
        backend: { transport: "mcp", costModelClass: "metered" },
      }),
    /transport 'mcp' requires `mcpServer`/,
  );
});

test("parseAgentBackend: openai-compatible transport without endpointEnv is rejected", () => {
  assert.throws(
    () =>
      parseAgentBackend({
        model: "x",
        backend: { transport: "openai-compatible", costModelClass: "metered" },
      }),
    /transport 'openai-compatible' requires `endpointEnv`/,
  );
});

test("parseAgentBackend: backend block missing model, and no top-level model, is rejected", () => {
  assert.throws(
    () => parseAgentBackend({ backend: { transport: "claude-native", costModelClass: "metered" } }),
    /`model` is required/,
  );
});

test("readAgentFrontmatter: parses a backend sub-block with a list field", () => {
  const md = `---
name: codex-reviewer
model: sonnet
backend:
  vendor: openai
  transport: mcp
  mcpServer: codex
  tools: [chat, review]
  costModelClass: subscription
---
Body text here.
`;
  const fm = readAgentFrontmatter(md);
  assert.equal(fm.name, "codex-reviewer");
  assert.equal(fm.model, "sonnet");
  assert.deepEqual(fm.backend, {
    vendor: "openai",
    transport: "mcp",
    mcpServer: "codex",
    tools: ["chat", "review"],
    costModelClass: "subscription",
  });
});

test("readAgentFrontmatter: no frontmatter block returns an empty object", () => {
  assert.deepEqual(readAgentFrontmatter("just body text, no frontmatter"), {});
});

test("readAgentFrontmatter: CRLF line endings parse identically to LF", () => {
  const lf = `---
name: codex-reviewer
model: sonnet
backend:
  vendor: openai
  transport: mcp
  mcpServer: codex
  tools: [chat, review]
  costModelClass: subscription
---
Body text here.
`;
  const crlf = lf.replace(/\n/g, "\r\n");
  const fmLf = readAgentFrontmatter(lf);
  const fmCrlf = readAgentFrontmatter(crlf);
  assert.deepEqual(fmCrlf, fmLf);
  assert.equal(fmCrlf.name, "codex-reviewer");
  assert.equal(fmCrlf.model, "sonnet");
  assert.deepEqual(fmCrlf.backend, {
    vendor: "openai",
    transport: "mcp",
    mcpServer: "codex",
    tools: ["chat", "review"],
    costModelClass: "subscription",
  });
});

test("readAgentFrontmatter: BOM + CRLF parses correctly", () => {
  const lf = `---
name: codex-reviewer
model: sonnet
backend:
  vendor: openai
  transport: mcp
  mcpServer: codex
  tools: [chat, review]
  costModelClass: subscription
---
Body text here.
`;
  const bomCrlf = "﻿" + lf.replace(/\n/g, "\r\n");
  const fm = readAgentFrontmatter(bomCrlf);
  assert.equal(fm.name, "codex-reviewer");
  assert.equal(fm.model, "sonnet");
  assert.deepEqual(fm.backend, {
    vendor: "openai",
    transport: "mcp",
    mcpServer: "codex",
    tools: ["chat", "review"],
    costModelClass: "subscription",
  });
});
