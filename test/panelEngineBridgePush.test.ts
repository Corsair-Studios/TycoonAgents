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

// panel.ts does `import * as vscode from "vscode"` at module scope. Stub the
// module loader (same technique as test/panelBridgeStaleness.test.ts) so this
// file's require of panel.js resolves under plain `node --test`, and we
// exercise the REAL production `_findFortniteEngineBridgeDir` /
// `_refreshEngineBridgeCopy` methods rather than reimplementations.
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
const { TycoonPanel } = require("../src/host/vscode/panel") as typeof import("../src/host/vscode/panel");

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// `_findFortniteEngineBridgeDir` only touches path/fs (plus the optional
// `programDataRoot` override param) -- a bare receiver is enough.
function findEngineBridgeDir(programDataRoot: string): string | null {
  return (TycoonPanel.prototype as any)._findFortniteEngineBridgeDir.call({}, programDataRoot);
}

// `_refreshEngineBridgeCopy` calls `this._powerToolsDir()`, which reads
// `this._extensionUri.fsPath` and `this._globalStorageUri.fsPath` to resolve
// the shipped bridge dir via `resolvePowerToolsDir`'s ladder -- mirrors
// test/panelBridgeStaleness.test.ts's `bridgeStale` receiver shape.
// `shippedRoot` stands in for the extension install dir (its
// `media/uefn-bridge` subdir is the bundled/rung-3 fallback, content-
// validated by a `uefn_bridge.py` marker); the REAL shipped
// media/uefn-bridge (owned by another worker) is never touched.
// `globalStorageDir` is always an empty dir the caller owns and cleans up,
// so rung 2 (installed copy) resolves to nothing and rung 3 (bundled) wins.
function refreshEngineBridgeCopy(
  engineDir: string,
  shippedRoot: string,
  globalStorageDir: string
): "updated" | "current" | "unavailable" {
  const fakeThis = {
    _extensionUri: { fsPath: shippedRoot },
    _globalStorageUri: { fsPath: globalStorageDir },
    _powerToolsDir: (TycoonPanel.prototype as any)._powerToolsDir,
  };
  return (TycoonPanel.prototype as any)._refreshEngineBridgeCopy.call(fakeThis, engineDir);
}

function writeManifest(manifestsDir: string, fileName: string, contents: string): void {
  fs.mkdirSync(manifestsDir, { recursive: true });
  fs.writeFileSync(path.join(manifestsDir, fileName), contents);
}

function manifestsDirFor(programDataRoot: string): string {
  return path.join(programDataRoot, "Epic", "EpicGamesLauncher", "Data", "Manifests");
}

// ---------------------------------------------------------------------------
// _findFortniteEngineBridgeDir: manifest discovery
// ---------------------------------------------------------------------------

test("_findFortniteEngineBridgeDir resolves the engine Python dir when the Fortnite manifest's install already has a staged bridge", () => {
  const programDataRoot = tmpDir("panelEngineBridgePush-discover-hit-");
  try {
    const installLoc = path.join(programDataRoot, "FortniteInstall");
    const pythonDir = path.join(installLoc, "FortniteGame", "Content", "Python");
    fs.mkdirSync(pythonDir, { recursive: true });
    fs.writeFileSync(path.join(pythonDir, "uefn_bridge.py"), "# engine bridge copy");

    writeManifest(
      manifestsDirFor(programDataRoot),
      "not-fortnite.item",
      JSON.stringify({ DisplayName: "Some Other Game", InstallLocation: path.join(programDataRoot, "Other") })
    );
    writeManifest(manifestsDirFor(programDataRoot), "corrupt.item", "{ this is not valid json");
    writeManifest(
      manifestsDirFor(programDataRoot),
      "fortnite.item",
      JSON.stringify({ DisplayName: "Fortnite", InstallLocation: installLoc })
    );

    assert.equal(findEngineBridgeDir(programDataRoot), pythonDir);
  } finally {
    fs.rmSync(programDataRoot, { recursive: true, force: true });
  }
});

test("_findFortniteEngineBridgeDir returns null when the Fortnite install has no staged bridge yet", () => {
  const programDataRoot = tmpDir("panelEngineBridgePush-discover-nobridge-");
  try {
    const installLoc = path.join(programDataRoot, "FortniteInstall");
    // FortniteGame/Content/Python doesn't exist at all -- nothing staged yet.
    writeManifest(
      manifestsDirFor(programDataRoot),
      "fortnite.item",
      JSON.stringify({ DisplayName: "Fortnite", InstallLocation: installLoc })
    );

    assert.equal(findEngineBridgeDir(programDataRoot), null);
  } finally {
    fs.rmSync(programDataRoot, { recursive: true, force: true });
  }
});

test("_findFortniteEngineBridgeDir returns null when there is no Fortnite manifest at all", () => {
  const programDataRoot = tmpDir("panelEngineBridgePush-discover-none-");
  try {
    writeManifest(
      manifestsDirFor(programDataRoot),
      "not-fortnite.item",
      JSON.stringify({ DisplayName: "Some Other Game", InstallLocation: path.join(programDataRoot, "Other") })
    );
    writeManifest(manifestsDirFor(programDataRoot), "corrupt.item", "{ not json");

    assert.equal(findEngineBridgeDir(programDataRoot), null);
  } finally {
    fs.rmSync(programDataRoot, { recursive: true, force: true });
  }
});

