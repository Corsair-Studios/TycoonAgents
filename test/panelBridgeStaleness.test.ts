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
// ladder call chain, see `UEFN_EVIDENCE_METHODS`) and `this._powerToolsDir()`,
// which itself reads `this._extensionUri.fsPath` and
// `this._globalStorageUri.fsPath` -- a minimal receiver carrying those is
// enough, mirroring test/panelProjectPlanSkillInstall.test.ts's pattern for
// `_extensionUri`. `shippedRoot` stands in for the extension install dir; a
// fake `media/uefn-bridge/{bridge_version.py,uefn_bridge.py}` is written
// under it by each test via `writeShippedBridge` -- the marker file is what
// makes `resolvePowerToolsDir`'s bundled rung (rung 3) resolve at all. The
// REAL shipped file (owned by another worker) is never touched. No installed
// copy is staged, so `globalStorageDir` is an empty dir purely to make rung 2
// resolve to nothing and fall through to the bundled rung.
function bridgeStale(root: string, shippedRoot: string, globalStorageDir: string): boolean {
  const fakeThis = {
    _extensionUri: { fsPath: shippedRoot },
    _globalStorageUri: { fsPath: globalStorageDir },
    _powerToolsDir: (TycoonPanel.prototype as any)._powerToolsDir,
    ...UEFN_EVIDENCE_METHODS,
  };
  return (TycoonPanel.prototype as any)._uefnBridgeStale.call(fakeThis, root);
}

// `_healDuplicateUefnBridgeStaging` only touches path/fs (`effRoot`,
// `bridgeDir` args) — a bare receiver is enough.
function healDuplicate(effRoot: string, bridgeDir: string): void {
  (TycoonPanel.prototype as any)._healDuplicateUefnBridgeStaging.call({}, effRoot, bridgeDir);
}

// `_stageBridgeTo` only touches path/fs -- a bare receiver is enough.
function stageBridgeTo(
  bridgeDir: string,
  pyDest: string
): { staged: number; updated: number; unchanged: number; error?: string } {
  return (TycoonPanel.prototype as any)._stageBridgeTo.call({}, bridgeDir, pyDest);
}

function chmodIfExists(p: string, mode: number): void {
  try {
    fs.chmodSync(p, mode);
  } catch {
    /* platform may not support this bit -- test below tolerates that */
  }
}

function writeStamp(dir: string, contents: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "bridge_version.py"), contents);
}

// `_powerToolsDir()` resolves via `resolvePowerToolsDir`'s content-validated
// ladder -- a directory only counts as a legacy "bundled" copy (rung 3) if it
// contains `uefn_bridge.py`, the marker `hasMarker` checks for. Fixtures
// that stand in for the shipped `media/uefn-bridge` dir and are read through
// `this._powerToolsDir()` (i.e. `_uefnBridgeStale`, `_autoUpdateUefnBridgeIfStale`,
// `_verifiedUefnBridgeStampValue`) must write both files, or the resolver
// finds nothing and every one of those methods degrades to its "unresolved"
// fallback instead of exercising the behavior under test.
function writeShippedBridge(dir: string, stampContents: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "bridge_version.py"), stampContents);
  fs.writeFileSync(path.join(dir, "uefn_bridge.py"), "# shipped bridge marker");
}

