/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as fs from "fs";
import * as path from "path";
import type { Backend, Transport, CostModelClass } from "./agentBackend";

// ---------------------------------------------------------------------------
// Routing profile schema loader/validator for .claude/tycoon/routing.json.
// See docs/ROUTING-PROFILE.md for the full field reference, precedence rule,
// and migration notes. Zero dependencies; no 'vscode' import — this module
// is compiled by tsc to out/src/core/routingProfile.js so the standalone
// build can require() it directly alongside the VS Code extension build.
// ---------------------------------------------------------------------------

const VALID_TRANSPORTS: Transport[] = ["claude-native", "mcp", "openai-compatible"];
const VALID_COST_MODEL_CLASSES: CostModelClass[] = ["metered", "subscription", "local"];
const SECRET_NAME_PATTERN = /key|secret|token|password/i;
const MAX_FALLBACK_DEPTH = 3;

export interface RoutingSlot {
  vendor?: string;
  transport?: Transport;
  mcpServer?: string;
  tools?: string[];
  /** 'provider/model' form or a bare alias (opus/sonnet/haiku/fable). */
  model?: string;
  costModelClass?: CostModelClass;
  endpointEnv?: string;
  /** Name of an env var holding the credential. Never a value. Replaces
   *  Backend's `apiKeyEnv` — see routingSlotToBackend() for the mapping. */
  credentialEnv?: string;
  fallback?: RoutingSlot[];
}

export interface RoutingProfile {
  version: 1;
  orchestrator?: RoutingSlot;
  agents: Record<string, RoutingSlot>;
  defaults?: Partial<RoutingSlot>;
  /** p25-t2: top-level fallback slot used at RESOLVE time (see
   *  hooks/fallbackChain.js resolveNextFallback) by any slot whose own
   *  `fallback` is undefined or empty. Never merged into per-agent slots by
   *  mergeSlots() — it is applied only when a resolver builds a chain for a
   *  slot, not inherited via the defaults/agent merge. */
  defaultFallback?: RoutingSlot;
}

export interface LoadRoutingProfileResult {
  profile: RoutingProfile | null;
  path: string;
  errors: string[];
}

function isTransport(v: unknown): v is Transport {
  return typeof v === "string" && (VALID_TRANSPORTS as string[]).includes(v);
}

function isCostModelClass(v: unknown): v is CostModelClass {
  return typeof v === "string" && (VALID_COST_MODEL_CLASSES as string[]).includes(v);
}

/**
 * Validate a single slot object found at `jsonPath` (e.g. "agents.coding-specialist"
 * or "agents.coding-specialist.fallback[0]"), pushing one error per problem
 * into `errors`. Returns true if the slot (and any nested fallback slots) is
 * structurally valid.
 */
/**
 * Recursively walk the entire parsed routing.json object (objects and arrays,
 * any depth) looking for a property key matching SECRET_NAME_PATTERN, exempting
 * exactly `credentialEnv` and `endpointEnv`. Pushes one error per offending key
 * into `errors`, naming its JSON path.
 */
function scanForSecretNames(value: unknown, jsonPath: string, errors: string[]): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, idx) => scanForSecretNames(item, `${jsonPath}[${idx}]`, errors));
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const childPath = jsonPath ? `${jsonPath}.${key}` : key;
    if (key !== "credentialEnv" && key !== "endpointEnv" && SECRET_NAME_PATTERN.test(key)) {
      errors.push(
        `${childPath}: secrets must not be stored in routing.json; use env var names (credentialEnv/endpointEnv)`
      );
    }
    scanForSecretNames(obj[key], childPath, errors);
  }
}

