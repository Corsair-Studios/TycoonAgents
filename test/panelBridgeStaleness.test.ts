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
// module loader (same technique as test/panelUrcIgnore.test.ts) so this
// file's require of panel.js resolves under plain `node --test`, and we
// exercise the REAL production `_uefnEffectiveRoot` / `_uefnBridgeStale` /
// `_healDuplicateUefnBridgeStaging` methods rather than reimplementations.
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

// `_uefnEffectiveRoot` delegates to `_resolveUefnContentDirEvidence` (the
// evidence ladder: matching .vproject Source dirPath, then an existing
// Python/init_unreal.py, then documented layout rules), which in turn calls
// `_findMatchingVprojectContentDirs`, `_plausibleContentDirCandidates`, and
// `_canonPath` — all of these only touch path/fs/process.env (no other
// `this` state), so a receiver carrying just this method set is enough to
// invoke the real methods under test with their real internal call chain.
const UEFN_EVIDENCE_METHODS = {
  _uefnEffectiveRoot: (TycoonPanel.prototype as any)._uefnEffectiveRoot,
  _resolveUefnContentDirEvidence: (TycoonPanel.prototype as any)._resolveUefnContentDirEvidence,
  _findMatchingVprojectContentDirs: (TycoonPanel.prototype as any)._findMatchingVprojectContentDirs,
  _plausibleContentDirCandidates: (TycoonPanel.prototype as any)._plausibleContentDirCandidates,
  _confirmedContentDirItself: (TycoonPanel.prototype as any)._confirmedContentDirItself,
  _canonPath: (TycoonPanel.prototype as any)._canonPath,
};

function effectiveRoot(root: string): string {
  return (TycoonPanel.prototype as any)._uefnEffectiveRoot.call({ ...UEFN_EVIDENCE_METHODS }, root);
}

// `_uefnBridgeStale` calls `this._uefnEffectiveRoot` (and its own evidence-
// ladder call chain, see `UEFN_EVIDENCE_METHODS`) and reads
// `this._extensionUri.fsPath` — a minimal receiver carrying those is
// enough, mirroring test/panelProjectPlanSkillInstall.test.ts's pattern for
// `_extensionUri`. `shippedRoot` stands in for the extension install dir; a
// fake `media/uefn-bridge/bridge_version.py` is written under it by each
// test — the REAL shipped file (owned by another worker) is never touched.
function bridgeStale(root: string, shippedRoot: string): boolean {
  const fakeThis = {
    _extensionUri: { fsPath: shippedRoot },
    ...UEFN_EVIDENCE_METHODS,
  };
  return (TycoonPanel.prototype as any)._uefnBridgeStale.call(fakeThis, root);
}

// `_healDuplicateUefnBridgeStaging` only touches path/fs (`effRoot`,
// `bridgeDir` args) — a bare receiver is enough.
function healDuplicate(effRoot: string, bridgeDir: string): void {
  (TycoonPanel.prototype as any)._healDuplicateUefnBridgeStaging.call({}, effRoot, bridgeDir);
}

function writeStamp(dir: string, contents: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "bridge_version.py"), contents);
}

// ---------------------------------------------------------------------------
// FIX 1: _uefnEffectiveRoot
// ---------------------------------------------------------------------------

