/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Agents screen UI mode (p74-t1). Purely a display decision — nothing in
// routing.json or agent files changes shape. The Agents screen defaults to
// a single-provider view (per-agent model tier radios for the one vendor
// the harness runs on); the full vendor/fallback UI shows only when the
// per-user `tycoonagents.agents.multiProvider` setting is on. The OpenCode
// harness and the standalone host are always "multi" and never show the
// checkbox — see resolveAgentsUiMode's callers in panel.ts / server.mjs.
// ---------------------------------------------------------------------------

import { MODEL_ALIASES } from "./modelAliases";

export type AgentsUiMode = "single" | "multi";

export interface ResolveAgentsUiModeInput {
  /** Effective harness id, e.g. "claude-code", "opencode", "codex", or the
   *  literal "standalone" for the standalone host (which has no harness of
   *  its own and is always multi). */
  harness: string;
  /** Current value of the `tycoonagents.agents.multiProvider` setting. */
  multiProvider: boolean;
}

/**
 * OpenCode always shows the full multi-provider UI (it natively routes
 * across vendors, so a single-provider simplification would hide real
 * per-agent vendor differences). The standalone host has no harness
 * concept of its own and is always multi too. Every other harness
 * (claude-code, codex, ...) defaults to the single-provider view unless the
 * user opted into `multiProvider`.
 */
export function resolveAgentsUiMode(input: ResolveAgentsUiModeInput): AgentsUiMode {
  const harness = (input.harness || "").toLowerCase();
  if (harness === "opencode" || harness === "standalone") return "multi";
  return input.multiProvider ? "multi" : "single";
}

export interface SingleProviderTier {
  id: string;
  label: string;
  model: string;
  /** One-line description shown beside the model in the catalog picker. */
  description?: string;
}

export interface SingleProviderTiers {
  vendor: string;
  tiers: SingleProviderTier[];
}

/**
 * Single source of truth for the Codex models accepted under ChatGPT sign-in
 * (Astra, Sol, Terra, Luna: most to least capable; Astra/Sol/Luna match Claude opus/sonnet/haiku, Terra is an explicit
 * middle choice, never a tier default). Ids read from `codex debug models` (2026-10-27). Import from "src/core/agentsUiMode".
 */
export const CODEX_ACCEPTED_MODELS: readonly SingleProviderTier[] = [
  { id: "astra", label: "Astra", model: "openai/gpt-6-astra", description: "Most capable; frontier work" },
  { id: "sol", label: "Sol", model: "openai/gpt-6.1-sol", description: "Near-Astra at lower cost" },
  { id: "terra", label: "Terra", model: "openai/gpt-6.1-terra", description: "Balanced model for straightforward work" },
  { id: "luna", label: "Luna", model: "openai/gpt-6-luna", description: "Cheap, high-volume work" },
];

/**
 * Bare Codex ids known to be rejected under ChatGPT sign-in. The dispatcher
 * (hooks/dispatcherClaudeChain.cjs, CommonJS) keeps a mirrored list that a
 * test asserts equal to this one.
 */
export const CODEX_REJECTED_MODELS: readonly string[] = ["gpt-5", "gpt-6"];

/** Older bare ids still listed by `codex debug models`: dispatch accepts a saved one, the UI never offers them (mirrored in hooks/dispatcherClaudeChain.cjs). */
export const CODEX_LEGACY_MODELS: readonly string[] = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-sol", "gpt-5.5"];

/**
 * Model tier lists for the single-provider Agents view, keyed by harness.
 * Claude reuses the SAME alias strings the existing model dropdown writes
 * (MODEL_ALIASES, modelAliases.ts) — never duplicated literals. Codex tiers
 * are the model ids actually accepted by ChatGPT-account Codex auth as
 * documented at media/mcp/catalog.json's `codex` entry and
 * src/host/vscode/packCatalog.ts's codex-reviewer template (backend.model
 * "openai/gpt-6.1-sol", with "openai/gpt-6-astra" as the higher-tier
 * option) — never invented slugs. An unrecognized harness returns an empty
 * tier list, and callers should fall back to "multi" in that case.
 */
export function singleProviderTiers(harness: string): SingleProviderTiers {
  const h = (harness || "").toLowerCase();
  if (h === "claude-code" || h === "claude") {
    return {
      vendor: "anthropic",
      tiers: [
        { id: "fable", label: "Fable", model: MODEL_ALIASES.fable },
        { id: "opus", label: "Opus", model: MODEL_ALIASES.opus },
        { id: "sonnet", label: "Sonnet", model: MODEL_ALIASES.sonnet },
        { id: "haiku", label: "Haiku", model: MODEL_ALIASES.haiku },
      ],
    };
  }
  if (h === "codex") {
    return {
      vendor: "openai",
      tiers: CODEX_ACCEPTED_MODELS.map((t) => ({ ...t })),
    };
  }
  return { vendor: "", tiers: [] };
}
