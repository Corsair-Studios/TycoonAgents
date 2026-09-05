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
  type RoutingProfile,
} from "./routingProfile";
import { readAgentFrontmatter, parseAgentBackend, type Backend } from "./agentBackend";
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

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export type RoutingSource = "routing" | "frontmatter" | "alias" | "default";

export interface RoutingAgentView {
  id: string;
  name: string;
  description?: string;
  backend: Backend;
  source: RoutingSource;
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
}

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
  envProbe: Record<string, EnvProbeEntry>;
  presets: RoutingPresets;
  lastApplied: RoutingLastApplied;
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
}

const EMPTY_SCRIPT_RESULT: ScriptRunResult = { code: -1, output: "" };
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
 * (fable resolves to "claude-fable-5"; opus/sonnet/haiku resolve to
 * themselves in MODEL_ALIASES today).
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

  return { vendors: Array.from(vendors), models: Array.from(modelsById.values()) };
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

function writeLastApplied(root: string, write: { claude: ScriptRunResult; opencode: ScriptRunResult }): void {
  try {
    const existing = readLastApplied(root);
    const now = new Date().toISOString();
    const next: RoutingLastApplied = { ...existing };
    if (write.claude.code === 0) next.claude = now;
    if (write.opencode.code === 0) next.opencode = now;
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

    const routingSlot = resolveAgentSlot(profile, id);
    let backend: Backend;
    let source: RoutingSource;
    if (routingSlot) {
      backend = routingSlotToBackend(routingSlot);
      source = "routing";
    } else {
      backend = safeParseAgentBackend(fm);
      source = classifyFrontmatterSource(fm);
    }
    collectEnvNames(backend, envNames);

    const rosterEntry = rosterById.get(id);
    agents.push({
      id,
      name: rosterEntry?.name ?? id,
      description: rosterEntry?.description,
      backend,
      source,
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
    envProbe: probeEnv(Array.from(envNames), env),
    presets: buildPresets(),
    lastApplied: readLastApplied(root),
  };
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

  const check = {
    claude: runScript(nodeBin, scripts.claude, root, ["--check"]),
    opencode: runScript(nodeBin, scripts.opencode, root, ["--check"]),
  };
  const write = {
    claude: runScript(nodeBin, scripts.claude, root, []),
    opencode: runScript(nodeBin, scripts.opencode, root, []),
  };
  writeLastApplied(root, write);

  const ok = write.claude.code === 0 && write.opencode.code === 0;
  return { ok, errors: [], check, write };
}

export interface ClearRoutingProfileOptions {
  root: string;
  scriptsDir: string;
  nodeBin?: string;
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

  const check = {
    claude: runScript(nodeBin, scripts.claude, root, ["--check"]),
    opencode: runScript(nodeBin, scripts.opencode, root, ["--check"]),
  };
  const write = {
    claude: runScript(nodeBin, scripts.claude, root, []),
    opencode: runScript(nodeBin, scripts.opencode, root, []),
  };
  writeLastApplied(root, write);

  const ok = write.claude.code === 0 && write.opencode.code === 0;
  return { ok, errors: [], check, write };
}
