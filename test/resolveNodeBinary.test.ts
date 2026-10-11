/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Tests src/providers/codex/resolveNodeBinary.ts: the node command written
// into Codex's config.toml must never be the VS Code (Electron) binary.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isElectronHostBinary, rejectedNodeOverride, resolveNodeBinary } from "../src/providers/codex/resolveNodeBinary";

const CODE = "C:\\Program Files\\Microsoft VS Code\\Code.exe";

test("plain node: process.execPath is used", () => {
  assert.equal(resolveNodeBinary({ env: {}, execPath: "/usr/bin/node", isElectron: false }), "/usr/bin/node");
});

test("Electron host: node is found on PATH (PATHEXT on Windows), not Code.exe", () => {
  const existing = new Set(["C:\\tools\\node.exe"]);
  const resolved = resolveNodeBinary({
    env: { PATH: "C:\\Windows;C:\\tools", PATHEXT: ".COM;.EXE;.CMD" },
    execPath: CODE,
    isElectron: true,
    platform: "win32",
    isFile: (p) => existing.has(p),
  });
  assert.equal(resolved, "C:\\tools\\node.exe");
});

test("Electron host: POSIX PATH scan", () => {
  const resolved = resolveNodeBinary({
    env: { PATH: "/usr/local/bin:/opt/node/bin" },
    execPath: "/usr/share/code/code",
    isElectron: true,
    platform: "linux",
    isFile: (p) => p === "/opt/node/bin/node",
  });
  assert.equal(resolved, "/opt/node/bin/node");
});

test("Electron host with no node on PATH falls back to bare node", () => {
  const resolved = resolveNodeBinary({ env: { PATH: "/nowhere" }, execPath: CODE, isElectron: true, platform: "linux", isFile: () => false });
  assert.equal(resolved, "node");
});

test("TYCOON_NODE_PATH override wins, even outside Electron", () => {
  assert.equal(resolveNodeBinary({ env: { TYCOON_NODE_PATH: "D:\\n\\node.exe" }, execPath: "/usr/bin/node", isElectron: false }), "D:\\n\\node.exe");
  assert.equal(resolveNodeBinary({ env: { TYCOON_NODE_PATH: "   " }, execPath: "/usr/bin/node", isElectron: false }), "/usr/bin/node");
});

test("isElectronHostBinary recognises editor binaries only", () => {
  assert.equal(isElectronHostBinary(CODE), true);
  assert.equal(isElectronHostBinary("C:\\Program Files\\Microsoft VS Code Insiders\\Code - Insiders.exe"), true);
  assert.equal(isElectronHostBinary("/usr/share/code/code"), true);
  assert.equal(isElectronHostBinary("C:\\Program Files\\nodejs\\node.exe"), false);
  assert.equal(isElectronHostBinary("node"), false);
});

test("isElectronHostBinary: macOS helpers, Electron and app bundles rejected; real node accepted", () => {
  assert.equal(isElectronHostBinary("/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)"), true);
  assert.equal(isElectronHostBinary("/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper"), true);
  assert.equal(isElectronHostBinary("/opt/x/Electron"), true);
  assert.equal(isElectronHostBinary("/Applications/X.app/Contents/MacOS/x"), true);
  assert.equal(isElectronHostBinary("/opt/homebrew/bin/node"), false);
  assert.equal(isElectronHostBinary("C:\\Users\\a\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"), true);
});

test("TYCOON_NODE_PATH pointing at an editor helper is ignored and discovery continues", () => {
  const helper = "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)";
  const env = { TYCOON_NODE_PATH: helper, PATH: "/opt/homebrew/bin" };
  const resolved = resolveNodeBinary({ env, execPath: "/Applications/VS Code.app/Contents/MacOS/Electron", isElectron: true, platform: "darwin", isFile: (p) => p === "/opt/homebrew/bin/node" });
  assert.equal(resolved, "/opt/homebrew/bin/node");
  assert.equal(rejectedNodeOverride(env), helper);
  assert.equal(rejectedNodeOverride({ TYCOON_NODE_PATH: "/opt/homebrew/bin/node" }), undefined);
  assert.equal(rejectedNodeOverride({}), undefined);
});
