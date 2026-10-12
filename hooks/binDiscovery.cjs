/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Shared CLI binary discovery for the hook/bridge scripts (docs/PATH-DISCOVERY.md).
 * A macOS user who launches VS Code from the Dock inherits a minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), so binaries installed by Homebrew, npm
 * global, nvm/volta or the Claude installer are invisible to a plain PATH scan.
 * The POSIX ladder after PATH is: ~/.claude/local, ~/.local/bin,
 * /opt/homebrew/bin, /usr/local/bin, ~/.npm-global/bin, ~/.volta/bin, the newest
 * ~/.nvm/versions/node/*\/bin, then ONE cached login-shell lookup
 * (`$SHELL -ilc 'command -v <name>'`). Windows only scans PATH plus the extra
 * dirs a caller passes. Every probe fails open; callers get the full list of
 * what was tried so their error can name it and the override variable.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

const LOGIN_SHELL_TIMEOUT_MS = 3000;
const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** name -> { value: string|null } so a login shell is spawned at most once per name per process. */
const loginShellCache = new Map();

function isFileSync(fsApi, p) {
  try {
    return fsApi.existsSync(p) && fsApi.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Compares "v20.11.1"-style directory names numerically; higher sorts later. */
function compareVersionDirs(a, b) {
  const parse = (s) => String(s).replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const va = parse(a);
  const vb = parse(b);
  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i++) {
    const d = (va[i] || 0) - (vb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The newest ~/.nvm/versions/node/<ver>/bin dir that exists, or null. */
function newestNvmBinDir(home, fsApi) {
  try {
    const root = path.posix.join(home.replace(/\\/g, "/"), ".nvm", "versions", "node");
    const versions = fsApi.readdirSync(root).filter((n) => /^v?\d/.test(n));
    if (versions.length === 0) return null;
    versions.sort(compareVersionDirs);
    return path.posix.join(root, versions[versions.length - 1], "bin");
  } catch {
    return null;
  }
}

/** Ordered POSIX install directories (ladder rungs after PATH). Pure apart from the nvm readdir. */
function posixSearchDirs(opts) {
  const o = opts || {};
  const fsApi = o.fs || fs;
  let home = o.home;
  if (home === undefined) {
    try { home = os.homedir(); } catch { home = ""; }
  }
  const dirs = [];
  const join = (...p) => path.posix.join(...p);
  if (home) {
    dirs.push(join(home, ".claude", "local"));
    dirs.push(join(home, ".local", "bin"));
  }
  dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  if (home) {
    dirs.push(join(home, ".npm-global", "bin"));
    dirs.push(join(home, ".volta", "bin"));
    const nvm = newestNvmBinDir(home, fsApi);
    if (nvm) dirs.push(nvm);
  }
  return dirs;
}

/**
 * Last absolute-path line of a login shell's output, or null. Interactive
 * shells can print banners/prompts, so only a full line that is an absolute
 * path counts, and the last one wins.
 */
function parseLastAbsolutePath(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("/")) return lines[i];
  }
  return null;
}

/**
 * Asks the user's login shell where `name` is (POSIX only). Runs at most once
 * per name per process, 3s timeout, every failure ignored. `opts` seams:
 * platform, env, spawnSync, cache (a Map).
 */
function loginShellLookup(name, opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  if (platform === "win32") return null;
  if (!SAFE_NAME_RE.test(String(name))) return null;
  const cache = o.cache || loginShellCache;
  if (cache.has(name)) return cache.get(name);
  const env = o.env || process.env;
  const shell = env.SHELL;
  let found = null;
  if (typeof shell === "string" && shell.startsWith("/")) {
    try {
      const spawnSync = o.spawnSync || childProcess.spawnSync;
      const r = spawnSync(shell, ["-ilc", `command -v ${name}`], {
        encoding: "utf8",
        timeout: LOGIN_SHELL_TIMEOUT_MS,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (r && !r.error && r.status === 0) found = parseLastAbsolutePath(r.stdout);
    } catch {
      found = null;
    }
  }
  cache.set(name, found);
  return found;
}

/**
 * PATH -> extra dirs -> (POSIX) install dirs -> (POSIX) login shell.
 * opts: names (candidate file names; default [name]), env, platform, home, fs,
 * extraDirs (searched right after PATH on every platform), spawnSync, cache.
 * Returns { bin, tried }; bin is null when nothing was found.
 */
function findBinary(name, opts) {
  const o = opts || {};
  const fsApi = o.fs || fs;
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const names = o.names && o.names.length ? o.names : [name];
  const tried = [];
  const isWin = platform === "win32";
  const sep = isWin ? ";" : ":";
  const join = isWin ? path.win32.join : path.posix.join;

  const probeDir = (dir) => {
    for (const n of names) {
      const full = join(dir, n);
      tried.push(full);
      if (isFileSync(fsApi, full)) return full;
    }
    return null;
  };

  const pathDirs = String(env.PATH || env.Path || "").split(sep).filter(Boolean);
  for (const dir of pathDirs) {
    const hit = probeDir(dir);
    if (hit) return { bin: hit, tried };
  }
  for (const dir of o.extraDirs || []) {
    const hit = probeDir(dir);
    if (hit) return { bin: hit, tried };
  }
  if (!isWin) {
    for (const dir of posixSearchDirs({ home: o.home, fs: fsApi })) {
      const hit = probeDir(dir);
      if (hit) return { bin: hit, tried };
    }
    tried.push(`login shell ($SHELL -ilc 'command -v ${name}')`);
    const viaShell = loginShellLookup(name, { platform, env, spawnSync: o.spawnSync, cache: o.cache });
    if (viaShell && isFileSync(fsApi, viaShell)) return { bin: viaShell, tried };
  }
  return { bin: null, tried };
}

/**
 * Windows resolves a bare command against the process/child cwd BEFORE PATH, so
 * a project directory can plant npm.cmd / taskkill.exe. These helpers resolve
 * absolutely instead and never consult cwd.
 */
function systemExe(name, opts) {
  const o = opts || {};
  if ((o.platform || process.platform) !== "win32") return null;
  const env = o.env || process.env;
  const exists = o.exists || fs.existsSync;
  const full = path.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", name);
  try {
    return exists(full) ? full : null;
  } catch {
    return null;
  }
}

/**
 * Absolute npm invocation { command, args } that needs no shell and no cwd
 * lookup, or null. win32: node.exe + npm-cli.js from the node install dir (next to
 * process.execPath) or an absolute PATH entry. POSIX: an absolute npm on PATH.
 */
function npmInvocation(opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  const env = o.env || process.env;
  const exists = o.exists || fs.existsSync;
  const cwd = (o.cwd !== undefined ? o.cwd : process.cwd()) || "";
  const dirs = [];
  const execPath = o.execPath !== undefined ? o.execPath : process.execPath;
  if (execPath && /^node(\.exe)?$/i.test(path.basename(execPath))) dirs.push(path.dirname(execPath));
  const pathVar = env.PATH || env.Path || "";
  for (const d of pathVar.split(platform === "win32" ? ";" : ":")) {
    if (d && path.isAbsolute(d)) dirs.push(d);
  }
  const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  for (const d of dirs) {
    try {
      if (platform === "win32" && cwd && sameDir(d, cwd)) continue;
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

/**
 * Windows: a bare command name resolves against the child's cwd before PATH. Resolves
 * it through absolute PATH entries only (never cwd); returns the command unchanged
 * when it is not a bare name, not on win32, or not found.
 */
function resolveBareOnPath(command, opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  if (platform !== "win32" || !command || /[\\/]/.test(command)) return command;
  const env = o.env || process.env;
  const fsApi = o.fs || fs;
  const cwd = (o.cwd !== undefined ? o.cwd : process.cwd()) || "";
  const norm = (d) => path.resolve(d).toLowerCase();
  for (const d of String(env.PATH || env.Path || "").split(";")) {
    if (!d || !path.isAbsolute(d) || (cwd && norm(d) === norm(cwd))) continue;
    for (const ext of [".exe", ".cmd", ".bat", ""]) {
      const full = path.join(d, command + ext);
      if (isFileSync(fsApi, full)) return full;
    }
  }
  return command;
}

module.exports = { resolveBareOnPath, systemExe, npmInvocation, findBinary, posixSearchDirs, loginShellLookup, parseLastAbsolutePath, newestNvmBinDir, LOGIN_SHELL_TIMEOUT_MS };
