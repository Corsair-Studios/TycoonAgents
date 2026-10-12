/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Windows resolves a bare command against cwd before PATH. These tests pin the
// cwd-safe resolution helpers (hooks/binDiscovery.cjs + src/core/safeExec.ts) and
// assert that a planted npm.cmd / taskkill.exe in a project dir is never reachable.
// Nothing here executes a planted file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { systemExe, npmInvocation } from "../src/core/safeExec";

const bin = require("../../hooks/binDiscovery.cjs") as {
  systemExe: typeof systemExe;
  npmInvocation: typeof npmInvocation;
  resolveBareOnPath: (c: string, o?: Record<string, unknown>) => string;
};
const bridgeClient = require("../../hooks/dispatcherBridgeClient.cjs") as { taskkillPath: () => string | null };
const gemini = require("../../hooks/gemini-mcp-wrapper.cjs") as { taskkillPath: () => string | null };

const repoRoot = path.join(__dirname, "..", "..");
const src = (rel: string): string => readFileSync(path.join(repoRoot, rel), "utf8");

function projectWithPlants(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tycoon-planted-"));
  for (const f of ["npm.cmd", "npm.bat", "npm", "taskkill.exe", "codex.cmd", "node.exe"]) writeFileSync(path.join(dir, f), "planted");
  return dir;
}

for (const [label, impl] of [["ts", { systemExe, npmInvocation }], ["cjs", bin]] as const) {
  test(`${label} systemExe is absolute under SystemRoot System32 and null off win32`, () => {
    const hit = impl.systemExe("taskkill.exe", { platform: "win32", env: { SystemRoot: "X:\\Win" }, exists: () => true });
    assert.equal(hit, path.join("X:\\Win", "System32", "taskkill.exe"));
    assert.ok(path.isAbsolute(hit as string) || /^[A-Za-z]:/.test(hit as string));
    assert.equal(impl.systemExe("taskkill.exe", { platform: "win32", env: { SystemRoot: "X:\\Win" }, exists: () => false }), null);
    assert.equal(impl.systemExe("taskkill.exe", { platform: "linux" }), null);
  });

  test(`${label} npmInvocation never resolves from cwd or a relative PATH entry`, () => {
    const project = projectWithPlants();
    try {
      // Everything planted lives in the project dir, which is both cwd and (relative + absolute) on PATH.
      const env = { PATH: [".", "", project].join(";") };
      const win = impl.npmInvocation({ platform: "win32", env, cwd: project, execPath: "", exists: (p: string) => p.startsWith(project) });
      assert.equal(win, null);
      const posixEnv = { PATH: [".", "bin", "relative/dir"].join(":") };
      const posix = impl.npmInvocation({ platform: "linux", env: posixEnv, cwd: project, execPath: "", exists: () => true });
      assert.equal(posix, null);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test(`${label} npmInvocation resolves absolutely, runs node directly (no shell) on win32`, () => {
    const exists = (p: string): boolean => /node\.exe$|npm-cli\.js$/.test(p);
    const r = impl.npmInvocation({ platform: "win32", env: { PATH: "C:\\nodejs" }, cwd: "C:\\proj", execPath: "", exists });
    assert.ok(r);
    assert.match(r!.command, /node\.exe$/);
    assert.match(r!.args[0], /npm-cli\.js$/);
    assert.ok(/^[A-Za-z]:/.test(r!.command));
  });
}

test("resolveBareOnPath skips cwd and relative PATH entries on win32", () => {
  const project = projectWithPlants();
  try {
    const env = { PATH: `.;${project};C:\\good` };
    const fs = { existsSync: (p: string) => p.startsWith(project) || p === path.join("C:\\good", "codex.cmd"), statSync: () => ({ isFile: () => true }) };
    const r = bin.resolveBareOnPath("codex", { platform: "win32", env, cwd: project, fs });
    assert.equal(r, path.join("C:\\good", "codex.cmd"));
    assert.equal(bin.resolveBareOnPath("codex", { platform: "linux", env }), "codex");
    assert.equal(bin.resolveBareOnPath("C:\\x\\codex.cmd", { platform: "win32", env }), "C:\\x\\codex.cmd");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("hook taskkillPath is absolute System32 taskkill.exe (win32) or null", () => {
  for (const fn of [bridgeClient.taskkillPath, gemini.taskkillPath]) {
    const p = fn();
    if (process.platform === "win32") {
      assert.ok(p && path.isAbsolute(p));
      assert.equal(path.basename(p!).toLowerCase(), "taskkill.exe");
      assert.match(p!, /system32/i);
    } else {
      assert.equal(p, null);
    }
  }
});

test("no bare taskkill spawn and no shell npm spawn remain in the patched sources", () => {
  for (const rel of ["hooks/dispatcherBridgeClient.cjs", "hooks/gemini-mcp-wrapper.cjs", "src/core/vendorKeyTest.ts"]) {
    assert.doesNotMatch(src(rel), /spawn(?:Sync)?\(\s*["']taskkill["']/, rel);
  }
  assert.doesNotMatch(src("hooks/codex-mcp-launcher.cjs"), /spawnSync\(\s*["']npm["']/);
  assert.doesNotMatch(src("src/providers/codex/codexDiscovery.ts"), /execFileSync\(\s*["']npm["']/);
  assert.match(src("hooks/codex-mcp-launcher.cjs"), /npmInvocation\(\)/);
  assert.match(src("src/providers/codex/codexDiscovery.ts"), /npmInvocation\(\)/);
});
