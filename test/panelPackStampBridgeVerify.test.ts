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
// exercise the REAL production `_ensureInstalledPacksFresh` /
// `_verifiedUefnBridgeStampValue` methods rather than reimplementations.
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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildAgentMarkdown } = require("../src/host/vscode/packCatalog") as typeof import("../src/host/vscode/packCatalog");

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const BUNDLED_VERSION = "0.0.490";

const UEFN_AGENT = {
  id: "uefn-auditor",
  name: "UEFN Auditor",
  model: "sonnet",
  role: "Reviews UEFN/Verse changes for correctness.",
  keywords: "verse|uefn|audit",
};

/**
 * Writes the fixture "extension install" this test's `_ensureInstalledPacksFresh`
 * call reads from: `package.json` (extension version), `media/packs/catalog.json`
 * (a single "uefn" pack whose marker agent is UEFN_AGENT, `mcp: "uefn-bridge"`
 * -- the exact predicate `_handleInstallPack`/`_ensureInstalledPacksFresh` use
 * to identify a pack that also provides the Python bridge), and
 * `media/uefn-bridge/bridge_version.py` (the shipped bridge stamp
 * `_verifiedUefnBridgeStampValue` compares against).
 */
function writeExtensionFixture(extensionRoot: string): void {
  fs.writeFileSync(path.join(extensionRoot, "package.json"), JSON.stringify({ version: BUNDLED_VERSION }));
  const packsDir = path.join(extensionRoot, "media", "packs");
  fs.mkdirSync(packsDir, { recursive: true });
  fs.writeFileSync(
    path.join(packsDir, "catalog.json"),
    JSON.stringify([{ id: "uefn", mcp: "uefn-bridge", agents: [UEFN_AGENT] }])
  );
  const bridgeDir = path.join(extensionRoot, "media", "uefn-bridge");
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, "bridge_version.py"), `BRIDGE_VERSION = "${BUNDLED_VERSION}"\n`);
}

/**
 * Writes the fixture "project" this test's `_ensureInstalledPacksFresh` call
 * reads from: the marker agent file (EXACTLY what `buildAgentMarkdown` would
 * generate, so the pack is recognized as "already installed" AND its
 * skill/agent restage is a no-op content-match -- isolating the assertions to
 * the bridge-verification behavior under test, not agent-file diffing).
 */
function writeProjectFixture(root: string): void {
  const agentPath = path.join(root, ".claude", "agents", `${UEFN_AGENT.id}.md`);
  fs.mkdirSync(path.dirname(agentPath), { recursive: true });
  fs.writeFileSync(agentPath, buildAgentMarkdown(UEFN_AGENT, "uefn"));
}

function ensurePacksFresh(root: string, extensionRoot: string): void {
  const fakeThis = {
    _extensionUri: { fsPath: extensionRoot },
    _projectRoot: () => root,
    _hooksInstalledForRoot: () => true,
    _currentExtensionVersion: (TycoonPanel.prototype as any)._currentExtensionVersion,
    _resolveUefnContentDirEvidence: (TycoonPanel.prototype as any)._resolveUefnContentDirEvidence,
    _findMatchingVprojectContentDirs: (TycoonPanel.prototype as any)._findMatchingVprojectContentDirs,
    _plausibleContentDirCandidates: (TycoonPanel.prototype as any)._plausibleContentDirCandidates,
    _confirmedContentDirItself: (TycoonPanel.prototype as any)._confirmedContentDirItself,
    _canonPath: (TycoonPanel.prototype as any)._canonPath,
    _verifiedUefnBridgeStampValue: (TycoonPanel.prototype as any)._verifiedUefnBridgeStampValue,
  };
  (TycoonPanel.prototype as any)._ensureInstalledPacksFresh.call(fakeThis);
}

function readStamp(root: string): { version?: string; packs?: Record<string, string> } {
  return JSON.parse(fs.readFileSync(path.join(root, ".claude", "tycoon", "pack-staging.json"), "utf8"));
}

// ---------------------------------------------------------------------------
// The stamp-must-not-lie fix: `packs.uefn = currentVersion` only ever claims
// the SKILL/AGENT restage succeeded -- the Python bridge itself is staged by
// an entirely separate rail (`_autoUpdateUefnBridgeIfStale`), so its real
// on-disk state must be independently re-verified and recorded under its own
// key, never inferred from the pack's own success.
// ---------------------------------------------------------------------------

