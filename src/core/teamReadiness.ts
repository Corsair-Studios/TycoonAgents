/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Readiness report core (plan task p50-t1, design-docs/team-setup-prd.md
// Milestone 3). Pure builder over INJECTED probes so it is independently
// testable and reusable by both hosts (panel.ts, standalone/src/server.mjs)
// — same posture as teamSetup.ts / teamSetupApply.ts. This module never
// touches fs/child_process itself for the pure builder; only
// createDefaultProbes() wires the real discovery seams, and even then it
// reuses existing discovery modules rather than reimplementing them:
//   - src/providers/codex/codexDiscovery.ts's discoverCodexBinary() for the
//     "codex" vendor.
//   - src/providers/opencode/discovery.ts's resolveOpenCode() for the
//     "opencode" vendor.
//   - src/core/localEnvStore.ts's hasValue() for locally-stored
//     endpoint/credential env values (presence only, never the value).
//   - src/core/routingProfile.ts's RoutingSlot shape for fallbackChain /
//     endpointEnv / credentialEnv naming conventions.
//
// CONTRACT: the returned TeamReadinessReport (and formatReadinessReport's
// output) must never contain an env var's VALUE or an absolute filesystem
// path. Callers wiring `probes.vendorAvailable`/`probes.reachability` MUST
// return sanitized `detail` strings (names/booleans only) — this module
// does not scrub detail text, it only ever asks for booleans (envSet) and
// passes vendor/model identifiers (never secret values) into probes.
// ---------------------------------------------------------------------------

import type { TeamManifest, TeamManifestRouting } from "./teamSetup";

export type ReadinessStatus = "ready" | "fallback" | "not_ready";

export interface VendorAvailability {
  available: boolean;
  /** Sanitized human-readable detail (no absolute paths, no secret values). */
  detail: string;
}

export interface ReachabilityResult {
  ok: boolean;
  detail: string;
}

/**
 * Injected probe seam. Every probe is fail-open from the caller's
 * perspective: this module treats a throwing/rejecting probe as "not
 * available" / "not set" rather than propagating.
 */
export interface TeamReadinessProbes {
  vendorAvailable: (vendor: string) => Promise<VendorAvailability>;
  /** Presence-only check — must never return or expose the value itself. */
  envSet: (name: string) => boolean;
  /** Optional, opt-in. Only called when opts.probeReachability is true. */
  reachability?: (vendor: string, model: string | undefined) => Promise<ReachabilityResult>;
  now: () => number;
}

export interface BuildTeamReadinessOptions {
  /** When true, also calls probes.reachability for each agent's resolved (ready/fallback) slot. Defaults to false. */
  probeReachability?: boolean;
}

export interface AgentReadiness {
  id: string;
  status: ReadinessStatus;
  /** Vendor actually in play: the primary vendor if ready, else the first ready fallback's vendor, else the primary vendor (for reporting) when nothing is ready. */
  vendor?: string;
  model?: string;
  /** Missing required env var names for the slot in play (names only). */
  missingEnv: string[];
  /** Set when status is "fallback": which fallback vendor/model was selected. */
  fallbackUsed?: { vendor?: string; model?: string; index: number };
  reachability?: ReachabilityResult;
  detail: string;
}

export interface TeamReadinessSummary {
  ready: number;
  total: number;
  text: string;
}

export interface TeamReadinessReport {
  generatedAt: number;
  agents: AgentReadiness[];
  summary: TeamReadinessSummary;
}

function missingEnvNames(requiredEnvNames: string[], envSet: (name: string) => boolean): string[] {
  return requiredEnvNames.filter((name) => !envSet(name));
}

interface SlotCandidate {
  vendor?: string;
  model?: string;
  requiredEnvNames: string[];
}

/**
 * Builds the ordered candidate list for one routing entry: the primary slot
 * (checked against ITS OWN `routing.envNames`, never the manifest-wide
 * requiredEnv union — see p50-t1 follow-up) followed by each fallback,
 * each checked against `routing.fallbackEnvNames[<label>]` (keyed by the
 * SAME "vendor/model" label that appears in `fallbackChain`, produced by
 * fallbackSlotLabel() in src/host/vscode/teamSetupHost.ts). A candidate
 * with no envNames entry needs no env at all — an unrelated agent's (or
 * unrelated fallback's) missing var no longer marks this candidate
 * not_ready.
 */
function buildCandidates(routing: TeamManifestRouting | undefined): SlotCandidate[] {
  if (!routing) return [{ requiredEnvNames: [] }];
  const primary: SlotCandidate = {
    vendor: routing.vendor,
    model: routing.model,
    requiredEnvNames: routing.envNames ?? [],
  };
  const fallbacks: SlotCandidate[] = (routing.fallbackChain ?? []).map((label) => ({
    vendor: label,
    requiredEnvNames: routing.fallbackEnvNames?.[label] ?? [],
  }));
  return [primary, ...fallbacks];
}

/**
 * Pure builder: assembles a TeamReadinessReport for `manifest` using
 * injected `probes`. Never reads fs/env/network directly — see
 * createDefaultProbes() for the real wiring.
 */
export async function buildTeamReadiness(
  manifest: TeamManifest,
  probes: TeamReadinessProbes,
  opts: BuildTeamReadinessOptions = {},
): Promise<TeamReadinessReport> {
  const agents: AgentReadiness[] = [];

  for (const entry of manifest.roster) {
    const routing = manifest.routing[entry.id];
    const candidates = buildCandidates(routing);

    let status: ReadinessStatus = "not_ready";
    let chosenVendor: string | undefined;
    let chosenModel: string | undefined;
    let missingEnv: string[] = [];
    let fallbackUsed: AgentReadiness["fallbackUsed"];
    let detail = "";

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const envMissing = missingEnvNames(candidate.requiredEnvNames, probes.envSet);

      let availability: VendorAvailability = { available: false, detail: "no vendor specified" };
      if (candidate.vendor) {
        try {
          availability = await probes.vendorAvailable(candidate.vendor);
        } catch {
          availability = { available: false, detail: "vendor probe failed" };
        }
      }

      if (availability.available && envMissing.length === 0) {
        chosenVendor = candidate.vendor;
        chosenModel = candidate.model;
        missingEnv = [];
        detail = availability.detail;
        if (i === 0) {
          status = "ready";
        } else {
          status = "fallback";
          fallbackUsed = { vendor: candidate.vendor, model: candidate.model, index: i - 1 };
        }
        break;
      }

      // Remember the primary candidate's failure reason/missing env for
      // reporting when NO candidate (including fallbacks) works out.
      if (i === 0) {
        chosenVendor = candidate.vendor;
        chosenModel = candidate.model;
        missingEnv = envMissing;
        detail = envMissing.length > 0 ? `missing required env: ${envMissing.join(", ")}` : availability.detail;
      }
    }

    let reachability: ReachabilityResult | undefined;
    if (opts.probeReachability && probes.reachability && status !== "not_ready" && chosenVendor) {
      try {
        reachability = await probes.reachability(chosenVendor, chosenModel);
      } catch {
        reachability = { ok: false, detail: "reachability probe failed" };
      }
    }

    agents.push({
      id: entry.id,
      status,
      vendor: chosenVendor,
      model: chosenModel,
      missingEnv,
      ...(fallbackUsed ? { fallbackUsed } : {}),
      ...(reachability ? { reachability } : {}),
      detail,
    });
  }

  const ready = agents.filter((a) => a.status === "ready" || a.status === "fallback").length;
  const total = agents.length;

  return {
    generatedAt: probes.now(),
    agents,
    summary: {
      ready,
      total,
      text: `${ready} of ${total} agents ready`,
    },
  };
}

