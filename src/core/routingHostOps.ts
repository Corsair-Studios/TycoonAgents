/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Host-agnostic implementation of the Routing panel screen (plan task
// p13-t1/t2/t4). Shared by the VS Code extension (src/host/vscode/panel.ts)
// and the standalone server (standalone/src/server.mjs) — no `vscode`
// import anywhere in this module or its transitive dependencies, so it is
// safe to compile to out/src/core/routingHostOps.js and require() it
// directly from the standalone's vscode-free process (same posture as
// packCatalog.ts / agentRoster.ts, both imported below).
//
// Precedence for an agent's effective backend/source MUST match
// scripts/apply-routing-profile.mjs and scripts/generate-opencode-config.mjs
// exactly:
//   1. 'routing'     — resolveAgentSlot(profile, id) resolves (routing.json
//                       covers this agent, directly or via `defaults`).
//   2. 'frontmatter' — the agent's own `backend:` frontmatter block.
//   3. 'alias'        — a bare top-level `model:` alias/string with no
//                       `backend:` block (opus/sonnet/haiku/fable/...).
//   4. 'default'      — neither a profile slot nor any model info at all;
//                       parseAgentBackend()'s built-in anthropic/"unknown"
//                       fallback.
// ---------------------------------------------------------------------------

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { spawnSync } from "child_process";

import {
  loadRoutingProfile,
  resolveAgentSlot,
  resolveOrchestratorSlot,
  routingSlotToBackend,
  hasHandWrittenBackendBlock,
  type RoutingProfile,
  type RoutingSlot,
} from "./routingProfile";
import { readAgentFrontmatter, parseAgentBackend, type Backend } from "./agentBackend";
import { isFallbackTargetDispatchable } from "./fallbackTargets";
import { describeProviderSelection, isOpencodeAvailable } from "./providerSelection";
import { readClaudeSubscriptionOptIn, writeClaudeSubscriptionOptIn, usesClaudeSubscriptionRoute, claudeSubscriptionBlockedMessage, type ClaudeRouteSlotLike } from "./claudeSubscriptionBridge";
import { resolveModelAlias, MODEL_ALIASES } from "./modelAliases";
import { loadAgentRoster } from "../providers/claude-code/agentRoster";
import { hasValue as localEnvHasValue, setValue as localEnvSetValue, clearValue as localEnvClearValue } from "./localEnvStore";
// FOREIGN_LLM_AGENTS is the existing, canonical foreign-vendor/model table
// (mirrors media/mcp/catalog.json's "codex"/"gemini"/"openai-compatible"/
// "claude-cli" MCP server entries) — reused here rather than inventing a
// second one. packCatalog.ts has no `vscode` import in its own or
// transitive dependencies (verified: it only pulls in ../../core/agentBackend),
// so importing it from core/ is safe at runtime even though the directory
// layout looks "backward" — the alternative (duplicating the table) is
// explicitly what this task must avoid.
import { FOREIGN_LLM_AGENTS } from "../host/vscode/packCatalog";
import { VENDOR_KEY_SPECS, type VendorKeySpec } from "./vendorKeys";
import { buildHostBridgeInfo, setGeminiBackend, type HostBridgeInfo } from "./hostBridgeSettings";
import { CODEX_ACCEPTED_MODELS } from "./agentsUiMode";

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export type RoutingSource = "routing" | "frontmatter" | "alias" | "default";

/**
 * Where an agent's effective backend actually came from, for the panel to
 * label a row (p17-t1). Distinct from `source` (routing/frontmatter/alias/
 * default, which is about backend-resolution precedence between routing.json
 * and frontmatter): `provenance` distinguishes an explicit
 * `agents[agentId]` entry from one resolved purely via `defaults`.
 *  - "explicit"    — profile.agents[id] resolved this agent (source "routing").
 *  - "default"     — no agents[id] entry; profile.defaults resolved it instead
 *                     (source "routing").
 *  - "frontmatter" — routing.json did not resolve this agent at all; backend
 *                     came from the agent's own file (source "frontmatter",
 *                     "alias", or "default").
 */
export type RoutingProvenance = "explicit" | "default" | "frontmatter";

export interface RoutingAgentView {
  id: string;
  name: string;
  description?: string;
  backend: Backend;
  source: RoutingSource;
  provenance: RoutingProvenance;
  /** True when this agent's own frontmatter has a hand-written `backend:`
   *  block (no tycoon-routing managed-by marker) — such agents are excluded
   *  from `defaults` expansion (see resolveAgentSlot's hasHandWrittenBackend
   *  option in src/core/routingProfile.ts). */
  handWrittenBackend: boolean;
}

export interface RoutingOrchestratorView {
  id: string;
  backend: Backend;
  source: RoutingSource;
}

export interface RoutingModelPreset {
  id: string;
  vendor: string;
  costModelClass: Backend["costModelClass"];
  label: string;
}

export interface RoutingPresets {
  vendors: string[];
  models: RoutingModelPreset[];
  /** Fixed per-vendor env names (vendorKeys.ts) the webview renders read-only on the Claude Code and Codex hosts. */
  vendorKeys: VendorKeySpec[];
}

/** p101: write GEMINI_MCP_BACKEND into the gemini server env in .mcp.json (shared by both hosts). */
export { setGeminiBackend };

export interface RoutingLastApplied {
  claude?: string;
  opencode?: string;
}

export interface RoutingView {
  profile: RoutingProfile | null;
  path: string;
  errors: string[];
  orchestrator: RoutingOrchestratorView;
  agents: RoutingAgentView[];
  /** The profile's top-level `defaults` slot (verbatim), or undefined when
   *  the profile has none / no profile is loaded — so the panel can render
   *  and edit the "route everything through one backend" control directly. */
  defaults?: Partial<RoutingSlot>;
  /** p25-t2: the profile's top-level `defaultFallback` (verbatim), or
   *  undefined when the profile has none / no profile is loaded. Read/write
   *  flows through the existing GET_ROUTING/SAVE_ROUTING message pair (see
   *  messages.ts SAVE_ROUTING) exactly like `defaults` above — no separate
   *  message type. */
  defaultFallback?: RoutingSlot;
  envProbe: Record<string, EnvProbeEntry>;
  /** p101-t2/t5/t6: project .mcp.json facts the webview shows read-only or validates against. */
  bridge: HostBridgeInfo;
  presets: RoutingPresets;
  lastApplied: RoutingLastApplied;
  /** Per-user opt-in (default false) to reach Claude via the user's subscription (`claude -p` bridge) under OpenCode; see claudeSubscriptionBridge.ts. */
  claudeSubscriptionOptIn: boolean;
}

export interface ScriptRunResult {
  code: number;
  output: string;
}

export interface SaveRoutingResult {
  ok: boolean;
  errors: string[];
  check: { claude: ScriptRunResult; opencode: ScriptRunResult };
  write: { claude: ScriptRunResult; opencode: ScriptRunResult };
  /** Codex-doctrine-gap follow-up: only populated when saveRoutingProfile's
   *  effectiveHarness was "codex" — the AGENTS.md/codex-agents.toml
   *  generator only needs to run under that harness (see runCodexGenerator
   *  below), so this stays undefined for claude-code/opencode saves rather
   *  than padding every result with an irrelevant script run. */
  codex?: ScriptRunResult;
  /** Notes from a relay conversion or revert the user should see: a backup of an edited relay, a relay that could not be restored. */
  relayNotices?: string[];
}

/** Lines the apply script printed with the relay notice prefix. */
function parseRelayNotices(output: string): string[] {
  const prefix = "TYCOON-RELAY-NOTICE:";
  return output.split(/\r?\n/).filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length).trim()).filter((l) => l !== "");
}

