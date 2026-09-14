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
// Every stub is a plain .cmd/.sh text shim (never a compiled or renamed
// .exe) per this repo's test-execution policy.
//
// process.env is saved/restored around every test. ENV_KEYS lists every
// signal codexDiscovery.ts's non-override rungs can reach, directly or via
// os.homedir()/child_process's shell PATH search: CODEX_BINARY_PATH (the
// override rung), PATH/Path (shell command resolution, and os.homedir()'s
// PATH-independent lookup is unaffected), APPDATA (npm-global default),
// USERPROFILE (Windows os.homedir() source, and the VS Code extension
// signal's own USERPROFILE read), HOME (os.homedir() on posix). Leaving any
// of these pointing at the real dev machine's values is what let two cases
// in this file pass in a working tree (which happens to have no matching
// real installs on some of these) while failing in a clean clone (where a
// stray leaked signal such as a real global npm codex install resolves and
// wins before the test's own fixture is reached) — sandboxEnv() below
// forces every one of them to miss.
const ENV_KEYS = ["CODEX_BINARY_PATH", "PATH", "Path", "APPDATA", "HOME", "USERPROFILE"] as const;

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCodexBinary, CodexDiscoveryError } from "../src/providers/codex/codexDiscovery";
import { writeVersionStub } from "./helpers/fakeCli";

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

/** Writes a throwaway stub that `codex --version` would produce if it matched (or didn't match) the real CLI's signature. Platform-appropriate (see test/helpers/fakeCli.ts): a .cmd batch shim on win32, a chmod'd #!/bin/sh script on posix — both are plain text, never a compiled or renamed executable. */
function writeStub(dir: string, name: string, versionOutput: string): string {
  return writeVersionStub(dir, name, versionOutput);
}

const IS_WIN = process.platform === "win32";

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

/** The bin/<platform> folder name discovery expects for this test's own process.platform/arch, mirroring vsCodeExtensionBinPlatformFolder(). */
function platformFolderForThisProcess(): string {
  if (process.platform === "win32") return "windows-x86_64";
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x86_64";
  return "linux-x86_64";
}

// The VS Code extension rung hardcodes `codex.exe` as the candidate name on
// win32, and this project's test-execution policy forbids compiling or
// renaming any file to .exe. Plan p34-t3: discoverCodexBinary() now accepts
// an injectable `exec` (execFileSync-shaped) via its options argument, so
// these two cases fake the `--version` probe entirely — the candidate path
// only has to exist on disk for fs.readdirSync() to see it (this signal's
// directory walk is untouched, real fs), never to actually be executed —
// and run identically on every platform instead of being skipped on win32.
function makeExec(matches: Record<string, string>): (command: string) => string {
  return (command: string) => {
    if (Object.prototype.hasOwnProperty.call(matches, command)) return matches[command];
    throw new Error(`ENOENT: no fake output configured for "${command}"`);
  };
}

test("VS Code extension rung: finds the bundled codex binary under ~/.vscode/extensions/openai.chatgpt-*/bin/<platform>/codex", () => {
  const snap = snapshotEnv();
  const dir = mkdtempSync(join(tmpdir(), "codex-disc-vscodeext-"));
  try {
    sandboxEnv(dir);
    const platformFolder = platformFolderForThisProcess();
    const extDir = join(dir, ".vscode", "extensions", "openai.chatgpt-26.901.22334-win32-x64", "bin", platformFolder);
    mkdirSync(extDir, { recursive: true });
    const binName = IS_WIN ? "codex.exe" : "codex";
    const candidatePath = join(extDir, binName);

    const resolved = discoverCodexBinary({ exec: makeExec({ [candidatePath]: "codex-cli 26.901.22334" }) });
    assert.equal(resolved, candidatePath, "must resolve the bundled extension binary when no other signal matches");
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
    const extensionsRoot = join(dir, ".vscode", "extensions");

    const oldDir = join(extensionsRoot, "openai.chatgpt-1.0.0-win32-x64", "bin", platformFolder);
    const newDir = join(extensionsRoot, "openai.chatgpt-26.901.22334-win32-x64", "bin", platformFolder);
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    const binName = IS_WIN ? "codex.exe" : "codex";
    const oldPath = join(oldDir, binName);
    const newPath = join(newDir, binName);

    const resolved = discoverCodexBinary({
      exec: makeExec({ [oldPath]: "codex-cli 1.0.0", [newPath]: "codex-cli 26.901.22334" }),
    });
    assert.equal(resolved, newPath, "must prefer the higher-version extension folder");
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