// ---------------------------------------------------------------------------
// Default probes: wires the real discovery seams. Reused, not reimplemented:
// discoverCodexBinary (codex), resolveOpenCode (opencode), localEnvStore's
// hasValue (env-value presence). "anthropic" is treated as always-available
// since this module runs inside the Claude Code host itself — there is no
// separate binary to discover for the host's own vendor.
// ---------------------------------------------------------------------------

export interface CreateDefaultProbesOptions {
  root: string;
  env: NodeJS.ProcessEnv;
  /** Optional execFileSync-shaped override, forwarded to discoverCodexBinary's exec seam (tests only). */
  execSeam?: (command: string) => string;
}

const REACHABILITY_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Wires createDefaultProbes' probes.vendorAvailable + probes.envSet against
 * the project's real discovery seams, plus a short-TTL in-memory cache
 * (10 min) for reachability results only (vendorAvailable/envSet are cheap
 * enough not to need caching — they're local fs/env checks, not network
 * calls).
 */
export function createDefaultProbes(opts: CreateDefaultProbesOptions): TeamReadinessProbes {
  const { root, env, execSeam } = opts;
  const reachabilityCache = new Map<string, { at: number; result: ReachabilityResult }>();

  const vendorAvailable = async (vendor: string): Promise<VendorAvailability> => {
    const v = vendor.toLowerCase();
    if (v === "anthropic" || v === "claude" || v === "claude-code") {
      return { available: true, detail: "native host vendor" };
    }
    if (v === "codex" || v === "openai") {
      try {
        // Lazy require so a host that never touches codex readiness never
        // pays codexDiscovery's import cost, and so this module has no
        // hard compile-time dependency direction on src/providers/*.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverCodexBinary } = require("../providers/codex/codexDiscovery") as typeof import("../providers/codex/codexDiscovery");
        discoverCodexBinary(execSeam ? { exec: execSeam } : undefined);
        return { available: true, detail: "codex CLI discovered" };
      } catch {
        return { available: false, detail: "codex CLI not found" };
      }
    }
    if (v === "opencode") {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { resolveOpenCode } = require("../providers/opencode/discovery") as typeof import("../providers/opencode/discovery");
        resolveOpenCode({ env, projectDir: root });
        return { available: true, detail: "OpenCode install discovered" };
      } catch {
        return { available: false, detail: "OpenCode install not found" };
      }
    }
    // Local/OpenAI-compatible or unknown vendors have no dedicated binary
    // discovery seam — readiness for these rests entirely on their env
    // slot (endpointEnv/credentialEnv), already covered by envSet checks
    // per-agent, so treat the vendor itself as available.
    return { available: true, detail: "no vendor discovery probe; env presence decides readiness" };
  };

  const envSet = (name: string): boolean => {
    if (typeof env[name] === "string" && env[name] !== "") return true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { hasValue } = require("./localEnvStore") as typeof import("./localEnvStore");
      return hasValue(name, { env });
    } catch {
      return false;
    }
  };

  const reachability = async (vendor: string, model: string | undefined): Promise<ReachabilityResult> => {
    const key = `${vendor}::${model ?? ""}`;
    const cached = reachabilityCache.get(key);
    const now = Date.now();
    if (cached && now - cached.at < REACHABILITY_CACHE_TTL_MS) {
      return cached.result;
    }
    // No live network reachability seam exists yet in this codebase; report
    // "unknown" rather than fabricating a probe. Hosts that gain a real
    // health-check endpoint later can inject their own `reachability` probe
    // into buildTeamReadiness() directly instead of relying on this default.
    const result: ReachabilityResult = { ok: true, detail: "reachability not probed (no live seam configured)" };
    reachabilityCache.set(key, { at: now, result });
    return result;
  };

  return {
    vendorAvailable,
    envSet,
    reachability,
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Plain-text formatter — identical output for both hosts.
// ---------------------------------------------------------------------------

export function formatReadinessReport(report: TeamReadinessReport): string {
  const lines: string[] = [];
  lines.push(report.summary.text);
  for (const agent of report.agents) {
    const parts: string[] = [agent.id, `[${agent.status}]`];
    if (agent.vendor) parts.push(agent.vendor + (agent.model ? `/${agent.model}` : ""));
    if (agent.status === "fallback" && agent.fallbackUsed) {
      parts.push(`(fallback #${agent.fallbackUsed.index + 1})`);
    }
    if (agent.missingEnv.length > 0) {
      parts.push(`missing env: ${agent.missingEnv.join(", ")}`);
    }
    if (agent.status === "not_ready" && agent.missingEnv.length === 0) {
      parts.push(`(${agent.detail})`);
    }
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}
