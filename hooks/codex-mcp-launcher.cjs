#!/usr/bin/env node
/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 *
 * Discovers the Codex CLI binary at launch time and execs it, so the
 * .mcp.json "codex" server entry never hardcodes a version-pinned path
 * under the OpenAI ChatGPT VS Code extension's install dir (that dir's
 * name changes on every extension auto-update, e.g.
 * openai.chatgpt-26.903.71938-win32-x64 -> openai.chatgpt-26.908.31748-win32-x64,
 * which breaks a hardcoded path in .mcp.json).
 *
 * Mirrors the discovery ladder in src/providers/codex/codexDiscovery.ts
 * and docs/PATH-DISCOVERY.md, in plain CommonJS (no TypeScript import,
 * Node built-ins only) so it can run directly via `node` from .mcp.json:
 *   1. CODEX_BINARY_PATH (checked first) or CODEX_CLI_PATH (alias, checked
 *      second) env override wins if set AND it resolves to a real,
 *      content-verified Codex binary. If the override is set but does not
 *      exist / doesn't verify, that is reported (not silently ignored) and
 *      discovery falls through to the remaining rungs.
 *   2. A project-local `node_modules/@openai/codex` devDependency (e.g.
 *      pinned to a build that still has `mcp-server`), resolved past its
 *      own bin/codex.js and codex.cmd shims to the real vendor .exe/binary
 *      the matching platform package ships.
 *   3. `codex` on PATH.
 *   4. npm global install location (npm prefix -g, then the standard
 *      per-platform default).
 *   5. Homebrew's install prefix (macOS only).
 *   6. Home-relative install dirs some installers use (~/.codex/bin,
 *      ~/.local/bin).
 *   7. The newest openai.chatgpt-* directory under the VS Code extensions
 *      dir (and .vscode-insiders), picking the highest version by numeric
 *      comparison, then bin/<platform-arch>/codex(.exe) inside it.
 *   8. Content/executability check: each candidate is run with `--version`
 *      and the output must start with "codex-cli ". Capability-aware: when
 *      the launcher was asked to run `mcp-server`, a candidate whose own
 *      --help does not list that subcommand is skipped (logged) rather
 *      than accepted — see discoverCodexBinary's hasCapability().
 *
 * On total failure, prints ONE explicit line to stderr listing every
 * location probed, and exits 1. Never silent, never a placeholder path.
 *
 * Env vars:
 *   CODEX_BINARY_PATH          — override, rung 1 above (checked first).
 *   CODEX_CLI_PATH             — alias for CODEX_BINARY_PATH, rung 1 above
 *     (checked second); also the internal handoff var this launcher sets
 *     when it re-execs into hooks/codex-app-server-mcp.cjs (see main()).
 *   CODEX_LAUNCHER_PROJECT_ROOT — test-isolation seam for the node_modules
 *     signal (rung 2): when set, the node_modules walk starts at this dir
 *     ONLY (no process.cwd()/__dirname fallback), so a test can scrub
 *     USERPROFILE/PATH and still keep this signal from finding the repo's
 *     real installed @openai/codex. Not consulted by any other rung.
 *
 * shell:false vs shell:true: a real executable (.exe on Windows, a binary
 * on unix) is spawned with shell:false so Node passes argv as a real array
 * to CreateProcess/execve — required for quoted -c values like
 * `-c model="gpt-5"` to arrive at the child with the literal quote
 * characters intact. shell:true is required instead for anything that
 * resolves through a shell shim: a bare `codex` PATH lookup, or a path
 * that ends in .cmd/.bat (Windows batch shims, e.g. the npm-global
 * install's codex.cmd) — spawning those with shell:false throws EINVAL on
 * Windows (a .cmd/.bat is not a native executable CreateProcess can launch
 * directly). Verified empirically (scratch .cmd-shim-plus-argv-echo probe,
 * see docs/codex-reviewer-onboarding-friction-2026-09-18.md #6): under
 * shell:true, cmd.exe's own command-line parsing DOES strip the literal
 * `"` characters from a value like `model="gpt-6-astra"` (the child sees
 * `model=gpt-6-astra`, no quotes) — but it does NOT mis-split or corrupt
 * argument boundaries; each `-c` array element still arrives as exactly
 * one argv entry, spaces and all. So a .cmd shim loses literal quote
 * characters, not argument structure — harmless for values Codex accepts
 * unquoted (its own onboarding session proved the quoted -c flags worked
 * end-to-end through a .cmd shim). This module still prefers resolving
 * PAST a known .cmd shim to the real underlying .exe wherever it can (see
 * collectNodeModulesSignal / collectNpmGlobalSignal) so quote characters
 * are never dropped at all, but a .cmd shim is not the correctness hazard
 * this comment previously implied.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync, spawn } = require("child_process");

const CODEX_VERSION_PREFIX = "codex-cli ";

const NOT_RECOGNIZED_PATTERNS = [
  /is not recognized as an internal or external command/i,
  /command not found/i,
  /No such file or directory/i,
];

/**
 * True when `command` must be launched through a shell: a bare name (no
 * path separators — PATH lookup, and on Windows a .cmd shim resolution),
 * or a path that itself ends in .cmd/.bat (a Windows batch shim — spawning
 * one with shell:false throws EINVAL, since it is not a native executable
 * CreateProcess can launch directly). A resolved path to a real executable
 * (.exe on Windows, a unix binary) must use shell:false so argv quoting
 * survives.
 */
function needsShell(command) {
  const isBareName = !command.includes("/") && !command.includes("\\");
  if (isBareName) return true;
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) return true;
  return false;
}

