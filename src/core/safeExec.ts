/*
 * Windows resolves a bare command name against the child's cwd BEFORE PATH, so a
 * project directory can plant npm.cmd, taskkill.exe, rundll32.exe and the like.
 * These helpers resolve absolutely and never consult cwd. Mirrors the helpers in
 * hooks/binDiscovery.cjs (CJS, shipped separately).
 */
import * as fs from "fs";
import * as path from "path";

export interface SafeExecOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
  cwd?: string;
  execPath?: string;
}

/** Absolute path of a Windows system executable (System32 by default, or the Windows dir itself), or null when not win32 or absent. */
export function systemExe(name: string, opts: SafeExecOptions & { inWindowsDir?: boolean } = {}): string | null {
  if ((opts.platform ?? process.platform) !== "win32") return null;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? fs.existsSync;
  const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  const full = opts.inWindowsDir ? path.join(root, name) : path.join(root, "System32", name);
  try {
    return exists(full) ? full : null;
  } catch {
    return null;
  }
}

/** Absolute npm invocation that needs neither a shell nor a cwd lookup, or null (skip that discovery rung). */
export function npmInvocation(opts: SafeExecOptions = {}): { command: string; args: string[] } | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? fs.existsSync;
  const cwd = (opts.cwd !== undefined ? opts.cwd : process.cwd()) || "";
  const dirs: string[] = [];
  const pathVar = env.PATH || env.Path || "";
  for (const d of pathVar.split(platform === "win32" ? ";" : ":")) {
    if (d && path.isAbsolute(d)) dirs.push(d);
  }
  const same = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  for (const d of dirs) {
    try {
      if (platform === "win32" && cwd && same(d, cwd)) continue;
      if (platform === "win32") {
        const cli = path.join(d, "node_modules", "npm", "bin", "npm-cli.js");
        const node = path.join(d, "node.exe");
        if (exists(cli) && exists(node)) return { command: node, args: [cli] };
      } else {
        const npm = path.join(d, "npm");
        if (exists(npm)) return { command: npm, args: [] };
      }
    } catch {
      /* try the next dir */
    }
  }
  return null;
}
