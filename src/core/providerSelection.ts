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

export const PROVIDER_IDS = ["claude-code", "opencode"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

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
}

/** Resolves which provider id a host should use, per the precedence above.
 * Throws on an unknown id from any source, naming the source and the valid
 * ids. */
export function resolveProviderId(options: ResolveProviderIdOptions): ProviderId {
  const env = options.env ?? process.env;

  const envValue = env["TYCOON_PROVIDER"];
  if (envValue !== undefined && envValue !== "") {
    if (!isProviderId(envValue)) throw invalidProviderError(envValue, "the TYCOON_PROVIDER environment variable");
    return envValue;
  }

  if (options.settingValue !== undefined && options.settingValue !== "") {
    if (!isProviderId(options.settingValue)) {
      throw invalidProviderError(options.settingValue, 'the "tycoonagents.provider" VS Code setting');
    }
    return options.settingValue;
  }

  const fromExecutionConfig = readExecutionConfigProvider(options.projectDir);
  if (fromExecutionConfig !== undefined) {
    if (!isProviderId(fromExecutionConfig)) {
      throw invalidProviderError(
        fromExecutionConfig,
        path.join(options.projectDir, ".claude", "tycoon", "execution.json"),
      );
    }
    return fromExecutionConfig;
  }

  return "claude-code";
}

export type ProviderSelectionSource = "env" | "setting" | "execution" | "default";

export interface ProviderSelectionDescription {
  effective: ProviderId;
  source: ProviderSelectionSource;
  /** The raw `provider` value currently on disk in execution.json, if any (even if it lost precedence). */
  fileValue: ProviderId | undefined;
}

/** Like resolveProviderId, but also reports which layer won and what's
 * currently on disk, for the Settings UI's "Which tool runs your agents?"
 * dropdown. Throws under the same conditions resolveProviderId does. */
export function describeProviderSelection(options: {
  settingValue?: string | undefined;
  env?: NodeJS.ProcessEnv;
  cwd: string;
}): ProviderSelectionDescription {
  const env = options.env ?? process.env;
  const fromExecutionConfigRaw = readExecutionConfigProvider(options.cwd);
  const fileValue = isProviderId(fromExecutionConfigRaw) ? fromExecutionConfigRaw : undefined;

  const envValue = env["TYCOON_PROVIDER"];
  if (envValue !== undefined && envValue !== "") {
    if (!isProviderId(envValue)) throw invalidProviderError(envValue, "the TYCOON_PROVIDER environment variable");
    return { effective: envValue, source: "env", fileValue };
  }

  if (options.settingValue !== undefined && options.settingValue !== "") {
    if (!isProviderId(options.settingValue)) {
      throw invalidProviderError(options.settingValue, 'the "tycoonagents.provider" VS Code setting');
    }
    return { effective: options.settingValue, source: "setting", fileValue };
  }

  if (fromExecutionConfigRaw !== undefined) {
    if (!isProviderId(fromExecutionConfigRaw)) {
      throw invalidProviderError(fromExecutionConfigRaw, path.join(options.cwd, ".claude", "tycoon", "execution.json"));
    }
    return { effective: fromExecutionConfigRaw, source: "execution", fileValue };
  }

  return { effective: "claude-code", source: "default", fileValue };
}

/** Writes only the `provider` key into <cwd>/.claude/tycoon/execution.json,
 * creating the file/directories if absent and preserving every other key
 * already there. Throws on an unrecognized provider id. */
export function writeProviderSelection(cwd: string, providerId: string): void {
  if (!isProviderId(providerId)) throw invalidProviderError(providerId, "writeProviderSelection");
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
