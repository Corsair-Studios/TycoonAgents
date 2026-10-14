/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Multi-LLM bridge picker + "Needs setup" status. Host-agnostic (no `vscode`
// import) so src/host/vscode/panel.ts and standalone/src/server.mjs share one
// implementation, the same posture as agentSettingsRoute.ts.
//
// A bridge agent (codex-reviewer, grok-reviewer, ...) is only useful when its
// MCP server is configured in the project's .mcp.json (Claude Code harness) or
// reachable through the TycoonAgents dispatcher (Codex harness, where nothing is
// written to .mcp.json) AND its login / key is present. This module:
//   - describes that setup state per agent (names only, never values),
//   - installs a user-chosen subset of the pack's agents together with the
//     servers they need (the shared openai-compatible server exactly once),
//   - validates and builds "Other (OpenAI-compatible endpoint)" agents.
// On the Claude Code harness a server the user installs is registered at Claude
// local scope (see claudeLocalMcp.ts), so it loads without the project-file
// approval prompt. No MCP approval key is ever written.
// ---------------------------------------------------------------------------

import * as fs from "fs";
import * as path from "path";
import { readAgentFrontmatter, parseAgentBackend } from "./agentBackend";
import type { Backend } from "./agentBackend";
import { probeEnv } from "./routingHostOps";
import type { EnvProbeEntry } from "./routingHostOps";
import {
  VENDOR_KEY_SPECS,
  vendorKeySpecFor,
  customEndpointNameProblem,
  customEndpointUrlProblem,
  customKeyNameProblem,
} from "./vendorKeys";
import { shouldSkipPackAgentForClaudeSubscription } from "./claudeSubscriptionBridge";
import { isSafeAgentId } from "../host/vscode/agentConfig";
import { hasMcpServer, mergeMcpServer, resolveConfigForPlatform, isUnpinnedMcpConfig } from "../host/vscode/mcpCatalog";
import { buildAgentMarkdown, agentMarkdownHasTycoonMarker, regenerateAgentMarkdownKeepingExtras } from "../host/vscode/packCatalog";
import type { PackAgent } from "../host/vscode/packCatalog";
import { withHookWriteAsync } from "./hookWriteGate";
import { hasLocalMcpServer, localizeMcpConfig, readLocalMcpServers, withLocalMcpServers } from "./claudeLocalMcp";
import { providedMcpEntryIsOurs, providedMcpKeys } from "./providedMcp";
import type { LocalMcpOps } from "./claudeLocalMcp";

/** Pack id of the picker pack in media/packs/catalog.json. */
export const BRIDGE_PACK_ID = "multi-llm";
/** The shared OpenAI-compatible MCP server id (grok / kimi / mistral / custom). */
export const OPENAI_COMPAT_SERVER = "openai-compatible";
/** Backend vendor written for user-defined "Other" endpoints (non-fixed, so the dispatcher treats it as custom). */
export const CUSTOM_VENDOR = "custom";

/** Picker labels and order, keyed by pack agent id. */
const PICKER_LABELS: Array<[string, string]> = [
  ["codex-reviewer", "Codex"],
  ["gemini-reviewer", "Gemini"],
  ["grok-reviewer", "Grok"],
  ["kimi-reviewer", "Kimi"],
  ["mistral-reviewer", "Mistral"],
  ["claude-worker", "Claude worker (subscription)"],
];

/** "pending" = listed only in the project .mcp.json, so Claude Code has not loaded it (Claude Code harness only). */
export type BridgeServerState = "installed" | "pending" | "missing" | "dispatcher" | "none";
export type BridgeKeyState = "ok" | "missing" | "signin" | "none";

export interface BridgeEnvStatus {
  /** Variable NAME only, never a value. */
  name: string;
  present: boolean;
  required: boolean;
  kind: "credential" | "endpoint";
}

export interface BridgeSetupInfo {
  /** MCP server this agent needs, or null for a native agent. */
  server: string | null;
  serverState: BridgeServerState;
  keyState: BridgeKeyState;
  /** Sign-in CLI label ("Codex", "Antigravity", "Claude") for sign-in vendors. */
  signIn?: string;
  env: BridgeEnvStatus[];
  /** True when the server is missing or a required key / URL is missing. */
  needsSetup: boolean;
  /** Short human reasons, names only. */
  reasons: string[];
}

export interface BridgeSetupContext {
  root: string;
  harness: string;
  env: NodeJS.ProcessEnv;
  /** Test seam; defaults to probeEnv (process env + per-user store). */
  probe?: (names: string[]) => Record<string, EnvProbeEntry>;
  /** Parsed .mcp.json override (tests); defaults to reading <root>/.mcp.json. */
  mcpConfig?: Record<string, unknown>;
}

/** True on the harness where bridges are written to .mcp.json (Claude Code). Other hosts use the dispatcher. */
export function harnessUsesMcpJson(harness: string): boolean {
  return (harness || "claude-code").toLowerCase() === "claude-code";
}

/** Strict read: distinguishes "no file" (ok, {}) from "file exists but is unreadable / not a JSON object". */
export function readProjectMcpConfigStrict(root: string): { config: Record<string, unknown>; unreadable: boolean } {
  const file = path.join(root, ".mcp.json");
  if (!fs.existsSync(file)) return { config: {}, unreadable: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return { config: parsed as Record<string, unknown>, unreadable: false };
  } catch {
    /* fall through */
  }
  return { config: {}, unreadable: true };
}

/**
 * The servers a project can load: its .mcp.json plus, on the Claude Code harness
 * ONLY, this user's Claude local-scope registrations for it. Other harnesses
 * never read ~/.claude.json.
 */
export function readProjectMcpConfig(root: string, harness: string): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
    if (parsed !== null && typeof parsed === "object") base = parsed as Record<string, unknown>;
  } catch {
    /* missing / invalid => {} */
  }
  return harnessUsesMcpJson(harness) ? withLocalMcpServers(base, root) : base;
}

