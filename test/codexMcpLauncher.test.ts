/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Plan task p28-t2 / p34-t1: unit tests for hooks/codex-mcp-launcher.cjs
// (needsShell + discoverCodexBinary + main). The launcher has no injectable
// env/platform seam (unlike src/providers/codex/codexDiscovery.ts's
// options-based discoverCodexBinary) — it reads process.env and
// os.homedir() directly.
//
// needsShell() itself is a pure function (no I/O) and is exported and unit
// tested directly below — no spawn, no fixture.
//
// The remaining cases spawn the launcher as a real child process
// (node <launcher.cjs> [...args]) with a fully controlled env: a scrubbed
// PATH, USERPROFILE pointed at a fixture temp dir (Node's os.homedir() on
// win32 reads USERPROFILE), and only the Windows plumbing vars
// (SystemRoot/ComSpec/PATHEXT/etc.) needed for cmd.exe/CreateProcess to
// function. This never touches the real ~/.vscode or PATH.
//
// The launcher resolves absolute-path candidates (CODEX_CLI_PATH, the VS
// Code extension bin/codex.exe, the node_modules vendor binary) with
// shell:false (see needsShell() in the launcher) — CreateProcess requires a
// genuine Win32 PE image for that path; a .cmd/.bat/text fixture fails with
// EINVAL under shell:false. This project's test-execution policy forbids
// compiling an executable (no csc.exe) or renaming any file to .exe, so
// those specific candidate-wins-the-ladder cases cannot be exercised
// end-to-end here and are marked test.skip with that reason. What CAN be
// (and is) covered without any exe: needsShell() directly for both branches
// (bare/.cmd/.bat -> shell:true, resolved non-shim path -> shell:false), and
// the override-missing / nothing-found cases below, which only need a
// missing or never-present binary.
//
// Every env var either file consults (directly or via os.homedir()) is
// enumerated and scrubbed for the duration of each spawn: PATH,
// USERPROFILE, HOME, APPDATA, CODEX_CLI_PATH, CODEX_LAUNCHER_PROJECT_ROOT.
// scrubbedEnv() below builds an explicit allowlist rather than inheriting
// process.env, so none of these can leak in from the host machine.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
const { needsShell, discoverCodexBinary, applyReasoningEffortOverride } = require("../../hooks/codex-mcp-launcher.cjs");

const IS_WIN = process.platform === "win32";
const LAUNCHER_PATH = join(__dirname, "..", "..", "hooks", "codex-mcp-launcher.cjs");
/** node's own bin dir — only enough PATH for fixture scripts to resolve `node` itself; not the real dev PATH. */
const NODE_BIN_DIR = dirname(process.execPath);

/**
 * Fake spawnSync (Plan p34-t3): matches the same argv shape needsShell()
 * drives real spawnSync calls with, but never spawns a real process — this
 * is the seam that lets the two previously-win32-skipped cases below (the
 * node_modules/VS Code bundle candidates the real ladder hardcodes to a
 * .exe on win32, which this project's test-execution policy forbids
 * fabricating) run on every platform. `matches` maps an exact command
 * string to `{ version, help }` canned output; any other command is
 * reported as "not recognized" (the same shape a real missing binary
 * produces), matching looksLikeCommandNotFound()'s check. Every call is
 * recorded on the returned function's `.calls` for assertions on argv/shell.
 */
function makeFakeSpawnSync(matches: Record<string, { version?: string; help?: string }>) {
  const calls: { command: string; args: string[]; shell: boolean }[] = [];
  const fn = (command: string, args: string[], options: { shell?: boolean }) => {
    calls.push({ command, args: args.slice(), shell: Boolean(options && options.shell) });
    const cfg = matches[command];
    if (!cfg) {
      return { stdout: "", stderr: `'${command}' is not recognized as an internal or external command`, status: 1, error: undefined };
    }
    if (args[0] === "--version") {
      return { stdout: cfg.version || "", stderr: "", status: 0, error: undefined };
    }
    // Any other invocation in this file's tests is a --help probe
    // (args is [...subArgs, "--help"]).
    return { stdout: cfg.help || "", stderr: "", status: 0, error: undefined };
  };
  (fn as any).calls = calls;
  return fn as unknown as typeof import("node:child_process").spawnSync & { calls: typeof calls };
}

