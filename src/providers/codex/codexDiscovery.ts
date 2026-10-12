/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { npmInvocation } from "../../core/safeExec";
import { loginShellLookup, posixSearchDirs } from "./posixBinDiscovery";

/**
 * Why this module exists, and why it looks the way it does: see
 * docs/PATH-DISCOVERY.md (the project-wide discovery doctrine) and
 * docs/provider-contract.md's "binary-absent" failure-taxonomy entry, both
 * of which this module must stay consistent with. The doctrine's reference
 * exemplar is media/uefn-bridge/init_unreal.py's project-root discovery
 * (~lines 79-132): gather candidates from several independent signals,
 * de-duplicate, and only then start probing — never a single guess.
 *
 * THE shell:true / ENOENT TRAP (empirically confirmed in Phase 1, frozen in
 * docs/provider-contract.md under "binary-absent"): on Windows, `codex`
 * resolves through a .cmd shim, so invoking it at all requires
 * `shell: true`. Under shell:true a MISSING command does NOT throw ENOENT —
 * cmd.exe instead exits nonzero with a "is not recognized as an internal or
 * external command" stderr. ENOENT is only produced when a literal
 * nonexistent absolute path is invoked with shell:false. So this module
 * treats BOTH shapes — a thrown ENOENT, and a nonzero exit whose stdout is
 * empty and whose stderr looks like a shell "command not found" message —
 * as the same "binary absent" condition. Checking ENOENT alone would miss
 * the real-world case entirely.
 */

/** Distinguishes the failure categories a later health-check phase needs, per docs/provider-contract.md's failure taxonomy. */
export type CodexDiscoveryFailureReason = "binary-absent" | "found-but-not-codex";

export class CodexDiscoveryError extends Error {
  readonly reason: CodexDiscoveryFailureReason;
  readonly triedLocations: string[];

  constructor(reason: CodexDiscoveryFailureReason, message: string, triedLocations: string[]) {
    super(message);
    this.name = "CodexDiscoveryError";
    this.reason = reason;
    this.triedLocations = triedLocations;
  }
}

interface CodexCandidate {
  /** Human-readable origin of this candidate, for the failure message (e.g. "PATH", "npm global prefix"). */
  origin: string;
  /** The command/path to probe. May be a bare command name (resolved via shell/PATH) or an absolute path. */
  command: string;
}

/** Content signal Phase 1 observed: `codex --version` prints "codex-cli " followed by a semver, e.g. "codex-cli 0.124.0". Matching on this (not merely exit code 0) is the content-based verification criterion 3 in docs/PATH-DISCOVERY.md requires. */
const CODEX_VERSION_PREFIX = "codex-cli ";

/**
 * Injectable execFileSync-shaped seam (Plan p34-t3): every probe in this
 * module runs `<command> --version` through this function instead of
 * calling child_process.execFileSync directly. Defaults to the real
 * execFileSync so production/CLI behaviour is byte-for-byte unchanged when
 * no override is supplied. Tests inject a fake that returns canned output
 * for a given command WITHOUT spawning any real process — this is what
 * lets the two VS Code-extension-rung cases (previously skipped on win32
 * because that rung hardcodes a `codex.exe` candidate name, and this
 * project's test-execution policy forbids compiling or renaming a file to
 * .exe) run on every platform: the candidate path only needs to exist for
 * fs.readdirSync() to see it, never to actually be executed.
 */
export type CodexExecFn = (command: string) => string;

const defaultExec: CodexExecFn = (command) =>
  execFileSync(command, ["--version"], {
    // Never the project cwd: cmd.exe would run a planted codex.cmd/codex.bat from it first.
    cwd: os.tmpdir(),
    shell: true,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });

export interface CodexDiscoveryOptions {
  /** Override for the `<command> --version` probe. Defaults to a real execFileSync call. */
  exec?: CodexExecFn;
  /** Override for the login-shell lookup (`$SHELL -ilc 'command -v codex'`); defaults to the real, cached, 3s-bounded lookup. */
  loginShell?: (name: string) => string | undefined;
  /** Override for the POSIX install dirs searched after PATH (tests). */
  posixDirs?: () => string[];
  /** Override for process.platform (tests). */
  platform?: NodeJS.Platform;
}