function looksLikeCommandNotFound(stdout, stderr) {
  if (stdout && stdout.trim().length > 0) return false;
  return NOT_RECOGNIZED_PATTERNS.some((re) => re.test(stderr || ""));
}

/**
 * Probes a single candidate by running `<command> --version` and checking
 * the output content. Fail-open: any thrown error, non-zero exit, or
 * missing binary is reported back as "not found" (null) rather than
 * propagated — probing one candidate must never abort discovery of the
 * rest. Returns { ok: true } on content-verified success, or
 * { ok: false, ranButWrongContent: boolean } on failure.
 */
function probeCandidate(command, spawnSyncFn) {
  try {
    const result = spawnSyncFn(command, ["--version"], {
      shell: needsShell(command),
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    const stdout = result.stdout || "";
    const stderr = result.stderr || "";
    if (result.error) {
      return { ok: false, ranButWrongContent: false };
    }
    if (stdout.trim().startsWith(CODEX_VERSION_PREFIX)) {
      return { ok: true };
    }
    if (looksLikeCommandNotFound(stdout, stderr)) {
      return { ok: false, ranButWrongContent: false };
    }
    // Ran, produced output (or exited nonzero for some other reason), but
    // it isn't Codex's signature — a same-named binary, or a broken one.
    const ranButWrongContent = stdout.trim().length > 0 && !stdout.trim().startsWith(CODEX_VERSION_PREFIX);
    return { ok: false, ranButWrongContent };
  } catch {
    return { ok: false, ranButWrongContent: false };
  }
}

function addCandidate(list, seen, origin, command) {
  try {
    if (!command) return;
    const key = path.normalize(command).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ origin, command });
  } catch {
    // Malformed candidate path — no-op, never abort collection of the rest.
  }
}

function collectPathSignal(list, seen) {
  addCandidate(list, seen, "PATH", "codex");
}

/**
 * Target-triple / platform-package map mirroring
 * node_modules/@openai/codex/bin/codex.js's PLATFORM_PACKAGE_BY_TARGET —
 * kept in sync manually since that file is ESM and this launcher is CJS.
 * Used only to resolve the REAL vendor .exe/binary the platform package
 * ships, so it can be spawned with shell:false instead of going through
 * the npm-installed codex.cmd/codex shim.
 */
