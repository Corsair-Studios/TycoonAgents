/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";

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
function probeCandidate(command: string): string | null {
  try {
    const stdout = execFileSync(command, ["--version"], {
      shell: true,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
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
function probeRanButWrongContent(command: string): boolean {
  try {
    const stdout = execFileSync(command, ["--version"], {
      shell: true,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
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
 * Signal: the npm global install location. Phase 1 observed this on one
 * machine at C:\Users\<user>\AppData\Roaming\npm\codex — but per
 * docs/PATH-DISCOVERY.md we must derive the prefix, never hardcode a
 * username or drive. Prefers asking npm itself (`npm prefix -g`, the
 * authoritative source), and falls back to the standard per-platform
 * default npm-global layout if npm isn't invocable — both wrapped so a
 * failure here is a silent no-op, never a crash.
 */
function collectNpmGlobalSignal(list: CodexCandidate[], seen: Set<string>): void {
  const basename = process.platform === "win32" ? "codex.cmd" : "codex";

  try {
    const prefix = execFileSync("npm", ["prefix", "-g"], {
      shell: true,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    }).trim();
    if (prefix) {
      const npmBin = process.platform === "win32" ? prefix : path.join(prefix, "bin");
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

/**
 * Discovers and content-verifies the path to the Codex CLI binary,
 * following docs/PATH-DISCOVERY.md's discovery ladder:
 *   1. CODEX_BINARY_PATH env override — always wins, skips every other rung.
 *   2. Multiple independent signals (PATH, npm global prefix, Homebrew,
 *      home-relative install dirs), de-duplicated before probing.
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
export function discoverCodexBinary(): string {
  const tried: string[] = [];

  const override = process.env["CODEX_BINARY_PATH"];
  if (override) {
    tried.push(`CODEX_BINARY_PATH=${override}`);
    const resolved = probeCandidate(override);
    if (resolved) {
      return resolved;
    }
    if (probeRanButWrongContent(override)) {
      throw new CodexDiscoveryError(
        "found-but-not-codex",
        `CODEX_BINARY_PATH is set to "${override}", but running it with --version did not produce Codex CLI's ` +
          `expected output (a string starting with "${CODEX_VERSION_PREFIX}"). This does not look like the Codex CLI. ` +
          `Verify CODEX_BINARY_PATH points at the real codex binary.`,
        tried,
      );
    }
    throw new CodexDiscoveryError(
      "binary-absent",
      `CODEX_BINARY_PATH is set to "${override}", but it could not be run (missing, or not the Codex CLI). ` +
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

  let sawWrongContent = false;
  for (const candidate of candidates) {
    tried.push(`${candidate.origin}: ${candidate.command}`);
    const resolved = probeCandidate(candidate.command);
    if (resolved) {
      return resolved;
    }
    if (!sawWrongContent && probeRanButWrongContent(candidate.command)) {
      sawWrongContent = true;
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