/** Shell "command not found" shapes observed/expected across platforms (Windows cmd.exe confirmed in Phase 1; POSIX "command not found" carried forward by analogy per docs/provider-contract.md's binary-absent entry). */
const NOT_RECOGNIZED_PATTERNS = [
  /is not recognized as an internal or external command/i,
  /command not found/i,
  /No such file or directory/i,
];

function looksLikeCommandNotFound(stdout: string, stderr: string): boolean {
  if (stdout.trim().length > 0) return false;
  return NOT_RECOGNIZED_PATTERNS.some((re) => re.test(stderr));
}

/**
 * Probes a single candidate by running `<command> --version` and checking
 * the output content. Fail-open at every layer: any thrown error (ENOENT,
 * shell "not recognized", non-zero exit, etc.) is caught here and reported
 * back as "not found" rather than propagated — probing one candidate must
 * never abort discovery of the rest. Returns the resolved command string on
 * success (content-verified as genuine Codex CLI output), or null.
 */
function probeCandidate(command: string, exec: CodexExecFn): string | null {
  try {
    const stdout = exec(command);
    if (stdout.trim().startsWith(CODEX_VERSION_PREFIX)) {
      return command;
    }
    // Ran, produced output, but it isn't Codex's signature — a same-named
    // binary. Not "absent", but also not verified as Codex.
    return null;
  } catch (err: unknown) {
    // Fail-open: ENOENT (shell:false-style missing path) and the
    // shell:true "not recognized"/"command not found" shape (surfaced here
    // as a non-zero exit, which execFileSync reports by throwing with
    // stdout/stderr attached) both collapse to "this candidate found
    // nothing" — never propagate out of a single probe.
    return null;
  }
}

/** True if this specific candidate ran and produced output, but the content didn't match Codex's signature — used to prefer reporting "found-but-not-codex" over the generic "binary-absent" when we can tell the difference. */
function probeRanButWrongContent(command: string, exec: CodexExecFn): boolean {
  try {
    const stdout = exec(command);
    return stdout.trim().length > 0 && !stdout.trim().startsWith(CODEX_VERSION_PREFIX);
  } catch {
    return false;
  }
}

function addCandidate(list: CodexCandidate[], seen: Set<string>, origin: string, command: string | undefined | null): void {
  try {
    if (!command) return;
    const key = path.normalize(command).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ origin, command });
  } catch {
    // Malformed candidate path — treat as a no-op, never let one bad
    // candidate abort collection of the rest.
  }
}

/** Signal: bare `codex` resolved through the shell's own PATH search (shell:true handles this without us pre-resolving it). */
function collectPathSignal(list: CodexCandidate[], seen: Set<string>): void {
  addCandidate(list, seen, "PATH", "codex");
}

/**
 * Target-triple / platform-package map mirroring
 * hooks/codex-mcp-launcher.cjs's NODE_MODULES_TARGET_TRIPLES — kept in sync
 * manually since that file is CJS and this module is TS. Used only to
 * resolve the REAL vendor .exe/binary an npm-global `@openai/codex` install
 * ships, so discovery can offer it as a candidate instead of only the
 * npm-global codex.cmd/codex shim.
 */
const NODE_MODULES_TARGET_TRIPLES: { platform: NodeJS.Platform; arch: string; triple: string; pkg: string }[] = [
  { platform: "linux", arch: "x64", triple: "x86_64-unknown-linux-musl", pkg: "@openai/codex-linux-x64" },
  { platform: "linux", arch: "arm64", triple: "aarch64-unknown-linux-musl", pkg: "@openai/codex-linux-arm64" },
  { platform: "darwin", arch: "x64", triple: "x86_64-apple-darwin", pkg: "@openai/codex-darwin-x64" },
  { platform: "darwin", arch: "arm64", triple: "aarch64-apple-darwin", pkg: "@openai/codex-darwin-arm64" },
  { platform: "win32", arch: "x64", triple: "x86_64-pc-windows-msvc", pkg: "@openai/codex-win32-x64" },
  { platform: "win32", arch: "arm64", triple: "aarch64-pc-windows-msvc", pkg: "@openai/codex-win32-arm64" },
];

/**
 * Resolves an npm-global node_modules root's installed `@openai/codex`
 * package PAST its own bin/codex.js and codex.cmd shims to the real
 * platform-specific vendor .exe/binary (p69-t2,
 * docs/codex-reviewer-onboarding-friction-2026-09-18.md #6). Fail-open:
 * returns null when the base package or matching platform package aren't
 * present.
 */
