/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Harness model defaults (panel side). On the Codex harness, specialists whose
// agent file names a Claude tier (`model: haiku|sonnet|opus|fable`) and that
// have no explicit user choice run on Codex models. The dispatcher runtime
// owns hooks/harnessModelDefaults.cjs; this file is the SAME table and
// resolver in TypeScript so the UI shows exactly what will run. A parity test
// (test/core/harnessModelDefaults.test.ts) requires the .cjs and compares.
// Display only: nothing here is ever written into routing.json.
// ---------------------------------------------------------------------------

export type ClaudeTierName = "haiku" | "sonnet" | "opus" | "fable";

export interface HarnessTierModel {
  model: string;
  effort?: string;
}

export const CODEX_TIER_MODELS: Readonly<Record<ClaudeTierName, HarnessTierModel>> = {
  haiku: { model: "gpt-5.6-sol", effort: "low" },
  sonnet: { model: "gpt-5.6-sol" },
  opus: { model: "gpt-6-astra" },
  fable: { model: "gpt-6-astra" },
};

export type HarnessDefaultSource = "explicit" | "harness-default" | "agent-vendor";

export interface HarnessAgentInput {
  /** The agent file's top-level `model:` value (alias or id), if any. */
  frontmatterModel?: string | null;
  /** Vendor of a hand-written `backend:` block in the agent file, if any. */
  backendVendor?: string | null;
  /** MCP server name of a hand-written `backend:` block (a non-Codex server, e.g. claude-cli, is kept). */
  backendMcpServer?: string | null;
  /** The routing.json slot (agents[id] or defaults) resolved for this agent, if any. */
  routingSlot?: { vendor?: string | null; model?: string | null } | null;
}

export interface HarnessResolved {
  vendor: string;
  model: string;
  effort?: string;
  source: HarnessDefaultSource;
}

const TIERS: readonly ClaudeTierName[] = ["haiku", "sonnet", "opus", "fable"];

function classifyTier(model: string): ClaudeTierName {
  const m = model.toLowerCase();
  for (const t of TIERS) if (m.includes(t)) return t;
  return "sonnet";
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Mirrors hooks/harnessModelDefaults.cjs resolveHarnessDefault (keep in step;
 * test/harnessModelDefaults.test.ts asserts parity). Off Codex the agent is
 * returned unchanged. On Codex: an explicit routing slot wins; a non-Anthropic
 * backend vendor or a non-Codex MCP backend (claude-worker) is kept; gpt-*
 * frontmatter passes through; a Claude tier alias maps to the Codex tier
 * table; unknown/inherit falls to the sonnet tier.
 */
export function resolveHarnessDefault(harness: string, agent: HarnessAgentInput): HarnessResolved {
  const a = agent || {};
  const slot = a.routingSlot || undefined;
  const slotVendor = str(slot?.vendor);
  const slotModel = str(slot?.model);
  const backendVendor = str(a.backendVendor);
  const fm = str(a.frontmatterModel);

  if (harness !== "codex") {
    if (slotVendor || slotModel) {
      return { vendor: slotVendor || backendVendor || "anthropic", model: slotModel || fm, source: "explicit" };
    }
    return { vendor: backendVendor || "anthropic", model: fm, source: "agent-vendor" };
  }
  if (slotVendor || slotModel) {
    return { vendor: slotVendor || backendVendor || "openai", model: slotModel || fm, source: "explicit" };
  }
  if (backendVendor && backendVendor.toLowerCase() !== "anthropic") {
    return { vendor: backendVendor, model: fm, source: "agent-vendor" };
  }
  const mcpServer = str(a.backendMcpServer).toLowerCase();
  if (mcpServer && mcpServer !== "codex") {
    return { vendor: backendVendor || "anthropic", model: fm, source: "agent-vendor" };
  }
  if (/^(openai\/)?gpt-/i.test(fm)) {
    return { vendor: "openai", model: fm.replace(/^openai\//i, ""), source: "harness-default" };
  }
  const tier = CODEX_TIER_MODELS[classifyTier(fm)];
  return {
    vendor: "openai",
    model: tier.model,
    ...(tier.effort !== undefined ? { effort: tier.effort } : {}),
    source: "harness-default",
  };
}

/** Short UI label for a Codex model id: "Sol", "Sol low", "Astra". */
export function harnessModelLabel(model: string, effort?: string): string {
  const s = (model || "").toLowerCase();
  let base = model;
  if (s.includes("sol")) base = "Sol";
  else if (s.includes("astra")) base = "Astra";
  return effort ? `${base} ${effort}` : base;
}

export interface HarnessDefaultInfo {
  vendor: string;
  model: string;
  effort?: string;
  label: string;
  source: "harness-default";
}

/** The display-ready default for an agent, or null when it has an explicit/own vendor choice or the harness is not Codex. */
export function describeHarnessDefault(harness: string, agent: HarnessAgentInput): HarnessDefaultInfo | null {
  const r = resolveHarnessDefault(harness, agent);
  if (r.source !== "harness-default") return null;
  return {
    vendor: r.vendor,
    model: r.model,
    ...(r.effort !== undefined ? { effort: r.effort } : {}),
    label: harnessModelLabel(r.model, r.effort),
    source: "harness-default",
  };
}
