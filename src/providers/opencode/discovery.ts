/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Path discovery for the OpenCode binary/config dir, following the ladder
// in docs/PATH-DISCOVERY.md: explicit env override wins outright; otherwise
// gather independent, de-duplicated candidate signals and probe each,
// fail-open (a missing/inapplicable probe is a silent no-op, never a
// throw). Only when nothing resolves do we surface an explicit error
// listing every location tried and naming both override variables.

import * as fs from "fs";
import * as path from "path";

export interface ResolveOpenCodeEnv {
  [key: string]: string | undefined;
}

export interface ResolveOpenCodeOptions {
  env: ResolveOpenCodeEnv;
  /** Project directory to probe for a local .opencode/ config dir. Defaults to process.cwd(). */
  projectDir?: string;
  /** Override platform for testing; defaults to process.platform. */
  platform?: NodeJS.Platform;
}

export interface ResolveOpenCodeResult {
  binPath?: string;
  configDir?: string;
  /** Every location probed, in order, for diagnostics/error reporting. */
  tried: string[];
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function safeExistsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function safeExistsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Candidate `opencode` binary names/extensions to probe on each PATH dir. */
function binNamesForPlatform(platform: NodeJS.Platform): string[] {
  if (platform === "win32") return ["opencode.exe", "opencode.cmd", "opencode.bat", "opencode"];
  return ["opencode"];
}

function candidateBinPaths(env: ResolveOpenCodeEnv, platform: NodeJS.Platform): string[] {
  const pathVar = env.PATH ?? env.Path ?? "";
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  const names = binNamesForPlatform(platform);
  const candidates: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      candidates.push(path.join(dir, name));
    }
  }
  return candidates;
}

function candidateConfigDirs(env: ResolveOpenCodeEnv, platform: NodeJS.Platform, projectDir: string): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? "";
  const candidates: string[] = [];
  if (home) candidates.push(path.join(home, ".config", "opencode"));
  if (platform === "win32") {
    if (env.APPDATA) candidates.push(path.join(env.APPDATA, "opencode"));
    if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, "opencode"));
  }
  candidates.push(path.join(projectDir, ".opencode"));
  return candidates;
}

/**
 * Resolve the OpenCode binary and/or config directory following the
 * discovery ladder in docs/PATH-DISCOVERY.md.
 *
 * 1. OPENCODE_BIN / OPENCODE_CONFIG_DIR env overrides — used verbatim, skip
 *    every other rung for that field.
 * 2. `opencode` on PATH (each PATH dir + platform-appropriate extensions).
 * 3. ~/.config/opencode, %APPDATA%/opencode, %LOCALAPPDATA%/opencode.
 * 4. <projectDir>/.opencode.
 *
 * Throws only when NEITHER a binPath NOR a configDir could be resolved,
 * listing every location tried and naming both override variables.
 */
export function resolveOpenCode(options: ResolveOpenCodeOptions): ResolveOpenCodeResult {
  const { env } = options;
  const platform = options.platform ?? process.platform;
  const projectDir = options.projectDir ?? process.cwd();
  const tried: string[] = [];

  let binPath: string | undefined;
  if (env.OPENCODE_BIN) {
    tried.push(env.OPENCODE_BIN);
    if (safeExistsFile(env.OPENCODE_BIN)) binPath = env.OPENCODE_BIN;
  } else {
    for (const candidate of dedupe(candidateBinPaths(env, platform))) {
      tried.push(candidate);
      if (!binPath && safeExistsFile(candidate)) binPath = candidate;
    }
  }

  let configDir: string | undefined;
  if (env.OPENCODE_CONFIG_DIR) {
    tried.push(env.OPENCODE_CONFIG_DIR);
    if (safeExistsDir(env.OPENCODE_CONFIG_DIR)) configDir = env.OPENCODE_CONFIG_DIR;
  } else {
    for (const candidate of dedupe(candidateConfigDirs(env, platform, projectDir))) {
      tried.push(candidate);
      if (!configDir && safeExistsDir(candidate)) configDir = candidate;
    }
  }

  const dedupedTried = dedupe(tried);

  if (!binPath && !configDir) {
    throw new Error(
      `resolveOpenCode: could not locate an OpenCode install. Tried:\n` +
        dedupedTried.map((p) => `  - ${p}`).join("\n") +
        `\nSet OPENCODE_BIN (path to the opencode binary) or OPENCODE_CONFIG_DIR ` +
        `(the opencode config directory) to override discovery.`,
    );
  }

  return { binPath, configDir, tried: dedupedTried };
}

/**
 * True if the given project directory has the shipped OpenCode plugin
 * installed at .opencode/plugin/tycoon-opencode-plugin.(ts|js). Used only
 * to WARN the user (via the provider's start()) that OpenCode activity
 * won't be captured without it — never to silently fall back to
 * claude-code.
 */
export function isProjectPluginInstalled(projectDir: string): boolean {
  const base = path.join(projectDir, ".opencode", "plugin", "tycoon-opencode-plugin");
  return safeExistsFile(`${base}.ts`) || safeExistsFile(`${base}.js`);
}