function resolveVendorExeUnderNodeModules(nodeModulesDir: string): string | null {
  const entry = NODE_MODULES_TARGET_TRIPLES.find((t) => t.platform === process.platform && t.arch === process.arch);
  if (!entry) return null;
  try {
    const basePackageJson = path.join(nodeModulesDir, "@openai", "codex", "package.json");
    if (!fs.existsSync(basePackageJson)) return null;
    const binName = process.platform === "win32" ? "codex.exe" : "codex";
    return path.join(nodeModulesDir, "@openai", entry.pkg.replace("@openai/", ""), "vendor", entry.triple, "bin", binName);
  } catch {
    return null;
  }
}

/**
 * Signal: the npm global install location. Phase 1 observed this on one
 * machine at C:\Users\<user>\AppData\Roaming\npm\codex — but per
 * docs/PATH-DISCOVERY.md we must derive the prefix, never hardcode a
 * username or drive. Prefers asking npm itself (`npm prefix -g`, the
 * authoritative source), and falls back to the standard per-platform
 * default npm-global layout if npm isn't invocable — both wrapped so a
 * failure here is a silent no-op, never a crash. Also resolves PAST the
 * npm-global codex.cmd/codex shim to the real vendor .exe when the
 * platform package is present alongside it, offering that real executable
 * as a candidate before the shim (p69-t2).
 */
function collectNpmGlobalSignal(list: CodexCandidate[], seen: Set<string>): void {
  const basename = process.platform === "win32" ? "codex.cmd" : "codex";

  try {
    // No shell and never the project cwd (a planted npm.cmd); skip this rung when npm is unresolvable.
    const npm = npmInvocation();
    const prefix = npm
      ? execFileSync(npm.command, [...npm.args, "prefix", "-g"], {
          cwd: os.tmpdir(),
          encoding: "utf8",
          windowsHide: true,
          timeout: 10_000,
        }).trim()
      : "";
    if (prefix) {
      const npmBin = process.platform === "win32" ? prefix : path.join(prefix, "bin");
      const npmNodeModules = process.platform === "win32" ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules");
      const vendorExe = resolveVendorExeUnderNodeModules(npmNodeModules);
      if (vendorExe) addCandidate(list, seen, `npm global prefix vendor exe (${npmNodeModules})`, vendorExe);
      addCandidate(list, seen, "npm global prefix (npm prefix -g)", path.join(npmBin, basename));
    }
  } catch {
    // npm not on PATH, or the call failed — fall through to the
    // standard-default probe below rather than giving up on this signal
    // entirely.
  }

  try {
    if (process.platform === "win32") {
      const appData = process.env["APPDATA"];
      if (appData) {
        addCandidate(list, seen, "npm global default (%APPDATA%\\npm)", path.join(appData, "npm", "codex.cmd"));
      }
    } else {
      // Standard per-platform default when npm's own prefix reporting
      // wasn't available: /usr/local for a typical Node install.
      addCandidate(list, seen, "npm global default (/usr/local/bin)", path.join("/usr/local/bin", "codex"));
    }
  } catch {
    // Environment lookup failure — fail-open, no-op.
  }
}

/** Signal: Homebrew's install prefix on macOS (Apple Silicon and Intel default locations), a common independent install path distinct from npm. Fail-open: irrelevant/no-op on any other platform. */
function collectHomebrewSignal(list: CodexCandidate[], seen: Set<string>): void {
  try {
    if (process.platform !== "darwin") return;
    for (const brewPrefix of ["/opt/homebrew/bin", "/usr/local/bin"]) {
      addCandidate(list, seen, `Homebrew (${brewPrefix})`, path.join(brewPrefix, "codex"));
    }
  } catch {
    // no-op
  }
}

/** Signal: the POSIX install dirs a Dock-launched VS Code's minimal PATH misses (npm-global, volta, newest nvm node, plus Homebrew/local dirs). Added after PATH, de-duplicated against the other signals. */
function collectPosixDirsSignal(list: CodexCandidate[], seen: Set<string>, dirs: string[]): void {
  for (const dir of dirs) {
    addCandidate(list, seen, `install dir (${dir})`, path.posix.join(dir, "codex"));
  }
}