function validateSlot(value: unknown, jsonPath: string, errors: string[], depth: number): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${jsonPath}: expected an object, got ${JSON.stringify(value)}`);
    return false;
  }
  const obj = value as Record<string, unknown>;
  let ok = true;

  if (obj["vendor"] !== undefined && typeof obj["vendor"] !== "string") {
    errors.push(`${jsonPath}.vendor: expected a string, got ${JSON.stringify(obj["vendor"])}`);
    ok = false;
  }
  if (obj["transport"] !== undefined && !isTransport(obj["transport"])) {
    errors.push(
      `${jsonPath}.transport: invalid value ${JSON.stringify(obj["transport"])} — allowed: ${VALID_TRANSPORTS.join(", ")}`
    );
    ok = false;
  }
  if (obj["mcpServer"] !== undefined && typeof obj["mcpServer"] !== "string") {
    errors.push(`${jsonPath}.mcpServer: expected a string, got ${JSON.stringify(obj["mcpServer"])}`);
    ok = false;
  }
  if (obj["tools"] !== undefined) {
    if (!Array.isArray(obj["tools"]) || obj["tools"].some((t) => typeof t !== "string")) {
      errors.push(`${jsonPath}.tools: expected a string array, got ${JSON.stringify(obj["tools"])}`);
      ok = false;
    }
  }
  if (obj["model"] !== undefined && typeof obj["model"] !== "string") {
    errors.push(`${jsonPath}.model: expected a string, got ${JSON.stringify(obj["model"])}`);
    ok = false;
  }
  if (obj["costModelClass"] !== undefined && !isCostModelClass(obj["costModelClass"])) {
    errors.push(
      `${jsonPath}.costModelClass: invalid value ${JSON.stringify(obj["costModelClass"])} — allowed: ${VALID_COST_MODEL_CLASSES.join(", ")}`
    );
    ok = false;
  }
  if (obj["endpointEnv"] !== undefined && typeof obj["endpointEnv"] !== "string") {
    errors.push(`${jsonPath}.endpointEnv: expected a string, got ${JSON.stringify(obj["endpointEnv"])}`);
    ok = false;
  }
  if (obj["credentialEnv"] !== undefined && typeof obj["credentialEnv"] !== "string") {
    errors.push(`${jsonPath}.credentialEnv: expected a string, got ${JSON.stringify(obj["credentialEnv"])}`);
    ok = false;
  }
  if (obj["fallback"] !== undefined) {
    if (!Array.isArray(obj["fallback"])) {
      errors.push(`${jsonPath}.fallback: expected an array of slots, got ${JSON.stringify(obj["fallback"])}`);
      ok = false;
    } else if (depth >= MAX_FALLBACK_DEPTH) {
      errors.push(`${jsonPath}.fallback: exceeds max fallback depth of ${MAX_FALLBACK_DEPTH}`);
      ok = false;
    } else {
      obj["fallback"].forEach((child, idx) => {
        if (!validateSlot(child, `${jsonPath}.fallback[${idx}]`, errors, depth + 1)) ok = false;
      });
    }
  }

  return ok;
}

/**
 * Load and validate `<projectRoot>/.claude/tycoon/routing.json`.
 *
 * - Never throws. A missing file returns `{ profile: null, path, errors: [] }`.
 * - A present-but-invalid file returns `{ profile: null, path, errors }` with
 *   one message per problem, each naming the JSON path of the offending field
 *   (matching resolveProviderId()'s descriptive-error style in
 *   src/core/providerSelection.ts, just returned rather than thrown so a
 *   caller can decide whether a broken profile should block startup).
 */
export function loadRoutingProfile(projectRoot: string): LoadRoutingProfileResult {
  const filePath = path.join(projectRoot, ".claude", "tycoon", "routing.json");

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { profile: null, path: filePath, errors: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      profile: null,
      path: filePath,
      errors: [`${filePath}: invalid JSON — ${(e as Error).message}`],
    };
  }

  const errors: string[] = [];
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { profile: null, path: filePath, errors: [`${filePath}: expected a top-level object`] };
  }
  const obj = parsed as Record<string, unknown>;

  scanForSecretNames(obj, "", errors);

  if (obj["version"] !== 1) {
    errors.push(`version: expected 1, got ${JSON.stringify(obj["version"])}`);
  }

  if (obj["agents"] === undefined || obj["agents"] === null || typeof obj["agents"] !== "object" || Array.isArray(obj["agents"])) {
    errors.push(`agents: expected an object, got ${JSON.stringify(obj["agents"])}`);
  } else {
    const agents = obj["agents"] as Record<string, unknown>;
    for (const agentId of Object.keys(agents)) {
      validateSlot(agents[agentId], `agents.${agentId}`, errors, 0);
    }
  }

  if (obj["orchestrator"] !== undefined) {
    validateSlot(obj["orchestrator"], "orchestrator", errors, 0);
  }

  if (obj["defaults"] !== undefined) {
    validateSlot(obj["defaults"], "defaults", errors, 0);
  }

  if (obj["defaultFallback"] !== undefined) {
    validateSlot(obj["defaultFallback"], "defaultFallback", errors, 0);
  }

  if (errors.length > 0) {
    return { profile: null, path: filePath, errors };
  }

  const profile: RoutingProfile = {
    version: 1,
    agents: (obj["agents"] as Record<string, RoutingSlot>) ?? {},
  };
  if (obj["orchestrator"] !== undefined) profile.orchestrator = obj["orchestrator"] as RoutingSlot;
  if (obj["defaults"] !== undefined) profile.defaults = obj["defaults"] as Partial<RoutingSlot>;
  if (obj["defaultFallback"] !== undefined) profile.defaultFallback = obj["defaultFallback"] as RoutingSlot;

  return { profile, path: filePath, errors: [] };
}

/**
 * Merge `defaults` (`base`) under a more specific slot (`override`).
 *
 * - Any field `override` sets always wins outright.
 * - `vendor` and `costModelClass` carry over from `base` whenever `override`
 *   omits them, regardless of vendor match (costModelClass is vendor-
 *   agnostic; an omitted vendor simply means "use the defaults vendor").
 * - `transport`, `endpointEnv`, `credentialEnv`, and `fallback` carry over
 *   from `base` ONLY when `override` omits (or matches) `base.vendor` — a
 *   per-agent entry naming a DIFFERENT vendor than defaults must never
 *   inherit connection details (endpoint/credential/transport/fallback)
 *   meant for a different backend.
 */
function mergeSlots(base: Partial<RoutingSlot> | undefined, override: RoutingSlot | undefined): RoutingSlot | null {
  if (!base && !override) return null;
  if (!override) return { ...(base as RoutingSlot) };
  const merged: RoutingSlot = { ...override };
  if (base) {
    const sameVendor = override.vendor === undefined || override.vendor === base.vendor;
    if (merged.vendor === undefined && base.vendor !== undefined) merged.vendor = base.vendor;
    if (merged.costModelClass === undefined && base.costModelClass !== undefined) {
      merged.costModelClass = base.costModelClass;
    }
    if (sameVendor) {
      if (merged.transport === undefined && base.transport !== undefined) merged.transport = base.transport;
      if (merged.endpointEnv === undefined && base.endpointEnv !== undefined) merged.endpointEnv = base.endpointEnv;
      if (merged.credentialEnv === undefined && base.credentialEnv !== undefined) {
        merged.credentialEnv = base.credentialEnv;
      }
      if (merged.fallback === undefined && base.fallback !== undefined) merged.fallback = base.fallback;
    }
  }
  return merged;
}

export interface ResolveAgentSlotOptions {
  /**
   * True when this agent's frontmatter has a hand-written `backend:` block
   * (one with no `# managed-by: tycoon-routing` marker as its first child
   * line — see hasHandWrittenBackendBlock()). When true, `defaults` is never
   * applied to this agent unless it also has an explicit `agents[agentId]`
   * entry in the profile (which always wins regardless of this flag).
   * Defaults to false so existing callers that don't pass this option keep
   * today's behavior (defaults apply to every agent with no explicit entry).
   */
  hasHandWrittenBackend?: boolean;
}