const NODE_MODULES_TARGET_TRIPLES = [
  { platform: "linux", arch: "x64", triple: "x86_64-unknown-linux-musl", pkg: "@openai/codex-linux-x64" },
  { platform: "linux", arch: "arm64", triple: "aarch64-unknown-linux-musl", pkg: "@openai/codex-linux-arm64" },
  { platform: "darwin", arch: "x64", triple: "x86_64-apple-darwin", pkg: "@openai/codex-darwin-x64" },
  { platform: "darwin", arch: "arm64", triple: "aarch64-apple-darwin", pkg: "@openai/codex-darwin-arm64" },
  { platform: "win32", arch: "x64", triple: "x86_64-pc-windows-msvc", pkg: "@openai/codex-win32-x64" },
  { platform: "win32", arch: "arm64", triple: "aarch64-pc-windows-msvc", pkg: "@openai/codex-win32-arm64" },
];

/** Walks upward from `startDir`, yielding each `<dir>/node_modules` that exists, stopping at the filesystem root. Fail-open: a missing/unreadable dir along the way is simply not yielded. */
function* walkUpNodeModulesDirs(startDir) {
  let dir = startDir;
  let prev = null;
  while (dir && dir !== prev) {
    const candidate = path.join(dir, "node_modules");
    try {
      if (fs.statSync(candidate).isDirectory()) yield candidate;
    } catch {
      // no node_modules at this level — keep walking up
    }
    prev = dir;
    dir = path.dirname(dir);
  }
}

/**
 * Signal: a project-local `node_modules/@openai/codex` devDependency
 * (e.g. pinned to a version with a subcommand the ChatGPT VS Code
 * extension's bundled build lacks). Resolves PAST the package's own
 * bin/codex.js shim (and past codex.cmd on Windows) straight to the real
 * platform-specific vendor binary — @openai/codex-<platform>/vendor/<target
 * triple>/bin/codex(.exe) — so the candidate is a real executable spawned
 * with shell:false, never a shim.
 *
 * Root selection: if CODEX_LAUNCHER_PROJECT_ROOT is set, the node_modules
 * walk starts there ONLY (no process.cwd()/__dirname fallback) — this is
 * the test isolation seam: a test that scrubs USERPROFILE/PATH and points
 * this at an empty fixture dir gets a clean ladder, unaffected by whatever
 * devDependency happens to be installed in this repo's real node_modules.
 * Without the override, it walks up from both process.cwd() and __dirname
 * (this script's own location), since the launcher may be invoked with a
 * cwd that isn't the project root.
 */
function collectNodeModulesSignal(list, seen) {
  const entry = NODE_MODULES_TARGET_TRIPLES.find((t) => t.platform === process.platform && t.arch === process.arch);
  if (!entry) return; // unsupported platform/arch combo for this package — no-op

  const binName = process.platform === "win32" ? "codex.exe" : "codex";
  const projectRootOverride = process.env["CODEX_LAUNCHER_PROJECT_ROOT"];
  const roots = projectRootOverride ? [projectRootOverride] : [process.cwd(), __dirname];

  for (const root of roots) {
    for (const nodeModulesDir of walkUpNodeModulesDirs(root)) {
      // Confirm the base @openai/codex package is actually installed here
      // before trusting this node_modules tree (content-over-name-matching:
      // don't just guess the platform package path).
      const basePackageJson = path.join(nodeModulesDir, "@openai", "codex", "package.json");
      if (!fs.existsSync(basePackageJson)) continue;

      const vendorExe = path.join(nodeModulesDir, "@openai", entry.pkg.replace("@openai/", ""), "vendor", entry.triple, "bin", binName);
      addCandidate(list, seen, `node_modules (${nodeModulesDir})`, vendorExe);
    }
  }
}

/**
 * Resolves an npm-global (or any) node_modules root's installed
 * `@openai/codex` package PAST its own bin/codex.js and codex.cmd shims to
 * the real platform-specific vendor .exe/binary, the same way
 * collectNodeModulesSignal does for a project-local devDependency — added
 * for p69-t2 (docs/codex-reviewer-onboarding-friction-2026-09-18.md #6),
 * since the npm-global install is the common case and was previously only
 * ever offered as the .cmd shim itself. Fail-open: returns null when the
 * base package or matching platform package aren't present.
 */