const EMPTY_SCRIPT_RESULT: ScriptRunResult = { code: -1, output: "" };
/** Reported for the OpenCode generator when another harness is active: not run, not a failure. */
const OPENCODE_SKIPPED_RESULT: ScriptRunResult = { code: 0, output: "skipped: OpenCode is not the active harness" };

/** The harness a save/clear runs under: the caller's value, else resolved from the project; claude-code on failure. */
function resolveHarnessFor(root: string, given?: string): string {
  // Launch gate: a requested "opencode" resolves to Claude Code while OpenCode is Coming Soon.
  if (given) return given === "opencode" && !isOpencodeAvailable() ? "claude-code" : given;
  try {
    return describeProviderSelection({ cwd: root }).effective;
  } catch {
    return "claude-code";
  }
}
const EMPTY_SAVE_RESULT_SCRIPTS = {
  claude: EMPTY_SCRIPT_RESULT,
  opencode: EMPTY_SCRIPT_RESULT,
};

// ---------------------------------------------------------------------------
// env probing
// ---------------------------------------------------------------------------

/** One env var's presence, split by source (p13-t6): a real process env var, vs. a per-user stored value. */
export interface EnvProbeEntry {
  env: boolean;
  stored: boolean;
}

/**
 * Presence-only probe for a list of env var NAMES (never values), split by
 * source — `env` (a real process env var) and `stored` (a per-user value
 * saved via localEnvStore, outside any project). Any name not matching
 * ENV_NAME_PATTERN is silently omitted from the result rather than
 * throwing — a malformed name from an untrusted webview payload must never
 * crash the host.
 */
export function probeEnv(names: string[], env: NodeJS.ProcessEnv): Record<string, EnvProbeEntry> {
  const result: Record<string, EnvProbeEntry> = {};
  for (const name of names) {
    if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name)) continue;
    result[name] = {
      env: typeof env[name] === "string" && env[name] !== "",
      stored: localEnvHasValue(name),
    };
  }
  return result;
}

/**
 * Validate + persist a locally-stored env value (p13-t6). Returns a fresh
 * probe entry for `name` so the caller can post an updated envProbe without
 * ever echoing the value itself back to the webview or a log line.
 */
export function setLocalEnvValue(name: string, value: string, env: NodeJS.ProcessEnv): EnvProbeEntry {
  if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name)) {
    throw new Error(`setLocalEnvValue: invalid env var name: ${JSON.stringify(name)}`);
  }
  localEnvSetValue(name, value);
  return { env: typeof env[name] === "string" && env[name] !== "", stored: localEnvHasValue(name) };
}

/** Remove a locally-stored env value (p13-t6) and return a fresh probe entry for `name`. */
export function clearLocalEnvValue(name: string, env: NodeJS.ProcessEnv): EnvProbeEntry {
  if (typeof name === "string" && ENV_NAME_PATTERN.test(name)) {
    localEnvClearValue(name);
  }
  return {
    env: typeof name === "string" && typeof env[name] === "string" && env[name] !== "",
    stored: typeof name === "string" ? localEnvHasValue(name) : false,
  };
}

function collectEnvNames(backend: Backend | undefined, out: Set<string>): void {
  if (!backend) return;
  if (backend.endpointEnv) out.add(backend.endpointEnv);
  if (backend.apiKeyEnv) out.add(backend.apiKeyEnv);
}

// ---------------------------------------------------------------------------
// orchestrator file detection (mirrors apply-routing-profile.mjs's
// isOrchestratorFrontmatter: a flat `role:` or `tier:` key equal to
// "orchestrator").
// ---------------------------------------------------------------------------

