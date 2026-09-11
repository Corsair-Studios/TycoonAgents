/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Plan task p23-t7: cross-platform discovery and coexistence tests.
// Covers CODEX_BINARY_PATH override behavior (discoverCodexBinary),
// CODEX_HOME resolution per platform (resolveCodexHome from
// installCodexHooks.ts), and rollout file lookup (findRolloutFile from
// hooks/codexRollout.cjs). All offline/deterministic: no real codex binary
// is invoked except via CODEX_BINARY_PATH pointed at fixture scripts we
// control, and no real HOME/filesystem outside a temp dir is touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverCodexBinary, CodexDiscoveryError } from "../src/providers/codex/codexDiscovery";
import { resolveCodexHome } from "../src/providers/codex/installCodexHooks";
const codexRollout = require("../../hooks/codexRollout.cjs");

// ---------------------------------------------------------------------------
// 1. discoverCodexBinary: CODEX_BINARY_PATH override behavior.
// ---------------------------------------------------------------------------

function makeFakeCodexScript(dir: string, versionOutput: string | null): string {
  const isWin = process.platform === "win32";
  const scriptPath = isWin ? join(dir, "fake-codex.cmd") : join(dir, "fake-codex.sh");
  if (isWin) {
    if (versionOutput === null) {
      // Simulate "not found" shape isn't directly scriptable via a .cmd that
      // exists; instead point CODEX_BINARY_PATH at a nonexistent file for
      // that case (handled separately below). This helper is only used for
      // the "wrong content" and "correct content" cases.
      writeFileSync(scriptPath, "@echo off\r\necho not codex output\r\n", "utf8");
    } else {
      writeFileSync(scriptPath, `@echo off\r\necho ${versionOutput}\r\n`, "utf8");
    }
  } else {
    if (versionOutput === null) {
      writeFileSync(scriptPath, "#!/bin/sh\necho 'not codex output'\n", "utf8");
    } else {
      writeFileSync(scriptPath, `#!/bin/sh\necho '${versionOutput}'\n`, "utf8");
    }
    chmodSync(scriptPath, 0o755);
  }
  return scriptPath;
}

