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
// binary when it really is node, then a PATH scan, then the bare name "node"
// (resolved by Codex's own environment at launch).

import * as fs from "fs";
import * as path from "path";

export interface ResolveNodeBinaryOptions {
  env?: Record<string, string | undefined>;
  execPath?: string;
  /** True when running inside Electron (VS Code). Defaults to process.versions.electron. */
  isElectron?: boolean;
  platform?: NodeJS.Platform;
  /** File-exists probe; defaults to a real stat. */
  isFile?: (p: string) => boolean;
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
  if (override !== undefined && override.trim() !== "") return override;
  const isElectron = options.isElectron ?? Boolean(process.versions.electron);
  const execPath = options.execPath ?? process.execPath;
  if (!isElectron) return execPath;
  return findNodeOnPath(env, options.platform ?? process.platform, options.isFile ?? defaultIsFile) ?? "node";
}

const ELECTRON_HOST_NAMES = new Set(["code", "code - insiders", "code-insiders", "electron", "cursor", "windsurf", "vscodium", "codium"]);

/** True for an editor/Electron host binary that must never be written as the node command. */
export function isElectronHostBinary(command: string): boolean {
  const base = (command.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
  return ELECTRON_HOST_NAMES.has(base);
}