/** Signal: the user's home-relative common install dirs some CLI installers use (e.g. `~/.codex/bin`, `~/.local/bin`). Fail-open if os.homedir() throws (rare sandboxed/CI environments). */
function collectHomeRelativeSignal(list: CodexCandidate[], seen: Set<string>): void {
  try {
    const home = os.homedir();
    if (!home) return;
    const basename = process.platform === "win32" ? "codex.exe" : "codex";
    addCandidate(list, seen, "~/.codex/bin", path.join(home, ".codex", "bin", basename));
    addCandidate(list, seen, "~/.local/bin", path.join(home, ".local", "bin", basename));
  } catch {
    // os.homedir() can throw in rare sandboxed/CI environments — no-op.
  }
}

/** Maps process.platform/arch to the folder name the OpenAI ChatGPT VS Code extension ships its bundled Codex binary under (observed under its `bin/` dir: windows-x86_64, darwin-arm64, darwin-x86_64, linux-x86_64). Returns null for combinations the extension doesn't ship (fail-open — this signal simply contributes no candidate). */
function vsCodeExtensionBinPlatformFolder(): string | null {
  if (process.platform === "win32") return "windows-x86_64";
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x86_64";
  if (process.platform === "linux") return "linux-x86_64";
  return null;
}

/**
 * Signal: the Codex binary bundled inside the OpenAI ChatGPT VS Code
 * extension (installed for the Codex-in-VS Code experience even when no
 * standalone `codex` CLI is on PATH). Extensions install under
 * `<home>/.vscode/extensions` (and `.vscode-insiders`); each version lives in
 * its own `openai.chatgpt-<version>-<platform>` folder, so we glob for that
 * prefix, prefer the highest version when several are installed, and probe
 * `bin/<platform-folder>/codex[.exe]` inside it.
 */
function collectVsCodeExtensionSignal(list: CodexCandidate[], seen: Set<string>): void {
  const platformFolder = vsCodeExtensionBinPlatformFolder();
  if (!platformFolder) return;

  let home: string;
  try {
    home = os.homedir();
    if (!home) return;
  } catch {
    return;
  }

  const extensionsRoots: { label: string; dir: string }[] = [
    { label: "~/.vscode/extensions", dir: path.join(home, ".vscode", "extensions") },
    { label: "~/.vscode-insiders/extensions", dir: path.join(home, ".vscode-insiders", "extensions") },
  ];
  if (process.platform === "win32") {
    const userProfile = process.env["USERPROFILE"];
    if (userProfile) {
      addUniqueRoot(extensionsRoots, "%USERPROFILE%\\.vscode\\extensions", path.join(userProfile, ".vscode", "extensions"));
    }
  }

  const binName = process.platform === "win32" ? "codex.exe" : "codex";

  for (const root of extensionsRoots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root.dir);
    } catch {
      continue; // root doesn't exist / not readable — fail-open, try the next root
    }

    const matches = entries.filter((name) => name.startsWith("openai.chatgpt-"));
    if (matches.length === 0) continue;

    // Prefer the highest version when several are installed. Folder shape:
    // openai.chatgpt-<version>-<platform>, e.g.
    // openai.chatgpt-26.901.22334-win32-x64. Sort by parsed leading version
    // numerically (falls back to string compare if unparseable) so the
    // newest install wins.
    matches.sort((a, b) => compareExtensionFolderVersions(b, a));

    for (const folder of matches) {
      const candidatePath = path.join(root.dir, folder, "bin", platformFolder, binName);
      addCandidate(list, seen, `VS Code extension (${root.label}/${folder})`, candidatePath);
    }
  }
}

/** Adds a root to the list only if its resolved dir isn't already present (avoids probing the same extensions dir twice when USERPROFILE and os.homedir() coincide, as they normally do on Windows). */
function addUniqueRoot(roots: { label: string; dir: string }[], label: string, dir: string): void {
  const key = path.normalize(dir).toLowerCase();
  if (roots.some((r) => path.normalize(r.dir).toLowerCase() === key)) return;
  roots.push({ label, dir });
}