test("(binary-override) CODEX_BINARY_PATH pointing at a content-verified codex script wins outright", () => {
  const dir = mkdtempSync(join(tmpdir(), "tycoon-codex-bin-"));
  try {
    const scriptPath = makeFakeCodexScript(dir, "codex-cli 0.999.0");
    const prevOverride = process.env["CODEX_BINARY_PATH"];
    process.env["CODEX_BINARY_PATH"] = scriptPath;
    try {
      const resolved = discoverCodexBinary();
      assert.equal(resolved, scriptPath, "should return the override path once content-verified");
    } finally {
      if (prevOverride === undefined) delete process.env["CODEX_BINARY_PATH"];
      else process.env["CODEX_BINARY_PATH"] = prevOverride;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(binary-override) CODEX_BINARY_PATH pointing at a script with wrong output throws found-but-not-codex", () => {
  const dir = mkdtempSync(join(tmpdir(), "tycoon-codex-bin-"));
  try {
    const scriptPath = makeFakeCodexScript(dir, null);
    const prevOverride = process.env["CODEX_BINARY_PATH"];
    process.env["CODEX_BINARY_PATH"] = scriptPath;
    try {
      assert.throws(
        () => discoverCodexBinary(),
        (err: unknown) => {
          assert.ok(err instanceof CodexDiscoveryError);
          assert.equal(err.reason, "found-but-not-codex");
          assert.ok(err.triedLocations.some((t) => t.includes("CODEX_BINARY_PATH")));
          return true;
        },
      );
    } finally {
      if (prevOverride === undefined) delete process.env["CODEX_BINARY_PATH"];
      else process.env["CODEX_BINARY_PATH"] = prevOverride;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(binary-override) CODEX_BINARY_PATH pointing at a nonexistent file throws binary-absent naming the override", () => {
  const dir = mkdtempSync(join(tmpdir(), "tycoon-codex-bin-"));
  try {
    const missingPath = join(dir, "does-not-exist-codex-binary");
    const prevOverride = process.env["CODEX_BINARY_PATH"];
    process.env["CODEX_BINARY_PATH"] = missingPath;
    try {
      assert.throws(
        () => discoverCodexBinary(),
        (err: unknown) => {
          assert.ok(err instanceof CodexDiscoveryError);
          assert.equal(err.reason, "binary-absent");
          assert.ok(err.triedLocations.some((t) => t.includes("CODEX_BINARY_PATH")));
          assert.ok(err.message.includes(missingPath));
          return true;
        },
      );
    } finally {
      if (prevOverride === undefined) delete process.env["CODEX_BINARY_PATH"];
      else process.env["CODEX_BINARY_PATH"] = prevOverride;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Note: full discovery-ladder shape per platform (PATH/npm/Homebrew/~/.codex/bin/
// VS Code extension bundle candidates) is NOT independently unit-testable without
// injectable process.platform/os.homedir/fs seams — codexDiscovery.ts's collect*
// functions call process.platform, os.homedir(), and fs.readdirSync directly with
// no options parameter to override them (unlike resolveCodexHome below, which DOES
// take an options.env/platform seam). Exercising per-platform candidate shape would
// require either monkeypatching os/process (unreliable/order-dependent across the
// whole test file) or a source change to add an injection seam, which is out of
// scope for this leaf worker (read-only on codexDiscovery.ts). Flagging as a gap:
// see the "open issues" note in this file's PR/report.
test.todo("(gap) per-platform candidate list shape (win32 .cmd/.exe, darwin Homebrew-only, PATH/npm/~/.codex/bin) needs an injectable platform/home/fs seam in codexDiscovery.ts to unit test directly");

// ---------------------------------------------------------------------------
// 2. resolveCodexHome (installCodexHooks.ts): per-platform CODEX_HOME resolution.
// ---------------------------------------------------------------------------

test("(codex-home) CODEX_HOME env override wins outright regardless of platform", () => {
  for (const platform of ["win32", "darwin", "linux"] as NodeJS.Platform[]) {
    const result = resolveCodexHome({
      env: { CODEX_HOME: "/custom/codex/home", HOME: "/home/someone", USERPROFILE: "C:\\Users\\someone" },
      platform,
    });
    assert.equal(result.codexHome, "/custom/codex/home");
    assert.deepEqual(result.tried, ["/custom/codex/home"]);
  }
});

test("(codex-home) default ~/.codex uses HOME on posix-style env, USERPROFILE fallback on Windows-style env", () => {
  const posixResult = resolveCodexHome({ env: { HOME: "/home/alice" }, platform: "linux" });
  assert.ok(posixResult.codexHome.includes("alice"));
  assert.ok(posixResult.codexHome.endsWith(".codex") || posixResult.codexHome.includes(".codex"));

  const winResult = resolveCodexHome({ env: { USERPROFILE: "C:\\Users\\bob" }, platform: "win32" });
  assert.ok(winResult.codexHome.includes("bob"));
  assert.ok(winResult.codexHome.includes(".codex"));

  // HOME takes precedence over USERPROFILE when both are present (code checks env.HOME || env.USERPROFILE).
  const bothResult = resolveCodexHome({ env: { HOME: "/home/preferred", USERPROFILE: "C:\\Users\\ignored" }, platform: "win32" });
  assert.ok(bothResult.codexHome.includes("preferred"));
});

test("(codex-home) missing HOME and USERPROFILE throws an explicit error naming what was tried", () => {
  assert.throws(
    () => resolveCodexHome({ env: {}, platform: "linux" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("resolveCodexHome"));
      assert.ok(err.message.includes("CODEX_HOME") || err.message.toLowerCase().includes("could not determine"));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 3. Rollout lookup (hooks/codexRollout.cjs): sessions/YYYY/MM/DD nesting,
//    newest-wins, no-match -> null, unreadable subdir doesn't throw.
// ---------------------------------------------------------------------------

function setupCodexHome(): string {
  return mkdtempSync(join(tmpdir(), "tycoon-codex-home-"));
}

test("(rollout) finds a rollout file nested under sessions/YYYY/MM/DD regardless of path-separator style", () => {
  const codexHome = setupCodexHome();
  try {
    const nestedDir = join(codexHome, "sessions", "2026", "09", "08");
    mkdirSync(nestedDir, { recursive: true });
    const fileName = "2026-09-08T12-00-00-thread-ABC123.jsonl";
    writeFileSync(join(nestedDir, fileName), JSON.stringify({ type: "session_meta", payload: { agent_path: "/root/x" } }) + "\n", "utf8");

    const found = codexRollout.findRolloutFile("ABC123", codexHome);
    assert.ok(found, "should find the nested rollout file");
    assert.ok(found.endsWith(fileName));
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("(rollout) newest-wins by filename when two files contain the same thread id", () => {
  const codexHome = setupCodexHome();
  try {
    const dir1 = join(codexHome, "sessions", "2026", "09", "07");
    const dir2 = join(codexHome, "sessions", "2026", "09", "08");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    const olderName = "2026-09-07T10-00-00-thread-DUPID.jsonl";
    const newerName = "2026-09-08T10-00-00-thread-DUPID.jsonl";
    writeFileSync(join(dir1, olderName), JSON.stringify({ type: "session_meta", payload: { agent_nickname: "older" } }) + "\n", "utf8");
    writeFileSync(join(dir2, newerName), JSON.stringify({ type: "session_meta", payload: { agent_nickname: "newer" } }) + "\n", "utf8");

    const found = codexRollout.findRolloutFile("DUPID", codexHome);
    assert.ok(found, "should find one of the two matches");
    assert.ok(found.endsWith(newerName), `expected the newer (lexicographically greater) filename to win, got ${found}`);

    const meta = codexRollout.resolveSessionMeta("DUPID", codexHome);
    assert.equal(meta?.agent_nickname, "newer");
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("(rollout) no matching thread id returns null, not throw", () => {
  const codexHome = setupCodexHome();
  try {
    const dir = join(codexHome, "sessions", "2026", "09", "08");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-09-08T10-00-00-thread-OTHER.jsonl"), "{}\n", "utf8");

    assert.equal(codexRollout.findRolloutFile("NOPE", codexHome), null);
    assert.equal(codexRollout.resolveSessionMeta("NOPE", codexHome), null);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("(rollout) a nonexistent sessions dir (never created) returns null rather than throwing", () => {
  const codexHome = setupCodexHome();
  try {
    // sessions/ deliberately never created.
    assert.equal(codexRollout.findRolloutFile("ANY", codexHome), null);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("(rollout) an unreadable-looking subdir entry (file masquerading as traversal target) does not throw", () => {
  const codexHome = setupCodexHome();
  try {
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    // A plain file directly under sessions/ (not a directory) — readdirSync's
    // withFileTypes lets findRolloutFile see it's not a directory and skip
    // pushing it onto the traversal stack; this exercises that branch without
    // relying on platform-specific permission semantics (which differ enough
    // between win32 and posix that a chmod-based "unreadable dir" test would
    // be flaky here).
    writeFileSync(join(sessionsDir, "stray-file.txt"), "not a dir", "utf8");
    const realDir = join(sessionsDir, "2026", "09", "08");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "2026-09-08T10-00-00-thread-SAFE.jsonl"), JSON.stringify({ type: "session_meta", payload: {} }) + "\n", "utf8");

    assert.doesNotThrow(() => codexRollout.findRolloutFile("SAFE", codexHome));
    const found = codexRollout.findRolloutFile("SAFE", codexHome);
    assert.ok(found && found.endsWith("thread-SAFE.jsonl"));
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("(rollout) resolveCodexHome (codexRollout.cjs) honors CODEX_HOME override, else USERPROFILE/HOME + .codex", () => {
  const prevCodexHome = process.env.CODEX_HOME;
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  try {
    process.env.CODEX_HOME = "/override/path";
    assert.equal(codexRollout.resolveCodexHome(), "/override/path");

    // resolveCodexHome (codexRollout.cjs) reads process.env.USERPROFILE || process.env.HOME
    // (USERPROFILE first, matching this Windows dev environment), so clear USERPROFILE
    // to exercise the HOME fallback deterministically on any platform.
    delete process.env.CODEX_HOME;
    delete process.env.USERPROFILE;
    process.env.HOME = "/home/carol";
    assert.ok(codexRollout.resolveCodexHome()?.includes("carol"));
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
});