/** Captures everything written to process.stderr for the duration of `fn()` (discoverCodexBinary writes its skip/failure diagnostics there directly), restoring the real stream afterward. */
function captureStderr(fn: () => unknown): { result: unknown; stderr: string } {
  let stderr = "";
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (chunk: any) => {
    stderr += chunk.toString();
    return true;
  };
  try {
    const result = fn();
    return { result, stderr };
  } finally {
    process.stderr.write = orig;
  }
}

// ---------------------------------------------------------------------------
// Shared fixture: one Node script, reused by every shim below. It is
// invoked as `node fakeCodex.js <selfPath> <realArgs...>` where <selfPath>
// is baked into the wrapping .cmd (win32) or shell script (posix) at
// generation time, so each copy reports an identity distinct from every
// other copy without relying on argv0/%~f0 quirks.
// ---------------------------------------------------------------------------

const fixtureRoot = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-fixture-"));
const fakeCodexJs = join(fixtureRoot, "fakeCodex.js");
writeFileSync(
  fakeCodexJs,
  [
    "const fs = require('fs');",
    "const path = require('path');",
    "const [self, ...rest] = process.argv.slice(2);",
    "if (rest[0] === '--version') { console.log('codex-cli 0.0.0-test'); process.exit(0); }",
    "if (rest[rest.length - 1] === '--help') {",
    "  const marker = path.join(path.dirname(self), 'NO_MCP_SERVER');",
    "  if (fs.existsSync(marker)) {",
    "    console.log('Commands:');",
    "    console.log('  version   Show version');",
    "    console.log('  help      Show this help');",
    "  } else {",
    "    console.log('Commands:');",
    "    console.log('  mcp-server   Run the MCP stdio server');",
    "    console.log('  version      Show version');",
    "  }",
    "  process.exit(0);",
    "}",
    "console.log('SELF:' + self + '|ARGV:[' + rest.map((a) => JSON.stringify(a)).join(',') + ']');",
  ].join("\n"),
  "utf8",
);
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

/** node's path with backslashes escaped for embedding inside a double-quoted .cmd literal. */
function cmdQuote(p: string): string {
  return `"${p}"`;
}

/**
 * Writes an executable stub at `dir/name` that runs the shared fixture with
 * its own path baked in as the SELF marker. Win32: a .cmd shim (content is
 * plain text — never a compiled or renamed .exe); the launcher's needsShell()
 * treats a .cmd path as shell:true, which is the only shape the launcher
 * accepts for a non-PE candidate. Posix: a real executable shebang script
 * (chmod 755), which the launcher spawns directly with shell:false — this is
 * genuine execution via execve, not a renamed binary.
 */
function writeFixtureStub(dir: string, name: string): string {
  const dest = join(dir, name);
  if (IS_WIN) {
    writeFileSync(dest, `@echo off\r\nnode ${cmdQuote(fakeCodexJs)} ${cmdQuote(dest)} %*\r\n`);
  } else {
    writeFileSync(dest, `#!/bin/sh\nexec node ${cmdQuote(fakeCodexJs)} ${cmdQuote(dest)} "$@"\n`, "utf8");
    chmodSync(dest, 0o755);
  }
  return dest;
}

// ---------------------------------------------------------------------------
// applyReasoningEffortOverride(): pure function, no fixture or spawn needed.
// ---------------------------------------------------------------------------

test("applyReasoningEffortOverride: no CODEX_REASONING_EFFORT env -> args pass through unchanged (same values, no -c appended)", () => {
  const args = ["-c", 'model="foo"', "mcp-server"];
  assert.deepEqual(applyReasoningEffortOverride(args, {}), args);
});