function resolveVendorExeUnderNodeModules(nodeModulesDir) {
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

/** Signal: the npm global install location. Prefers asking npm itself (npm prefix -g), falls back to the standard per-platform default npm-global layout if npm isn't invocable — wrapped so a failure here is a silent no-op, never a crash. Mirrors collectNpmGlobalSignal in codexDiscovery.ts. Also resolves PAST the npm-global codex.cmd/codex shim to the real vendor .exe when the platform package is present alongside it (see resolveVendorExeUnderNodeModules), so this signal offers the real executable candidate FIRST and the shim as a fallback candidate. */
function collectNpmGlobalSignal(list, seen) {
  const basename = process.platform === "win32" ? "codex.cmd" : "codex";

  try {
    const result = spawnSync("npm", ["prefix", "-g"], {
      shell: true,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    const prefix = (result.stdout || "").trim();
    if (!result.error && prefix) {
      const npmBin = process.platform === "win32" ? prefix : path.join(prefix, "bin");
      const npmNodeModules = process.platform === "win32" ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules");
      const vendorExe = resolveVendorExeUnderNodeModules(npmNodeModules);
      if (vendorExe) addCandidate(list, seen, `npm global prefix vendor exe (${npmNodeModules})`, vendorExe);
      addCandidate(list, seen, "npm global prefix (npm prefix -g)", path.join(npmBin, basename));
    }
  } catch {
    // npm not on PATH, or the call failed — fall through to the standard
    // default below rather than giving up on this signal entirely.
  }

  try {
    if (process.platform === "win32") {
      const appData = process.env["APPDATA"];
      if (appData) {
        addCandidate(list, seen, "npm global default (%APPDATA%\\npm)", path.join(appData, "npm", "codex.cmd"));
      }
    } else {
      addCandidate(list, seen, "npm global default (/usr/local/bin)", path.join("/usr/local/bin", "codex"));
    }
  } catch {
    // Environment lookup failure — fail-open, no-op.
  }
}

/** Signal: Homebrew's install prefix on macOS (Apple Silicon and Intel default locations). Fail-open / no-op on any other platform. Mirrors collectHomebrewSignal in codexDiscovery.ts. */
function collectHomebrewSignal(list, seen) {
  try {
    if (process.platform !== "darwin") return;
    for (const brewPrefix of ["/opt/homebrew/bin", "/usr/local/bin"]) {
      addCandidate(list, seen, `Homebrew (${brewPrefix})`, path.join(brewPrefix, "codex"));
    }
  } catch {
    // no-op
  }
}

/** Signal: the user's home-relative common install dirs some CLI installers use (~/.codex/bin, ~/.local/bin). Fail-open if os.homedir() throws. Mirrors collectHomeRelativeSignal in codexDiscovery.ts. */
function collectHomeRelativeSignal(list, seen) {
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

/** Same platform-arch folder names codexDiscovery.ts uses under the VS Code extension's bin/ dir. */
function vsCodeExtensionBinPlatformFolder() {
  if (process.platform === "win32") return "windows-x86_64";
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x86_64";
  if (process.platform === "linux") return "linux-x86_64";
  return null;
}

/** Extracts the `<version>` segment from an `openai.chatgpt-<version>-<platform>` folder name and compares two such names numerically (highest first when used as (a,b)=>compare(b,a)), falling back to a string compare when unparseable. */
function compareExtensionFolderVersions(a, b) {
  const versionOf = (name) => {
    const match = /^openai\.chatgpt-(\d+(?:\.\d+)*)/.exec(name);
    if (!match) return null;
    return match[1].split(".").map((n) => parseInt(n, 10));
  };
  const va = versionOf(a);
  const vb = versionOf(b);
  if (!va || !vb) return a.localeCompare(b);
  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i++) {
    const diff = (va[i] || 0) - (vb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function addUniqueRoot(roots, label, dir) {
  const key = path.normalize(dir).toLowerCase();
  if (roots.some((r) => path.normalize(r.dir).toLowerCase() === key)) return;
  roots.push({ label, dir });
}

/** Signal: the Codex binary bundled inside the OpenAI ChatGPT VS Code extension. Extensions install under <home>/.vscode/extensions (and .vscode-insiders); each version lives in its own openai.chatgpt-<version>-<platform> folder, so this globs for that prefix, prefers the highest version, and probes bin/<platform-folder>/codex[.exe] inside it. */
function collectVsCodeExtensionSignal(list, seen) {
  const platformFolder = vsCodeExtensionBinPlatformFolder();
  if (!platformFolder) return;

  let home;
  try {
    home = os.homedir();
    if (!home) return;
  } catch {
    return;
  }

  const extensionsRoots = [
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
    let entries;
    try {
      entries = fs.readdirSync(root.dir);
    } catch {
      continue; // root doesn't exist / not readable — fail-open, try the next root
    }

    const matches = entries.filter((name) => name.startsWith("openai.chatgpt-"));
    if (matches.length === 0) continue;

    matches.sort((a, b) => compareExtensionFolderVersions(b, a));

    for (const folder of matches) {
      const candidatePath = path.join(root.dir, folder, "bin", platformFolder, binName);
      addCandidate(list, seen, `VS Code extension (${root.label}/${folder})`, candidatePath);
    }
  }
}

/**
 * Discovers and content-verifies the path to the Codex CLI binary,
 * following docs/PATH-DISCOVERY.md's discovery ladder. Returns the
 * resolved command string on success. On total failure, writes one
 * explicit line to stderr listing every location tried and exits 1
 * (never returns / never silent).
 *
 * Capability-aware: when `requestedArgs` asks for `mcp-server`, a
 * candidate that content-verifies as Codex but whose own --help does NOT
 * list `mcp-server` (e.g. the ChatGPT VS Code extension's newer alpha
 * build, which dropped it — see docs/codex-harness-findings.md) is
 * skipped rather than accepted: one stderr line names the skip, and the
 * ladder continues to the next candidate. This is why the node_modules
 * signal (a pinned devDependency build that still has `mcp-server`) is
 * checked before the VS Code extension signal — see the ladder order
 * below. Other requested subcommands are not capability-checked; the
 * version-drift translateMcpServerSubcommand() below remains the
 * last-resort fallback if every candidate is skipped this way.
 */
/**
 * `opts.allowIncapableFallback`: when true AND `requestedArgs` wants
 * `mcp-server` AND every content-verified candidate is skipped ONLY for
 * lacking the `mcp-server` capability (Plan p30-t1: 0.154+ builds dropped
 * it), this returns `{ fallbackTo: <first incapable command> }` instead of
 * printing the "could not find a usable Codex CLI" error and exiting —
 * main() uses that to launch hooks/codex-app-server-mcp.cjs against that
 * binary instead. A candidate that fails outright (wrong/no content) is
 * still just skipped as before and does not trigger this fallback path by
 * itself; the fallback only fires when discovery would otherwise have
 * failed and at least one real (but incapable) Codex binary was found.
 */
function discoverCodexBinary(requestedArgs, opts) {
  const tried = [];
  const wantsMcpServer = Array.isArray(requestedArgs) && requestedArgs.includes("mcp-server");
  const allowIncapableFallback = Boolean(opts && opts.allowIncapableFallback) && wantsMcpServer;
  // Injectable spawnSync-shaped seam (Plan p34-t3): defaults to the real
  // child_process.spawnSync, so CLI entry behaviour (`main()` with no
  // override) is byte-for-byte identical to before this seam existed.
  // Tests inject a fake that returns canned --help/--version text and
  // records how it was called, without ever spawning a real process — this
  // is what lets the two win32-skipped cases below run everywhere.
  const spawnSyncFn = (opts && opts.spawnSync) || spawnSync;
  // Per-call cache (defaults to the shared module-level cache used by
  // getHelpText/translateMcpServerSubcommand at real runtime) so injected
  // test spawns never collide with each other or with a prior real call.
  const helpCache = (opts && opts.helpTextCache) || helpTextCache;
  let firstIncapable = null;

  function hasCapability(command) {
    if (!wantsMcpServer) return true;
    // Deliberately a plain substring test, not the stricter
    // Commands-list-anchored helpListsCommand() used elsewhere in this
    // file: this check must also pass against a minimal argv-echo/fixture
    // binary used in tests, whose --help output is not shaped like real
    // clap output. Literal token "mcp-server" anywhere in --help is
    // sufficient signal here.
    const help = getHelpText(command, [], spawnSyncFn, helpCache);
    if (help && help.includes("mcp-server")) return true;
    if (allowIncapableFallback && !firstIncapable) firstIncapable = command;
    process.stderr.write(
      `codex-mcp-launcher: skipping "${command}" — its --help does not mention "mcp-server" (an MCP-server-incapable ` +
        `Codex CLI build); trying the next candidate.\n`,
    );
    return false;
  }

  const overrideVarName = process.env["CODEX_BINARY_PATH"] ? "CODEX_BINARY_PATH" : "CODEX_CLI_PATH";
  const override = process.env["CODEX_BINARY_PATH"] || process.env["CODEX_CLI_PATH"];
  if (override) {
    tried.push(`${overrideVarName}=${override}`);
    const probed = probeCandidate(override, spawnSyncFn);
    if (probed.ok && hasCapability(override)) {
      return override;
    }
    if (!probed.ok) {
      // Override set but did not resolve — report it, then fall through to
      // the rest of the ladder rather than treating this as fatal.
      process.stderr.write(
        `codex-mcp-launcher: ${overrideVarName}="${override}" did not resolve to a working Codex CLI ` +
          `(expected output starting with "${CODEX_VERSION_PREFIX}") — falling back to discovery.\n`,
      );
    }
  }

  const candidates = [];
  const seen = new Set();
  collectNodeModulesSignal(candidates, seen);
  collectPathSignal(candidates, seen);
  collectNpmGlobalSignal(candidates, seen);
  collectHomebrewSignal(candidates, seen);
  collectHomeRelativeSignal(candidates, seen);
  collectVsCodeExtensionSignal(candidates, seen);

  for (const candidate of candidates) {
    tried.push(`${candidate.origin}: ${candidate.command}`);
    const probed = probeCandidate(candidate.command, spawnSyncFn);
    if (probed.ok && hasCapability(candidate.command)) {
      return candidate.command;
    }
  }

  if (allowIncapableFallback && firstIncapable) {
    return { fallbackTo: firstIncapable };
  }

  const triedList = tried.map((t) => `  - ${t}`).join("\n");
  process.stderr.write(
    `codex-mcp-launcher: could not find a usable Codex CLI${wantsMcpServer ? " with an mcp-server subcommand" : ""}. Tried:\n${triedList}\n\n` +
      `Set the CODEX_BINARY_PATH (or CODEX_CLI_PATH) environment variable to the codex binary's full path to override discovery.\n`,
  );
  process.exit(1);
}

/**
 * Version-drift best-effort translation for the trailing MCP-server-start
 * subcommand. Some Codex CLI builds (observed: 0.154.0-alpha.6.1) removed
 * the historical `mcp-server` subcommand from `codex --help`'s Commands
 * list — running it unrecognized falls through to the interactive CLI,
 * which reads argv as a PROMPT and then fails with "stdin is not a
 * terminal" instead of starting an MCP stdio server. This function does
 * ONE `--help` probe (cached in-process) and, only if `mcp-server` is
 * genuinely absent from the binary's Commands list, tries a short list of
 * known alternate spellings; whichever is present in the help text is
 * substituted, and the substitution is logged to stderr (never silent).
 *
 * Empirically verified against 0.154.0-alpha.6.1 (see docs/codex-harness-findings.md):
 * that build's `codex mcp` subcommand only manages *external* MCP servers
 * Codex itself connects out to (list/get/add/remove/login/logout) and its
 * `app-server` subcommand speaks a different, Codex-proprietary JSON-RPC
 * protocol (confirmed: `initialize` succeeds but `tools/list` is rejected
 * as an unknown method, with `app-server`'s own method list returned
 * instead) — neither is an MCP-compatible substitute. When no known
 * alternate spelling is found either, this logs one stderr line and
 * passes `mcp-server` through unchanged (best-effort; the caller/user must
 * pin a Codex CLI build that still exposes a real MCP stdio server).
 */
// Empirically checked against 0.154.0-alpha.6.1 (docs/codex-harness-findings.md):
// "mcp serve" and "serve" are NOT valid in that build (`codex mcp --help`
// lists only list/get/add/remove/login/logout). They stay in this list so a
// future build that adds one is picked up automatically via the strict
// sub-help check below — a loose substring check previously mis-matched
// "serve" against "app-server" and produced a wrong, non-functional guess.
const KNOWN_MCP_SERVER_SPELLINGS = ["mcp-server", "mcp serve", "serve"];

const helpTextCache = new Map();
function getHelpText(command, subArgs, spawnSyncFn, cache) {
  const spawn = spawnSyncFn || spawnSync;
  const helpCache = cache || helpTextCache;
  const key = command + "\0" + subArgs.join(" ");
  if (helpCache.has(key)) return helpCache.get(key);
  let text = "";
  try {
    const result = spawn(command, [...subArgs, "--help"], {
      shell: needsShell(command),
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    text = (result.stdout || "") + (result.stderr || "");
  } catch {
    text = "";
  }
  helpCache.set(key, text);
  return text;
}

function helpListsCommand(helpText, name) {
  // Matches a Commands: entry like "  mcp-server   ..." — word boundary so
  // "mcp" doesn't falsely match "mcp-server", and anchored to the start of
  // a Commands-list line (not a raw substring search, which previously
  // mis-matched "serve" inside "app-server").
  const re = new RegExp(`^\\s{2}${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`, "m");
  return re.test(helpText);
}

/** True only if `spelling` (one or two words) is a genuine subcommand path in this build: each word is independently confirmed present in its own --help's Commands list (never a raw substring match against unrelated help text). */
function spellingIsValid(command, parts, spawnSyncFn, helpCache) {
  const topHelp = getHelpText(command, [], spawnSyncFn, helpCache);
  if (!helpListsCommand(topHelp, parts[0])) return false;
  if (parts.length === 1) return true;
  const subHelp = getHelpText(command, [parts[0]], spawnSyncFn, helpCache);
  return helpListsCommand(subHelp, parts[1]);
}

function translateMcpServerSubcommand(command, args, spawnSyncFn, helpCache) {
  const idx = args.lastIndexOf("mcp-server");
  if (idx === -1) return args;

  const topHelp = getHelpText(command, [], spawnSyncFn, helpCache);
  if (!topHelp) return args; // couldn't probe help — pass through unchanged, best-effort

  if (helpListsCommand(topHelp, "mcp-server")) {
    return args; // this build still has it — no translation needed
  }

  for (const spelling of KNOWN_MCP_SERVER_SPELLINGS) {
    if (spelling === "mcp-server") continue;
    const parts = spelling.split(" ");
    if (spellingIsValid(command, parts, spawnSyncFn, helpCache)) {
      process.stderr.write(
        `codex-mcp-launcher: this Codex CLI build's --help does not list "mcp-server"; substituting "${spelling}" (confirmed present in --help). ` +
          `If this is wrong, set CODEX_CLI_PATH to a build that still supports the expected subcommand.\n`,
      );
      const next = args.slice();
      next.splice(idx, 1, ...parts);
      return next;
    }
  }

  process.stderr.write(
    `codex-mcp-launcher: this Codex CLI build's --help does not list "mcp-server" and no known alternate spelling ` +
      `(${KNOWN_MCP_SERVER_SPELLINGS.filter((s) => s !== "mcp-server").join(", ")}) was confirmed present in --help either — ` +
      `passing "mcp-server" through unchanged. This build has no known MCP-compatible stdio server subcommand ` +
      `(its "mcp" subcommand only manages external MCP servers Codex connects out to, and "app-server" speaks a ` +
      `different, non-MCP protocol) — the MCP server will fail to start. See docs/codex-harness-findings.md.\n`,
  );
  return args;
}

/**
 * Spawns the discovered binary with the (possibly version-translated)
 * launcher args, stdio "inherit" (stdout is the MCP channel — this script
 * must never print to stdout itself), forwarding the child's exit code and
 * signal. Uses shell:false for the resolved absolute path so quoted -c
 * values are not mangled (see needsShell doc comment above).
 */
// p69-t3: honors a per-launch reasoning-effort override when set, since the
// static `-c model_reasoning_effort="..."` args baked into .mcp.json are
// shared by every agent using this "codex" MCP server entry and cannot
// reflect a single agent's `backend.reasoningEffort` frontmatter. When
// CODEX_REASONING_EFFORT is set (e.g. exported by whatever spawned this
// launcher for a specific agent), any existing `-c model_reasoning_effort=`
// pair in the requested args is replaced; otherwise the pair is appended.
// Unset (the common case): args pass through unchanged, so the static -c
// flags baked into .mcp.json / catalog.json remain the only path — see
// docs/adding-a-non-anthropic-agent.md's "Routing files" section.
const REASONING_EFFORT_ALLOWLIST = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

function applyReasoningEffortOverride(args, env) {
  const override = env && env["CODEX_REASONING_EFFORT"];
  if (!override) return args;
  const normalized = String(override).trim().toLowerCase();
  if (!REASONING_EFFORT_ALLOWLIST.has(normalized)) {
    // Never echo the raw value: this may reach cmd.exe via shell:true, so an
    // unvalidated value is a potential argument/shell-metacharacter injection
    // vector, not just a bad config value.
    process.stderr.write("CODEX_REASONING_EFFORT ignored: not an allowed value\n");
    return args;
  }
  const flagValue = `model_reasoning_effort="${normalized}"`;
  const out = [];
  let replaced = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c" && typeof args[i + 1] === "string" && /^model_reasoning_effort=/.test(args[i + 1])) {
      out.push("-c", flagValue);
      replaced = true;
      i++;
      continue;
    }
    out.push(args[i]);
  }
  if (!replaced) out.push("-c", flagValue);
  return out;
}

function main(opts) {
  const spawnSyncFn = (opts && opts.spawnSync) || spawnSync;
  const spawnFn = (opts && opts.spawn) || spawn;
  const helpCache = (opts && opts.helpTextCache) || helpTextCache;
  const requestedArgs = applyReasoningEffortOverride(process.argv.slice(2), process.env);
  const wantsMcpServer = requestedArgs.includes("mcp-server");
  const discovered = discoverCodexBinary(requestedArgs, {
    allowIncapableFallback: wantsMcpServer,
    spawnSync: spawnSyncFn,
    helpTextCache: helpCache,
  });

  if (discovered && typeof discovered === "object" && discovered.fallbackTo) {
    // Plan p30-t1: every candidate that content-verified as Codex lacks the
    // `mcp-server` subcommand (0.154+ dropped it) — fall back to the
    // app-server-backed MCP shim, driving that same (incapable) binary via
    // CODEX_CLI_PATH so it never re-runs discovery. This is an explicit,
    // logged substitution, never silent.
    const shimPath = path.join(__dirname, "codex-app-server-mcp.cjs");
    process.stderr.write(
      `codex-mcp-launcher: no discovered Codex CLI has an "mcp-server" subcommand; falling back to the app-server ` +
        `MCP shim (${shimPath}) against "${discovered.fallbackTo}".\n`,
    );
    const shimArgs = requestedArgs.filter((a) => a !== "mcp-server");
    const child = spawnFn(process.execPath, [shimPath, ...shimArgs], {
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, CODEX_CLI_PATH: discovered.fallbackTo },
    });
    child.on("error", (err) => {
      process.stderr.write(`codex-mcp-launcher: failed to launch app-server shim: ${err && err.message}\n`);
      process.exit(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code === null ? 1 : code);
    });
    return;
  }

  const command = discovered;
  const args = translateMcpServerSubcommand(command, requestedArgs, spawnSyncFn, helpCache);

  const child = spawnFn(command, args, {
    shell: needsShell(command),
    stdio: "inherit",
    windowsHide: true,
  });

  child.on("error", (err) => {
    process.stderr.write(`codex-mcp-launcher: failed to launch "${command}": ${err && err.message}\n`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      // Re-raise the same signal on ourselves so the parent sees the same
      // termination shape it would have from the child directly.
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code === null ? 1 : code);
  });
}

module.exports = { discoverCodexBinary, main, needsShell, applyReasoningEffortOverride };

if (require.main === module) {
  main();
}