/** Extracts the `<version>` segment from an `openai.chatgpt-<version>-<platform>` folder name and compares two such names numerically (highest first when used as `(a,b)=>compare(b,a)`), falling back to a plain string compare when a version can't be parsed. */
function compareExtensionFolderVersions(a: string, b: string): number {
  const versionOf = (name: string): number[] | null => {
    const match = /^openai\.chatgpt-(\d+(?:\.\d+)*)/.exec(name);
    if (!match) return null;
    return match[1].split(".").map((n) => parseInt(n, 10));
  };
  const va = versionOf(a);
  const vb = versionOf(b);
  if (!va || !vb) return a.localeCompare(b);
  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i++) {
    const diff = (va[i] ?? 0) - (vb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Discovers and content-verifies the path to the Codex CLI binary,
 * following docs/PATH-DISCOVERY.md's discovery ladder:
 *   1. CODEX_BINARY_PATH (primary) or CODEX_CLI_PATH (alias, checked when
 *      CODEX_BINARY_PATH is unset) env override — always wins, skips every
 *      other rung.
 *   2. Multiple independent signals (PATH, npm global prefix, Homebrew,
 *      home-relative install dirs, the OpenAI ChatGPT VS Code extension's
 *      bundled binary), de-duplicated before probing.
 *   3. Content-based verification: each candidate is run with `--version`
 *      and the output must start with "codex-cli " — a same-named file is
 *      never accepted on name/existence alone.
 *   4. Every probe fails open — a thrown error from one candidate never
 *      aborts discovery of the rest.
 *
 * On total failure, throws a CodexDiscoveryError listing every location
 * tried and naming CODEX_BINARY_PATH as the override to set. Never returns
 * an empty string, null, or other success-shaped placeholder.
 */
export function discoverCodexBinary(opts?: CodexDiscoveryOptions): string {
  const exec = (opts && opts.exec) || defaultExec;
  const tried: string[] = [];

  const overrideVarName = process.env["CODEX_BINARY_PATH"] ? "CODEX_BINARY_PATH" : "CODEX_CLI_PATH";
  const override = process.env["CODEX_BINARY_PATH"] || process.env["CODEX_CLI_PATH"];
  if (override) {
    tried.push(`${overrideVarName}=${override}`);
    const resolved = probeCandidate(override, exec);
    if (resolved) {
      return resolved;
    }
    if (probeRanButWrongContent(override, exec)) {
      throw new CodexDiscoveryError(
        "found-but-not-codex",
        `${overrideVarName} is set to "${override}", but running it with --version did not produce Codex CLI's ` +
          `expected output (a string starting with "${CODEX_VERSION_PREFIX}"). This does not look like the Codex CLI. ` +
          `Verify ${overrideVarName} points at the real codex binary.`,
        tried,
      );
    }
    throw new CodexDiscoveryError(
      "binary-absent",
      `${overrideVarName} is set to "${override}", but it could not be run (missing, or not the Codex CLI). ` +
        `Verify the path and that the Codex CLI is installed there.`,
      tried,
    );
  }

  const candidates: CodexCandidate[] = [];
  const seen = new Set<string>();
  collectPathSignal(candidates, seen);
  collectNpmGlobalSignal(candidates, seen);
  collectHomebrewSignal(candidates, seen);
  collectHomeRelativeSignal(candidates, seen);
  const platform = opts?.platform ?? process.platform;
  if (platform !== "win32") collectPosixDirsSignal(candidates, seen, opts?.posixDirs ? opts.posixDirs() : posixSearchDirs());
  collectVsCodeExtensionSignal(candidates, seen);

  let sawWrongContent = false;
  for (const candidate of candidates) {
    tried.push(`${candidate.origin}: ${candidate.command}`);
    const resolved = probeCandidate(candidate.command, exec);
    if (resolved) {
      return resolved;
    }
    if (!sawWrongContent && probeRanButWrongContent(candidate.command, exec)) {
      sawWrongContent = true;
    }
  }

  // Last rung (POSIX only): ask the user's login shell, which sees the PATH their terminal does.
  if (platform !== "win32") {
    tried.push("login shell ($SHELL -ilc 'command -v codex')");
    const viaShell = (opts?.loginShell ?? ((n: string) => loginShellLookup(n, { platform })))("codex");
    if (viaShell) {
      tried.push(`login shell: ${viaShell}`);
      const resolved = probeCandidate(viaShell, exec);
      if (resolved) return resolved;
      if (!sawWrongContent && probeRanButWrongContent(viaShell, exec)) sawWrongContent = true;
    }
  }

  const triedList = tried.map((t) => `  - ${t}`).join("\n");
  throw new CodexDiscoveryError(
    sawWrongContent ? "found-but-not-codex" : "binary-absent",
    `Could not find the Codex CLI. Tried:\n${triedList}\n\n` +
      `Set the CODEX_BINARY_PATH environment variable to the codex binary's full path to override discovery.`,
    tried,
  );
}
