/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// src/host/vscode/mcpHeal.ts's `healMcpServerPathIfStale` is now the REAL
// implementation, extracted verbatim out of panel.ts's
// `_autoHealMcpServerPathIfStale` (still exhaustively covered end-to-end via
// the panel wrapper in test/panelMcpPathHeal.test.ts — 9 scenarios: stale
// missing target, stale older-extension-dir target, custom-build passthrough,
// no-op with no .mcp.json, unparseable-JSON passthrough, other-entries
// preserved, env.UEFN_BRIDGE_DIR stripping, no-arg passthrough, never-write-
// onto-unshipped-file).
//
// This file exists to prove the EXTRACTION ITSELF is wired correctly — that
// `mcpHeal.ts`'s export is callable and behaves correctly when imported
// DIRECTLY (the path `extension.ts`'s `activate()` uses, independent of
// panel.ts ever constructing a TycoonPanel) — rather than re-duplicating the
// panel suite's full scenario matrix.
//
// mcpHeal.ts does `import * as vscode from "vscode"` at module scope (only
// for `vscode.window.showInformationMessage` and the `vscode.Uri` type), so
// the same module-stubbing technique as the panel tests is needed here too.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require("module");
const originalLoad = NodeModule._load;
function makeVscodeStub(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === "__esModule") return true;
      if (!(prop in target)) {
        target[prop] = new Proxy(function stub() {}, handler);
      }
      return target[prop];
    },
    apply() {
      return new Proxy({}, handler);
    },
    construct() {
      return new Proxy({}, handler);
    },
  };
  return new Proxy({}, handler);
}
const vscodeStub = makeVscodeStub();
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "vscode") return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { healMcpServerPathIfStale } = require("../src/host/vscode/mcpHeal") as typeof import("../src/host/vscode/mcpHeal");

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function stageCurrentServer(extensionRoot: string): void {
  const dir = path.join(extensionRoot, "media", "uefn-bridge");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "uefn-server.mjs"), "// current shipped server\n");
}

function currentServerPathForward(extensionRoot: string): string {
  return path.join(extensionRoot, "media", "uefn-bridge", "uefn-server.mjs").replace(/\\/g, "/");
}

function fakeExtensionUri(fsPath: string) {
  return { fsPath } as unknown as import("vscode").Uri;
}

test("healMcpServerPathIfStale (called directly, not via the panel wrapper): heals a stale versioned extension path to the current one, forward-slashed", () => {
  const root = tmpDir("mcpHealDirect-stale-root-");
  const extensionRoot = tmpDir("mcpHealDirect-stale-ext-");
  try {
    stageCurrentServer(extensionRoot);
    const mcpPath = path.join(root, ".mcp.json");
    fs.writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          "uefn-bridge": {
            command: "node",
            args: ["c:/Users/someone/.vscode/extensions/tycoonagents.tycoonagents-0.0.424/media/uefn-bridge/uefn-server.mjs"],
          },
        },
      })
    );

    healMcpServerPathIfStale(root, fakeExtensionUri(extensionRoot));

    const updated = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    const healedPath: string = updated.mcpServers["uefn-bridge"].args[0];
    assert.equal(healedPath, currentServerPathForward(extensionRoot));
    assert.equal(healedPath.includes("\\"), false, "healed path must use forward slashes");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  }
});

test("healMcpServerPathIfStale (called directly): a non-ours / user-customized entry pointing at an existing custom file is left untouched", () => {
  const root = tmpDir("mcpHealDirect-custom-root-");
  const extensionRoot = tmpDir("mcpHealDirect-custom-ext-");
  const customDir = tmpDir("mcpHealDirect-custom-build-");
  try {
    stageCurrentServer(extensionRoot);
    const customServerPath = path.join(customDir, "uefn-server.mjs");
    fs.writeFileSync(customServerPath, "// deliberate custom build, not ours\n");
    const mcpPath = path.join(root, ".mcp.json");
    const original = {
      mcpServers: {
        "uefn-bridge": { command: "node", args: [customServerPath.replace(/\\/g, "/")] },
      },
    };
    fs.writeFileSync(mcpPath, JSON.stringify(original));
    const rawBefore = fs.readFileSync(mcpPath, "utf8");

    healMcpServerPathIfStale(root, fakeExtensionUri(extensionRoot));

    const rawAfter = fs.readFileSync(mcpPath, "utf8");
    assert.equal(rawAfter, rawBefore, "a path outside any tycoonagents dir that still exists must be left byte-for-byte unchanged");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(customDir, { recursive: true, force: true });
  }
});

test("healMcpServerPathIfStale (called directly): no .mcp.json present is a no-op and never throws", () => {
  const root = tmpDir("mcpHealDirect-none-root-");
  const extensionRoot = tmpDir("mcpHealDirect-none-ext-");
  try {
    stageCurrentServer(extensionRoot);
    assert.doesNotThrow(() => healMcpServerPathIfStale(root, fakeExtensionUri(extensionRoot)));
    assert.equal(fs.existsSync(path.join(root, ".mcp.json")), false, "must never create .mcp.json");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  }
});

test("healMcpServerPathIfStale (called directly): empty root string is a guarded no-op, never throws", () => {
  const extensionRoot = tmpDir("mcpHealDirect-emptyroot-ext-");
  try {
    stageCurrentServer(extensionRoot);
    assert.doesNotThrow(() => healMcpServerPathIfStale("", fakeExtensionUri(extensionRoot)));
  } finally {
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  }
});
