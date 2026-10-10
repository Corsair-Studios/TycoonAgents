/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Single source of truth for which Provider (see src/core/provider.ts) a
// host should construct. Pure Node — no `vscode` import — so the compiled
// output (out/src/core/providerSelection.js) can be `require()`'d directly
// by standalone/src/sharedLogic.mjs (a bare Node process, no extension host)
// as well as by src/host/vscode/providerFactory.ts inside the extension.
//
// Precedence (highest wins):
//   1. TYCOON_PROVIDER environment variable
//   2. `settingValue` (the VS Code `tycoonagents.provider` setting — only
//      the VS Code host passes this; the standalone CLI never does)
//   3. the `provider` key in <projectDir>/.claude/tycoon/execution.json
//   4. 'claude-code' (default)

import * as fs from "fs";
import * as path from "path";

export const PROVIDER_IDS = ["claude-code", "opencode", "codex"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Launch gate: OpenCode is "Coming Soon" and not selectable while false.
 * Flip to true to restore the previous behaviour everywhere (pickers,
 * resolution, SET_HARNESS). Every host reads this one constant.
 */
export const OPENCODE_HARNESS_AVAILABLE = false;

/** One-line Settings notice shown when a stored/forced "opencode" is resolved to Claude Code by the gate. */
export const OPENCODE_COMING_SOON_NOTICE =
  "OpenCode support is coming soon — this project now runs on Claude Code.";

let opencodeAvailableOverride: boolean | undefined;
/** Test seam only: forces the gate on/off for the process; pass undefined to restore the constant. */
export function setOpencodeAvailableForTests(value: boolean | undefined): void {
  opencodeAvailableOverride = value;
}
/** Current gate value (the constant unless a test override is set). */
export function isOpencodeAvailable(): boolean {
  return opencodeAvailableOverride ?? OPENCODE_HARNESS_AVAILABLE;
}

export interface HarnessOption {
  id: ProviderId;
  label: string;
  /** True when the option is shown but cannot be chosen. */
  disabled?: boolean;
}

/** Options for the "Which tool runs your agents?" picker; OpenCode is disabled while gated. */
export function buildHarnessOptions(opencodeAvailable: boolean = isOpencodeAvailable()): HarnessOption[] {
  return [
    { id: "claude-code", label: "Claude Code" },
    { id: "codex", label: "Codex (Experimental)" },
    opencodeAvailable
      ? { id: "opencode", label: "OpenCode (Experimental)" }
      : { id: "opencode", label: "OpenCode (Coming Soon)", disabled: true },
  ];
}

function gate(id: ProviderId, opencodeAvailable: boolean | undefined): ProviderId {
  return id === "opencode" && !(opencodeAvailable ?? isOpencodeAvailable()) ? "claude-code" : id;
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

function invalidProviderError(value: unknown, source: string): Error {
  return new Error(
    `TycoonAgents: invalid provider id ${JSON.stringify(value)} from ${source}. ` +
      `Valid provider ids are: ${PROVIDER_IDS.join(", ")}.`,
  );
}

/**
 * Reads the `provider` key out of <projectDir>/.claude/tycoon/execution.json,
 * if present. Tolerates a missing file, missing key, or malformed JSON by
 * returning undefined — this file is optional and may not exist yet on a
 * fresh project. A *present but invalid* provider id still throws (surfaced
 * by resolveProviderId), since that's a real misconfiguration, not absence.
 */
function readExecutionConfigProvider(projectDir: string): unknown {
  const execPath = path.join(projectDir, ".claude", "tycoon", "execution.json");
  let raw: string;
  try {
    raw = fs.readFileSync(execPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "provider" in (parsed as Record<string, unknown>)) {
      return (parsed as Record<string, unknown>)["provider"];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export interface ResolveProviderIdOptions {
  /** The VS Code `tycoonagents.provider` setting value, if this host has one. */
  settingValue?: string | undefined;
  /** Environment to read TYCOON_PROVIDER from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Project root used to locate .claude/tycoon/execution.json. */
  projectDir: string;
  /** Test seam; defaults to OPENCODE_HARNESS_AVAILABLE. */
  opencodeAvailable?: boolean;
}

/** Resolves which provider id a host should use, per the precedence above.
 * Throws on an unknown id from any source, naming the source and the valid
 * ids. */
export function resolveProviderId(options: ResolveProviderIdOptions): ProviderId {
  const env = options.env ?? process.env;

  const envValue = env["TYCOON_PROVIDER"];
  if (envValue !== undefined && envValue !== "") {
    if (!isProviderId(envValue)) throw invalidProviderError(envValue, "the TYCOON_PROVIDER environment variable");
    return gate(envValue, options.opencodeAvailable);
  }

  if (options.settingValue !== undefined && options.settingValue !== "") {
    if (!isProviderId(options.settingValue)) {
      throw invalidProviderError(options.settingValue, 'the "tycoonagents.provider" VS Code setting');
    }
    return gate(options.settingValue, options.opencodeAvailable);
  }

  const fromExecutionConfig = readExecutionConfigProvider(options.projectDir);
  if (fromExecutionConfig !== undefined) {
    if (!isProviderId(fromExecutionConfig)) {
      throw invalidProviderError(
        fromExecutionConfig,
        path.join(options.projectDir, ".claude", "tycoon", "execution.json"),
      );
    }
    return gate(fromExecutionConfig, options.opencodeAvailable);
  }

  return "claude-code";
}

export type ProviderSelectionSource = "env" | "setting" | "execution" | "default";

export interface ProviderSelectionDescription {
  effective: ProviderId;
  source: ProviderSelectionSource;
  /** The raw `provider` value currently on disk in execution.json, if any (even if it lost precedence). */
  fileValue: ProviderId | undefined;
  /** Set to "opencode" when the launch gate replaced a requested OpenCode with Claude Code. */
  gatedFrom?: "opencode";
}

/** Like resolveProviderId, but also reports which layer won and what's
 * currently on disk, for the Settings UI's "Which tool runs your agents?"
 * dropdown. Throws under the same conditions resolveProviderId does. */
export function describeProviderSelection(options: {
  settingValue?: string | undefined;
  env?: NodeJS.ProcessEnv;
  cwd: string;
  opencodeAvailable?: boolean;
}): ProviderSelectionDescription {
  const avail = options.opencodeAvailable ?? isOpencodeAvailable();
  const out = (effective: ProviderId, source: ProviderSelectionSource, fileValue: ProviderId | undefined): ProviderSelectionDescription => {
    const g = gate(effective, avail);
    return g === effective ? { effective, source, fileValue } : { effective: g, source, fileValue, gatedFrom: "opencode" };
  };
  const env = options.env ?? process.env;
  const fromExecutionConfigRaw = readExecutionConfigProvider(options.cwd);
  const fileValue = isProviderId(fromExecutionConfigRaw) ? fromExecutionConfigRaw : undefined;

  const envValue = env["TYCOON_PROVIDER"];
  if (envValue !== undefined && envValue !== "") {
    if (!isProviderId(envValue)) throw invalidProviderError(envValue, "the TYCOON_PROVIDER environment variable");
    return out(envValue, "env", fileValue);
  }

  if (options.settingValue !== undefined && options.settingValue !== "") {
    if (!isProviderId(options.settingValue)) {
      throw invalidProviderError(options.settingValue, 'the "tycoonagents.provider" VS Code setting');
    }
    return out(options.settingValue, "setting", fileValue);
  }

  if (fromExecutionConfigRaw !== undefined) {
    if (!isProviderId(fromExecutionConfigRaw)) {
      throw invalidProviderError(fromExecutionConfigRaw, path.join(options.cwd, ".claude", "tycoon", "execution.json"));
    }
    return out(fromExecutionConfigRaw, "execution", fileValue);
  }

  return { effective: "claude-code", source: "default", fileValue };
}

/**
 * Reads the `useMultipleLlms` boolean out of <cwd>/.claude/tycoon/execution.json
 * (p18-t1). Defaults to false on a missing file, missing key, malformed
 * JSON, or a non-boolean value — this setting is optional and its absence
 * is never an error.
 */
export function readUseMultipleLlms(cwd: string): boolean {
  const execPath = path.join(cwd, ".claude", "tycoon", "execution.json");
  try {
    const raw = fs.readFileSync(execPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "useMultipleLlms" in (parsed as Record<string, unknown>)) {
      const value = (parsed as Record<string, unknown>)["useMultipleLlms"];
      return typeof value === "boolean" ? value : false;
    }
    return false;
  } catch {
    return false;
  }
}

/** Writes only the `useMultipleLlms` key into <cwd>/.claude/tycoon/execution.json,
 * creating the file/directories if absent and preserving every other key
 * already there (including `provider`). */
export function writeUseMultipleLlms(cwd: string, value: boolean): void {
  const dir = path.join(cwd, ".claude", "tycoon");
  const execPath = path.join(dir, "execution.json");
  let parsed: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(execPath, "utf8");
    const existing: unknown = JSON.parse(raw);
    if (existing && typeof existing === "object") parsed = existing as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  parsed["useMultipleLlms"] = value;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(execPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
}

/** Writes only the `provider` key into <cwd>/.claude/tycoon/execution.json,
 * creating the file/directories if absent and preserving every other key
 * already there. Throws on an unrecognized provider id. */
export function writeProviderSelection(cwd: string, providerId: string, opencodeAvailable: boolean = isOpencodeAvailable()): void {
  if (!isProviderId(providerId)) throw invalidProviderError(providerId, "writeProviderSelection");
  if (providerId === "opencode" && !opencodeAvailable) throw new Error(OPENCODE_COMING_SOON_NOTICE);
  const dir = path.join(cwd, ".claude", "tycoon");
  const execPath = path.join(dir, "execution.json");
  let parsed: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(execPath, "utf8");
    const existing: unknown = JSON.parse(raw);
    if (existing && typeof existing === "object") parsed = existing as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  parsed["provider"] = providerId;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(execPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
}
