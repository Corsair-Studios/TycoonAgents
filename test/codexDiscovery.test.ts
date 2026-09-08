/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// discoverCodexBinary() (src/providers/codex/codexDiscovery.ts) calls
// child_process.execFileSync directly inside unexported probeCandidate() /
// probeRanButWrongContent() helpers — there is no injection seam to stub the
// probe itself. Rather than mock child_process at the module level (out of
// scope for a test-only change, and this file does not touch the module
// under test), these tests exercise the real function against real,
// throwaway stub scripts written to a temp dir per test: a stub whose
// --version output starts with "codex-cli " stands in for a genuine
// install, and a nonexistent/bogus path stands in for "nothing found".
// process.env is saved/restored around every test so CODEX_BINARY_PATH,
// PATH, APPDATA, and HOME/USERPROFILE never leak into other tests or leave
// a real machine install able to leak in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { discoverCodexBinary, CodexDiscoveryError } from "../src/providers/codex/codexDiscovery";

const ENV_KEYS = ["CODEX_BINARY_PATH", "PATH", "Path", "APPDATA", "HOME", "USERPROFILE"] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) snap[key] = process.env[key];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (snap[key] === undefined) delete process.env[key];
    else process.env[key] = snap[key];
  }
}

/** Isolates discovery from whatever the host machine actually has installed: clears PATH-like vars and points HOME/APPDATA at an empty scratch dir so every non-override signal misses. */
function sandboxEnv(emptyDir: string): void {
  delete process.env["CODEX_BINARY_PATH"];
  process.env["PATH"] = emptyDir;
  process.env["Path"] = emptyDir;
  process.env["APPDATA"] = join(emptyDir, "appdata");
  process.env["HOME"] = emptyDir;
  process.env["USERPROFILE"] = emptyDir;
}

/** Writes a throwaway stub that `codex --version` would produce if it matched (or didn't match) the real CLI's signature. Windows-only .cmd form, matching this project's dev/CI platform. */
function writeStub(dir: string, name: string, versionOutput: string): string {
  const script = join(dir, name);
  writeFileSync(script, `@echo off\r\necho ${versionOutput}\r\n`);
  return script;
}

