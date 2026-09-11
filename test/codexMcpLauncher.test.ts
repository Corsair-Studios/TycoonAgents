/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Plan task p28-t2: unit tests for hooks/codex-mcp-launcher.cjs
// (discoverCodexBinary + main). The launcher has no injectable env/platform
// seam (unlike src/providers/codex/codexDiscovery.ts's options-based
// discoverCodexBinary) — it reads process.env and os.homedir() directly.
// So every case here spawns the launcher as a real child process
// (node <launcher.cjs> [...args]) with a fully controlled env: a scrubbed
// PATH, USERPROFILE pointed at a fixture temp dir (Node's os.homedir() on
// win32 reads USERPROFILE), and only the Windows plumbing vars
// (SystemRoot/ComSpec/PATHEXT/etc.) needed for cmd.exe/CreateProcess to
// function. This never touches the real ~/.vscode or PATH.
//
// The launcher resolves absolute-path candidates (CODEX_CLI_PATH, the VS
// Code extension bin/codex.exe) with shell:false (see needsShell() in the
// launcher) — a real Win32 executable is required; a .cmd/.bat fixture
// fails with EINVAL under shell:false (verified empirically while writing
// this file: spawnSync(<abs path>.cmd, ..., {shell:false}) -> EINVAL).
// So content-verified fixtures here are real, tiny, freshly-compiled PE
// binaries built with the .NET Framework C# compiler (csc.exe) already
// present on this machine — not downloaded, not checked into the repo,
// generated once into a temp dir in `before()` and cleaned up in `after()`.
// If csc.exe is unavailable (non-Windows, or a Windows box without a .NET
// Framework install), every case that needs a working fake binary is
// skipped with an explicit reason — cases 3 and 4 (which only need a
// *missing* or *never-present* binary) still run everywhere.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const IS_WIN = process.platform === "win32";
const LAUNCHER_PATH = join(__dirname, "..", "..", "hooks", "codex-mcp-launcher.cjs");
/** node's own bin dir — only enough PATH for fixture scripts to resolve `node` itself; not the real dev PATH. */
const NODE_BIN_DIR = dirname(process.execPath);

const CSC_CANDIDATES = [
  "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
];

let fixtureRoot: string | null = null;
let fakeExePath: string | null = null; // content-verified: --version -> "codex-cli 0.0.0-test"; --help -> a Commands list containing "mcp-server" UNLESS a "NO_MCP_SERVER" marker file sits next to this copy; else prints SELF:<own path>|ARGV:[...]
let emptyProjectRoot: string | null = null; // CODEX_LAUNCHER_PROJECT_ROOT default: has no node_modules at all, so the node_modules signal never finds this repo's real @openai/codex install.

function findCsc(): string | null {
  for (const c of CSC_CANDIDATES) {
    if (existsSync(c)) return c;
  }
  return null;
}

before(() => {
  if (!IS_WIN) return;
  emptyProjectRoot = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-empty-root-"));
  const csc = findCsc();
  if (!csc) return;
  fixtureRoot = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-fixture-"));
  const src = join(fixtureRoot, "fake.cs");
  writeFileSync(
    src,
    [
      "using System;",
      "using System.IO;",
      "using System.Reflection;",
      "class FakeCodex {",
      "  static int Main(string[] args) {",
      '    if (args.Length > 0 && args[0] == "--version") {',
      '      Console.WriteLine("codex-cli 0.0.0-test");',
      "      return 0;",
      "    }",
      '    if (args.Length > 0 && args[args.Length - 1] == "--help") {',
      "      string self0 = Assembly.GetExecutingAssembly().Location;",
      '      string marker = Path.Combine(Path.GetDirectoryName(self0), "NO_MCP_SERVER");',
      "      if (File.Exists(marker)) {",
      '        Console.WriteLine("Commands:");',
      '        Console.WriteLine("  version   Show version");',
      '        Console.WriteLine("  help      Show this help");',
      "      } else {",
      '        Console.WriteLine("Commands:");',
      '        Console.WriteLine("  mcp-server   Run the MCP stdio server");',
      '        Console.WriteLine("  version      Show version");',
      "      }",
      "      return 0;",
      "    }",
      "    string self = Assembly.GetExecutingAssembly().Location;",
      '    Console.WriteLine("SELF:" + self + "|ARGV:[" + string.Join(",", Array.ConvertAll(args, a => "\\"" + a.Replace("\\"", "\\\\\\"") + "\\"")) + "]");',
      "    return 0;",
      "  }",
      "}",
    ].join("\n"),
    "utf8",
  );
  const out = join(fixtureRoot, "fake.exe");
  const build = spawnSync(csc, ["/nologo", `/out:${out}`, src], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  if (build.status === 0 && existsSync(out)) {
    fakeExePath = out;
  }
});

after(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  if (emptyProjectRoot) rmSync(emptyProjectRoot, { recursive: true, force: true });
});

function scrubbedEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const passthrough = ["SystemRoot", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "SystemDrive"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of passthrough) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env["PATH"] = NODE_BIN_DIR;
  // Always set: keeps the node_modules signal (rung 2) from walking up to
  // this repo's real node_modules/@openai/codex install. Tests that
  // specifically exercise that signal override it below.
  env["CODEX_LAUNCHER_PROJECT_ROOT"] = emptyProjectRoot as string;
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

function makeExtensionFixture(home: string, versions: string[]): Record<string, string> {
  const extDir = join(home, ".vscode", "extensions");
  const binPaths: Record<string, string> = {};
  for (const v of versions) {
    const dir = join(extDir, `openai.chatgpt-${v}-win32-x64`, "bin", "windows-x86_64");
    mkdirSync(dir, { recursive: true });
    binPaths[v] = join(dir, "codex.exe");
  }
  return binPaths;
}

// ---------------------------------------------------------------------------
// 1. Newest version bundle wins by NUMERIC comparison, not lexical.
// ---------------------------------------------------------------------------

test("(extension-signal) the numerically-newest VS Code extension candidate is the one actually launched", { skip: (!IS_WIN && "win32-only: extension bin/ signal uses a win32 bin/windows-x86_64/codex.exe layout") || (IS_WIN && !fakeExePathAtLoad() && "csc.exe (.NET Framework) not found on this machine — cannot build a content-verified fixture .exe") }, () => {
  const home = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-"));
  try {
    // Lexical string order would rank "26.1000.1" BELOW "26.903..." and
    // "26.908..." (since '1' < '9' as the first differing character);
    // numeric order ranks it highest. All three get an IDENTICAL working
    // fixture binary copied in, so a content-check success alone can't
    // tell us which one ran — we identify the winner by its own compiled
    // location (SELF:<path>), which is unique per copy.
    const binPaths = makeExtensionFixture(home, ["26.903.71938", "26.908.31748", "26.1000.1"]);
    for (const v of Object.keys(binPaths)) {
      copyFileSync(fakeExePath as string, binPaths[v]);
    }
    const env = scrubbedEnv({ USERPROFILE: home });
    const result = runLauncher(["marker-arg"], env);

    assert.equal(result.status, 0, `expected success, stderr: ${result.stderr}`);
    assert.ok(
      result.stdout.includes(`SELF:${binPaths["26.1000.1"]}`),
      `expected the 26.1000.1 copy to be the one launched, got stdout: ${result.stdout}`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. CODEX_CLI_PATH override wins over a bundle candidate.
// ---------------------------------------------------------------------------

test("(override) CODEX_CLI_PATH pointing at a content-verified binary wins over an available bundle", { skip: (!IS_WIN && "win32-only fixture") || (IS_WIN && !fakeExePathAtLoad() && "csc.exe not found") }, () => {
  const home = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-"));
  try {
    const binPaths = makeExtensionFixture(home, ["26.1.0"]); // present, working, but must never be reached
    copyFileSync(fakeExePath as string, binPaths["26.1.0"]);
    const env = scrubbedEnv({ USERPROFILE: home, CODEX_CLI_PATH: fakeExePath as string });
    const result = runLauncher(["hello"], env);

    assert.equal(result.status, 0, `expected success, stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes(`SELF:${fakeExePath}`), `expected the override binary to run, got stdout: ${result.stdout}`);
    assert.ok(!(result.stderr || "").includes("openai.chatgpt"), "the extension bundle candidate must never be probed once the override wins");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. CODEX_CLI_PATH override that does not exist is reported, discovery continues.
// ---------------------------------------------------------------------------

test("(override) a nonexistent CODEX_CLI_PATH is reported to stderr and discovery falls through", () => {
  const home = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-"));
  try {
    const missing = join(home, "does-not-exist-codex-binary");
    const env = scrubbedEnv({ USERPROFILE: home, CODEX_CLI_PATH: missing });
    const result = runLauncher(["--version"], env);

    assert.notEqual(result.status, 0, "no real codex is reachable after the override fails, so overall discovery still fails");
    const stderr = result.stderr || "";
    assert.ok(stderr.includes("CODEX_CLI_PATH"), `expected the override to be named in stderr, got:\n${stderr}`);
    assert.ok(stderr.includes("falling back to discovery"), `expected the fallback message, got:\n${stderr}`);
    assert.ok(stderr.includes(missing), `expected the missing path itself to be reported, got:\n${stderr}`);
    assert.ok(stderr.includes("PATH: codex"), `expected discovery to continue to the PATH signal, got:\n${stderr}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Nothing found: non-zero exit, stderr lists probed locations, stdout empty.
// ---------------------------------------------------------------------------

test("(not-found) no candidates anywhere: non-zero exit, empty stdout, stderr lists every probed location", () => {
  const home = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-"));
  try {
    const env = scrubbedEnv({ USERPROFILE: home });
    const result = runLauncher(["--version"], env);

    assert.equal(result.status, 1, "launcher explicitly exits 1 on total discovery failure");
    assert.equal((result.stdout || "").trim(), "", "launcher must never print to stdout on failure (stdout is reserved for the MCP channel)");
    const stderr = result.stderr || "";
    assert.ok(stderr.includes("could not find a usable Codex CLI"), `expected the explicit failure message, got:\n${stderr}`);
    assert.ok(stderr.includes("PATH: codex"), `expected the PATH signal to have been probed and listed, got:\n${stderr}`);
    assert.ok(stderr.includes("CODEX_CLI_PATH"), `expected guidance to set the override, got:\n${stderr}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. argv passthrough: a quoted argument arrives intact as a single element.
// ---------------------------------------------------------------------------

test("(passthrough) launcher args reach the resolved binary as distinct, unmangled arguments", { skip: (!IS_WIN && "win32-only fixture") || (IS_WIN && !fakeExePathAtLoad() && "csc.exe not found") }, () => {
  const home = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-"));
  try {
    const env = scrubbedEnv({ USERPROFILE: home, CODEX_CLI_PATH: fakeExePath as string });
    const result = runLauncher(["-c", 'model="gpt-5"', "mcp-server"], env);

    assert.equal(result.status, 0, `expected success, stderr: ${result.stderr}`);
    const match = /ARGV:(\[.*\])/.exec(result.stdout);
    assert.ok(match, `expected an ARGV: line in stdout, got: ${result.stdout}`);
    const argv = JSON.parse(match![1]) as string[];
    // The launcher spawns a resolved absolute-path binary with shell:false
    // specifically so embedded quotes survive verbatim (see needsShell()'s
    // doc comment in the launcher) — verified empirically against this
    // exact fixture before writing this assertion.
    assert.deepEqual(argv, ["-c", 'model="gpt-5"', "mcp-server"], `expected all 3 args to arrive in order with the quote intact, got: ${JSON.stringify(argv)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Capability check: a candidate whose --help lacks "mcp-server" is
//    skipped (with a stderr line), and the next candidate in the ladder wins.
// ---------------------------------------------------------------------------

test("(capability) a --help-incapable candidate is skipped, and the next candidate wins", { skip: (!IS_WIN && "win32-only fixture") || (IS_WIN && !fakeExePathAtLoad() && "csc.exe not found") }, () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-proj-"));
  const pathDir = mkdtempSync(join(tmpdir(), "tycoon-codex-launcher-pathbin-"));
  try {
    // Rung 2 (node_modules): a content-verified but MCP-server-incapable
    // candidate — package.json present (so the signal trusts this tree),
    // vendor exe present, NO_MCP_SERVER marker dropped next to it so this
    // fixture's --help omits "mcp-server".
    const nmDir = join(projectRoot, "node_modules");
    mkdirSync(join(nmDir, "@openai", "codex"), { recursive: true });
    writeFileSync(join(nmDir, "@openai", "codex", "package.json"), "{}", "utf8");
    const vendorDir = join(nmDir, "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin");
    mkdirSync(vendorDir, { recursive: true });
    const incapableExe = join(vendorDir, "codex.exe");
    copyFileSync(fakeExePath as string, incapableExe);
    writeFileSync(join(vendorDir, "NO_MCP_SERVER"), "", "utf8");

    // Rung 3 (PATH): a capable candidate — same fixture binary, no marker.
    const capableExe = join(pathDir, "codex.exe");
    copyFileSync(fakeExePath as string, capableExe);

    const env = scrubbedEnv({
      USERPROFILE: projectRoot,
      CODEX_LAUNCHER_PROJECT_ROOT: projectRoot,
      PATH: `${pathDir};${NODE_BIN_DIR}`,
    });
    const result = runLauncher(["mcp-server"], env);

    const stderr = result.stderr || "";
    assert.ok(
      stderr.includes(`skipping "${incapableExe}"`) && stderr.includes('does not mention "mcp-server"'),
      `expected the incapable node_modules candidate to be named and skipped, got stderr:\n${stderr}`,
    );
    assert.equal(result.status, 0, `expected the PATH candidate to win after the skip, stderr: ${stderr}`);
    assert.ok(result.stdout.includes(`SELF:${capableExe}`), `expected the capable PATH candidate to be the one launched, got stdout: ${result.stdout}`);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(pathDir, { recursive: true, force: true });
  }
});

// Small helper so the `skip` option (evaluated at test-registration time,
// before `before()` has necessarily populated fakeExePath in registration
// order) reads the module-level var by reference at the time node:test
// actually runs the skip check. node:test evaluates options synchronously
// at test() call time, which happens before before() runs — so `skip` here
// intentionally does NOT gate on fakeExePath's *value* at registration;
// instead each test body itself would fail loudly if fakeExePath were null.
// To keep the skip reason honest we resolve csc.exe presence directly
// (cheap, synchronous, no compilation) rather than gating on the compiled
// output, which is why skip conditions above call findCsc()-equivalent
// logic via this helper.
function fakeExePathAtLoad(): boolean {
  return findCsc() !== null;
}
