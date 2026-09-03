/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Exercises src/providers/opencode/discovery.ts's resolveOpenCode ladder
// (OPENCODE_BIN / OPENCODE_CONFIG_DIR override first, then PATH, then
// ~/.config/opencode, %APPDATA%/%LOCALAPPDATA%/opencode, then
// <projectDir>/.opencode) and isProjectPluginInstalled.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveOpenCode, isProjectPluginInstalled } from "../src/providers/opencode/discovery";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("(a) OPENCODE_BIN override wins: binPath equals it, tried stays minimal", () => {
  const dir = tmpDir("tycoon-oc-bin-");
  try {
    const binPath = join(dir, "opencode.exe");
    writeFileSync(binPath, "", "utf8");
    const result = resolveOpenCode({ env: { OPENCODE_BIN: binPath }, projectDir: dir });
    assert.equal(result.binPath, binPath);
    // No PATH probing should have happened for the bin field: only the
    // override path (plus whatever configDir probing occurred) is tried.
    assert.ok(result.tried.includes(binPath));
    assert.equal(
      result.tried.filter((p) => p.includes("opencode.exe") || p.includes("opencode.cmd") || p.includes("opencode.bat")).length,
      1,
      "only the override bin path should appear among exe/cmd/bat candidates",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(b) OPENCODE_CONFIG_DIR override: configDir equals it", () => {
  const dir = tmpDir("tycoon-oc-cfg-");
  try {
    const configDir = join(dir, "cfg");
    mkdirSync(configDir);
    const result = resolveOpenCode({ env: { OPENCODE_CONFIG_DIR: configDir }, projectDir: dir });
    assert.equal(result.configDir, configDir);
    assert.ok(result.tried.includes(configDir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(c) nothing resolves -> throws, listing every probed path and both override var names", () => {
  const home = tmpDir("tycoon-oc-home-");
  const appdata = tmpDir("tycoon-oc-appdata-");
  const localAppdata = tmpDir("tycoon-oc-localappdata-");
  const projectDir = tmpDir("tycoon-oc-project-"); // no .opencode inside
  try {
    let thrown: Error | undefined;
    try {
      resolveOpenCode({
        env: { PATH: "", HOME: home, USERPROFILE: home, APPDATA: appdata, LOCALAPPDATA: localAppdata },
        projectDir,
        platform: "win32",
      });
    } catch (err) {
      thrown = err as Error;
    }
    assert.ok(thrown, "resolveOpenCode should throw when nothing resolves");
    assert.match(thrown!.message, /OPENCODE_BIN/);
    assert.match(thrown!.message, /OPENCODE_CONFIG_DIR/);
    assert.match(thrown!.message, new RegExp(join(home, ".config", "opencode").replace(/\\/g, "\\\\")));
    assert.match(thrown!.message, new RegExp(join(appdata, "opencode").replace(/\\/g, "\\\\")));
    assert.match(thrown!.message, new RegExp(join(localAppdata, "opencode").replace(/\\/g, "\\\\")));
    assert.match(thrown!.message, new RegExp(join(projectDir, ".opencode").replace(/\\/g, "\\\\")));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(appdata, { recursive: true, force: true });
    rmSync(localAppdata, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("(d) project .opencode present -> configDir resolves to it; isProjectPluginInstalled tracks plugin file presence", () => {
  const home = tmpDir("tycoon-oc-home2-");
  const projectDir = tmpDir("tycoon-oc-project2-");
  const projectOpencodeDir = join(projectDir, ".opencode");
  mkdirSync(projectOpencodeDir);
  try {
    const result = resolveOpenCode({
      env: { PATH: "", HOME: home, USERPROFILE: home },
      projectDir,
      platform: "win32",
    });
    assert.equal(result.configDir, projectOpencodeDir);

    assert.equal(isProjectPluginInstalled(projectDir), false, "no plugin file yet");

    const pluginDir = join(projectOpencodeDir, "plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "tycoon-opencode-plugin.ts"), "", "utf8");
    assert.equal(isProjectPluginInstalled(projectDir), true, "plugin .ts file should be detected");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});