function isOrchestratorFrontmatter(fm: Record<string, unknown>): boolean {
  const role = typeof fm["role"] === "string" ? (fm["role"] as string).trim() : undefined;
  const tier = typeof fm["tier"] === "string" ? (fm["tier"] as string).trim() : undefined;
  return role === "orchestrator" || tier === "orchestrator";
}

function classifyFrontmatterSource(fm: Record<string, unknown>): "frontmatter" | "alias" | "default" {
  if (fm["backend"] !== undefined && fm["backend"] !== null) return "frontmatter";
  if (typeof fm["model"] === "string" && fm["model"].trim() !== "") return "alias";
  return "default";
}

function safeParseAgentBackend(fm: Record<string, unknown>): Backend {
  try {
    return parseAgentBackend(fm);
  } catch {
    // parseAgentBackend() throws on a malformed `backend:` block (e.g. bad
    // transport/costModelClass) — this view must never throw, so degrade to
    // the same "unknown model" default it would return for no backend at all.
    return { vendor: "anthropic", transport: "claude-native", model: "unknown", costModelClass: "metered" };
  }
}

// ---------------------------------------------------------------------------
// presets
// ---------------------------------------------------------------------------

/**
 * Preset MODEL entries for the routing picker (p13-t4 audit fix). Each entry
 * is a model, never an agent — the id/label are the model id the pack would
 * actually route to (e.g. "anthropic/claude-sonnet-4-6", "openai/gpt-5.4-mini"),
 * not the agent name that happens to use it today (FOREIGN_LLM_AGENTS carries
 * "Claude Worker"/"Codex Reviewer"/etc., which is agent-shaped, not model-
 * shaped — using agent.name as the label made the MODEL select render agent
 * names). Deduplicated by id since more than one alias/agent can resolve to
 * the same underlying model. A short top-level `model:` alias (opus/sonnet/
 * haiku/fable) shows its resolved full id, with the alias noted in
 * parentheses only when the resolved id actually differs from the alias
 * (fable resolves to its LATEST_MODEL_IDS entry, currently
 * "claude-fable-5-1"; opus/sonnet/haiku resolve to themselves in
 * MODEL_ALIASES).
 */
function buildPresets(): RoutingPresets {
  const vendors = new Set<string>(["anthropic"]);
  const modelsById = new Map<string, RoutingModelPreset>();

  for (const alias of Object.keys(MODEL_ALIASES)) {
    const resolved = resolveModelAlias(alias) ?? alias;
    const id = `anthropic/${resolved}`;
    if (modelsById.has(id)) continue;
    const label = resolved === alias ? id : `${id} (${alias})`;
    modelsById.set(id, { id, vendor: "anthropic", costModelClass: "metered", label });
  }

  for (const agent of FOREIGN_LLM_AGENTS) {
    if (!agent.backend) continue;
    vendors.add(agent.backend.vendor);
    const id = agent.backend.model;
    if (modelsById.has(id)) continue;
    modelsById.set(id, { id, vendor: agent.backend.vendor, costModelClass: agent.backend.costModelClass, label: id });
  }

  // p101-t4: the Codex models accepted under ChatGPT sign-in (single source:
  // CODEX_ACCEPTED_MODELS); API-key users pick "Custom…" in the webview.
  for (const m of CODEX_ACCEPTED_MODELS) {
    vendors.add("openai");
    modelsById.delete(m.model); // keep catalog order (most to least capable) even if an agent already added it
    modelsById.set(m.model, { id: m.model, vendor: "openai", costModelClass: "subscription", label: `${m.label} — ${m.description ?? ""} (${m.model})` });
  }

  // OpenCode's Zen provider — the standalone's default orchestrator model
  // when OpenCode is the host (see docs/opencode-probe-findings.md,
  // .opencode/agents/orchestrator.md). Free tier, so costModelClass is
  // "subscription" (renders as "quota", no $/token figure) rather than
  // "metered". This is a model natively known to an OpenCode host (Zen is
  // built into OpenCode itself, not an external endpoint), so it needs no
  // MCP bridge or openai-compatible provider entry — generate-opencode-
  // config.mjs's computeOpencodeProviderVendors() only writes an
  // opencode.json provider block for transport "openai-compatible" slots,
  // which would incorrectly try to (re)configure Zen as if it were an
  // external npm provider. "claude-native" is reused here as the generic
  // "handled natively by the host, no bridge required" transport.
  vendors.add("opencode");
  modelsById.set("opencode/big-pickle", {
    id: "opencode/big-pickle",
    vendor: "opencode",
    costModelClass: "subscription",
    label: "opencode/big-pickle (Zen, free)",
  });

  // xAI Grok, via OpenCode's built-in xai provider (https://opencode.ai/docs/providers/,
  // model ids in "xai/<model>" form) — no native Claude Code or Codex host,
  // OpenCode-only. Like the opencode/big-pickle entry above, this is handled
  // natively by the OpenCode host itself (no MCP bridge, no openai-compatible
  // endpoint config), so "claude-native" (this project's generic "no bridge
  // required" transport value) applies once a slot picks this vendor — see
  // buildSlotEditorFields' vendor-change handler in
  // media/src/main/100-slot-editor-settings.js. Auth is XAI_API_KEY (an API
  // key from https://console.x.ai/); OpenCode's docs also mention a SuperGrok/
  // X Premium `/connect` OAuth login, unverified from a third-party guide —
  // see docs/AGENT-BACKENDS.md's xAI example for the apiKeyEnv wiring.
  vendors.add("xai");
  modelsById.set("xai/grok-4.7", {
    id: "xai/grok-4.7",
    vendor: "xai",
    costModelClass: "metered",
    label: "xai/grok-4.7 (flagship reasoning)",
  });
  modelsById.set("xai/grok-build-0.1", {
    id: "xai/grok-build-0.1",
    vendor: "xai",
    costModelClass: "metered",
    label: "xai/grok-build-0.1 (fast, cheap)",
  });

  return { vendors: Array.from(vendors), models: Array.from(modelsById.values()), vendorKeys: VENDOR_KEY_SPECS };
}

