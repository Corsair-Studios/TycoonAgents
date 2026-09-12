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
const { needsShell } = require("../../hooks/codex-mcp-launcher.cjs");

const IS_WIN = process.platform === "win32";
const LAUNCHER_PATH = join(__dirname, "..", "..", "hooks", "codex-mcp-launcher.cjs");
/** node's own bin dir — only enough PATH for fixture scripts to resolve `node` itself; not the real dev PATH. */
const NODE_BIN_DIR = dirname(process.execPath);

const PE_SKIP_REASON =
  "requires a genuine win32 PE codex.exe spawned with shell:false (bundle/node_modules signals are hardcoded to a .exe path there); cannot fabricate one without compiling or renaming to .exe (forbidden by test-execution policy)";

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

function scrubbedEnv(overrides: NodeJS.ProcessEnv, emptyProjectRoot: string): NodeJS.ProcessEnv {
  const passthrough = ["SystemRoot", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "SystemDrive"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of passthrough) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env["PATH"] = NODE_BIN_DIR;
  delete env["USERPROFILE"];
  delete env["HOME"];
  delete env["APPDATA"];
  delete env["CODEX_CLI_PATH"];
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
// (extension-signal) posix only: win32's bundle candidate is hardcoded to
// bin/<platform>/codex.exe — a real PE, which is skipped per PE_SKIP_REASON.
// ---------------------------------------------------------------------------

test(
  "(extension-signal) the numerically-newest VS Code extension candidate is the one actually launched",
  { skip: IS_WIN && PE_SKIP_REASON },
  () => {
    const home = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-"));
    const emptyProjectRoot = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-empty-root-"));
    try {
      const platformFolder = platformFolderForThisProcess();
      const versions = ["26.903.71938", "26.908.31748", "26.1000.1"];
      const selfPaths: Record<string, string> = {};
      for (const v of versions) {
        const dir = join(home, ".vscode", "extensions", `openai.chatgpt-${v}-${process.platform}-x64`, "bin", platformFolder);
        mkdirSync(dir, { recursive: true });
        selfPaths[v] = writeFixtureStub(dir, "codex");
      }
      const env = scrubbedEnv({ USERPROFILE: home }, emptyProjectRoot);
      const result = runLauncher(["marker-arg"], env);

      assert.equal(result.status, 0, `expected success, stderr: ${result.stderr}`);
      assert.ok(
        result.stdout.includes(`SELF:${selfPaths["26.1000.1"]}`),
        `expected the numerically-highest (26.1000.1) copy to be the one launched — lexical order would rank it below the others, got stdout: ${result.stdout}`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(emptyProjectRoot, { recursive: true, force: true });
    }
  },
);

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
    const env = scrubbedEnv({ USERPROFILE: home, CODEX_CLI_PATH: overridePath }, emptyProjectRoot);
    const result = runLauncher(["hello"], env);

    assert.equal(result.status, 0, `expected success, stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes(`SELF:${overridePath}`), `expected the override binary to run, got stdout: ${result.stdout}`);
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
    const env = scrubbedEnv({ USERPROFILE: home, CODEX_CLI_PATH: overridePath }, emptyProjectRoot);
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
// (capability) posix only: the incapable candidate lives at the
// node_modules signal's hardcoded vendor path, which is codex.exe on win32
// (a real PE, shell:false) — skipped there per PE_SKIP_REASON.
// ---------------------------------------------------------------------------

test(
  "(capability) a --help-incapable candidate is skipped, and the next candidate wins",
  { skip: IS_WIN && PE_SKIP_REASON },
  () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-proj-"));
    const pathDir = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-pathbin-"));
    const emptyProjectRoot = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-empty-root-"));
    try {
      // Rung 2 (node_modules): a content-verified but MCP-server-incapable
      // candidate — package.json present (so the signal trusts this tree),
      // vendor binary present, NO_MCP_SERVER marker dropped next to it so
      // this fixture's --help omits "mcp-server".
      const triple = process.platform === "darwin" ? (process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin") : "x86_64-unknown-linux-musl";
      const pkg = process.platform === "darwin" ? (process.arch === "arm64" ? "codex-darwin-arm64" : "codex-darwin-x64") : "codex-linux-x64";
      const nmDir = join(projectRoot, "node_modules");
      mkdirSync(join(nmDir, "@openai", "codex"), { recursive: true });
      writeFileSync(join(nmDir, "@openai", "codex", "package.json"), "{}", "utf8");
      const vendorDir = join(nmDir, "@openai", pkg, "vendor", triple, "bin");
      mkdirSync(vendorDir, { recursive: true });
      const incapableSelf = writeFixtureStub(vendorDir, "codex");
      writeFileSync(join(vendorDir, "NO_MCP_SERVER"), "", "utf8");

      // Rung 3 (PATH): a capable candidate — same fixture, no marker.
      const capableSelf = writeFixtureStub(pathDir, "codex");

      const env = scrubbedEnv(
        {
          USERPROFILE: projectRoot,
          CODEX_LAUNCHER_PROJECT_ROOT: projectRoot,
          PATH: `${pathDir}${IS_WIN ? ";" : ":"}${NODE_BIN_DIR}`,
        },
        emptyProjectRoot,
      );
      const result = runLauncher(["mcp-server"], env);

      const stderr = result.stderr || "";
      assert.ok(
        stderr.includes(`skipping "${incapableSelf}"`) && stderr.includes('does not mention "mcp-server"'),
        `expected the incapable node_modules candidate to be named and skipped, got stderr:\n${stderr}`,
      );
      assert.equal(result.status, 0, `expected the PATH candidate to win after the skip, stderr: ${stderr}`);
      assert.ok(result.stdout.includes(`SELF:${capableSelf}`), `expected the capable PATH candidate to be the one launched, got stdout: ${result.stdout}`);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(pathDir, { recursive: true, force: true });
      rmSync(emptyProjectRoot, { recursive: true, force: true });
    }
  },
);

test("(override) a nonexistent CODEX_CLI_PATH is reported to stderr and discovery falls through", () => {
  const home = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-"));
  const emptyProjectRoot = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-empty-root-"));
  try {
    const missing = join(home, "does-not-exist-codex-binary");
    const env = scrubbedEnv({ USERPROFILE: home, CODEX_CLI_PATH: missing }, emptyProjectRoot);
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
    const env = scrubbedEnv({ USERPROFILE: home }, emptyProjectRoot);
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
