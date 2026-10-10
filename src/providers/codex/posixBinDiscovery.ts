/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// POSIX install-location ladder shared by node and Codex discovery
// (docs/PATH-DISCOVERY.md). Mirrors hooks/binDiscovery.cjs, which the hook
// scripts use because they cannot import TypeScript. A macOS app launched from
// the Dock gets PATH=/usr/bin:/bin:/usr/sbin:/sbin, so Homebrew, npm-global,
// volta and nvm installs are invisible to a PATH scan; these dirs plus one
// cached login-shell lookup cover them.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

export const LOGIN_SHELL_TIMEOUT_MS = 3000;
const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;

export interface PosixDirsOptions {
  home?: string;
  readdir?: (dir: string) => string[];
}

function compareVersionDirs(a: string, b: string): number {
  const parse = (s: string): number[] => s.replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const va = parse(a);
  const vb = parse(b);
  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i++) {
    const d = (va[i] ?? 0) - (vb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Ordered POSIX install dirs: Claude installer, ~/.local/bin, Homebrew, /usr/local, npm-global, volta, newest nvm node. */
export function posixSearchDirs(options: PosixDirsOptions = {}): string[] {
  let home = options.home;
  if (home === undefined) {
    try {
      home = os.homedir();
    } catch {
      home = "";
    }
  }
  const readdir = options.readdir ?? ((d: string) => fs.readdirSync(d));
  const join = path.posix.join;
  const dirs: string[] = [];
  if (home) {
    dirs.push(join(home, ".claude", "local"), join(home, ".local", "bin"));
  }
  dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  if (home) {
    dirs.push(join(home, ".npm-global", "bin"), join(home, ".volta", "bin"));
    try {
      const root = join(home.replace(/\\/g, "/"), ".nvm", "versions", "node");
      const versions = readdir(root).filter((n) => /^v?\d/.test(n));
      if (versions.length > 0) {
        versions.sort(compareVersionDirs);
        dirs.push(join(root, versions[versions.length - 1], "bin"));
      }
    } catch {
      // no nvm install
    }
  }
  return dirs;
}

/** Last full line that is an absolute path, or undefined. */
export function parseLastAbsolutePath(stdout: string): string | undefined {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("/")) return lines[i];
  }
  return undefined;
}

export interface LoginShellOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  spawn?: (shell: string, args: string[]) => { status: number | null; stdout: string; error?: unknown };
  cache?: Map<string, string | undefined>;
}

const defaultCache = new Map<string, string | undefined>();

/** `$SHELL -ilc 'command -v <name>'` once per name per process; 3s timeout; POSIX only; failures ignored. */
export function loginShellLookup(name: string, options: LoginShellOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" || !SAFE_NAME_RE.test(name)) return undefined;
  const cache = options.cache ?? defaultCache;
  if (cache.has(name)) return cache.get(name);
  const shell = (options.env ?? process.env).SHELL;
  let found: string | undefined;
  if (typeof shell === "string" && shell.startsWith("/")) {
    try {
      const spawn =
        options.spawn ??
        ((sh: string, args: string[]) => {
          const r = spawnSync(sh, args, { encoding: "utf8", timeout: LOGIN_SHELL_TIMEOUT_MS, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] });
          return { status: r.status, stdout: r.stdout ?? "", error: r.error };
        });
      const r = spawn(shell, ["-ilc", `command -v ${name}`]);
      if (!r.error && r.status === 0) found = parseLastAbsolutePath(r.stdout);
    } catch {
      found = undefined;
    }
  }
  cache.set(name, found);
  return found;
}

/** First existing `name` in the POSIX install dirs, then the login shell; `tried` lists what was probed for error messages. */
export function findOnPosixLadder(
  name: string,
  options: {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
    isFile: (p: string) => boolean;
    dirs?: PosixDirsOptions;
    login?: LoginShellOptions;
  },
): { bin?: string; tried: string[] } {
  const tried: string[] = [];
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return { tried };
  for (const dir of posixSearchDirs(options.dirs)) {
    const full = path.posix.join(dir, name);
    tried.push(full);
    if (options.isFile(full)) return { bin: full, tried };
  }
  tried.push(`login shell ($SHELL -ilc 'command -v ${name}')`);
  const viaShell = loginShellLookup(name, { platform, env: options.env, ...options.login });
  if (viaShell && options.isFile(viaShell)) return { bin: viaShell, tried };
  return { tried };
}