/**
 * Resolve the effective slot for `agentId`: defaults merged with
 * `agents[agentId]` (agent-specific fields win). Returns null when the agent
 * has no entry in the profile and either `defaults.model` is not set, or the
 * agent has a hand-written `backend:` block (see ResolveAgentSlotOptions) —
 * i.e. there is nothing this profile can resolve for that agent, so the
 * caller should fall back to agent frontmatter.
 */
export function resolveAgentSlot(
  profile: RoutingProfile | null,
  agentId: string,
  options: ResolveAgentSlotOptions = {}
): RoutingSlot | null {
  if (!profile) return null;
  const agentSlot = profile.agents[agentId];
  if (agentSlot) {
    return mergeSlots(profile.defaults, agentSlot);
  }
  if (options.hasHandWrittenBackend) return null;
  if (!profile.defaults?.model) return null;
  return mergeSlots(profile.defaults, undefined);
}

/**
 * Resolve the effective slot for the orchestrator: defaults merged with
 * `orchestrator`. Returns null when neither is present.
 */
export function resolveOrchestratorSlot(profile: RoutingProfile | null): RoutingSlot | null {
  if (!profile) return null;
  if (!profile.orchestrator && !profile.defaults) return null;
  return mergeSlots(profile.defaults, profile.orchestrator);
}