// `_autoUpdateUefnBridgeIfStale`'s opt-in signal is `uefn_bridge.py`
// presence (the fix for the silent-skip bug -- see FIX 5 below), NOT the
// version stamp alone. Fixtures that want "a bridge is already staged
// here, with this stamp" must write both files; this helper does that in
// one call so each test site doesn't have to remember it.
function writeStagedProjectBridge(pyDir: string, stampContents: string | null): void {
  fs.mkdirSync(pyDir, { recursive: true });
  fs.writeFileSync(path.join(pyDir, "uefn_bridge.py"), "# staged bridge");
  if (stampContents !== null) {
    fs.writeFileSync(path.join(pyDir, "bridge_version.py"), stampContents);
  }
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
  const globalStorageDir = tmpDir("panelBridgeStaleness-stale-match-storage-");
  try {
    const stamp = 'BRIDGE_VERSION = "1.2.3"';
    writeStamp(path.join(root, "Content", "Python"), `# generated\n# do not edit\n\n${stamp}\n`);
    writeShippedBridge(path.join(shippedRoot, "media", "uefn-bridge"), `# generated\n# do not edit\n\n${stamp}\n`);

    assert.equal(bridgeStale(root, shippedRoot, globalStorageDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(shippedRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
  }
});

test("_uefnBridgeStale is true when the staged and shipped stamps differ", () => {
  const root = tmpDir("panelBridgeStaleness-stale-diff-root-");
  const shippedRoot = tmpDir("panelBridgeStaleness-stale-diff-shipped-");
  const globalStorageDir = tmpDir("panelBridgeStaleness-stale-diff-storage-");
  try {
    writeStamp(path.join(root, "Content", "Python"), '# generated\n\nBRIDGE_VERSION = "1.2.3"\n');
    writeShippedBridge(path.join(shippedRoot, "media", "uefn-bridge"), '# generated\n\nBRIDGE_VERSION = "1.2.4"\n');

    assert.equal(bridgeStale(root, shippedRoot, globalStorageDir), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(shippedRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
  }
});

test("_uefnBridgeStale falls back to false (not stale) when the staged stamp is missing", () => {
  const root = tmpDir("panelBridgeStaleness-stale-missing-root-");
  const shippedRoot = tmpDir("panelBridgeStaleness-stale-missing-shipped-");
  const globalStorageDir = tmpDir("panelBridgeStaleness-stale-missing-storage-");
  try {
    // No staged bridge_version.py at all -- pre-stamping install.
    fs.mkdirSync(path.join(root, "Content", "Python"), { recursive: true });
    writeShippedBridge(path.join(shippedRoot, "media", "uefn-bridge"), '# generated\n\nBRIDGE_VERSION = "1.2.4"\n');

    assert.equal(bridgeStale(root, shippedRoot, globalStorageDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(shippedRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
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
// `_autoUpdateUefnBridgeIfStale` calls `this._powerToolsDir()` (needing
// `_extensionUri` + `_globalStorageUri`) in addition to the evidence-ladder
// methods. No installed copy is staged in these fixtures, so `globalStorageDir`
// is always an empty dir the caller owns and cleans up -- that makes rung 2
// resolve to nothing and fall through to the bundled rung at `extensionRoot`.
async function autoUpdate(
  root: string,
  extensionRoot: string,
  findEngineBridgeDir: () => string | null,
  refreshEngineBridgeCopy: (bridgeDir: string) => "updated" | "current" | "unavailable",
  globalStorageDir: string
): Promise<{ engineCalls: string[]; findCalls: number }> {
  const engineCalls: string[] = [];
  let findCalls = 0;
  const fakeThis = {
    _extensionUri: { fsPath: extensionRoot },
    _globalStorageUri: { fsPath: globalStorageDir },
    _powerToolsDir: (TycoonPanel.prototype as any)._powerToolsDir,
    ...UEFN_EVIDENCE_METHODS,
    _stageBridgeTo: (TycoonPanel.prototype as any)._stageBridgeTo,
    _healDuplicateUefnBridgeStaging: (TycoonPanel.prototype as any)._healDuplicateUefnBridgeStaging,
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
  const globalStorageDir = tmpDir("panelBridgeStaleness-auto-engine-current-storage-");
  const sentinelEngineDir = tmpDir("panelBridgeStaleness-auto-engine-current-engine-");
  try {
    const stamp = 'BRIDGE_VERSION = "1.2.3"';
    // Project copy already matches bundled -- no project-side staleness.
    writeStagedProjectBridge(path.join(root, "Content", "Python"), `${stamp}\n`);
    writeShippedBridge(path.join(extensionRoot, "media", "uefn-bridge"), `${stamp}\n`);

    const { engineCalls, findCalls } = await autoUpdate(
      root,
      extensionRoot,
      () => sentinelEngineDir,
      () => "current",
      globalStorageDir
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
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
    fs.rmSync(sentinelEngineDir, { recursive: true, force: true });
  }
});

test("_autoUpdateUefnBridgeIfStale calls _refreshEngineBridgeCopy with the discovered engine dir when the project copy is stale too", async () => {
  const root = tmpDir("panelBridgeStaleness-auto-engine-stale-root-");
  const extensionRoot = tmpDir("panelBridgeStaleness-auto-engine-stale-ext-");
  const globalStorageDir = tmpDir("panelBridgeStaleness-auto-engine-stale-storage-");
  const sentinelEngineDir = tmpDir("panelBridgeStaleness-auto-engine-stale-engine-");
  try {
    writeStagedProjectBridge(path.join(root, "Content", "Python"), 'BRIDGE_VERSION = "1.2.3"\n');
    writeShippedBridge(path.join(extensionRoot, "media", "uefn-bridge"), 'BRIDGE_VERSION = "1.2.4"\n');

    const { engineCalls } = await autoUpdate(
      root,
      extensionRoot,
      () => sentinelEngineDir,
      () => "updated",
      globalStorageDir
    );

    assert.equal(engineCalls.length, 1, "_refreshEngineBridgeCopy must still be called alongside a stale project copy");
    assert.equal(engineCalls[0], sentinelEngineDir, "must pass the discovered engine dir, not the shipped bridgeDir");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
    fs.rmSync(sentinelEngineDir, { recursive: true, force: true });
  }
});

test("_autoUpdateUefnBridgeIfStale never calls _refreshEngineBridgeCopy when the project never opted into UEFN", async () => {
  const root = tmpDir("panelBridgeStaleness-auto-engine-noopt-root-");
  const extensionRoot = tmpDir("panelBridgeStaleness-auto-engine-noopt-ext-");
  const globalStorageDir = tmpDir("panelBridgeStaleness-auto-engine-noopt-storage-");
  try {
    // No Content/Python/uefn_bridge.py at all -- opt-in guard returns early.
    writeShippedBridge(path.join(extensionRoot, "media", "uefn-bridge"), 'BRIDGE_VERSION = "1.2.4"\n');

    const { engineCalls, findCalls } = await autoUpdate(
      root,
      extensionRoot,
      () => {
        throw new Error("_findFortniteEngineBridgeDir must not be called when opt-in guard returns early");
      },
      () => "updated",
      globalStorageDir
    );
    assert.equal(findCalls, 0, "opt-in guard must prevent any engine dir discovery");
    assert.equal(engineCalls.length, 0, "opt-in guard must prevent any engine refresh");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
  }
});

test("_autoUpdateUefnBridgeIfStale treats a missing engine dir as unavailable: never calls _refreshEngineBridgeCopy and fires no engine-only toast", async () => {
  const root = tmpDir("panelBridgeStaleness-auto-engine-missing-root-");
  const extensionRoot = tmpDir("panelBridgeStaleness-auto-engine-missing-ext-");
  const globalStorageDir = tmpDir("panelBridgeStaleness-auto-engine-missing-storage-");
  try {
    const stamp = 'BRIDGE_VERSION = "1.2.3"';
    // Project copy already current -- isolates the engine-only path.
    writeStagedProjectBridge(path.join(root, "Content", "Python"), `${stamp}\n`);
    writeShippedBridge(path.join(extensionRoot, "media", "uefn-bridge"), `${stamp}\n`);

    const { engineCalls, findCalls } = await autoUpdate(
      root,
      extensionRoot,
      () => null,
      () => {
        throw new Error("_refreshEngineBridgeCopy must not be called when no engine dir was found");
      },
      globalStorageDir
    );

    assert.equal(findCalls, 1, "_findFortniteEngineBridgeDir must still be attempted");
    assert.equal(engineCalls.length, 0, "_refreshEngineBridgeCopy must not be called when discovery returns null");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FIX 5: the silent-skip bug. A pre-stamping-era (June) install has
// uefn_bridge.py staged but NO bridge_version.py -- the old opt-in gate
// checked for the STAMP's existence and read "no stamp" as "never opted
// into UEFN, do nothing", so a project that badly needed refreshing was
// silently skipped forever. The fix gates opt-in on `uefn_bridge.py`
// itself and treats a missing/unparseable installed stamp as MAXIMALLY
// stale. This section also covers the two things wired into the SAME rail
// alongside the gate fix: the misplaced Content/Content/Python heal (only
// ran on explicit install before), and using the real evidence-ladder
// target resolution (never a fallback guess) since this is a write path.
// ---------------------------------------------------------------------------

function writeVprojectForAuto(vprojectPath: string, sourceDir: string, name: string): void {
  fs.mkdirSync(path.dirname(vprojectPath), { recursive: true });
  fs.writeFileSync(
    vprojectPath,
    JSON.stringify({
      packages: [
        { desc: { name, dirPath: sourceDir, settings: { role: "Source" } } },
        { desc: { name: "SomeExternalPkg", settings: { role: "External" } } },
      ],
    })
  );
}

test("_autoUpdateUefnBridgeIfStale refreshes a STAMPLESS (pre-stamping-era) staged bridge instead of silently skipping it", async () => {
  const root = tmpDir("panelBridgeStaleness-gate-stampless-root-");
  const extensionRoot = tmpDir("panelBridgeStaleness-gate-stampless-ext-");
  const globalStorageDir = tmpDir("panelBridgeStaleness-gate-stampless-storage-");
  try {
    const projectPyDir = path.join(root, "Content", "Python");
    // June-era install: real bridge file present, NO bridge_version.py at
    // all -- this is exactly the shape the old gate misread as "not
    // opted in".
    fs.mkdirSync(projectPyDir, { recursive: true });
    fs.writeFileSync(path.join(projectPyDir, "uefn_bridge.py"), "# STALE June bridge, no stamp");

    writeShippedBridge(path.join(extensionRoot, "media", "uefn-bridge"), 'BRIDGE_VERSION = "2.1.0"\n');

    const { findCalls } = await autoUpdate(
      root,
      extensionRoot,
      () => null,
      () => {
        throw new Error("must not be called -- no engine dir in this fixture");
      },
      globalStorageDir
    );

    assert.equal(findCalls, 1, "the rail must run past the opt-in gate to reach the engine-refresh step too");
    assert.equal(
      fs.readFileSync(path.join(projectPyDir, "bridge_version.py"), "utf8"),
      'BRIDGE_VERSION = "2.1.0"\n',
      "a missing stamp must be treated as maximally stale and refreshed, never silently skipped"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
  }
});

test("_autoUpdateUefnBridgeIfStale heals a misplaced Content/Content/Python left by the old staging bug, alongside a normal project refresh", async () => {
  const root = tmpDir("panelBridgeStaleness-gate-dupheal-root-");
  const extensionRoot = tmpDir("panelBridgeStaleness-gate-dupheal-ext-");
  const globalStorageDir = tmpDir("panelBridgeStaleness-gate-dupheal-storage-");
  try {
    const projectPyDir = path.join(root, "Content", "Python");
    writeStagedProjectBridge(projectPyDir, 'BRIDGE_VERSION = "1.0.0"\n');

    const bridgeDir = path.join(extensionRoot, "media", "uefn-bridge");
    fs.mkdirSync(bridgeDir, { recursive: true });
    fs.writeFileSync(path.join(bridgeDir, "uefn_bridge.py"), "# shipped bridge");
    fs.writeFileSync(path.join(bridgeDir, "bridge_version.py"), 'BRIDGE_VERSION = "2.1.0"\n');

    // The old staging bug's fabricated nested copy, carrying our own
    // bridge's filenames.
    const bogusNestedPythonDir = path.join(root, "Content", "Content", "Python");
    fs.mkdirSync(bogusNestedPythonDir, { recursive: true });
    fs.writeFileSync(path.join(bogusNestedPythonDir, "uefn_bridge.py"), "# bogus nested copy");
    fs.writeFileSync(path.join(bogusNestedPythonDir, "bridge_version.py"), 'BRIDGE_VERSION = "1.0.0"\n');

    await autoUpdate(
      root,
      extensionRoot,
      () => null,
      () => {
        throw new Error("must not be called -- no engine dir in this fixture");
      },
      globalStorageDir
    );

    assert.equal(
      fs.readFileSync(path.join(projectPyDir, "uefn_bridge.py"), "utf8"),
      "# shipped bridge",
      "the real project copy must be refreshed"
    );
    assert.ok(!fs.existsSync(bogusNestedPythonDir), "the misplaced nested copy must be healed on this SAME auto-heal rail, not just on explicit install");
    assert.ok(!fs.existsSync(path.join(root, "Content", "Content")), "the emptied Content/Content parent must be removed too");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
  }
});

test("_autoUpdateUefnBridgeIfStale field fixture: Plugins-layout project, workspace opened at the plugin's Content dir, stampless staged bridge, and a bogus nested Content/Content copy -- resolves via the evidence ladder, refreshes the real dir, and heals the nested copy", async () => {
  const projectRoot = tmpDir("panelBridgeStaleness-field-plugins-");
  const verseProjectRoot = tmpDir("panelBridgeStaleness-field-plugins-vproj-");
  const extensionRoot = tmpDir("panelBridgeStaleness-field-plugins-ext-");
  const globalStorageDir = tmpDir("panelBridgeStaleness-field-plugins-storage-");
  const savedOverride = process.env.UEFN_VERSE_PROJECT_DIR;
  try {
    // "<...>\MyIsland_\Plugins\PluginA\Content\" -- the real content dir,
    // confirmed by the vproject's Source dirPath below.
    const realContentDir = path.join(projectRoot, "Plugins", "PluginA", "Content");
    fs.mkdirSync(realContentDir, { recursive: true });

    // Stampless June bridge already staged directly in the real content
    // dir -- a pre-stamping-era install, the exact shape the old gate
    // silently skipped.
    const realPythonDir = path.join(realContentDir, "Python");
    fs.mkdirSync(realPythonDir, { recursive: true });
    fs.writeFileSync(path.join(realPythonDir, "uefn_bridge.py"), "# STALE June bridge, no stamp");

    // The old bug's fabricated nested copy: realContentDir/Content/Python.
    const bogusNestedPythonDir = path.join(realContentDir, "Content", "Python");
    fs.mkdirSync(bogusNestedPythonDir, { recursive: true });
    fs.writeFileSync(path.join(bogusNestedPythonDir, "uefn_bridge.py"), "# bogus nested copy");
    fs.writeFileSync(path.join(bogusNestedPythonDir, "bridge_version.py"), 'BRIDGE_VERSION = "2.0.0"\n');

    // The .vproject UEFN wrote for this project: its Source package
    // dirPath IS realContentDir.
    writeVprojectForAuto(
      path.join(verseProjectRoot, "PluginA", "vproject", "PluginA.vproject"),
      realContentDir,
      "PluginA"
    );

    const bridgeDir = path.join(extensionRoot, "media", "uefn-bridge");
    fs.mkdirSync(bridgeDir, { recursive: true });
    fs.writeFileSync(path.join(bridgeDir, "uefn_bridge.py"), "# shipped bridge");
    fs.writeFileSync(path.join(bridgeDir, "bridge_version.py"), 'BRIDGE_VERSION = "2.1.0"\n');

    process.env.UEFN_VERSE_PROJECT_DIR = verseProjectRoot;

    // Workspace opened directly at the plugin's Content dir -- the exact
    // shape of the field failure.
    await autoUpdate(
      realContentDir,
      extensionRoot,
      () => null,
      () => {
        throw new Error("must not be called -- no engine dir in this fixture");
      },
      globalStorageDir
    );

    assert.equal(
      fs.readFileSync(path.join(realPythonDir, "uefn_bridge.py"), "utf8"),
      "# shipped bridge",
      "the REAL Python dir must be refreshed, resolved via vproject evidence"
    );
    assert.equal(
      fs.readFileSync(path.join(realPythonDir, "bridge_version.py"), "utf8"),
      'BRIDGE_VERSION = "2.1.0"\n',
      "a fresh stamp must land even though the installed copy had none at all"
    );
    assert.ok(!fs.existsSync(bogusNestedPythonDir), "the bogus nested Content/Content/Python dir must be healed on the panel-load rail");
    assert.ok(!fs.existsSync(path.join(realContentDir, "Content")), "the emptied Content/Content parent must be removed too");
    assert.ok(fs.existsSync(realContentDir), "the real content dir itself must survive");
  } finally {
    if (savedOverride === undefined) delete process.env.UEFN_VERSE_PROJECT_DIR;
    else process.env.UEFN_VERSE_PROJECT_DIR = savedOverride;
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(verseProjectRoot, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
  }
});

test("_autoUpdateUefnBridgeIfStale never guesses a target: an unresolved evidence ladder (ambiguous Plugins layout) writes nothing", async () => {
  const projectRoot = tmpDir("panelBridgeStaleness-field-ambiguous-");
  const verseProjectRoot = tmpDir("panelBridgeStaleness-field-ambiguous-vproj-");
  const extensionRoot = tmpDir("panelBridgeStaleness-field-ambiguous-ext-");
  const globalStorageDir = tmpDir("panelBridgeStaleness-field-ambiguous-storage-");
  const savedOverride = process.env.UEFN_VERSE_PROJECT_DIR;
  try {
    // Two plausible Plugins-layout content dirs, no vproject evidence to
    // disambiguate between them, and no existing bridge under either --
    // rung 4 (layout-rule) sees 2 candidates and must refuse to guess.
    const pluginAContent = path.join(projectRoot, "Plugins", "PluginA", "Content");
    const pluginBContent = path.join(projectRoot, "Plugins", "PluginB", "Content");
    fs.mkdirSync(pluginAContent, { recursive: true });
    fs.mkdirSync(pluginBContent, { recursive: true });

    const bridgeDir = path.join(extensionRoot, "media", "uefn-bridge");
    fs.mkdirSync(bridgeDir, { recursive: true });
    fs.writeFileSync(path.join(bridgeDir, "uefn_bridge.py"), "# shipped bridge");
    fs.writeFileSync(path.join(bridgeDir, "bridge_version.py"), 'BRIDGE_VERSION = "2.1.0"\n');

    process.env.UEFN_VERSE_PROJECT_DIR = verseProjectRoot; // exists, empty -- zero vproject matches

    const { findCalls } = await autoUpdate(
      projectRoot,
      extensionRoot,
      () => {
        throw new Error("must not be called -- target never resolved, rail must return before engine discovery");
      },
      () => {
        throw new Error("must not be called");
      },
      globalStorageDir
    );

    assert.equal(findCalls, 0, "an unresolved/ambiguous target must stop the rail before any staging or engine discovery");
    assert.ok(!fs.existsSync(path.join(pluginAContent, "Python")), "must never guess-write into either candidate");
    assert.ok(!fs.existsSync(path.join(pluginBContent, "Python")), "must never guess-write into either candidate");
  } finally {
    if (savedOverride === undefined) delete process.env.UEFN_VERSE_PROJECT_DIR;
    else process.env.UEFN_VERSE_PROJECT_DIR = savedOverride;
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(verseProjectRoot, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FIX 6: stamp-after-verify ordering (review-gate CRITICAL). `_stageBridgeTo`
// used to copy files in plain directory-listing order, and
// `bridge_version.py` sorts alphabetically ahead of nearly every sibling. On
// the panel-load rail, which can run while UEFN holds a sibling file locked,
// that meant the stamp could land and THEN a later sibling could fail to
// copy -- new stamp + stale files on disk, silently certified as current
// forever after (the next load reads the stamp as current and never
// retries). The fix copies bridge_version.py LAST, and only attempts it if
// every other sibling copied cleanly; a real per-file failure now leaves the
// OLD stamp (or none) in place, so the on-disk state alone drives a retry.
// ---------------------------------------------------------------------------

test("_stageBridgeTo: a locked sibling fails to copy -> bridge_version.py is skipped entirely, the OLD stamp survives, and the failure is reported", () => {
  const bridgeDir = tmpDir("panelBridgeStaleness-order-bridge-");
  const pyDest = tmpDir("panelBridgeStaleness-order-dest-");
  try {
    // "zzz_locked.py" deliberately sorts AFTER "bridge_version.py"
    // alphabetically -- proving this is a real reorder, not an accident of
    // directory-listing order.
    fs.writeFileSync(path.join(bridgeDir, "aaa_ok.py"), "NEW aaa content");
    fs.writeFileSync(path.join(bridgeDir, "bridge_version.py"), 'BRIDGE_VERSION = "2.1.0"\n');
    fs.writeFileSync(path.join(bridgeDir, "zzz_locked.py"), "NEW zzz content");

    fs.mkdirSync(pyDest, { recursive: true });
    fs.writeFileSync(path.join(pyDest, "aaa_ok.py"), "OLD aaa content");
    fs.writeFileSync(path.join(pyDest, "bridge_version.py"), 'BRIDGE_VERSION = "1.0.0"\n');
    fs.writeFileSync(path.join(pyDest, "zzz_locked.py"), "OLD zzz content, different from shipped");
    // Simulate UEFN holding this file locked / a read-only/AV block --
    // copyFileSync throws EPERM overwriting a read-only destination on
    // Windows (confirmed against the real fs, not assumed).
    fs.chmodSync(path.join(pyDest, "zzz_locked.py"), 0o444);

    const result = stageBridgeTo(bridgeDir, pyDest);

    assert.ok(result.error, "a real per-file failure must be reported, never swallowed to a clean-looking result");
    assert.ok(result.error!.includes("zzz_locked.py"), "the error must name the file that actually failed");
    assert.ok(
      result.error!.includes("bridge_version.py"),
      "the error must also record that the stamp was skipped as a consequence"
    );

    assert.equal(
      fs.readFileSync(path.join(pyDest, "bridge_version.py"), "utf8"),
      'BRIDGE_VERSION = "1.0.0"\n',
      "the OLD stamp must survive a partial failure -- never advance while siblings are stale"
    );
    // A sibling that copied fine BEFORE the failure still lands -- one
    // failing file must not roll back unrelated successful progress.
    assert.equal(fs.readFileSync(path.join(pyDest, "aaa_ok.py"), "utf8"), "NEW aaa content");
  } finally {
    chmodIfExists(path.join(pyDest, "zzz_locked.py"), 0o666);
    fs.rmSync(bridgeDir, { recursive: true, force: true });
    fs.rmSync(pyDest, { recursive: true, force: true });
  }
});

test("_stageBridgeTo: once the lock is cleared, the NEXT call completes cleanly and the stamp advances", () => {
  const bridgeDir = tmpDir("panelBridgeStaleness-order-retry-bridge-");
  const pyDest = tmpDir("panelBridgeStaleness-order-retry-dest-");
  try {
    fs.writeFileSync(path.join(bridgeDir, "bridge_version.py"), 'BRIDGE_VERSION = "2.1.0"\n');
    fs.writeFileSync(path.join(bridgeDir, "zzz_locked.py"), "NEW zzz content");

    fs.mkdirSync(pyDest, { recursive: true });
    fs.writeFileSync(path.join(pyDest, "bridge_version.py"), 'BRIDGE_VERSION = "1.0.0"\n');
    fs.writeFileSync(path.join(pyDest, "zzz_locked.py"), "OLD zzz content, different from shipped");
    fs.chmodSync(path.join(pyDest, "zzz_locked.py"), 0o444);

    const firstAttempt = stageBridgeTo(bridgeDir, pyDest);
    assert.ok(firstAttempt.error, "first attempt must fail while the file is locked");
    assert.equal(
      fs.readFileSync(path.join(pyDest, "bridge_version.py"), "utf8"),
      'BRIDGE_VERSION = "1.0.0"\n',
      "still the old stamp after the first, failed attempt"
    );

    // The block is removed (file unlocked) -- the on-disk state (stamp
    // still 1.0.0) is exactly what makes the caller retry on the next
    // panel load; simulate that retry directly.
    fs.chmodSync(path.join(pyDest, "zzz_locked.py"), 0o666);
    const secondAttempt = stageBridgeTo(bridgeDir, pyDest);

    assert.equal(secondAttempt.error, undefined, "the retry must complete cleanly once the block is gone");
    assert.equal(
      fs.readFileSync(path.join(pyDest, "bridge_version.py"), "utf8"),
      'BRIDGE_VERSION = "2.1.0"\n',
      "the stamp must now advance -- every sibling copied successfully this time"
    );
    assert.equal(fs.readFileSync(path.join(pyDest, "zzz_locked.py"), "utf8"), "NEW zzz content");
  } finally {
    chmodIfExists(path.join(pyDest, "zzz_locked.py"), 0o666);
    fs.rmSync(bridgeDir, { recursive: true, force: true });
    fs.rmSync(pyDest, { recursive: true, force: true });
  }
});

test("_autoUpdateUefnBridgeIfStale end-to-end: a locked sibling blocks the stamp this panel load, then a later panel load (block removed) completes and shows the update toast", async () => {
  const root = tmpDir("panelBridgeStaleness-order-e2e-root-");
  const extensionRoot = tmpDir("panelBridgeStaleness-order-e2e-ext-");
  const globalStorageDir = tmpDir("panelBridgeStaleness-order-e2e-storage-");
  try {
    const projectPyDir = path.join(root, "Content", "Python");
    fs.mkdirSync(projectPyDir, { recursive: true });
    fs.writeFileSync(path.join(projectPyDir, "uefn_bridge.py"), "# staged bridge (old)");
    fs.writeFileSync(path.join(projectPyDir, "bridge_version.py"), 'BRIDGE_VERSION = "1.0.0"\n');
    fs.writeFileSync(path.join(projectPyDir, "zzz_locked.py"), "OLD zzz content, different from shipped");
    fs.chmodSync(path.join(projectPyDir, "zzz_locked.py"), 0o444);

    const bridgeDir = path.join(extensionRoot, "media", "uefn-bridge");
    fs.mkdirSync(bridgeDir, { recursive: true });
    fs.writeFileSync(path.join(bridgeDir, "uefn_bridge.py"), "# shipped bridge (new)");
    fs.writeFileSync(path.join(bridgeDir, "bridge_version.py"), 'BRIDGE_VERSION = "2.1.0"\n');
    fs.writeFileSync(path.join(bridgeDir, "zzz_locked.py"), "NEW zzz content");

    const toasts: string[] = [];
    const fakeThis = {
      _extensionUri: { fsPath: extensionRoot },
      _globalStorageUri: { fsPath: globalStorageDir },
      _powerToolsDir: (TycoonPanel.prototype as any)._powerToolsDir,
      ...UEFN_EVIDENCE_METHODS,
      _stageBridgeTo: (TycoonPanel.prototype as any)._stageBridgeTo,
      _healDuplicateUefnBridgeStaging: (TycoonPanel.prototype as any)._healDuplicateUefnBridgeStaging,
      _findFortniteEngineBridgeDir: () => null,
      _refreshEngineBridgeCopy: () => {
        throw new Error("must not be called -- no engine dir in this fixture");
      },
    };
    const run = async (): Promise<void> => {
      toasts.length = 0;
      await (TycoonPanel.prototype as any)._autoUpdateUefnBridgeIfStale.call(fakeThis, root);
    };

    await run();
    assert.equal(
      fs.readFileSync(path.join(projectPyDir, "bridge_version.py"), "utf8"),
      'BRIDGE_VERSION = "1.0.0"\n',
      "first (locked) panel load must NOT advance the stamp"
    );
    // "uefn_bridge.py" sorts alphabetically before "zzz_locked.py", so it
    // copies successfully on this same (still overall-failing) run --
    // partial progress on files that DID succeed is expected and fine; the
    // one thing that must never advance on a partial failure is the stamp
    // itself (asserted above).
    assert.equal(
      fs.readFileSync(path.join(projectPyDir, "uefn_bridge.py"), "utf8"),
      "# shipped bridge (new)",
      "a sibling that copies fine before the failing file is allowed to land"
    );

    // The lock is released (e.g. the user closed UEFN) -- next panel load.
    fs.chmodSync(path.join(projectPyDir, "zzz_locked.py"), 0o666);
    await run();

    assert.equal(
      fs.readFileSync(path.join(projectPyDir, "bridge_version.py"), "utf8"),
      'BRIDGE_VERSION = "2.1.0"\n',
      "the retry must complete once the block is gone -- the stamp finally advances"
    );
    assert.equal(fs.readFileSync(path.join(projectPyDir, "uefn_bridge.py"), "utf8"), "# shipped bridge (new)");
  } finally {
    chmodIfExists(path.join(root, "Content", "Python", "zzz_locked.py"), 0o666);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
  }
});

test("_verifiedUefnBridgeStampValue treats a matching stamp with a missing uefn_bridge.py as stale, not verified", () => {
  const root = tmpDir("panelBridgeStaleness-verify-missing-entry-");
  const extensionRoot = tmpDir("panelBridgeStaleness-verify-missing-entry-ext-");
  const globalStorageDir = tmpDir("panelBridgeStaleness-verify-missing-entry-storage-");
  try {
    const pyDir = path.join(root, "Content", "Python");
    fs.mkdirSync(pyDir, { recursive: true });
    // Stamp matches the shipped version, but the actual bridge entry point
    // never landed (or was removed) -- must not be read as verified.
    fs.writeFileSync(path.join(pyDir, "bridge_version.py"), 'BRIDGE_VERSION = "2.1.0"\n');

    // The shipped/bundled side needs its own uefn_bridge.py marker so
    // resolvePowerToolsDir's bundled rung resolves at all -- otherwise
    // _powerToolsDir() returns null and the method short-circuits to
    // "unresolved:power-tools-not-installed" before ever reaching the
    // missing-entry-point check this test targets.
    const bridgeDir = path.join(extensionRoot, "media", "uefn-bridge");
    writeShippedBridge(bridgeDir, 'BRIDGE_VERSION = "2.1.0"\n');

    const fakeThis = {
      _extensionUri: { fsPath: extensionRoot },
      _globalStorageUri: { fsPath: globalStorageDir },
      _powerToolsDir: (TycoonPanel.prototype as any)._powerToolsDir,
      ...UEFN_EVIDENCE_METHODS,
    };
    const value = (TycoonPanel.prototype as any)._verifiedUefnBridgeStampValue.call(fakeThis, root);

    assert.equal(value, "stale:missing-uefn_bridge.py");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
  }
});