test("applyReasoningEffortOverride: an allowlisted value with no existing model_reasoning_effort pair appends one", () => {
  const args = ["mcp-server"];
  const result = applyReasoningEffortOverride(args, { CODEX_REASONING_EFFORT: "high" });
  assert.deepEqual(result, ["mcp-server", "-c", 'model_reasoning_effort="high"']);
});

test("applyReasoningEffortOverride: an allowlisted value replaces an existing -c model_reasoning_effort= pair in place", () => {
  const args = ["-c", 'model_reasoning_effort="low"', "mcp-server"];
  const result = applyReasoningEffortOverride(args, { CODEX_REASONING_EFFORT: "MAX" });
  assert.deepEqual(result, ["-c", 'model_reasoning_effort="max"', "mcp-server"]);
});

test("applyReasoningEffortOverride: an invalid value is dropped, args unchanged, warning goes to stderr without echoing the raw value", () => {
  const args = ["mcp-server"];
  const { result, stderr } = captureStderr(() => applyReasoningEffortOverride(args, { CODEX_REASONING_EFFORT: "$(rm -rf /)" }));
  assert.deepEqual(result, args, "args must be returned unchanged for an invalid override");
  assert.ok(stderr.includes("CODEX_REASONING_EFFORT ignored"), `expected an ignore warning, got: ${stderr}`);
  assert.ok(!stderr.includes("$(rm -rf /)"), "the raw invalid value must never be echoed to stderr");
});

test("applyReasoningEffortOverride: every allowlisted value is accepted verbatim (lowercased)", () => {
  for (const v of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
    const result = applyReasoningEffortOverride([], { CODEX_REASONING_EFFORT: v.toUpperCase() });
    assert.deepEqual(result, ["-c", `model_reasoning_effort="${v}"`]);
  }
});

// ---------------------------------------------------------------------------
// needsShell(): pure function, no fixture or spawn needed.
// ---------------------------------------------------------------------------

test("needsShell: a bare command name (PATH lookup) requires a shell", () => {
  assert.equal(needsShell("codex"), true);
});

test("needsShell: a .cmd path requires a shell on win32", { skip: !IS_WIN && "win32-only branch" }, () => {
  assert.equal(needsShell("C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd"), true);
  assert.equal(needsShell("C:\\Users\\me\\AppData\\Roaming\\npm\\codex.bat"), true);
});

test("needsShell: a resolved absolute path to a real executable does not require a shell", () => {
  const exePath = IS_WIN ? "C:\\Users\\me\\.vscode\\extensions\\openai.chatgpt-1.0.0-win32-x64\\bin\\windows-x86_64\\codex.exe" : "/home/me/.codex/bin/codex";
  assert.equal(needsShell(exePath), false);
});

function platformFolderForThisProcess(): string {
  if (process.platform === "win32") return "windows-x86_64";
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x86_64";
  return "linux-x86_64";
}

/**
 * The env var os.homedir() actually reads on this platform — win32 reads
 * USERPROFILE, posix reads HOME. A test fixture that only sets USERPROFILE
 * (Windows-only semantics) leaves os.homedir() on posix pointed at
 * whatever the real CI runner's HOME is, so the VS Code extension signal
 * (which globs under `<home>/.vscode/extensions`) silently finds nothing —
 * this is what made the extension-signal test fail on ubuntu-latest while
 * passing on windows-latest.
 */
const HOME_ENV_KEY = IS_WIN ? "USERPROFILE" : "HOME";

/** Builds the { USERPROFILE } or { HOME } override for scrubbedEnv()'s `overrides`, whichever this platform's os.homedir() actually reads. */
function homeOverride(dir: string): NodeJS.ProcessEnv {
  return { [HOME_ENV_KEY]: dir };
}