// ---------------------------------------------------------------------------
// lastApplied marker (written by saveRoutingProfile/clearRoutingProfile on a
// successful real-write run of each generator; read back here so the panel
// can show "last applied at ..." without re-running either script).
// ---------------------------------------------------------------------------

function lastAppliedPath(root: string): string {
  return path.join(root, ".claude", "tycoon", "routing-applied.json");
}

function readLastApplied(root: string): RoutingLastApplied {
  try {
    const raw = fs.readFileSync(lastAppliedPath(root), "utf8");
    const parsed = JSON.parse(raw);
    const out: RoutingLastApplied = {};
    if (typeof parsed?.claude === "string") out.claude = parsed.claude;
    if (typeof parsed?.opencode === "string") out.opencode = parsed.opencode;
    return out;
  } catch {
    return {};
  }
}

function writeLastApplied(root: string, write: { claude: ScriptRunResult; opencode: ScriptRunResult }, opencodeRan = true): void {
  try {
    const existing = readLastApplied(root);
    const now = new Date().toISOString();
    const next: RoutingLastApplied = { ...existing };
    if (write.claude.code === 0) next.claude = now;
    if (opencodeRan && write.opencode.code === 0) next.opencode = now;
    const dir = path.dirname(lastAppliedPath(root));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lastAppliedPath(root), JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {
    // Best-effort only — losing the "last applied" marker must never fail
    // an otherwise-successful save/clear.
  }
}

// ---------------------------------------------------------------------------
// buildRoutingView
// ---------------------------------------------------------------------------

export interface BuildRoutingViewOptions {
  root: string;
  env: NodeJS.ProcessEnv;
  agentsDir?: string;
}

/** Never throws — every failure degrades to an honest partial view with errors populated. */
export function buildRoutingView(opts: BuildRoutingViewOptions): RoutingView {
  const { root, env } = opts;
  const agentsDir = opts.agentsDir ?? path.join(root, ".claude", "agents");

  const { profile, path: profilePath, errors } = loadRoutingProfile(root);

  const envNames = new Set<string>();
  const agents: RoutingAgentView[] = [];

  let files: string[] = [];
  try {
    files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch {
    files = [];
  }

  const roster = loadAgentRoster(agentsDir);
  const rosterById = new Map(roster.map((r) => [r.id, r]));

  let orchestratorFileId: string | undefined;
  let orchestratorFrontmatter: Record<string, unknown> | undefined;

  for (const file of files) {
    const id = file.replace(/\.md$/, "");
    let content = "";
    try {
      content = fs.readFileSync(path.join(agentsDir, file), "utf8");
    } catch {
      continue;
    }
    const fm = readAgentFrontmatter(content);
    if (orchestratorFileId === undefined && isOrchestratorFrontmatter(fm)) {
      orchestratorFileId = id;
      orchestratorFrontmatter = fm;
    }

    const handWrittenBackend = hasHandWrittenBackendBlock(content);
    const isExplicitEntry = profile?.agents[id] !== undefined;
    const routingSlot = resolveAgentSlot(profile, id, { hasHandWrittenBackend: handWrittenBackend });
    let backend: Backend;
    let source: RoutingSource;
    let provenance: RoutingProvenance;
    if (routingSlot) {
      backend = routingSlotToBackend(routingSlot);
      source = "routing";
      provenance = isExplicitEntry ? "explicit" : "default";
    } else {
      backend = safeParseAgentBackend(fm);
      source = classifyFrontmatterSource(fm);
      provenance = "frontmatter";
    }
    collectEnvNames(backend, envNames);

    const rosterEntry = rosterById.get(id);
    agents.push({
      id,
      name: rosterEntry?.name ?? id,
      description: rosterEntry?.description,
      backend,
      source,
      provenance,
      handWrittenBackend,
    });
  }

  // Orchestrator: routing.json's orchestrator slot wins outright (matching
  // apply-routing-profile.mjs); otherwise fall back to whichever agent file
  // declared role/tier: orchestrator in its own frontmatter.
  let orchestrator: RoutingOrchestratorView;
  const orchestratorSlot = resolveOrchestratorSlot(profile);
  if (orchestratorSlot) {
    const backend = routingSlotToBackend(orchestratorSlot);
    collectEnvNames(backend, envNames);
    orchestrator = { id: orchestratorFileId ?? "", backend, source: "routing" };
  } else if (orchestratorFileId !== undefined && orchestratorFrontmatter !== undefined) {
    const backend = safeParseAgentBackend(orchestratorFrontmatter);
    collectEnvNames(backend, envNames);
    orchestrator = { id: orchestratorFileId, backend, source: classifyFrontmatterSource(orchestratorFrontmatter) };
  } else {
    orchestrator = {
      id: "",
      backend: { vendor: "anthropic", transport: "claude-native", model: "", costModelClass: "metered" },
      source: "default",
    };
  }
  // p13 audit fix: a "default" orchestrator (no routing.json slot, and either
  // no orchestrator.md at all or one with neither `model:` nor `backend:`)
  // must never surface the literal "unknown"/"anthropic/unknown" placeholder
  // parseAgentBackend() falls back to for a bare agent file — the Routing
  // view showed that as model "unknown" with a stray "Choose from list"
  // hint. Blank it out instead so the panel renders an empty, honest
  // "no model configured" field.
  if (orchestrator.source === "default" && (orchestrator.backend.model === "unknown" || orchestrator.backend.model === "anthropic/unknown")) {
    orchestrator = { ...orchestrator, backend: { ...orchestrator.backend, model: "" } };
  }

  return {
    profile,
    path: profilePath,
    errors,
    orchestrator,
    agents,
    defaults: profile?.defaults,
    defaultFallback: profile?.defaultFallback,
    envProbe: probeEnv(Array.from(envNames), env),
    bridge: buildHostBridgeInfo(root, env),
    presets: buildPresets(),
    lastApplied: readLastApplied(root),
    claudeSubscriptionOptIn: readClaudeSubscriptionOptIn(),
  };
}

/** Handles the Settings opt-in toggle (OpenCode: Claude subscription via the claude CLI); per-user, default off. */
export function setClaudeSubscriptionOptIn(value: boolean): boolean {
  writeClaudeSubscriptionOptIn(!!value);
  return readClaudeSubscriptionOptIn();
}

/**
 * p17-t4: shared computation used by both hosts' harness-settings payload
 * builders (VS Code's panel.ts `_buildHarnessSettings` and standalone's
 * `buildStandaloneHarnessSettings`) to decide whether the Settings screen
 * should nudge the user toward the Routing view's "Default for all agents"
 * card. True only when ALL of:
 *   - the effective harness is "opencode" (OpenCode has no subscription
 *     fallback the way claude-code does — every agent needs a real route);
 *   - the routing view has no usable `defaults` slot (no model set); and
 *   - at least one agent is running purely off its own frontmatter (never
 *     touched routing.json) rather than a hand-written `backend:` block —
 *     those agents (e.g. the MCP reviewers) intentionally keep their own
 *     backend and don't need a default route.
 *
 * p23-t5 follow-up: reviewed whether provider "codex" needs this same
 * nudge. It does not — `effectiveHarness` here is a HOST selection
 * (claude-code vs opencode), and codex is not a third host in that sense;
 * codex-reviewer is subscription-billed via the ChatGPT plan the same way
 * claude-code agents are, so the "no subscription fallback" condition this
 * function guards against doesn't hold for it. Left opencode-only.
 */
export function computeNeedsDefaultRoute(effectiveHarness: string, view: Pick<RoutingView, "defaults" | "agents">): boolean {
  if (effectiveHarness !== "opencode") return false;
  const hasDefaultModel = typeof view.defaults?.model === "string" && view.defaults.model.trim() !== "";
  if (hasDefaultModel) return false;
  return view.agents.some((a) => a.provenance === "frontmatter" && !a.handWrittenBackend);
}

// ---------------------------------------------------------------------------
// scripts-dir discovery + generator invocation
// ---------------------------------------------------------------------------

/**
 * Resolve `<scriptsDir>/scripts/{apply-routing-profile,generate-opencode-config}.mjs`.
 * `scriptsDir` is supplied by the caller — VS Code passes `context.extensionPath`,
 * the standalone passes the repo root it already resolves at startup (see
 * server.mjs's REPO_ROOT). This function does no discovery of its own beyond
 * that single candidate: per-host discovery is the caller's job (it already
 * knows its own install layout); this just fails loudly, listing exactly
 * what it tried, when the caller's candidate doesn't pan out.
 */
function resolveGeneratorScripts(scriptsDir: string): { claude: string; opencode: string } {
  const claude = path.join(scriptsDir, "scripts", "apply-routing-profile.mjs");
  const opencode = path.join(scriptsDir, "scripts", "generate-opencode-config.mjs");
  const missing: string[] = [];
  if (!fs.existsSync(claude)) missing.push(claude);
  if (!fs.existsSync(opencode)) missing.push(opencode);
  if (missing.length > 0) {
    throw new Error(
      `routingHostOps: routing generator script(s) not found. Tried: ${missing.join(", ")}. ` +
        "Pass the correct scriptsDir (the TycoonAgents install root that contains scripts/)."
    );
  }
  return { claude, opencode };
}

/**
 * Resolve `<scriptsDir>/scripts/generate-codex-config.mjs` — the Codex
 * doctrine (AGENTS.md managed block + codex-agents.toml.generated)
 * generator, separate from resolveGeneratorScripts because it only needs
 * to run when the effective harness is "codex" (unlike the claude/opencode
 * pair above, which run on every save regardless of harness).
 */
function resolveCodexGeneratorScript(scriptsDir: string): string {
  const codex = path.join(scriptsDir, "scripts", "generate-codex-config.mjs");
  if (!fs.existsSync(codex)) {
    throw new Error(
      `routingHostOps: Codex config generator script not found. Tried: ${codex}. ` +
        "Pass the correct scriptsDir (the TycoonAgents install root that contains scripts/)."
    );
  }
  return codex;
}

/**
 * Run scripts/generate-codex-config.mjs for `root` (write, not --check),
 * resolving the script from `scriptsDir` the same way
 * resolveGeneratorScripts resolves the claude/opencode pair — reused by
 * saveRoutingProfile (when effectiveHarness === "codex"), the panel's
 * INSTALL_CODEX_HOOKS handler, and both hosts' provider-switch-to-codex
 * handlers, so all four triggers share one resolution + spawn path. Never
 * throws: script-not-found and spawn failures both come back as a
 * ScriptRunResult with code !== 0 and a human-readable `output`, exactly
 * like runScript's own failure shape, so callers can surface it uniformly
 * (e.g. "Couldn't update AGENTS.md for Codex: <output>").
 */
export function runCodexConfigGenerator(root: string, scriptsDir: string, nodeBin?: string): ScriptRunResult {
  const bin = nodeBin ?? process.execPath;
  let scriptPath: string;
  try {
    scriptPath = resolveCodexGeneratorScript(scriptsDir);
  } catch (err) {
    return { code: -1, output: err instanceof Error ? err.message : String(err) };
  }
  return runScript(bin, scriptPath, root, []);
}

const SCRIPT_TIMEOUT_MS = 15000;
const OUTPUT_CAP = 4000;

function runScript(nodeBin: string, scriptPath: string, root: string, extraArgs: string[]): ScriptRunResult {
  try {
    const result = spawnSync(nodeBin, [scriptPath, "--root", root, ...extraArgs], {
      encoding: "utf8",
      timeout: SCRIPT_TIMEOUT_MS,
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const output = `${stdout}${stderr}`.trim().slice(0, OUTPUT_CAP);
    if (result.error) {
      return { code: -1, output: `${output}\n${result.error.message}`.trim().slice(0, OUTPUT_CAP) };
    }
    return { code: result.status ?? -1, output };
  } catch (err) {
    return { code: -1, output: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// save / clear
// ---------------------------------------------------------------------------

export interface SaveRoutingProfileOptions {
  root: string;
  profile: unknown;
  scriptsDir: string;
  nodeBin?: string;
  /** Override for the per-user Claude subscription opt-in (tests); defaults to the stored flag. */
  claudeSubscriptionOptIn?: boolean;
  /** p20-t1: the caller's already-resolved effective harness (e.g. from
   *  describeProviderSelection). When it is anything other than "opencode",
   *  a profile carrying an `orchestrator` slot is rejected outright — the
   *  orchestrator is OpenCode's concept, and under Claude Code that slot
   *  would silently do nothing. Omitted (undefined) means "unknown" and
   *  skips this check, preserving existing callers that don't yet pass it.
   *  p23-t5 follow-up: reviewed for codex — the `orchestrator` profile slot
   *  is an OpenCode-native concept (its own orchestrator.md/backend
   *  wiring); codex has no equivalent slot to guard, so this rejection
   *  stays keyed on effectiveHarness !== "opencode" rather than adding a
   *  codex-specific branch. */
  effectiveHarness?: string;
}

/**
 * Validate, then atomically write, `<root>/.claude/tycoon/routing.json`, then
 * run both generators (check, then real writes). Never throws:
 * - An invalid or secret-carrying profile is rejected (via a round-trip
 *   through loadRoutingProfile on a TEMP copy — the same validator, and the
 *   same scanForSecretNames pass, routing.json's own loader already runs)
 *   and NOTHING is written, including the real routing.json.
 * - A missing generator script fails the whole call with one error, no writes.
 */
/**
 * GEMINI_API_KEY presence for the codex+google dispatchability check:
 * process.env first, then the per-user local env value store (same
 * fallback order as hooks/dispatcherAdapters.cjs's resolveVendorEnv() and
 * the webview's "stored" treatment) — never the value itself, only a
 * synthetic marker fed into isFallbackTargetDispatchable's `env` param so
 * the real secret never passes through this function or any error message.
 */
function buildFallbackDispatchEnv(): Record<string, string | undefined> {
  const present =
    (typeof process.env["GEMINI_API_KEY"] === "string" && process.env["GEMINI_API_KEY"] !== "") ||
    (() => {
      try {
        return localEnvHasValue("GEMINI_API_KEY");
      } catch {
        return false;
      }
    })();
  return { GEMINI_API_KEY: present ? "present" : undefined };
}

/**
 * Walk every `fallback` chain entry (any agent slot, orchestrator, defaults)
 * plus the top-level `defaultFallback`, recording one error string per
 * target isFallbackTargetDispatchable() rejects for `harness`. Named after
 * the offending JSON path so the panel can point at the exact entry.
 */
function collectUndispatchableFallbackTargets(profile: RoutingProfile, harness: string): string[] {
  const errors: string[] = [];
  const dispatchEnv = buildFallbackDispatchEnv();
  // Only actual FALLBACK targets are checked — a primary agents[id]/
  // orchestrator/defaults slot is the intentionally-chosen main route and
  // is out of scope here, matching p25-t4's "chain entry and defaultFallback"
  // wording.
  const walkChain = (chain: RoutingSlot[] | undefined, jsonPath: string): void => {
    if (!Array.isArray(chain)) return;
    chain.forEach((child, idx) => {
      const childPath = `${jsonPath}[${idx}]`;
      const check = isFallbackTargetDispatchable(child, harness, dispatchEnv);
      if (!check.ok) {
        errors.push(`${childPath}: ${check.reason ?? "not dispatchable under the current harness"}`);
      }
      walkChain(child.fallback, `${childPath}.fallback`);
    });
  };
  for (const agentId of Object.keys(profile.agents ?? {})) {
    walkChain(profile.agents[agentId]?.fallback, `agents.${agentId}.fallback`);
  }
  walkChain(profile.orchestrator?.fallback, "orchestrator.fallback");
  if (profile.defaultFallback) {
    const check = isFallbackTargetDispatchable(profile.defaultFallback, harness, dispatchEnv);
    if (!check.ok) {
      errors.push(`defaultFallback: ${check.reason ?? "not dispatchable under the current harness"}`);
    }
    walkChain(profile.defaultFallback.fallback, "defaultFallback.fallback");
  }
  return errors;
}

/** JSON of every slot in a profile that uses the Claude subscription route (top-level slots and their fallbacks). */
function collectClaudeSubscriptionSlots(profile: unknown): string[] {
  const out: string[] = [];
  const visit = (slot: unknown): void => {
    if (!slot || typeof slot !== "object") return;
    const sl = slot as Record<string, unknown>;
    if (usesClaudeSubscriptionRoute(sl as ClaudeRouteSlotLike)) out.push(JSON.stringify(sl));
    if (Array.isArray(sl["fallback"])) sl["fallback"].forEach(visit);
  };
  if (!profile || typeof profile !== "object") return out;
  const p = profile as Record<string, unknown>;
  visit(p["defaults"]);
  visit(p["defaultFallback"]);
  visit(p["orchestrator"]);
  if (p["agents"] && typeof p["agents"] === "object") Object.values(p["agents"] as Record<string, unknown>).forEach(visit);
  return out;
}

export function saveRoutingProfile(opts: SaveRoutingProfileOptions): SaveRoutingResult {
  const { root, profile } = opts;
  const nodeBin = opts.nodeBin ?? process.execPath;

  // Guard against a missing/malformed profile up front: JSON.stringify(undefined)
  // returns the bare JS value `undefined`, which string-concatenation then
  // silently coerces to the text "undefined\n" instead of throwing — that
  // text is valid-looking enough to sail past the naive serialization check
  // below and only fail much later (an opaque "validation failed" JSON parse
  // error). A caller passing through a mis-wired transport (e.g. reading the
  // profile off the wrong field of an inbound message) should get an
  // explicit error naming the real cause instead.
  if (profile === undefined || profile === null || typeof profile !== "object") {
    return {
      ok: false,
      errors: [`routing profile is missing or not an object (got ${profile === null ? "null" : typeof profile})`],
      check: EMPTY_SAVE_RESULT_SCRIPTS,
      write: EMPTY_SAVE_RESULT_SCRIPTS,
    };
  }

  // p20-t1 (review fix): reject an `orchestrator` slot under a non-OpenCode
  // harness only when it actually CHANGES the on-disk slot — the webview's
  // sparse profile assembly carries an existing orchestrator slot through
  // unmodified on every save, so an unchanged carry-through (or no incoming
  // slot at all) must never block an unrelated per-agent save under Claude
  // Code. Compared by JSON-normalized deep-equality so key order never
  // causes a false mismatch.
  const incomingOrchestrator = (profile as Record<string, unknown>)["orchestrator"];
  if (
    opts.effectiveHarness !== undefined &&
    opts.effectiveHarness !== "opencode" &&
    incomingOrchestrator !== undefined &&
    incomingOrchestrator !== null
  ) {
    const existingOrchestrator = loadRoutingProfile(root).profile?.orchestrator ?? null;
    const changed = JSON.stringify(incomingOrchestrator) !== JSON.stringify(existingOrchestrator ?? null);
    if (changed) {
      return {
        ok: false,
        errors: [
          "Orchestrator routing applies only when OpenCode runs your agents; set the Claude Code session model with /model.",
        ],
        check: EMPTY_SAVE_RESULT_SCRIPTS,
        write: EMPTY_SAVE_RESULT_SCRIPTS,
      };
    }
  }

  // Claude subscription opt-in: under OpenCode, a slot that NEWLY uses the
  // claude -p bridge (not already on disk) is rejected until the user opts in.
  // Slots already saved that way carry through unchanged (grandfathered).
  if (opts.effectiveHarness === "opencode" && !(opts.claudeSubscriptionOptIn ?? readClaudeSubscriptionOptIn())) {
    const existingRoutes = new Set(collectClaudeSubscriptionSlots(loadRoutingProfile(root).profile));
    const added = collectClaudeSubscriptionSlots(profile).filter((j) => !existingRoutes.has(j));
    if (added.length > 0) {
      return {
        ok: false,
        errors: [claudeSubscriptionBlockedMessage("Routing Claude through the claude CLI")],
        check: EMPTY_SAVE_RESULT_SCRIPTS,
        write: EMPTY_SAVE_RESULT_SCRIPTS,
      };
    }
  }

  const json = (() => {
    try {
      return JSON.stringify(profile, null, 2) + "\n";
    } catch (err) {
      return undefined;
    }
  })();
  if (json === undefined) {
    return {
      ok: false,
      errors: ["routing profile is not JSON-serializable"],
      check: EMPTY_SAVE_RESULT_SCRIPTS,
      write: EMPTY_SAVE_RESULT_SCRIPTS,
    };
  }

  // Round-trip validate on a throwaway temp project before touching the real
  // file — this reuses loadRoutingProfile's own schema + scanForSecretNames
  // pass rather than re-implementing it here.
  let tempRoot: string | undefined;
  try {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-routing-validate-"));
    const tempDir = path.join(tempRoot, ".claude", "tycoon");
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "routing.json"), json, "utf8");
    const { profile: validated, errors: validationErrors } = loadRoutingProfile(tempRoot);
    if (!validated || validationErrors.length > 0) {
      return {
        ok: false,
        errors: validationErrors.length > 0 ? validationErrors : ["routing profile failed validation"],
        check: EMPTY_SAVE_RESULT_SCRIPTS,
        write: EMPTY_SAVE_RESULT_SCRIPTS,
      };
    }

    // p25-t4: reject any chain entry or defaultFallback that cannot
    // actually dispatch under the caller's current harness. Only runs when
    // the caller supplied effectiveHarness (undefined skips this, same
    // "unknown harness" posture the orchestrator guard above takes) — a
    // hard block here, not a partial write, since a silently-unreachable
    // fallback target is worse than a rejected save.
    if (opts.effectiveHarness !== undefined) {
      const dispatchErrors = collectUndispatchableFallbackTargets(validated, opts.effectiveHarness);
      if (dispatchErrors.length > 0) {
        return {
          ok: false,
          errors: dispatchErrors,
          check: EMPTY_SAVE_RESULT_SCRIPTS,
          write: EMPTY_SAVE_RESULT_SCRIPTS,
        };
      }
    }
  } catch (err) {
    return {
      ok: false,
      errors: [`routing profile validation failed: ${err instanceof Error ? err.message : String(err)}`],
      check: EMPTY_SAVE_RESULT_SCRIPTS,
      write: EMPTY_SAVE_RESULT_SCRIPTS,
    };
  } finally {
    if (tempRoot) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        // best-effort cleanup only
      }
    }
  }

  let scripts: { claude: string; opencode: string };
  try {
    scripts = resolveGeneratorScripts(opts.scriptsDir);
  } catch (err) {
    return {
      ok: false,
      errors: [err instanceof Error ? err.message : String(err)],
      check: EMPTY_SAVE_RESULT_SCRIPTS,
      write: EMPTY_SAVE_RESULT_SCRIPTS,
    };
  }

  // Atomic write: tmp file in the same directory, then rename.
  try {
    const finalDir = path.join(root, ".claude", "tycoon");
    fs.mkdirSync(finalDir, { recursive: true });
    const finalPath = path.join(finalDir, "routing.json");
    const tmpPath = path.join(finalDir, `.routing.json.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    fs.writeFileSync(tmpPath, json, "utf8");
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    return {
      ok: false,
      errors: [`failed to write routing.json: ${err instanceof Error ? err.message : String(err)}`],
      check: EMPTY_SAVE_RESULT_SCRIPTS,
      write: EMPTY_SAVE_RESULT_SCRIPTS,
    };
  }

  // The OpenCode generator (project .opencode/ + opencode.json + the global config) only runs when OpenCode is the harness.
  const resolvedHarness = resolveHarnessFor(root, opts.effectiveHarness);
  const runOpencode = resolvedHarness === "opencode";
  // Claude Code only: a bridged foreign-provider slot turns the agent file into a managed relay.
  const relayArgs = resolvedHarness === "claude-code" ? ["--relay"] : [];
  const check = {
    claude: runScript(nodeBin, scripts.claude, root, ["--check", ...relayArgs]),
    opencode: runOpencode ? runScript(nodeBin, scripts.opencode, root, ["--check"]) : OPENCODE_SKIPPED_RESULT,
  };
  const write = {
    claude: runScript(nodeBin, scripts.claude, root, relayArgs),
    opencode: runOpencode ? runScript(nodeBin, scripts.opencode, root, []) : OPENCODE_SKIPPED_RESULT,
  };
  writeLastApplied(root, write, runOpencode);

  // Codex-doctrine-gap follow-up (trigger (c)): a Routing save only needs
  // to refresh AGENTS.md's Codex block / codex-agents.toml.generated when
  // Codex is the effective harness — under claude-code/opencode this
  // generator's output is irrelevant, so it stays out of `check`/`write`
  // above (which run unconditionally for every save) and only appears on
  // the result when it actually ran.
  let codexResult: ScriptRunResult | undefined;
  if (opts.effectiveHarness === "codex") {
    codexResult = runCodexConfigGenerator(root, opts.scriptsDir, nodeBin);
  }

  // codexResult failure never flips `ok` — routing.json itself saved fine
  // and the claude/opencode generators (the ones every save depends on)
  // succeeded; a Codex doctrine-refresh failure is surfaced separately
  // (panel.ts turns codexResult.code !== 0 into a non-blocking message)
  // rather than reported as the whole save having failed.
  const ok = write.claude.code === 0 && write.opencode.code === 0;
  const relayNotices = parseRelayNotices(write.claude.output);
  return { ok, errors: [], check, write, ...(codexResult !== undefined ? { codex: codexResult } : {}), ...(relayNotices.length > 0 ? { relayNotices } : {}) };
}

export interface ClearRoutingProfileOptions {
  root: string;
  scriptsDir: string;
  nodeBin?: string;
  /** Effective harness; resolved from the project when omitted. The OpenCode generator runs only under "opencode". */
  effectiveHarness?: string;
}

/** Delete routing.json (if present) and rerun both generators so agents fall back to frontmatter/alias/default. Never throws. */
export function clearRoutingProfile(opts: ClearRoutingProfileOptions): SaveRoutingResult {
  const { root } = opts;
  const nodeBin = opts.nodeBin ?? process.execPath;

  try {
    fs.unlinkSync(path.join(root, ".claude", "tycoon", "routing.json"));
  } catch {
    // Missing file is fine — clearing an already-absent profile is a no-op on disk.
  }

  let scripts: { claude: string; opencode: string };
  try {
    scripts = resolveGeneratorScripts(opts.scriptsDir);
  } catch (err) {
    return {
      ok: false,
      errors: [err instanceof Error ? err.message : String(err)],
      check: EMPTY_SAVE_RESULT_SCRIPTS,
      write: EMPTY_SAVE_RESULT_SCRIPTS,
    };
  }

  // The OpenCode generator (project .opencode/ + opencode.json + the global config) only runs when OpenCode is the harness.
  const runOpencode = resolveHarnessFor(root, opts.effectiveHarness) === "opencode";
  const check = {
    claude: runScript(nodeBin, scripts.claude, root, ["--check"]),
    opencode: runOpencode ? runScript(nodeBin, scripts.opencode, root, ["--check"]) : OPENCODE_SKIPPED_RESULT,
  };
  const write = {
    claude: runScript(nodeBin, scripts.claude, root, []),
    opencode: runOpencode ? runScript(nodeBin, scripts.opencode, root, []) : OPENCODE_SKIPPED_RESULT,
  };
  writeLastApplied(root, write, runOpencode);

  const ok = write.claude.code === 0 && write.opencode.code === 0;
  const relayNotices = parseRelayNotices(write.claude.output);
  return { ok, errors: [], check, write, ...(relayNotices.length > 0 ? { relayNotices } : {}) };
}
