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
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