test("_uefnEffectiveRoot redirects to the parent when root is a Content dir with a sibling .uefnproject", () => {
  const projectRoot = tmpDir("panelBridgeStaleness-eff-a-");
  try {
    fs.writeFileSync(path.join(projectRoot, "MyProject.uefnproject"), "");
    const contentDir = path.join(projectRoot, "Content");
    fs.mkdirSync(contentDir, { recursive: true });

    assert.equal(effectiveRoot(contentDir), projectRoot);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("_uefnEffectiveRoot leaves a Content-named root unchanged when the parent has no .uefnproject", () => {
  const projectRoot = tmpDir("panelBridgeStaleness-eff-b-");
  try {
    const contentDir = path.join(projectRoot, "Content");
    fs.mkdirSync(contentDir, { recursive: true });

    assert.equal(effectiveRoot(contentDir), contentDir);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("_uefnEffectiveRoot leaves a normal (non-Content) root unchanged", () => {
  const parentDir = tmpDir("panelBridgeStaleness-eff-c-");
  try {
    // Even with a sibling .uefnproject present, a root not named "Content"
    // must never be redirected.
    fs.writeFileSync(path.join(parentDir, "Unrelated.uefnproject"), "");
    const root = path.join(parentDir, "SomeProjectFolder");
    fs.mkdirSync(root, { recursive: true });

    assert.equal(effectiveRoot(root), root);
  } finally {
    fs.rmSync(parentDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FIX 2: staleness detection
// ---------------------------------------------------------------------------

test("_uefnBridgeStale is false when the staged and shipped stamps match", () => {
  const root = tmpDir("panelBridgeStaleness-stale-match-root-");
  const shippedRoot = tmpDir("panelBridgeStaleness-stale-match-shipped-");
  try {
    const stamp = 'BRIDGE_VERSION = "1.2.3"';
    writeStamp(path.join(root, "Content", "Python"), `# generated\n# do not edit\n\n${stamp}\n`);
    writeStamp(path.join(shippedRoot, "media", "uefn-bridge"), `# generated\n# do not edit\n\n${stamp}\n`);

    assert.equal(bridgeStale(root, shippedRoot), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(shippedRoot, { recursive: true, force: true });
  }
});

test("_uefnBridgeStale is true when the staged and shipped stamps differ", () => {
  const root = tmpDir("panelBridgeStaleness-stale-diff-root-");
  const shippedRoot = tmpDir("panelBridgeStaleness-stale-diff-shipped-");
  try {
    writeStamp(path.join(root, "Content", "Python"), '# generated\n\nBRIDGE_VERSION = "1.2.3"\n');
    writeStamp(path.join(shippedRoot, "media", "uefn-bridge"), '# generated\n\nBRIDGE_VERSION = "1.2.4"\n');

    assert.equal(bridgeStale(root, shippedRoot), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(shippedRoot, { recursive: true, force: true });
  }
});

test("_uefnBridgeStale falls back to false (not stale) when the staged stamp is missing", () => {
  const root = tmpDir("panelBridgeStaleness-stale-missing-root-");
  const shippedRoot = tmpDir("panelBridgeStaleness-stale-missing-shipped-");
  try {
    // No staged bridge_version.py at all -- pre-stamping install.
    fs.mkdirSync(path.join(root, "Content", "Python"), { recursive: true });
    writeStamp(path.join(shippedRoot, "media", "uefn-bridge"), '# generated\n\nBRIDGE_VERSION = "1.2.4"\n');

    assert.equal(bridgeStale(root, shippedRoot), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(shippedRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FIX 3: duplicate auto-heal
// ---------------------------------------------------------------------------

test("_healDuplicateUefnBridgeStaging deletes only bridge-owned files, preserving an unrelated file and leaving non-empty dirs in place", () => {
  const effRoot = tmpDir("panelBridgeStaleness-heal-partial-root-");
  const bridgeDir = tmpDir("panelBridgeStaleness-heal-partial-bridge-");
  try {
    // Source bridge file set (mirrors media/uefn-bridge/'s shape).
    fs.writeFileSync(path.join(bridgeDir, "uefn_bridge.py"), "# bridge");
    fs.writeFileSync(path.join(bridgeDir, "bridge_version.py"), 'BRIDGE_VERSION = "1.2.3"');
    fs.writeFileSync(path.join(bridgeDir, "trashbyrd_40x40.png"), "fake-png-bytes");
    fs.writeFileSync(path.join(bridgeDir, "uefn-server.mjs"), "// must NOT be deleted from dup dir either");

    const dupPythonDir = path.join(effRoot, "Content", "Content", "Python");
    fs.mkdirSync(dupPythonDir, { recursive: true });
    fs.writeFileSync(path.join(dupPythonDir, "uefn_bridge.py"), "# stale bridge copy");
    fs.writeFileSync(path.join(dupPythonDir, "bridge_version.py"), 'BRIDGE_VERSION = "1.2.3"');
    fs.writeFileSync(path.join(dupPythonDir, "trashbyrd_40x40.png"), "fake-png-bytes");
    fs.writeFileSync(path.join(dupPythonDir, "keep.txt"), "user file, must survive");

    healDuplicate(effRoot, bridgeDir);

    assert.ok(!fs.existsSync(path.join(dupPythonDir, "uefn_bridge.py")), "uefn_bridge.py must be deleted");
    assert.ok(!fs.existsSync(path.join(dupPythonDir, "bridge_version.py")), "bridge_version.py must be deleted");
    assert.ok(!fs.existsSync(path.join(dupPythonDir, "trashbyrd_40x40.png")), "trashbyrd_40x40.png must be deleted");
    assert.ok(fs.existsSync(path.join(dupPythonDir, "keep.txt")), "keep.txt must be preserved");
    assert.ok(fs.existsSync(dupPythonDir), "non-empty Python dir must be left in place");
  } finally {
    fs.rmSync(effRoot, { recursive: true, force: true });
    fs.rmSync(bridgeDir, { recursive: true, force: true });
  }
});

test("_healDuplicateUefnBridgeStaging removes the dup Python dir and its Content/Content parent when they end up empty", () => {
  const effRoot = tmpDir("panelBridgeStaleness-heal-full-root-");
  const bridgeDir = tmpDir("panelBridgeStaleness-heal-full-bridge-");
  try {
    fs.writeFileSync(path.join(bridgeDir, "uefn_bridge.py"), "# bridge");
    fs.writeFileSync(path.join(bridgeDir, "bridge_version.py"), 'BRIDGE_VERSION = "1.2.3"');

    const dupPythonDir = path.join(effRoot, "Content", "Content", "Python");
    fs.mkdirSync(dupPythonDir, { recursive: true });
    fs.writeFileSync(path.join(dupPythonDir, "uefn_bridge.py"), "# stale bridge copy");
    fs.writeFileSync(path.join(dupPythonDir, "bridge_version.py"), 'BRIDGE_VERSION = "1.2.3"');

    healDuplicate(effRoot, bridgeDir);

    const dupContentDir = path.join(effRoot, "Content", "Content");
    assert.ok(!fs.existsSync(dupPythonDir), "emptied Python dir must be removed");
    assert.ok(!fs.existsSync(dupContentDir), "emptied Content/Content parent must be removed");
    // The real Content dir itself (holding the removed Content/Content) must survive.
    assert.ok(fs.existsSync(path.join(effRoot, "Content")), "the real Content dir must survive");
  } finally {
    fs.rmSync(effRoot, { recursive: true, force: true });
    fs.rmSync(bridgeDir, { recursive: true, force: true });
  }
});

test("_healDuplicateUefnBridgeStaging is a no-op when there is no duplicate staging location", () => {
  const effRoot = tmpDir("panelBridgeStaleness-heal-noop-root-");
  const bridgeDir = tmpDir("panelBridgeStaleness-heal-noop-bridge-");
  try {
    fs.writeFileSync(path.join(bridgeDir, "uefn_bridge.py"), "# bridge");
    // No Content/Content/Python at all -- must not throw or create anything.
    healDuplicate(effRoot, bridgeDir);
    assert.ok(!fs.existsSync(path.join(effRoot, "Content", "Content")), "must not create a dup dir");
  } finally {
    fs.rmSync(effRoot, { recursive: true, force: true });
    fs.rmSync(bridgeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FIX 4: _autoUpdateUefnBridgeIfStale also refreshes an existing engine copy,
// independent of whether the project copy was stale (0.0.444).
// ---------------------------------------------------------------------------

// `_autoUpdateUefnBridgeIfStale` reads/writes real fs paths (project
// Content/Python + a fake extension dir standing in for media/uefn-bridge)
// and calls three other prototype methods on `this`: the real
// `_stageBridgeTo` (fs-only, safe to run for real against tmp dirs), and
// `_findFortniteEngineBridgeDir` + `_refreshEngineBridgeCopy`, both replaced
// with spies. This is the regression guard for the real bug found by reading
// the code: `_refreshEngineBridgeCopy` treats its argument as the ENGINE
// dir it reads/writes into, but the production code used to pass it the
// SHIPPED `bridgeDir` directly -- comparing the shipped stamp to itself, so
// it always returned "current" and the real Fortnite engine copy was never
// found or updated. The fix discovers the engine dir via
// `_findFortniteEngineBridgeDir` first and only calls `_refreshEngineBridgeCopy`
// with THAT discovered dir -- `engineCalls` captures the exact arg received
// so a regression back to passing the shipped dir fails the assertion below.
async function autoUpdate(
  root: string,
  extensionRoot: string,
  findEngineBridgeDir: () => string | null,
  refreshEngineBridgeCopy: (bridgeDir: string) => "updated" | "current" | "unavailable"
): Promise<{ engineCalls: string[]; findCalls: number }> {
  const engineCalls: string[] = [];
  let findCalls = 0;
  const fakeThis = {
    _extensionUri: { fsPath: extensionRoot },
    ...UEFN_EVIDENCE_METHODS,
    _stageBridgeTo: (TycoonPanel.prototype as any)._stageBridgeTo,
    _findFortniteEngineBridgeDir: () => {
      findCalls++;
      return findEngineBridgeDir();
    },
    _refreshEngineBridgeCopy: (bridgeDir: string) => {
      engineCalls.push(bridgeDir);
      return refreshEngineBridgeCopy(bridgeDir);
    },
  };
  await (TycoonPanel.prototype as any)._autoUpdateUefnBridgeIfStale.call(fakeThis, root);
  return { engineCalls, findCalls };
}

test("_autoUpdateUefnBridgeIfStale calls _refreshEngineBridgeCopy with the DISCOVERED engine dir, not the shipped bridgeDir, even when the project copy is already current", async () => {
  const root = tmpDir("panelBridgeStaleness-auto-engine-current-root-");
  const extensionRoot = tmpDir("panelBridgeStaleness-auto-engine-current-ext-");
  const sentinelEngineDir = tmpDir("panelBridgeStaleness-auto-engine-current-engine-");
  try {
    const stamp = 'BRIDGE_VERSION = "1.2.3"';
    // Project copy already matches bundled -- no project-side staleness.
    writeStamp(path.join(root, "Content", "Python"), `${stamp}\n`);
    writeStamp(path.join(extensionRoot, "media", "uefn-bridge"), `${stamp}\n`);

    const { engineCalls, findCalls } = await autoUpdate(
      root,
      extensionRoot,
      () => sentinelEngineDir,
      () => "current"
    );

    assert.equal(findCalls, 1, "_findFortniteEngineBridgeDir must be called to discover the engine dir");
    assert.equal(engineCalls.length, 1, "_refreshEngineBridgeCopy must be called even with a current project copy");
    // KEY REGRESSION ASSERTION: the arg passed must be the DISCOVERED engine
    // dir, never the shipped media/uefn-bridge dir (extensionRoot's bridgeDir).
    assert.equal(engineCalls[0], sentinelEngineDir);
    assert.notEqual(engineCalls[0], path.join(extensionRoot, "media", "uefn-bridge"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(sentinelEngineDir, { recursive: true, force: true });
  }
});

test("_autoUpdateUefnBridgeIfStale calls _refreshEngineBridgeCopy with the discovered engine dir when the project copy is stale too", async () => {
  const root = tmpDir("panelBridgeStaleness-auto-engine-stale-root-");
  const extensionRoot = tmpDir("panelBridgeStaleness-auto-engine-stale-ext-");
  const sentinelEngineDir = tmpDir("panelBridgeStaleness-auto-engine-stale-engine-");
  try {
    writeStamp(path.join(root, "Content", "Python"), 'BRIDGE_VERSION = "1.2.3"\n');
    writeStamp(path.join(extensionRoot, "media", "uefn-bridge"), 'BRIDGE_VERSION = "1.2.4"\n');

    const { engineCalls } = await autoUpdate(
      root,
      extensionRoot,
      () => sentinelEngineDir,
      () => "updated"
    );

    assert.equal(engineCalls.length, 1, "_refreshEngineBridgeCopy must still be called alongside a stale project copy");
    assert.equal(engineCalls[0], sentinelEngineDir, "must pass the discovered engine dir, not the shipped bridgeDir");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(sentinelEngineDir, { recursive: true, force: true });
  }
});

test("_autoUpdateUefnBridgeIfStale never calls _refreshEngineBridgeCopy when the project never opted into UEFN", async () => {
  const root = tmpDir("panelBridgeStaleness-auto-engine-noopt-root-");
  const extensionRoot = tmpDir("panelBridgeStaleness-auto-engine-noopt-ext-");
  try {
    // No Content/Python/bridge_version.py at all -- opt-in guard returns early.
    writeStamp(path.join(extensionRoot, "media", "uefn-bridge"), 'BRIDGE_VERSION = "1.2.4"\n');

    const { engineCalls, findCalls } = await autoUpdate(
      root,
      extensionRoot,
      () => {
        throw new Error("_findFortniteEngineBridgeDir must not be called when opt-in guard returns early");
      },
      () => "updated"
    );
    assert.equal(findCalls, 0, "opt-in guard must prevent any engine dir discovery");
    assert.equal(engineCalls.length, 0, "opt-in guard must prevent any engine refresh");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  }
});

test("_autoUpdateUefnBridgeIfStale treats a missing engine dir as unavailable: never calls _refreshEngineBridgeCopy and fires no engine-only toast", async () => {
  const root = tmpDir("panelBridgeStaleness-auto-engine-missing-root-");
  const extensionRoot = tmpDir("panelBridgeStaleness-auto-engine-missing-ext-");
  try {
    const stamp = 'BRIDGE_VERSION = "1.2.3"';
    // Project copy already current -- isolates the engine-only path.
    writeStamp(path.join(root, "Content", "Python"), `${stamp}\n`);
    writeStamp(path.join(extensionRoot, "media", "uefn-bridge"), `${stamp}\n`);

    const { engineCalls, findCalls } = await autoUpdate(
      root,
      extensionRoot,
      () => null,
      () => {
        throw new Error("_refreshEngineBridgeCopy must not be called when no engine dir was found");
      }
    );

    assert.equal(findCalls, 1, "_findFortniteEngineBridgeDir must still be attempted");
    assert.equal(engineCalls.length, 0, "_refreshEngineBridgeCopy must not be called when discovery returns null");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  }
});