export type McpServerState = "installed" | "pending" | "absent";

/** The project's .mcp.json alone (no local-scope merge). Never throws. */
export function readProjectFileMcpConfig(root: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
    if (parsed !== null && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    /* missing / invalid => {} */
  }
  return {};
}

/**
 * THE single rule for whether an MCP server counts as installed. Claude Code harness: only
 * a Claude local-scope registration is "installed"; a server found only in the project's
 * .mcp.json is "pending" (Claude Code holds it for approval, so it is not loaded). Other
 * harnesses: .mcp.json membership is "installed" and "pending" never occurs. The MCP tab,
 * Packs tab, Multi-LLM picker and the standalone payloads all call this.
 * `fileConfig` is an optional pre-read project .mcp.json.
 */
export function mcpServerState(root: string, harness: string, id: string, fileConfig?: Record<string, unknown>): McpServerState {
  const file = fileConfig ?? readProjectFileMcpConfig(root);
  // A server owned by another product may be registered under more than one key (providedMcpKeys).
  const keys = providedMcpKeys(id);
  const fileServers = (file as { mcpServers?: unknown }).mcpServers;
  const inFile = keys.some((k) => hasMcpServer(file, k) && providedMcpEntryIsOurs(id, (fileServers as Record<string, unknown>)[k]));
  if (!harnessUsesMcpJson(harness)) return inFile ? "installed" : "absent";
  if (keys.length === 1 ? hasLocalMcpServer(root, id) : (() => { const local = readLocalMcpServers(root); return keys.some((k) => Object.prototype.hasOwnProperty.call(local, k) && providedMcpEntryIsOurs(id, local[k])); })()) return "installed";
  return inFile ? "pending" : "absent";
}

/** The MCP server a backend needs, or null. openai-compatible transport always means the shared server. */
export function bridgeServerFor(backend: Backend | null | undefined): string | null {
  if (!backend) return null;
  if (backend.transport === "claude-native") return null;
  if (backend.mcpServer) return backend.mcpServer;
  if (backend.transport === "openai-compatible") return OPENAI_COMPAT_SERVER;
  return null;
}

/** Bridge MCP servers TycoonAgents may register on the user's behalf from the Agents screen. */
/** The write-access sibling of the read-only `codex` server; registered only for an agent whose card ticks "Let Codex edit files". */
export const CODEX_WRITE_SERVER = "codex-write";
const REGISTRABLE_BRIDGE_SERVERS = new Set(["codex", CODEX_WRITE_SERVER, "gemini", OPENAI_COMPAT_SERVER, "claude-cli"]);

/** True for a bridge server TycoonAgents may register on the user's behalf (the slot card's Enable MCP). */
export function isRegistrableBridgeServer(name: unknown): name is string {
  return typeof name === "string" && REGISTRABLE_BRIDGE_SERVERS.has(name);
}

/** Slot vendor -> bridge server, for slots that do not name one. Anthropic is native: no server. */
const VENDOR_BRIDGE_SERVER: Record<string, string> = {
  openai: "codex",
  google: "gemini",
  xai: OPENAI_COMPAT_SERVER,
  mistral: OPENAI_COMPAT_SERVER,
  moonshot: OPENAI_COMPAT_SERVER,
};

function slotRouteKey(slot: unknown): string {
  if (!slot || typeof slot !== "object") return "";
  const s = slot as Record<string, unknown>;
  return JSON.stringify([s["vendor"], s["model"], s["transport"], s["mcpServer"], s["endpointEnv"]]);
}

/**
 * Bridge servers that THIS Save newly needs (deduplicated, stable order): only agent slots whose
 * vendor/model/route differs from the previously saved profile (`previous`, read from disk before
 * the write). An unchanged slot never registers anything, so a deliberate removal sticks and a
 * repo-shipped profile cannot trigger registration. The user choosing a foreign vendor/model is
 * the consent to register that vendor's bridge at Claude local scope. Native slots need nothing.
 */
