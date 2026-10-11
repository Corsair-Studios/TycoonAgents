/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Which `node` should Codex launch for our hook script and dispatcher? In a
// plain node process that is process.execPath. Inside the VS Code extension
// host process.execPath is the editor itself (Code.exe), and writing that into
// config.toml makes Codex open VS Code on every turn. Discovery follows
// docs/PATH-DISCOVERY.md: TYCOON_NODE_PATH override first, then the running
// binary when it really is node, then a PATH scan, then the POSIX install dirs
// (Homebrew, npm-global, volta, nvm) and one login-shell lookup (a Dock-launched
// VS Code on macOS has a minimal PATH), then the bare name "node" (resolved by
// Codex's own environment at launch). Callers show NODE_NOT_FOUND_WARNING when
// only the bare name is left.

import * as fs from "fs";
import * as path from "path";
import { findOnPosixLadder, type LoginShellOptions, type PosixDirsOptions } from "./posixBinDiscovery";

export interface ResolveNodeBinaryOptions {
  env?: Record<string, string | undefined>;
  execPath?: string;
  /** True when running inside Electron (VS Code). Defaults to process.versions.electron. */
  isElectron?: boolean;
  platform?: NodeJS.Platform;
  /** File-exists probe; defaults to a real stat. */
  isFile?: (p: string) => boolean;
  /** Test seams for the POSIX install-dir and login-shell rungs. */
  posixDirs?: PosixDirsOptions;
  loginShell?: LoginShellOptions;
}

/** Shown by the installers when no node executable could be located and the bare name "node" is written. */
export const NODE_NOT_FOUND_WARNING =
  "TycoonAgents could not find a node executable (looked on PATH, in the Homebrew, npm-global, volta and nvm folders, and via your login shell), so Codex will be told to run plain \"node\". Set TYCOON_NODE_PATH to the full path of node and install again.";

/** True when the command is the unresolved bare name, i.e. discovery found nothing. */
export function isBareNodeCommand(command: string): boolean {
  return command === "node";
}

function defaultIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Scan PATH for a node executable (PATHEXT on Windows) without spawning a shell. */
function findNodeOnPath(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  isFile: (p: string) => boolean,
): string | undefined {
  const win = platform === "win32";
  const pathVar = env.PATH ?? env.Path ?? "";
  const dirs = pathVar.split(win ? ";" : ":").filter((d) => d !== "");
  const exts = win
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter((e) => e !== "")
        .map((e) => e.toLowerCase())
    : [""];
  // .exe first: .cmd/.bat shims cannot be launched without a shell.
  const ordered = win ? [".exe", ...exts.filter((e) => e !== ".exe" && e !== ".cmd" && e !== ".bat")] : exts;
  const join = win ? path.win32.join : path.posix.join;
  for (const dir of dirs) {
    for (const ext of ordered) {
      const candidate = join(dir.replace(/^"|"$/g, ""), "node" + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export function resolveNodeBinary(options: ResolveNodeBinaryOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env.TYCOON_NODE_PATH;
  // An override pointing at an editor/Electron helper is ignored (discovery continues);
  // callers surface it with rejectedNodeOverride().
  if (override !== undefined && override.trim() !== "" && !isElectronHostBinary(override)) return override;
  const isElectron = options.isElectron ?? Boolean(process.versions.electron);
  const execPath = options.execPath ?? process.execPath;
  if (!isElectron) return execPath;
  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? defaultIsFile;
  const onPath = findNodeOnPath(env, platform, isFile);
  if (onPath) return onPath;
  const ladder = findOnPosixLadder("node", {
    platform,
    env,
    isFile,
    dirs: options.posixDirs,
    login: options.loginShell,
  });
  return ladder.bin ?? "node";
}

const ELECTRON_HOST_NAMES = new Set(["code", "code - insiders", "code-insiders", "electron", "cursor", "windsurf", "vscodium", "codium"]);

const ELECTRON_PATH_RE = /(?:Code|Cursor|Windsurf|VSCodium|Codium)(?:\s*-\s*Insiders)?\s+Helper|Electron|\.app\/Contents\/(?:MacOS|Frameworks)/i;

/**
 * True for an editor/Electron host binary that must never be written as the node
 * command: the editor executable itself, or anything whose basename or any parent
 * segment looks like an Electron/editor helper (Code Helper, Electron Framework,
 * `.app/Contents/MacOS|Frameworks`).
 */
export function isElectronHostBinary(command: string): boolean {
  const base = (command.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
  if (ELECTRON_HOST_NAMES.has(base)) return true;
  return ELECTRON_PATH_RE.test(command.replace(/\\/g, "/"));
}

/** The TYCOON_NODE_PATH override when it points at an editor/Electron binary (so it is ignored), else undefined. */
export function rejectedNodeOverride(env: Record<string, string | undefined> = process.env): string | undefined {
  const v = env.TYCOON_NODE_PATH;
  return v !== undefined && v.trim() !== "" && isElectronHostBinary(v) ? v : undefined;
}