function scrubbedEnv(overrides: NodeJS.ProcessEnv, emptyProjectRoot: string): NodeJS.ProcessEnv {
  const passthrough = ["SystemRoot", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "SystemDrive"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of passthrough) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Every fixture shim on posix is `#!/bin/sh` + `exec node "<fixture.js>" "$@"`,
  // so PATH must resolve both `node` (this process's own execPath dir) and
  // `sh` itself (via /bin, /usr/bin) inside the spawned child's env.
  env["PATH"] = IS_WIN ? NODE_BIN_DIR : `${NODE_BIN_DIR}:/bin:/usr/bin`;
  delete env["USERPROFILE"];
  delete env["HOME"];
  delete env["APPDATA"];
  delete env["CODEX_CLI_PATH"];
  delete env["CODEX_BINARY_PATH"];
  // Always set: keeps the node_modules signal (rung 2) from walking up to
  // this repo's real node_modules/@openai/codex install. Tests that
  // specifically exercise that signal would override it.
  env["CODEX_LAUNCHER_PROJECT_ROOT"] = emptyProjectRoot;
  return { ...env, ...overrides };
}

function runLauncher(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [LAUNCHER_PATH, ...args], {
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
}

// ---------------------------------------------------------------------------
// (extension-signal) Plan p34-t3: exercises discoverCodexBinary() directly
// (in-process, no launcher subprocess) with an injected fake spawnSync, so
// the win32 bundle candidate (hardcoded to bin/<platform>/codex.exe, a real
// PE the test-execution policy forbids fabricating) never needs to actually
// be spawned — the fake matches on the exact candidate path string.
// ---------------------------------------------------------------------------

test("(extension-signal) the numerically-newest VS Code extension candidate is the one actually launched", () => {
  const home = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-"));
  const emptyProjectRoot = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-empty-root-"));
  const savedEnv = {
    USERPROFILE: process.env["USERPROFILE"],
    HOME: process.env["HOME"],
    CODEX_CLI_PATH: process.env["CODEX_CLI_PATH"],
    CODEX_LAUNCHER_PROJECT_ROOT: process.env["CODEX_LAUNCHER_PROJECT_ROOT"],
    PATH: process.env["PATH"],
    Path: process.env["Path"],
  };
  try {
    process.env[HOME_ENV_KEY] = home;
    delete process.env["CODEX_CLI_PATH"];
    process.env["CODEX_LAUNCHER_PROJECT_ROOT"] = emptyProjectRoot;
    // No candidate here is spawned via a real shell PATH lookup (spawnSync
    // is fully faked), so an empty PATH only needs to keep
    // collectNpmGlobalSignal's real `npm prefix -g` call from finding a
    // real npm on this machine.
    process.env["PATH"] = "";
    process.env["Path"] = "";

    const platformFolder = platformFolderForThisProcess();
    const binName = IS_WIN ? "codex.exe" : "codex";
    const versions = ["26.903.71938", "26.908.31748", "26.1000.1"];
    const candidatePaths: Record<string, string> = {};
    for (const v of versions) {
      const dir = join(home, ".vscode", "extensions", `openai.chatgpt-${v}-${process.platform}-x64`, "bin", platformFolder);
      mkdirSync(dir, { recursive: true });
      candidatePaths[v] = join(dir, binName);
    }
    const matches: Record<string, { version: string }> = {};
    for (const v of versions) matches[candidatePaths[v]] = { version: "codex-cli 0.0.0-test" };
    const spawnSyncFn = makeFakeSpawnSync(matches);

    const { result } = captureStderr(() => discoverCodexBinary(["marker-arg"], { spawnSync: spawnSyncFn }));

    assert.equal(result, candidatePaths["26.1000.1"], "expected the numerically-highest (26.1000.1) copy to be the one resolved — lexical order would rank it below the others");
    const versionCall = spawnSyncFn.calls.find((c) => c.command === candidatePaths["26.1000.1"] && c.args[0] === "--version");
    assert.ok(versionCall, "expected the winning candidate to have been probed with --version");
    assert.equal(versionCall!.shell, false, "a resolved absolute .exe/binary path must be spawned with shell:false");
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(emptyProjectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (override) both platforms: CODEX_CLI_PATH resolves through a .cmd shim on
// win32 (needsShell() treats .cmd as shell:true) or a direct executable
// script on posix. The override short-circuits before any bundle signal is
// even collected, so no bundle fixture is needed to prove it's never probed.
// ---------------------------------------------------------------------------

test("(override) CODEX_CLI_PATH pointing at a content-verified binary wins over an available bundle", () => {
  const home = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-"));
  const emptyProjectRoot = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-empty-root-"));
  try {
    const overridePath = writeFixtureStub(home, IS_WIN ? "codex.cmd" : "codex");
    const env = scrubbedEnv({ ...homeOverride(home), CODEX_CLI_PATH: overridePath }, emptyProjectRoot);
    const result = runLauncher(["hello"], env);

    assert.equal(result.status, 0, `expected success, stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes(`SELF:${overridePath}`), `expected the override binary to run, got stdout: ${result.stdout}`);
    assert.ok(!(result.stderr || "").includes("openai.chatgpt"), "the extension bundle candidate must never be probed once the override wins");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(emptyProjectRoot, { recursive: true, force: true });
  }
});

test("(override) CODEX_BINARY_PATH is honored (checked before CODEX_CLI_PATH)", () => {
  const home = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-"));
  const emptyProjectRoot = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-empty-root-"));
  try {
    const overridePath = writeFixtureStub(home, IS_WIN ? "codex.cmd" : "codex");
    const env = scrubbedEnv({ ...homeOverride(home), CODEX_BINARY_PATH: overridePath }, emptyProjectRoot);
    const result = runLauncher(["hello"], env);

    assert.equal(result.status, 0, `expected success, stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes(`SELF:${overridePath}`), `expected the CODEX_BINARY_PATH binary to run, got stdout: ${result.stdout}`);
    assert.ok(!(result.stderr || "").includes("openai.chatgpt"), "the extension bundle candidate must never be probed once the override wins");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(emptyProjectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (passthrough) both platforms via the same override path as above.
// ---------------------------------------------------------------------------

test("(passthrough) launcher args reach the resolved binary as distinct, unmangled arguments", () => {
  const home = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-"));
  const emptyProjectRoot = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-empty-root-"));
  try {
    const overridePath = writeFixtureStub(home, IS_WIN ? "codex.cmd" : "codex");
    const env = scrubbedEnv({ ...homeOverride(home), CODEX_CLI_PATH: overridePath }, emptyProjectRoot);
    const result = runLauncher(["-c", 'model="gpt-5"', "mcp-server"], env);

    assert.equal(result.status, 0, `expected success, stderr: ${result.stderr}`);
    const match = /ARGV:(\[.*\])/.exec(result.stdout);
    assert.ok(match, `expected an ARGV: line in stdout, got: ${result.stdout}`);
    const argv = JSON.parse(match![1]) as string[];
    // On posix the override is spawned with shell:false (a real executable
    // script) so the embedded quote survives verbatim. On win32 the
    // override is necessarily a .cmd shim (needsShell() requires shell:true
    // for .cmd), and cmd.exe's own argv reconstruction through a batch
    // file's %* strips embedded double quotes — verified empirically here,
    // not assumed; the 3 args still arrive in order and unsplit, which is
    // the property this rung of the ladder can actually guarantee for a
    // .cmd candidate.
    const expected = IS_WIN ? ["-c", "model=gpt-5", "mcp-server"] : ["-c", 'model="gpt-5"', "mcp-server"];
    assert.deepEqual(argv, expected, `expected all 3 args to arrive in order, got: ${JSON.stringify(argv)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(emptyProjectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (capability) Plan p34-t3: exercises discoverCodexBinary() directly with an
// injected fake spawnSync — the incapable candidate lives at the
// node_modules signal's hardcoded vendor path (codex.exe on win32, a real
// PE the test-execution policy forbids fabricating), so faking the
// --version/--help probes lets this run on every platform without ever
// spawning that path.
// ---------------------------------------------------------------------------

test("(capability) a --help-incapable candidate is skipped, and the next candidate wins", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-proj-"));
  const emptyHome = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-empty-home-"));
  const savedEnv: NodeJS.ProcessEnv = {
    CODEX_LAUNCHER_PROJECT_ROOT: process.env["CODEX_LAUNCHER_PROJECT_ROOT"],
    CODEX_CLI_PATH: process.env["CODEX_CLI_PATH"],
    PATH: process.env["PATH"],
    Path: process.env["Path"],
    [HOME_ENV_KEY]: process.env[HOME_ENV_KEY],
  };
  try {
    delete process.env["CODEX_CLI_PATH"];
    process.env[HOME_ENV_KEY] = emptyHome;
    // Nothing here is actually spawned via a shell PATH lookup (spawnSync
    // is fully faked below), so an empty PATH is sufficient — it only
    // needs to keep collectNpmGlobalSignal's real `npm prefix -g` call
    // from finding a real npm on this machine.
    process.env["PATH"] = "";
    process.env["Path"] = "";
    // Rung 2 (node_modules): a content-verified but MCP-server-incapable
    // candidate — package.json present (so the signal trusts this tree)
    // and the vendor path built from the real target-triple map; the
    // binary itself is never written to disk since the fake spawnSync
    // matches on the path string, not real file content.
    const triple = process.platform === "darwin" ? (process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin") : process.platform === "win32" ? "x86_64-pc-windows-msvc" : "x86_64-unknown-linux-musl";
    const pkg = process.platform === "darwin" ? (process.arch === "arm64" ? "codex-darwin-arm64" : "codex-darwin-x64") : process.platform === "win32" ? "codex-win32-x64" : "codex-linux-x64";
    const nmDir = join(projectRoot, "node_modules");
    mkdirSync(join(nmDir, "@openai", "codex"), { recursive: true });
    writeFileSync(join(nmDir, "@openai", "codex", "package.json"), "{}", "utf8");
    const vendorDir = join(nmDir, "@openai", pkg, "vendor", triple, "bin");
    const incapablePath = join(vendorDir, IS_WIN ? "codex.exe" : "codex");

    // Rung 3 (PATH): a capable candidate — the bare "codex" PATH lookup.
    const capableCommand = "codex";

    process.env["CODEX_LAUNCHER_PROJECT_ROOT"] = projectRoot;

    const spawnSyncFn = makeFakeSpawnSync({
      [incapablePath]: { version: "codex-cli 0.0.0-test", help: "Commands:\n  version   Show version\n  help      Show this help\n" },
      [capableCommand]: { version: "codex-cli 0.0.0-test", help: "Commands:\n  mcp-server   Run the MCP stdio server\n  version      Show version\n" },
    });

    const { result, stderr } = captureStderr(() => discoverCodexBinary(["mcp-server"], { spawnSync: spawnSyncFn }));

    assert.ok(
      stderr.includes(`skipping "${incapablePath}"`) && stderr.includes('does not mention "mcp-server"'),
      `expected the incapable node_modules candidate to be named and skipped, got stderr:\n${stderr}`,
    );
    assert.equal(result, capableCommand, `expected the capable PATH candidate to win after the skip, stderr:\n${stderr}`);
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(emptyHome, { recursive: true, force: true });
  }
});

test("(override) a nonexistent CODEX_CLI_PATH is reported to stderr and discovery falls through", () => {
  const home = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-"));
  const emptyProjectRoot = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-empty-root-"));
  try {
    const missing = join(home, "does-not-exist-codex-binary");
    const env = scrubbedEnv({ ...homeOverride(home), CODEX_CLI_PATH: missing }, emptyProjectRoot);
    const result = runLauncher(["--version"], env);

    assert.notEqual(result.status, 0, "no real codex is reachable after the override fails, so overall discovery still fails");
    const stderr = result.stderr || "";
    assert.ok(stderr.includes("CODEX_CLI_PATH"), `expected the override to be named in stderr, got:\n${stderr}`);
    assert.ok(stderr.includes("falling back to discovery"), `expected the fallback message, got:\n${stderr}`);
    assert.ok(stderr.includes(missing), `expected the missing path itself to be reported, got:\n${stderr}`);
    assert.ok(stderr.includes("PATH: codex"), `expected discovery to continue to the PATH signal, got:\n${stderr}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(emptyProjectRoot, { recursive: true, force: true });
  }
});

test("(not-found) no candidates anywhere: non-zero exit, empty stdout, stderr lists every probed location", () => {
  const home = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-"));
  const emptyProjectRoot = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-empty-root-"));
  try {
    const env = scrubbedEnv({ ...homeOverride(home) }, emptyProjectRoot);
    const result = runLauncher(["--version"], env);

    assert.equal(result.status, 1, "launcher explicitly exits 1 on total discovery failure");
    assert.equal((result.stdout || "").trim(), "", "launcher must never print to stdout on failure (stdout is reserved for the MCP channel)");
    const stderr = result.stderr || "";
    assert.ok(stderr.includes("could not find a usable Codex CLI"), `expected the explicit failure message, got:\n${stderr}`);
    assert.ok(stderr.includes("PATH: codex"), `expected the PATH signal to have been probed and listed, got:\n${stderr}`);
    assert.ok(stderr.includes("CODEX_CLI_PATH"), `expected guidance to set the override, got:\n${stderr}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(emptyProjectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (backend) automatic mcp-server vs app-server selection, and the
// TYCOON_CODEX_BACKEND override. The fake codex reports FAKE_CODEX_VERSION
// and lists `mcp-server` in --help only when that version is below 0.154.
// The app-server shim answers initialize/tools/list itself, so the fake never
// needs to speak app-server.
// ---------------------------------------------------------------------------

const versionedFakeJs = join(fixtureRoot, "versionedFakeCodex.js");
writeFileSync(
  versionedFakeJs,
  [
    "const [self, ...rest] = process.argv.slice(2);",
    "const version = process.env.FAKE_CODEX_VERSION || '0.153.0';",
    "const minor = Number(version.split('.')[1]);",
    "if (rest[0] === '--version') { console.log('codex-cli ' + version); process.exit(0); }",
    "if (rest[rest.length - 1] === '--help') {",
    "  console.log('Commands:');",
    "  if (minor < 154) console.log('  mcp-server   Run the MCP stdio server');",
    "  console.log('  app-server   Run the app server');",
    "  process.exit(0);",
    "}",
    "console.log('SELF:' + self + '|ARGV:[' + rest.map((a) => JSON.stringify(a)).join(',') + ']');",
  ].join("\n"),
  "utf8",
);

function writeVersionedStub(dir: string): string {
  const dest = join(dir, IS_WIN ? "codex.cmd" : "codex");
  if (IS_WIN) {
    writeFileSync(dest, `@echo off\r\nnode ${cmdQuote(versionedFakeJs)} ${cmdQuote(dest)} %*\r\n`);
  } else {
    writeFileSync(dest, `#!/bin/sh\nexec node ${cmdQuote(versionedFakeJs)} ${cmdQuote(dest)} "$@"\n`, "utf8");
    chmodSync(dest, 0o755);
  }
  return dest;
}

const MCP_HANDSHAKE =
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) +
  "\n" +
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) +
  "\n";

function runBackend(version: string, extra: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-"));
  const emptyProjectRoot = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-empty-root-"));
  try {
    const stub = writeVersionedStub(home);
    const env = scrubbedEnv({ ...homeOverride(home), CODEX_CLI_PATH: stub, FAKE_CODEX_VERSION: version, ...extra }, emptyProjectRoot);
    // Catalog shape: only -c pairs, no subcommand.
    return spawnSync(process.execPath, [LAUNCHER_PATH, "-c", 'model="x"'], { env, encoding: "utf8", windowsHide: true, timeout: 60_000, input: MCP_HANDSHAKE });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(emptyProjectRoot, { recursive: true, force: true });
  }
}

function assertAppServerShim(result: ReturnType<typeof runBackend>) {
  assert.ok((result.stderr || "").includes("app-server MCP shim"), `expected shim fallback, stderr: ${result.stderr}`);
  const lines = (result.stdout || "").split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l));
  assert.equal(lines[0]?.id, 1, `initialize must be answered, stdout: ${result.stdout}`);
  assert.ok(lines[0]?.result, "initialize result");
  const names = (lines[1]?.result?.tools ?? []).map((t: { name: string }) => t.name);
  assert.deepEqual(names.sort(), ["codex", "codex-reply"]);
}

test("(backend) codex 0.155 without mcp-server -> app-server shim answers initialize and tools/list", () => {
  assertAppServerShim(runBackend("0.155.0"));
});

test("(backend) codex 0.153 -> native mcp-server path, subcommand appended to catalog-shaped args", () => {
  const result = runBackend("0.153.0");
  assert.ok(!(result.stderr || "").includes("app-server MCP shim"), `must not use the shim, stderr: ${result.stderr}`);
  const match = /ARGV:(\[.*\])/.exec(result.stdout || "");
  assert.ok(match, `expected the fake to run, stdout: ${result.stdout}`);
  assert.equal(JSON.parse(match![1]).at(-1), "mcp-server");
});

test("(backend) TYCOON_CODEX_BACKEND=app-server forces the shim even on 0.153", () => {
  assertAppServerShim(runBackend("0.153.0", { TYCOON_CODEX_BACKEND: "app-server" }));
});

test("(backend) TYCOON_CODEX_BACKEND=mcp-server forces the native path even on 0.155", () => {
  const result = runBackend("0.155.0", { TYCOON_CODEX_BACKEND: "mcp-server" });
  assert.ok(!(result.stderr || "").includes("app-server MCP shim"), `must not use the shim, stderr: ${result.stderr}`);
  const match = /ARGV:(\[.*\])/.exec(result.stdout || "");
  assert.ok(match, `expected the fake to run, stdout: ${result.stdout}`);
  assert.equal(JSON.parse(match![1]).at(-1), "mcp-server");
});

test("(backend) version/launch-shape helpers", () => {
  const l = require("../../hooks/codex-mcp-launcher.cjs");
  assert.equal(l.versionLacksMcpServer("0.155.0"), true);
  assert.equal(l.versionLacksMcpServer("0.154.0-alpha.6.1"), true);
  assert.equal(l.versionLacksMcpServer("0.153.0"), false);
  assert.equal(l.versionLacksMcpServer("0.0.0-test"), false);
  assert.equal(l.wantsMcpServerLaunch(["-c", 'model="x"']), true);
  assert.equal(l.wantsMcpServerLaunch(["--version"]), false);
  assert.equal(l.wantsMcpServerLaunch(["hello"]), false);
});

test("(proxy) mcp-server path forwards a tools/call model argument to the child unchanged", () => {
  const { createMcpResultProxy } = require("../../hooks/codex-mcp-launcher.cjs");
  const toChild: string[] = [];
  const proxy = createMcpResultProxy({ writeClient: () => undefined, writeChild: (l: string) => toChild.push(l), model: "gpt-5.6-sol", timeoutMs: 60000, env: {} });
  const line = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "codex", arguments: { prompt: "hi", model: "gpt-6-astra" } } });
  proxy.onClientLine(line);
  const forwarded = toChild.map((l) => JSON.parse(l)).find((m) => m.method === "tools/call");
  assert.equal(forwarded.params.arguments.model, "gpt-6-astra");
  assert.equal(forwarded.params.arguments.prompt, "hi");
  proxy.dispose?.();
});