test("_findFortniteEngineBridgeDir returns null when the manifests dir doesn't exist", () => {
  const programDataRoot = tmpDir("panelEngineBridgePush-discover-missing-dir-");
  try {
    assert.equal(findEngineBridgeDir(programDataRoot), null);
  } finally {
    fs.rmSync(programDataRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// _refreshEngineBridgeCopy
// ---------------------------------------------------------------------------

test("_refreshEngineBridgeCopy copies shipped files and preserves unrelated files when the engine stamp is stale", () => {
  const engineDir = tmpDir("panelEngineBridgePush-refresh-stale-engine-");
  const shippedRoot = tmpDir("panelEngineBridgePush-refresh-stale-shipped-");
  const globalStorageDir = tmpDir("panelEngineBridgePush-refresh-stale-storage-");
  try {
    const shippedDir = path.join(shippedRoot, "media", "uefn-bridge");
    fs.mkdirSync(shippedDir, { recursive: true });
    fs.writeFileSync(path.join(shippedDir, "bridge_version.py"), 'BRIDGE_VERSION = "1.2.4"\n');
    fs.writeFileSync(path.join(shippedDir, "uefn_bridge.py"), "# new shipped bridge code");
    fs.writeFileSync(path.join(shippedDir, "trashbyrd_40x40.png"), "fake-png-bytes");
    fs.writeFileSync(path.join(shippedDir, "uefn-server.mjs"), "// must NOT be copied to the engine dir");
    fs.mkdirSync(path.join(shippedDir, "__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(shippedDir, "__pycache__", "junk.pyc"), "compiled junk");

    fs.mkdirSync(engineDir, { recursive: true });
    fs.writeFileSync(path.join(engineDir, "bridge_version.py"), 'BRIDGE_VERSION = "1.2.3"\n');
    fs.writeFileSync(path.join(engineDir, "uefn_bridge.py"), "# old stale bridge code");
    fs.writeFileSync(path.join(engineDir, "unreal_legacy_file.py"), "# UEFN's own file -- must survive");

    const result = refreshEngineBridgeCopy(engineDir, shippedRoot, globalStorageDir);

    assert.equal(result, "updated");
    assert.equal(fs.readFileSync(path.join(engineDir, "bridge_version.py"), "utf8"), 'BRIDGE_VERSION = "1.2.4"\n');
    assert.equal(fs.readFileSync(path.join(engineDir, "uefn_bridge.py"), "utf8"), "# new shipped bridge code");
    assert.equal(fs.readFileSync(path.join(engineDir, "trashbyrd_40x40.png"), "utf8"), "fake-png-bytes");
    assert.ok(!fs.existsSync(path.join(engineDir, "uefn-server.mjs")), "uefn-server.mjs must never be copied");
    assert.ok(
      fs.existsSync(path.join(engineDir, "unreal_legacy_file.py")),
      "UEFN's own/legacy file must be preserved"
    );
    assert.equal(
      fs.readFileSync(path.join(engineDir, "unreal_legacy_file.py"), "utf8"),
      "# UEFN's own file -- must survive"
    );
  } finally {
    fs.rmSync(engineDir, { recursive: true, force: true });
    fs.rmSync(shippedRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
  }
});

test("_refreshEngineBridgeCopy is a no-op returning \"current\" when the stamps already match", () => {
  const engineDir = tmpDir("panelEngineBridgePush-refresh-current-engine-");
  const shippedRoot = tmpDir("panelEngineBridgePush-refresh-current-shipped-");
  const globalStorageDir = tmpDir("panelEngineBridgePush-refresh-current-storage-");
  try {
    const shippedDir = path.join(shippedRoot, "media", "uefn-bridge");
    fs.mkdirSync(shippedDir, { recursive: true });
    const stamp = 'BRIDGE_VERSION = "1.2.4"';
    fs.writeFileSync(path.join(shippedDir, "bridge_version.py"), `${stamp}\n`);
    fs.writeFileSync(path.join(shippedDir, "uefn_bridge.py"), "# shipped bridge code, should NOT be copied");

    fs.mkdirSync(engineDir, { recursive: true });
    // Trimmed-content match: trailing whitespace differs but trims equal.
    fs.writeFileSync(path.join(engineDir, "bridge_version.py"), `${stamp}\n\n  \n`);
    fs.writeFileSync(path.join(engineDir, "uefn_bridge.py"), "# untouched engine bridge code");

    const result = refreshEngineBridgeCopy(engineDir, shippedRoot, globalStorageDir);

    assert.equal(result, "current");
    assert.equal(
      fs.readFileSync(path.join(engineDir, "uefn_bridge.py"), "utf8"),
      "# untouched engine bridge code",
      "nothing should be rewritten when stamps already match"
    );
  } finally {
    fs.rmSync(engineDir, { recursive: true, force: true });
    fs.rmSync(shippedRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
  }
});

test("_refreshEngineBridgeCopy returns \"unavailable\" when the engine dir doesn't exist", () => {
  const shippedRoot = tmpDir("panelEngineBridgePush-refresh-missing-shipped-");
  const globalStorageDir = tmpDir("panelEngineBridgePush-refresh-missing-storage-");
  try {
    const shippedDir = path.join(shippedRoot, "media", "uefn-bridge");
    fs.mkdirSync(shippedDir, { recursive: true });
    fs.writeFileSync(path.join(shippedDir, "bridge_version.py"), 'BRIDGE_VERSION = "1.2.4"\n');
    fs.writeFileSync(path.join(shippedDir, "uefn_bridge.py"), "# shipped bridge code");

    const missingEngineDir = path.join(shippedRoot, "does-not-exist", "Python");

    const result = refreshEngineBridgeCopy(missingEngineDir, shippedRoot, globalStorageDir);

    assert.equal(result, "unavailable");
    assert.ok(!fs.existsSync(missingEngineDir), "must not create the missing engine dir");
  } finally {
    fs.rmSync(shippedRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
  }
});