export function bridgeServersForRoutingProfile(profile: unknown, previous?: unknown): string[] {
  const out: string[] = [];
  const agents = profile && typeof profile === "object" ? (profile as { agents?: unknown }).agents : undefined;
  if (!agents || typeof agents !== "object") return out;
  const prevAgents = previous && typeof previous === "object" ? (previous as { agents?: unknown }).agents : undefined;
  const prev = prevAgents && typeof prevAgents === "object" ? (prevAgents as Record<string, unknown>) : {};
  for (const [id, slot] of Object.entries(agents as Record<string, unknown>)) {
    if (!slot || typeof slot !== "object") continue;
    if (Object.prototype.hasOwnProperty.call(prev, id) && slotRouteKey(prev[id]) === slotRouteKey(slot)) continue;
    const s = slot as { vendor?: unknown; transport?: unknown; mcpServer?: unknown; endpointEnv?: unknown };
    const vendor = typeof s.vendor === "string" ? s.vendor.trim().toLowerCase() : "";
    if (vendor === "anthropic") continue; // runs natively on Claude Code (as claude-worker does): no bridge
    let server: string | undefined;
    if (typeof s.mcpServer === "string" && s.mcpServer !== "") server = s.mcpServer;
    else if (s.transport === "openai-compatible") server = OPENAI_COMPAT_SERVER;
    else if (vendor !== "" && VENDOR_BRIDGE_SERVER[vendor] !== undefined) server = VENDOR_BRIDGE_SERVER[vendor];
    else if (vendor !== "" && vendor !== "anthropic" && typeof s.endpointEnv === "string" && s.endpointEnv !== "") server = OPENAI_COMPAT_SERVER;
    if (server !== undefined && REGISTRABLE_BRIDGE_SERVERS.has(server) && !out.includes(server)) out.push(server);
  }
  return out;
}

/**
 * True while any saved slot (agent, defaults, orchestrator or a fallback entry) still names the
 * write-access Codex server. When false the host removes `codex-write` from Claude local scope.
 */
export function profileUsesCodexWrite(profile: unknown): boolean {
  try {
    return JSON.stringify(profile ?? null).includes(`"mcpServer":"${CODEX_WRITE_SERVER}"`);
  } catch {
    return false;
  }
}

/** Describe one backend's setup state. Pure given the context. Returns null for a native (non-bridge) agent. */
export function describeBackendSetup(backend: Backend | null | undefined, ctx: BridgeSetupContext): BridgeSetupInfo | null {
  const server = bridgeServerFor(backend);
  if (!backend || server === null) return null;
  // An Anthropic-vendor agent on the Claude Code harness runs as a normal Claude
  // subagent on the user's sign-in: no bridge, so no setup badge. (Codex and
  // OpenCode keep the bridge behaviour.)
  if ((ctx.harness || "claude-code").toLowerCase() === "claude-code" && String(backend.vendor).toLowerCase() === "anthropic") return null;
  const probe = ctx.probe ?? ((names: string[]) => probeEnv(names, ctx.env));
  const rows: Array<{ name: string; required: boolean; kind: "credential" | "endpoint" }> = [];
  let signIn: string | undefined;
  const spec = vendorKeySpecFor(backend.vendor);
  if (spec) {
    if (spec.auth === "signin") signIn = spec.signIn ?? spec.label;
    for (const r of spec.rows) rows.push({ name: r.env, required: r.required, kind: r.kind });
  } else if (backend.transport === "openai-compatible") {
    if (backend.endpointEnv) rows.push({ name: backend.endpointEnv, required: true, kind: "endpoint" });
    if (backend.apiKeyEnv) rows.push({ name: backend.apiKeyEnv, required: false, kind: "credential" });
  }
  const probed = probe(rows.map((r) => r.name));
  const env: BridgeEnvStatus[] = rows.map((r) => {
    const e = probed[r.name];
    return { name: r.name, present: !!(e && (e.env || e.stored)), required: r.required, kind: r.kind };
  });
  // Fixed vendors fall back to a default base URL, so only a missing REQUIRED row counts.
  const missingRequired = env.filter((e) => e.required && !e.present);
  let keyState: BridgeKeyState;
  if (missingRequired.length > 0) keyState = "missing";
  else if (signIn !== undefined && env.length === 0) keyState = "signin";
  else if (env.some((e) => e.kind === "credential")) keyState = "ok";
  else keyState = signIn !== undefined ? "signin" : "none";

  let serverState: BridgeServerState;
  if (!harnessUsesMcpJson(ctx.harness)) serverState = "dispatcher";
  else if (ctx.mcpConfig) serverState = hasMcpServer(ctx.mcpConfig, server) ? "installed" : "missing";
  else {
    const st = mcpServerState(ctx.root, ctx.harness, server);
    serverState = st === "installed" ? "installed" : st === "pending" ? "pending" : "missing";
  }

  const reasons: string[] = [];
  if (serverState === "missing") reasons.push(`MCP server "${server}" is not installed for this project`);
  if (serverState === "pending") reasons.push(`MCP server "${server}" is in .mcp.json but not enabled in Claude Code`);
  for (const m of missingRequired) reasons.push(`${m.name} is not set`);
  return {
    server,
    serverState,
    keyState,
    ...(signIn !== undefined ? { signIn } : {}),
    env,
    needsSetup: serverState === "missing" || serverState === "pending" || keyState === "missing",
    reasons,
  };
}

/**
 * Slot editor payload (Claude Code harness): per-vendor bridge setup plus the install state of every
 * registrable bridge server, so the card can say whether Save will set the server up. Names only.
 */
export interface VendorBridgeSetups {
  servers: Record<string, McpServerState>;
  vendors: Record<string, BridgeSetupInfo>;
}

