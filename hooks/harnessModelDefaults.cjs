"use strict";
/*
 * TycoonAgents - https://x.com/thetrashbyrd
 *
 * Per-harness default models. Specialist agent files carry Claude tier aliases
 * (haiku|sonnet|opus|fable); on the Codex harness those map to OpenAI ids.
 * Mirrored in src/core/harnessModelDefaults.ts (a parity test requires this file).
 */

const CODEX_TIER_MODELS = {
  haiku: { model: "gpt-5.6-sol", effort: "low" },
  sonnet: { model: "gpt-5.6-sol" },
  opus: { model: "gpt-6-astra" },
  fable: { model: "gpt-6-astra" },
};

const TIERS = ["haiku", "sonnet", "opus", "fable"];

function classifyTier(model) {
  const m = String(model || "").toLowerCase();
  for (const t of TIERS) if (m.includes(t)) return t;
  return "sonnet";
}

function bareId(model) {
  return String(model || "").trim().replace(/^openai\//i, "");
}

function stripVendor(model) {
  return String(model || "").trim();
}

/**
 * @param {string} harness "codex" or anything else (returned unchanged)
 * backendMcpServer (optional extra): a backend that names a non-Codex MCP server (claude-cli) is kept as-is.
 * @param {{frontmatterModel?:string, backendVendor?:string, backendMcpServer?:string, routingSlot?:{vendor?:string, model?:string}}} agent
 */
function resolveHarnessDefault(harness, agent) {
  const a = agent || {};
  const slot = a.routingSlot || undefined;
  const backendVendor = a.backendVendor ? String(a.backendVendor).trim() : "";
  const fm = stripVendor(a.frontmatterModel);

  if (harness !== "codex") {
    if (slot && (slot.vendor || slot.model)) {
      return { vendor: slot.vendor || backendVendor || "anthropic", model: slot.model || fm || undefined, source: "explicit" };
    }
    return { vendor: backendVendor || "anthropic", model: fm || undefined, source: "agent-vendor" };
  }

  if (slot && (slot.vendor || slot.model)) {
    const out = { vendor: slot.vendor || backendVendor || "openai", model: slot.model || fm || undefined, source: "explicit" };
    return out;
  }
  if (backendVendor && backendVendor.toLowerCase() !== "anthropic") {
    return { vendor: backendVendor, model: fm || undefined, source: "agent-vendor" };
  }
  const mcpServer = a.backendMcpServer ? String(a.backendMcpServer).trim().toLowerCase() : "";
  if (mcpServer && mcpServer !== "codex") {
    return { vendor: backendVendor || "anthropic", model: fm || undefined, source: "agent-vendor" };
  }
  if (/^(openai\/)?gpt-/i.test(fm)) {
    return { vendor: "openai", model: bareId(fm), source: "harness-default" };
  }
  const tier = CODEX_TIER_MODELS[classifyTier(fm)];
  const out = { vendor: "openai", model: tier.model, source: "harness-default" };
  if (tier.effort) out.effort = tier.effort;
  return out;
}

module.exports = { CODEX_TIER_MODELS, resolveHarnessDefault };