test("_ensureInstalledPacksFresh records the bridge as stale:missing when the pack restages fine but the real bridge_version.py never landed", () => {
  const projectTmp = tmpDir("panelPackStampBridge-missing-proj-");
  const extensionRoot = tmpDir("panelPackStampBridge-missing-ext-");
  const verseProjectRoot = tmpDir("panelPackStampBridge-missing-vproj-");
  const savedOverride = process.env.UEFN_VERSE_PROJECT_DIR;
  try {
    // Workspace opened directly at a confirmed content dir (a real .verse
    // file present) -- resolves via rung 2 without needing vproject
    // evidence. No UEFN_VERSE_PROJECT_DIR override -> point it at an empty
    // tmp dir so rung 1 never depends on this machine's real UEFN state.
    process.env.UEFN_VERSE_PROJECT_DIR = verseProjectRoot;
    const root = path.join(projectTmp, "Content");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "MyDevice.verse"), "using { /Verse.org/Simulation }\n");
    // Deliberately NOT writing Content/Python/bridge_version.py anywhere --
    // this is the field bug: the bridge never actually landed.

    writeExtensionFixture(extensionRoot);
    writeProjectFixture(root);

    ensurePacksFresh(root, extensionRoot);

    const stamp = readStamp(root);
    assert.equal(stamp.version, BUNDLED_VERSION);
    assert.equal(stamp.packs?.uefn, BUNDLED_VERSION, "pack content (skills/agents) restage genuinely succeeded");
    assert.equal(
      stamp.packs?.["uefn-bridge"],
      "stale:missing",
      "the bridge's own verified state must show it never landed, not silently inherit the pack's success"
    );
    assert.notEqual(
      stamp.packs?.["uefn-bridge"],
      BUNDLED_VERSION,
      "must never claim the bridge is current without verifying the real file on disk"
    );
  } finally {
    if (savedOverride === undefined) delete process.env.UEFN_VERSE_PROJECT_DIR;
    else process.env.UEFN_VERSE_PROJECT_DIR = savedOverride;
    fs.rmSync(projectTmp, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(verseProjectRoot, { recursive: true, force: true });
  }
});

test("_ensureInstalledPacksFresh records the bridge's real verified version when its bridge_version.py matches the shipped stamp exactly", () => {
  const projectTmp = tmpDir("panelPackStampBridge-current-proj-");
  const extensionRoot = tmpDir("panelPackStampBridge-current-ext-");
  const verseProjectRoot = tmpDir("panelPackStampBridge-current-vproj-");
  const savedOverride = process.env.UEFN_VERSE_PROJECT_DIR;
  try {
    process.env.UEFN_VERSE_PROJECT_DIR = verseProjectRoot;
    const root = path.join(projectTmp, "Content");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "MyDevice.verse"), "using { /Verse.org/Simulation }\n");

    // The bridge DID land -- both the entry point AND a matching stamp --
    // `_verifiedUefnBridgeStampValue`'s spot-check requires the entry point
    // to actually be present, not just a matching stamp.
    fs.mkdirSync(path.join(root, "Python"), { recursive: true });
    fs.writeFileSync(path.join(root, "Python", "uefn_bridge.py"), "# staged bridge entry point");
    fs.writeFileSync(path.join(root, "Python", "bridge_version.py"), `BRIDGE_VERSION = "${BUNDLED_VERSION}"\n`);

    writeExtensionFixture(extensionRoot);
    writeProjectFixture(root);

    ensurePacksFresh(root, extensionRoot);

    const stamp = readStamp(root);
    assert.equal(stamp.packs?.uefn, BUNDLED_VERSION);
    assert.equal(
      stamp.packs?.["uefn-bridge"],
      BUNDLED_VERSION,
      "a genuinely verified, matching on-disk bridge stamp must be recorded as the real version"
    );
  } finally {
    if (savedOverride === undefined) delete process.env.UEFN_VERSE_PROJECT_DIR;
    else process.env.UEFN_VERSE_PROJECT_DIR = savedOverride;
    fs.rmSync(projectTmp, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(verseProjectRoot, { recursive: true, force: true });
  }
});

test("_ensureInstalledPacksFresh records the bridge as stale:<old-version> when a real but OUTDATED bridge_version.py is on disk", () => {
  const projectTmp = tmpDir("panelPackStampBridge-outdated-proj-");
  const extensionRoot = tmpDir("panelPackStampBridge-outdated-ext-");
  const verseProjectRoot = tmpDir("panelPackStampBridge-outdated-vproj-");
  const savedOverride = process.env.UEFN_VERSE_PROJECT_DIR;
  try {
    process.env.UEFN_VERSE_PROJECT_DIR = verseProjectRoot;
    const root = path.join(projectTmp, "Content");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "MyDevice.verse"), "using { /Verse.org/Simulation }\n");

    fs.mkdirSync(path.join(root, "Python"), { recursive: true });
    fs.writeFileSync(path.join(root, "Python", "bridge_version.py"), 'BRIDGE_VERSION = "0.0.400"\n');

    writeExtensionFixture(extensionRoot);
    writeProjectFixture(root);

    ensurePacksFresh(root, extensionRoot);

    const stamp = readStamp(root);
    assert.equal(stamp.packs?.uefn, BUNDLED_VERSION);
    assert.equal(stamp.packs?.["uefn-bridge"], "stale:0.0.400");
  } finally {
    if (savedOverride === undefined) delete process.env.UEFN_VERSE_PROJECT_DIR;
    else process.env.UEFN_VERSE_PROJECT_DIR = savedOverride;
    fs.rmSync(projectTmp, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(verseProjectRoot, { recursive: true, force: true });
  }
});