export function describeVendorBridgeSetups(ctx: BridgeSetupContext): VendorBridgeSetups {
  const servers: Record<string, McpServerState> = {};
  const vendors: Record<string, BridgeSetupInfo> = {};
  if (!ctx.root || !harnessUsesMcpJson(ctx.harness)) return { servers, vendors };
  const fileConfig = ctx.mcpConfig ?? readProjectFileMcpConfig(ctx.root);
  for (const server of REGISTRABLE_BRIDGE_SERVERS) servers[server] = mcpServerState(ctx.root, ctx.harness, server, fileConfig);
  for (const [vendor, server] of Object.entries(VENDOR_BRIDGE_SERVER)) {
    const backend: Backend = {
      vendor,
      transport: server === OPENAI_COMPAT_SERVER ? "openai-compatible" : "mcp",
      mcpServer: server,
      model: "",
      costModelClass: "metered",
    };
    try {
      const info = describeBackendSetup(backend, { ...ctx, mcpConfig: undefined });
      if (info) vendors[vendor] = info;
    } catch {
      /* no entry for this vendor */
    }
  }
  return { servers, vendors };
}

/** Setup info for every installed agent file that declares a bridge backend, keyed by agent id. */
export function describeBridgeSetup(ctx: BridgeSetupContext): Record<string, BridgeSetupInfo> {
  const out: Record<string, BridgeSetupInfo> = {};
  const agentsDir = path.join(ctx.root, ".claude", "agents");
  let files: string[] = [];
  try {
    files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return out;
  }
  const withMcp: BridgeSetupContext = ctx;
  for (const f of files) {
    try {
      const fm = readAgentFrontmatter(fs.readFileSync(path.join(agentsDir, f), "utf8"));
      if (fm["backend"] === undefined || fm["backend"] === null) continue;
      const info = describeBackendSetup(parseAgentBackend(fm), withMcp);
      if (info) out[f.slice(0, -3)] = info;
    } catch {
      /* unparseable agent file: no badge */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Picker payload (attached to the pack entry in getPacks).
// ---------------------------------------------------------------------------

export interface BridgePickerModel {
  agentId: string;
  label: string;
  /** Agent file already present: the row is pre-checked. */
  installed: boolean;
  setup: BridgeSetupInfo | null;
}

export interface BridgePickerOther {
  agentId: string;
  label: string;
  model: string;
  setup: BridgeSetupInfo | null;
}

export interface BridgePickerPayload {
  models: BridgePickerModel[];
  /** Existing "Other" agents (custom endpoints), shown read-only with their status. */
  others: BridgePickerOther[];
  /** True when bridges go through the dispatcher and no .mcp.json entry is written. */
  dispatcherHost: boolean;
  /** Env var names the Other form must not use as a base URL variable are validated host-side; this is only a hint. */
  endpointNameHint: string;
}

export function buildBridgePicker(packAgents: PackAgent[], ctx: BridgeSetupContext): BridgePickerPayload {
  const c: BridgeSetupContext = ctx;
  const byId = new Map(packAgents.map((a) => [a.id, a] as const));
  const agentExists = (id: string): boolean => fs.existsSync(path.join(ctx.root, ".claude", "agents", `${id}.md`));
  const models: BridgePickerModel[] = [];
  for (const [id, label] of PICKER_LABELS) {
    const a = byId.get(id);
    if (!a) continue;
    models.push({ agentId: id, label, installed: agentExists(id), setup: describeBackendSetup(a.backend, c) });
  }
  const others: BridgePickerOther[] = [];
  const packIds = new Set(packAgents.map((a) => a.id));
  try {
    const agentsDir = path.join(ctx.root, ".claude", "agents");
    for (const f of fs.readdirSync(agentsDir)) {
      if (!f.endsWith(".md")) continue;
      const id = f.slice(0, -3);
      if (packIds.has(id)) continue;
      try {
        const text = fs.readFileSync(path.join(agentsDir, f), "utf8");
        if (!agentMarkdownHasTycoonMarker(text) || !/^tycoon_pack:\s*multi-llm\s*$/m.test(text)) continue;
        const backend = parseAgentBackend(readAgentFrontmatter(text));
        if (backend.vendor !== CUSTOM_VENDOR) continue;
        const nameMatch = /^#\s+(.+)$/m.exec(text);
        others.push({ agentId: id, label: nameMatch ? nameMatch[1].trim() : id, model: backend.model.replace(/^custom\//, ""), setup: describeBackendSetup(backend, c) });
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no agents dir */
  }
  return { models, others, dispatcherHost: !harnessUsesMcpJson(ctx.harness), endpointNameHint: "OLLAMA_BASE_URL" };
}

// ---------------------------------------------------------------------------
// "Other (OpenAI-compatible endpoint)" agents.
// ---------------------------------------------------------------------------

export interface OtherAgentSpec {
  /** Agent id / file slug. */
  agentId: string;
  /** Display label (H1 heading). */
  label: string;
  /** Model id sent to the endpoint (bare, e.g. "llama3"). */
  model: string;
  /** Env var NAME holding the base URL, e.g. OLLAMA_BASE_URL. */
  endpointEnv: string;
  /** Optional env var NAME holding the API key, e.g. OLLAMA_API_KEY. */
  apiKeyEnv?: string;
  /** Optional base URL VALUE: validated, then stored in the per-user env store, never in a project file. */
  baseUrl?: string;
  /** Optional one-line role. */
  role?: string;
  /** Optional routing keywords (pipe, comma or space separated). */
  keywords?: string;
}

const SLUG_RE = /^[a-z][a-z0-9-]{1,39}$/;
const RESERVED_IDS = new Set([
  "orchestrator", "primary-agent", "reviewer", "tycoon",
  // Windows reserved device names (a file named con.md / nul.md misbehaves on Windows).
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

export function validateOtherSpec(
  spec: Partial<OtherAgentSpec> | null | undefined,
  taken: Iterable<string>,
): string[] {
  const problems: string[] = [];
  if (!spec || typeof spec !== "object") return ["Missing endpoint details."];
  const id = typeof spec.agentId === "string" ? spec.agentId : "";
  const takenSet = new Set(Array.from(taken, (t) => t.toLowerCase()));
  if (!SLUG_RE.test(id) || !isSafeAgentId(id)) {
    problems.push("Agent name must be a lower-case slug: letters, digits and hyphens, starting with a letter (2-40 characters).");
  } else if (RESERVED_IDS.has(id) || takenSet.has(id.toLowerCase())) {
    problems.push(`An agent named "${id}" already exists; choose another name.`);
  }
  const label = typeof spec.label === "string" ? spec.label.trim() : "";
  if (label === "" || label.length > 60 || /[\r\n]/.test(label)) problems.push("Display label must be 1-60 characters on one line.");
  const model = typeof spec.model === "string" ? spec.model.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/.test(model)) {
    problems.push("Model id must be 1-120 characters of letters, digits and . _ : / @ + -");
  } else if (VENDOR_KEY_SPECS.some((s) => s.modelPrefix && model.toLowerCase().startsWith(s.modelPrefix)) || /^custom\//i.test(model)) {
    problems.push("Model id must not start with a built-in vendor prefix (xai/, mistral/, moonshot/, custom/); those route to fixed endpoints.");
  }
  const endpointEnv = typeof spec.endpointEnv === "string" ? spec.endpointEnv : "";
  const epProblem = customEndpointNameProblem(endpointEnv);
  if (epProblem) problems.push(epProblem);
  const apiKeyEnv = typeof spec.apiKeyEnv === "string" && spec.apiKeyEnv.trim() !== "" ? spec.apiKeyEnv.trim() : undefined;
  if (apiKeyEnv !== undefined) {
    const kp = customKeyNameProblem(apiKeyEnv, undefined, endpointEnv);
    if (kp) problems.push(kp);
  }
  const baseUrl = typeof spec.baseUrl === "string" && spec.baseUrl.trim() !== "" ? spec.baseUrl.trim() : undefined;
  if (baseUrl !== undefined) {
    const up = customEndpointUrlProblem(baseUrl);
    if (up) problems.push(up);
  }
  if (typeof spec.role === "string" && spec.role.length > 240) problems.push("Role line must be 240 characters or fewer.");
  return problems;
}

function normalizeKeywords(raw: string | undefined, id: string): string {
  const toks = (raw ?? "")
    .split(/[|,\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => /^[a-z0-9][a-z0-9._-]*$/.test(t));
  const base = toks.length > 0 ? toks : [id, "custom-endpoint", "foreign-review", "cross-vendor", "second-opinion"];
  return Array.from(new Set(base)).join("|");
}

function otherBody(spec: OtherAgentSpec, role: string, keywords: string): string {
  const keyLine = spec.apiKeyEnv
    ? `\`apiKeyEnv: "${spec.apiKeyEnv}"\` (the key is read from that variable name; it is optional for a local server)`
    : "no `apiKeyEnv` (a keyless local server)";
  return (
    "<!-- wrapper-class: relay - forwards the brief to a user-defined OpenAI-compatible endpoint via the dispatcher and reformats the returned envelope into the verdict shape; no independent verification -->\n\n" +
    "## Role\n" +
    `${role} This agent reviews; it does not author, edit, or fix. It must never review a change it authored itself. Treat every review as a single pass — it does not loop, re-review, or iterate; the orchestrator owns any retry policy.\n\n` +
    "## Calling through the dispatcher (when available)\n" +
    "The `tycoon` dispatcher is optional and is not registered on every host (it is usually absent on Claude Code). If the `mcp__tycoon__delegate` tool is in this session's tool list, make exactly ONE call to it instead of calling the vendor tool directly; if it is not in the tool list, call the vendor tool directly. Arguments:\n" +
    `- \`specialist: "${spec.agentId}"\` — this agent's own id, so the dispatcher resolves this agent's backend and routing chain.\n` +
    "- `task`: the complete, self-contained request. The delegated provider sees only this text, never this conversation.\n" +
    "- `description`: optional short label. Never set `_tycoon` — the hook injects it.\n\n" +
    "The result is the bridge envelope `{tycoonBridge:1,status,provider,model,summary,truncated,error,attempts,fellBackFrom}`. On `status: \"ok\"`, review `summary` and return the structured verdict below. If `mcp__tycoon__delegate` was called, its result is final: report it and make NO further model calls. If it is absent from this session's tool list, fall back to the direct `chat` call below. Never call both for the same request.\n\n" +
    "## Calling the endpoint\n" +
    `Use the \`openai-compatible\` MCP server's \`chat\` tool with \`model: "${spec.model.trim()}"\`, \`endpointEnv: "${spec.endpointEnv}"\` and ${keyLine}. Pass the material under review as \`prompt\`. The base URL and key values are resolved by the server from the process environment or the per-user TycoonAgents store; they never appear in this file.\n\n` +
    "## Recognizing a provider failure vs. a review outcome\n" +
    "Any `isError:true` response, or an envelope with `status` of `provider_error`, `timeout` or `empty`, is NOT a review. Report `verdict: \"provider-unavailable\"` with the raw error text — never silently upgrade an unreachable endpoint into an approval.\n\n" +
    "## Structured verdict shape\n" +
    "Return exactly one verdict object:\n\n" +
    "```\nverdict: approve | changes-requested | provider-unavailable\nsummary: <one sentence>\nfindings:\n  - file: <path>\n    line: <int or range>\n    severity: blocker | major | minor\n    summary: <one sentence, the defect only>\nprovider_error: <raw error text, only when verdict is provider-unavailable>\n```\n\n" +
    "`findings` is empty when `verdict` is `approve`. Do not add extra fields or a narrative wrapper.\n\n" +
    "## Keywords (for task routing)\n" +
    `${keywords}\n\n` +
    "## Report Format\n" +
    "Outcome first: state the verdict shape above directly. No headings, no decorative bullets, no flattery or self-assessment. Under 250 words. Do not invite a follow-up round — this is one pass.\n"
  );
}

/** Build the PackAgent for an (already validated) Other spec. Env var NAMES only. */
export function buildOtherAgent(spec: OtherAgentSpec): PackAgent {
  const role =
    (typeof spec.role === "string" && spec.role.trim() !== "" ? spec.role.trim().replace(/\s+/g, " ") : "") ||
    `Runs a cross-vendor second-opinion review of a completed change through ${spec.label.trim()} (${spec.model.trim()}) on a user-defined OpenAI-compatible endpoint and returns a structured, machine-parseable verdict.`;
  const keywords = normalizeKeywords(spec.keywords, spec.agentId);
  const backend: Backend = {
    vendor: CUSTOM_VENDOR,
    transport: "openai-compatible",
    mcpServer: OPENAI_COMPAT_SERVER,
    tools: ["chat"],
    model: `${CUSTOM_VENDOR}/${spec.model.trim()}`,
    costModelClass: "local",
    endpointEnv: spec.endpointEnv,
  };
  if (spec.apiKeyEnv && spec.apiKeyEnv.trim() !== "") backend.apiKeyEnv = spec.apiKeyEnv.trim();
  return {
    id: spec.agentId,
    name: spec.label.trim(),
    model: "haiku",
    role,
    keywords,
    backend,
    body: otherBody(spec, role, keywords),
  };
}

// ---------------------------------------------------------------------------
// MCP entry install (shared by pack picker and the "Needs setup" action).
// ---------------------------------------------------------------------------

export type McpInstallOutcome = "installed" | "exists" | { status: "skipped"; error: string };

export interface McpEntryDeps {
  platform: NodeJS.Platform;
  /** Substitute ${EXTENSION_DIR} etc. in the platform config. */
  resolveTokens: (config: unknown) => unknown;
  /** Host finalisation (dispatcher project dir, pinned Codex binary). */
  finalize: (mcpId: string, config: unknown, root: string) => unknown;
  /** Host side effect after the write (copy bridge launchers into .claude/hooks). Not called for a local-scope install. */
  afterWrite: (root: string, finalConfig: unknown) => void;
  /**
   * Claude Code harness: register at Claude local scope (running the installed bridge
   * scripts) instead of writing the project's .mcp.json. Omit for the legacy file write.
   */
  local?: LocalMcpOps;
  /** Test seam for the atomic write; defaults to node:fs. */
  fsOps?: { writeFileSync: typeof fs.writeFileSync; renameSync: typeof fs.renameSync; unlinkSync: typeof fs.unlinkSync };
}

/**
 * Install one MCP catalog entry. With `deps.local` it is registered at Claude local
 * scope for this project; otherwise it is added to <root>/.mcp.json. Idempotent
 * ("exists"), refuses unpinned npx/uvx entries, never writes an approval key.
 */
export async function installMcpEntry(root: string, mcpId: string, catalog: any[], deps: McpEntryDeps): Promise<McpInstallOutcome> {
  const entry = catalog.find((x: any) => x && x.id === mcpId);
  if (entry === undefined) return { status: "skipped", error: `MCP catalog entry not found for id: ${mcpId}` };
  if (deps.local) return await installMcpEntryLocal(root, mcpId, entry, deps, deps.local);
  const mcpPath = path.join(root, ".mcp.json");
  const read = readProjectMcpConfigStrict(root);
  if (read.unreadable) {
    return { status: "skipped", error: "Couldn't read .mcp.json — fix it and try again. Nothing was changed." };
  }
  const existing = read.config;
  if (hasMcpServer(existing, mcpId)) return "exists";
  const platformConfig = resolveConfigForPlatform(entry, deps.platform);
  if (!platformConfig.ok) return { status: "skipped", error: platformConfig.error };
  const resolved = deps.resolveTokens(platformConfig.config);
  if (/<[^<>]*>/.test(JSON.stringify(resolved))) {
    return { status: "skipped", error: `${mcpId} needs manual configuration; see .mcp.json.example.` };
  }
  const finalConfig = deps.finalize(mcpId, resolved, root);
  if (isUnpinnedMcpConfig(finalConfig)) {
    return { status: "skipped", error: `${mcpId} is not version-pinned and was not installed.` };
  }
  const ops = deps.fsOps ?? fs;
  const tmpPath = path.join(root, `.mcp.json.${process.pid}.${Date.now()}.tmp`);
  try {
    ops.writeFileSync(tmpPath, JSON.stringify(mergeMcpServer(existing, mcpId, finalConfig), null, 2));
    ops.renameSync(tmpPath, mcpPath);
  } catch (e) {
    try {
      ops.unlinkSync(tmpPath);
    } catch {
      /* temp may not exist */
    }
    return { status: "skipped", error: `Could not write .mcp.json: ${String(e)}` };
  }
  deps.afterWrite(root, finalConfig);
  return "installed";
}

async function installMcpEntryLocal(root: string, mcpId: string, entry: any, deps: McpEntryDeps, local: LocalMcpOps): Promise<McpInstallOutcome> {
  if (local.has(root, mcpId)) return "exists";
  const platformConfig = resolveConfigForPlatform(entry, deps.platform);
  if (!platformConfig.ok) return { status: "skipped", error: platformConfig.error };
  const resolved = deps.resolveTokens(platformConfig.config);
  if (/<[^<>]*>/.test(JSON.stringify(resolved))) {
    return { status: "skipped", error: `${mcpId} needs manual configuration; see .mcp.json.example.` };
  }
  const finalConfig = deps.finalize(mcpId, resolved, root);
  if (isUnpinnedMcpConfig(finalConfig)) {
    return { status: "skipped", error: `${mcpId} is not version-pinned and was not installed.` };
  }
  const localized = localizeMcpConfig(finalConfig, local.hooksDir);
  if (!localized.ok) return { status: "skipped", error: localized.error };
  const written = await local.set(root, mcpId, localized.config);
  if (!written.ok) return { status: "skipped", error: written.error ?? `Could not register ${mcpId}.` };
  return "installed";
}

// ---------------------------------------------------------------------------
// Picker install.
// ---------------------------------------------------------------------------

export type AgentFileStatus = "created" | "refreshed" | "unchanged" | "replaced-legacy" | "skipped" | "error";

export interface BridgeInstallArgs {
  root: string;
  packAgents: PackAgent[];
  /** Pack agent ids the user ticked. Unknown ids are ignored. */
  selectedAgentIds: string[];
  others: OtherAgentSpec[];
  harness: string;
  claudeSubscriptionOptIn: boolean;
  installMcp: (mcpId: string) => McpInstallOutcome | Promise<McpInstallOutcome>;
  /**
   * Remove a server's Claude local-scope registration (Claude Code harness). Called for
   * servers that only unticked picker models needed; the agent files are left in place.
   */
  removeMcp?: (mcpId: string) => void | Promise<void>;
  /** Persist a validated base URL VALUE into the per-user store (never a project file). */
  storeLocalValue?: (name: string, value: string) => void;
  /** Read the per-user store's current value for a name (host seam); used to refuse a silent overwrite. */
  getLocalValue?: (name: string) => string | undefined;
}

export interface BridgeInstallResult {
  ok: boolean;
  /** Agents whose file is now on disk and should be keyword-registered by the host. */
  installed: Array<{ agent: PackAgent; status: AgentFileStatus }>;
  agents: Array<{ id: string; status: AgentFileStatus; error?: string }>;
  mcp: Record<string, McpInstallOutcome>;
  errors: string[];
  /** .mcp.json was deliberately not touched (dispatcher host). */
  dispatcherHost: boolean;
}

/** Write one agent file the way the pack installer does (marker => refresh, foreign => back up then replace). */
export function writeBridgeAgentFile(root: string, agent: PackAgent, packId: string): AgentFileStatus {
  const agentsDir = path.join(root, ".claude", "agents");
  const agentPath = path.join(agentsDir, `${agent.id}.md`);
  const fresh = buildAgentMarkdown(agent, packId);
  let generated = fresh;
  if (!fs.existsSync(agentPath)) {
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(agentPath, generated);
    return "created";
  }
  const existing = fs.readFileSync(agentPath, "utf8");
  if (agentMarkdownHasTycoonMarker(existing)) {
    generated = regenerateAgentMarkdownKeepingExtras(existing, fresh);
    if (existing === generated) return "unchanged";
    fs.writeFileSync(agentPath, generated);
    return "refreshed";
  }
  const backupPath = `${agentPath}.bak`;
  if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, existing);
  fs.writeFileSync(agentPath, generated);
  return "replaced-legacy";
}

export function listAgentIds(root: string): string[] {
  try {
    return fs.readdirSync(path.join(root, ".claude", "agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
  } catch {
    return [];
  }
}

export async function installBridgeSelection(args: BridgeInstallArgs): Promise<BridgeInstallResult> {
  return withHookWriteAsync(() => installBridgeSelectionUngated(args));
}

async function installBridgeSelectionUngated(args: BridgeInstallArgs): Promise<BridgeInstallResult> {
  const result: BridgeInstallResult = { ok: true, installed: [], agents: [], mcp: {}, errors: [], dispatcherHost: !harnessUsesMcpJson(args.harness) };
  const existingIds = listAgentIds(args.root);
  const packIds = args.packAgents.map((a) => a.id);

  // Validate every Other spec up front so a bad one installs nothing.
  const takenSoFar = [...existingIds, ...packIds];
  const otherAgents: Array<{ spec: OtherAgentSpec; agent: PackAgent }> = [];
  for (const spec of args.others) {
    const problems = validateOtherSpec(spec, takenSoFar);
    if (problems.length > 0) {
      result.errors.push(`${spec && typeof spec.agentId === "string" ? spec.agentId : "(other)"}: ${problems.join(" ")}`);
      continue;
    }
    if (spec.baseUrl && spec.baseUrl.trim() !== "" && args.getLocalValue) {
      const current = args.getLocalValue(spec.endpointEnv);
      if (current !== undefined && current !== "" && current !== spec.baseUrl.trim()) {
        result.errors.push(`${spec.agentId}: ${spec.endpointEnv} already has a different value stored on this machine; choose a different base URL variable name (the stored value was not changed).`);
        continue;
      }
    }
    takenSoFar.push(spec.agentId);
    otherAgents.push({ spec, agent: buildOtherAgent(spec) });
  }
  if (result.errors.length > 0) {
    result.ok = false;
    return result;
  }

  const wanted = new Set(args.selectedAgentIds);
  const chosen: PackAgent[] = args.packAgents.filter((a) => wanted.has(a.id));
  const all: PackAgent[] = [...chosen, ...otherAgents.map((o) => o.agent)];
  if (all.length === 0) {
    result.ok = false;
    result.errors.push("Choose at least one model.");
    return result;
  }

  // Servers first (each unique id once), then agent files.
  const servers: string[] = [];
  for (const a of all) {
    const s = bridgeServerFor(a.backend);
    if (s !== null && !servers.includes(s)) servers.push(s);
  }
  for (const a of all) {
    if (shouldSkipPackAgentForClaudeSubscription(args.harness, args.claudeSubscriptionOptIn, a.backend)) {
      result.agents.push({ id: a.id, status: "skipped", error: "Claude subscription routing is not enabled for this harness." });
      continue;
    }
    try {
      const status = writeBridgeAgentFile(args.root, a, BRIDGE_PACK_ID);
      result.agents.push({ id: a.id, status });
      result.installed.push({ agent: a, status });
    } catch (e) {
      result.agents.push({ id: a.id, status: "error", error: String(e) });
      result.ok = false;
    }
  }
  if (!result.dispatcherHost) {
    const needed = new Set(result.installed.map((i) => bridgeServerFor(i.agent.backend)).filter((s): s is string => s !== null));
    for (const s of servers) {
      if (!needed.has(s)) continue;
      try {
        result.mcp[s] = await args.installMcp(s);
      } catch (e) {
        result.mcp[s] = { status: "skipped", error: String(e) };
      }
    }
  }
  if (!result.dispatcherHost && args.removeMcp) {
    // Unticking a model removes the servers nothing else installed still needs.
    const unticked = args.packAgents.filter((a) => !wanted.has(a.id) && fs.existsSync(path.join(args.root, ".claude", "agents", `${a.id}.md`)));
    if (unticked.length > 0) {
      const untickedIds = new Set(unticked.map((a) => a.id));
      const stillNeeded = new Set<string>();
      for (const id of listAgentIds(args.root)) {
        if (untickedIds.has(id)) continue;
        const s = serverForInstalledAgent(args.root, id);
        if (s !== null) stillNeeded.add(s);
      }
      for (const a of unticked) {
        const s = bridgeServerFor(a.backend);
        if (s === null || stillNeeded.has(s)) continue;
        try {
          await args.removeMcp(s);
        } catch {
          /* leave the registration; the badge stays truthful */
        }
        stillNeeded.add(s);
      }
    }
  }
  for (const { spec } of otherAgents) {
    if (spec.baseUrl && spec.baseUrl.trim() !== "" && args.storeLocalValue) {
      try {
        args.storeLocalValue(spec.endpointEnv, spec.baseUrl.trim());
      } catch (e) {
        result.errors.push(`${spec.endpointEnv}: could not store the base URL (${String(e)}).`);
      }
    }
  }
  return result;
}

/** Server id an installed agent needs (for the "Needs setup" action), or null. */
export function serverForInstalledAgent(root: string, agentId: string): string | null {
  if (!isSafeAgentId(agentId)) return null;
  try {
    const text = fs.readFileSync(path.join(root, ".claude", "agents", `${agentId}.md`), "utf8");
    const fm = readAgentFrontmatter(text);
    if (fm["backend"] === undefined || fm["backend"] === null) return null;
    return bridgeServerFor(parseAgentBackend(fm));
  } catch {
    return null;
  }
}