/**
 * Adapt a resolved RoutingSlot to the existing Backend shape (see
 * src/core/agentBackend.ts) so generators can reuse parseAgentBackend-
 * compatible data. `credentialEnv` maps to Backend's `apiKeyEnv`.
 *
 * Missing required Backend fields (`vendor`, `transport`, `model`,
 * `costModelClass`) fall back to the same defaults parseAgentBackend() uses
 * for an agent with no `backend:` block, so a partial slot degrades
 * gracefully rather than producing an invalid Backend.
 */
const MANAGED_BACKEND_MARKER = "# managed-by: tycoon-routing";

/**
 * True when `rawFileText` (a full .claude/agents/<id>.md file's text) has a
 * top-level `backend:` frontmatter block that was NOT written by
 * apply-routing-profile.mjs — i.e. it either has no
 * `# managed-by: tycoon-routing` marker as its first indented child line, or
 * has no `backend:` block at all counts as "no hand-written block" (false).
 * Mirrors scripts/apply-routing-profile.mjs's findAnyBackendBlockRange +
 * MANAGED_MARKER check exactly, so generators can call this on raw
 * frontmatter text instead of duplicating the regex logic.
 */
export function hasHandWrittenBackendBlock(rawFileText: string): boolean {
  const normalized = rawFileText.replace(/\r\n?/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return false;
  const lines = match[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const topMatch = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (topMatch && !/^\s/.test(line) && topMatch[1] === "backend") {
      let j = i + 1;
      while (j < lines.length && /^\s+\S/.test(lines[j])) j++;
      const firstChild = i + 1 < j ? lines[i + 1].trim() : undefined;
      return firstChild !== MANAGED_BACKEND_MARKER;
    }
  }
  return false;
}

export function routingSlotToBackend(slot: RoutingSlot): Backend {
  const result: Backend = {
    vendor: slot.vendor ?? "anthropic",
    transport: slot.transport ?? "claude-native",
    model: slot.model ?? "unknown",
    costModelClass: slot.costModelClass ?? "metered",
  };
  if (slot.mcpServer) result.mcpServer = slot.mcpServer;
  if (slot.tools) result.tools = slot.tools;
  if (slot.endpointEnv) result.endpointEnv = slot.endpointEnv;
  if (slot.credentialEnv) result.apiKeyEnv = slot.credentialEnv;
  return result;
}