test("CODEX_BINARY_PATH override wins and is used over every other signal", () => {
  const snap = snapshotEnv();
  const dir = mkdtempSync(join(tmpdir(), "codex-disc-override-"));
  try {
    sandboxEnv(dir);
    const stub = writeStub(dir, "fake-codex.cmd", "codex-cli 9.9.9");
    process.env["CODEX_BINARY_PATH"] = stub;

    const resolved = discoverCodexBinary();
    assert.equal(resolved, stub, "override path must be returned, bypassing PATH/npm/Homebrew/home-relative signals");
  } finally {
    restoreEnv(snap);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no binary found: error message names CODEX_BINARY_PATH and triedLocations is non-empty", () => {
  const snap = snapshotEnv();
  const dir = mkdtempSync(join(tmpdir(), "codex-disc-absent-"));
  try {
    sandboxEnv(dir);
    // CODEX_BINARY_PATH left unset; PATH/APPDATA/HOME all point at an empty
    // dir so every signal (PATH, npm global, home-relative) misses.

    assert.throws(
      () => discoverCodexBinary(),
      (err: unknown) => {
        assert.ok(err instanceof CodexDiscoveryError, "must throw a CodexDiscoveryError");
        const discErr = err as CodexDiscoveryError;
        assert.ok(
          discErr.message.includes("CODEX_BINARY_PATH"),
          "error message must name the override variable",
        );
        assert.ok(discErr.triedLocations.length > 0, "triedLocations must list the locations that were tried");
        assert.equal(discErr.reason, "binary-absent");
        return true;
      },
    );
  } finally {
    restoreEnv(snap);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fail-open: a probe that throws internally does not propagate out of discoverCodexBinary", () => {
  const snap = snapshotEnv();
  const dir = mkdtempSync(join(tmpdir(), "codex-disc-failopen-"));
  try {
    sandboxEnv(dir);
    // A bare unresolved command name makes execFileSync's shell:true probe
    // throw internally (Windows cmd.exe "is not recognized" -> non-zero
    // exit, which execFileSync surfaces by throwing). If probeCandidate's
    // catch didn't swallow this, it would propagate as a raw Error instead
    // of the typed CodexDiscoveryError discovery is documented to throw.
    process.env["CODEX_BINARY_PATH"] = "nonexistent-cmd-xyz-not-real";

    assert.throws(
      () => discoverCodexBinary(),
      (err: unknown) => {
        assert.ok(
          err instanceof CodexDiscoveryError,
          "the internal probe error must be caught and reclassified, never propagated raw",
        );
        return true;
      },
    );
  } finally {
    restoreEnv(snap);
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A real (non-batch) .exe cannot be a plain text script — CreateProcess
 * requires an actual PE image, so a `@echo off`-style stub (fine for the
 * ".cmd" candidates the other rungs use) fails with "not compatible"
 * instead of running. The VS Code extension rung specifically probes
 * `codex.exe` on win32, so its tests need a genuine tiny executable. This
 * compiles one, once, on demand via the .NET compiler already available
 * through PowerShell's `Add-Type -OutputType ConsoleApplication` — it reads
 * a sibling `version.txt` next to itself and prints "codex-cli <that
 * text>", so every test can reuse the same compiled binary and just vary
 * the sidecar file for a different reported version.
 */
const _compiledExeStubsByVersion = new Map<string, string>();
function compiledExeStubForVersion(versionOutput: string): string {
  const cached = _compiledExeStubsByVersion.get(versionOutput);
  if (cached && existsSync(cached)) return cached;

  const workDir = mkdtempSync(join(tmpdir(), "codex-disc-exe-src-"));
  const csFile = join(workDir, "stub.cs");
  const outExe = join(workDir, "stub.exe");
  // Written to a real .cs file (not inlined into the PowerShell command
  // line) so the C# double quotes below never have to survive cmd.exe's own
  // quote handling under execFileSync's shell:true.
  const source =
    "using System;\r\n" +
    "class P { static void Main() { Console.WriteLine(\"codex-cli " + versionOutput + "\"); } }\r\n";
  writeFileSync(csFile, source);

  // sandboxEnv() (called before this in every test) blanks PATH so
  // discovery's other signals miss, which would also hide "powershell" from
  // a bare-name lookup here — use the well-known absolute location instead.
  const systemRoot = process.env["SystemRoot"] || process.env["windir"] || "C:\\Windows";
  const powershellExe = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  execFileSync(
    powershellExe,
    ["-NoProfile", "-Command", `Add-Type -OutputType ConsoleApplication -OutputAssembly '${outExe}' -Path '${csFile}'`],
    { shell: true, windowsHide: true, timeout: 30_000 },
  );
  _compiledExeStubsByVersion.set(versionOutput, outExe);
  return outExe;
}

/** Copies a compiled exe stub (built once per distinct version string, then cached) into `dir/name` so it reports "codex-cli <versionOutput>" when run with `--version`. */
function writeExeStub(dir: string, name: string, versionOutput: string): string {
  const dest = join(dir, name);
  copyFileSync(compiledExeStubForVersion(versionOutput), dest);
  return dest;
}

/** The bin/<platform> folder name discovery expects for this test's own process.platform/arch, mirroring vsCodeExtensionBinPlatformFolder(). */
function platformFolderForThisProcess(): string {
  if (process.platform === "win32") return "windows-x86_64";
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x86_64";
  return "linux-x86_64";
}

test("VS Code extension rung: finds the bundled codex binary under ~/.vscode/extensions/openai.chatgpt-*/bin/<platform>/codex", () => {
  const snap = snapshotEnv();
  const dir = mkdtempSync(join(tmpdir(), "codex-disc-vscodeext-"));
  try {
    sandboxEnv(dir);
    const platformFolder = platformFolderForThisProcess();
    const extDir = join(dir, ".vscode", "extensions", "openai.chatgpt-26.901.22334-win32-x64", "bin", platformFolder);
    mkdirSync(extDir, { recursive: true });
    const binName = process.platform === "win32" ? "codex.exe" : "codex";
    const stub = process.platform === "win32" ? writeExeStub(extDir, binName, "26.901.22334") : writeStub(extDir, binName, "codex-cli 26.901.22334");

    const resolved = discoverCodexBinary();
    assert.equal(resolved, stub, "must resolve the bundled extension binary when no other signal matches");
  } finally {
    restoreEnv(snap);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VS Code extension rung: prefers the highest version when multiple extension folders are installed", () => {
  const snap = snapshotEnv();
  const dir = mkdtempSync(join(tmpdir(), "codex-disc-vscodeext-multi-"));
  try {
    sandboxEnv(dir);
    const platformFolder = platformFolderForThisProcess();
    const binName = process.platform === "win32" ? "codex.exe" : "codex";
    const extensionsRoot = join(dir, ".vscode", "extensions");

    const oldDir = join(extensionsRoot, "openai.chatgpt-1.0.0-win32-x64", "bin", platformFolder);
    const newDir = join(extensionsRoot, "openai.chatgpt-26.901.22334-win32-x64", "bin", platformFolder);
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    const isWin = process.platform === "win32";
    if (isWin) writeExeStub(oldDir, binName, "1.0.0");
    else writeStub(oldDir, binName, "codex-cli 1.0.0");
    const newStub = isWin ? writeExeStub(newDir, binName, "26.901.22334") : writeStub(newDir, binName, "codex-cli 26.901.22334");

    const resolved = discoverCodexBinary();
    assert.equal(resolved, newStub, "must prefer the higher-version extension folder");
  } finally {
    restoreEnv(snap);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("found-but-not-codex: a binary that runs but whose output lacks the codex-cli signature is rejected", () => {
  const snap = snapshotEnv();
  const dir = mkdtempSync(join(tmpdir(), "codex-disc-wrongcontent-"));
  try {
    sandboxEnv(dir);
    const stub = writeStub(dir, "impostor.cmd", "not-codex-at-all 1.0.0");
    process.env["CODEX_BINARY_PATH"] = stub;

    assert.throws(
      () => discoverCodexBinary(),
      (err: unknown) => {
        assert.ok(err instanceof CodexDiscoveryError);
        const discErr = err as CodexDiscoveryError;
        assert.equal(
          discErr.reason,
          "found-but-not-codex",
          "a same-named binary with non-matching output must not be accepted on existence alone",
        );
        return true;
      },
    );
  } finally {
    restoreEnv(snap);
    rmSync(dir, { recursive: true, force: true });
  }
});
