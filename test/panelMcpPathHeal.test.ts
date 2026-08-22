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
// module loader (same technique as test/panelBridgeStaleness.test.ts) so
// this file's require of panel.js resolves under plain `node --test`, and we
// exercise the REAL production `_autoHealMcpServerPathIfStale` method rather
// than a reimplementation.
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

// Stages a resolvable Power Tools copy under `<globalStorageDir>/powertools`
// -- rung 2 of powerToolsInstall.ts's resolvePowerToolsDir ladder (an
// "installed copy", content-validated by the presence of uefn-server.mjs).
// The resolver no longer looks at `<extensionRoot>/media/uefn-bridge` first
// for this marker; that legacy bundled rung (rung 3) requires uefn_bridge.py,
// not uefn-server.mjs, so staging only media/uefn-bridge as this file
// previously did no longer resolves to anything.
function stageCurrentServer(globalStorageDir: string): void {
  const dir = path.join(globalStorageDir, "powertools");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "uefn-server.mjs"), "// current shipped server\n");
}

function currentServerPathForward(globalStorageDir: string): string {
  return path.join(globalStorageDir, "powertools", "uefn-server.mjs").replace(/\\/g, "/");
}

/** `_autoHealMcpServerPathIfStale` reads `this._extensionUri.fsPath` and `this._globalStorageUri.fsPath`. */
function heal(root: string, extensionRoot: string, globalStorageDir: string): void {
  const fakeThis = { _extensionUri: { fsPath: extensionRoot }, _globalStorageUri: { fsPath: globalStorageDir } };
  (TycoonPanel.prototype as any)._autoHealMcpServerPathIfStale.call(fakeThis, root);
}

function writeMcpJson(root: string, config: unknown): void {
  fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify(config, null, 2));
}

function readMcpJson(root: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
}

// ---------------------------------------------------------------------------

test("_autoHealMcpServerPathIfStale rewrites a stale path whose target file no longer exists", () => {
  const root = tmpDir("panelMcpPathHeal-missing-root-");
  const extensionRoot = tmpDir("panelMcpPathHeal-missing-ext-");
  const globalStorageDir = tmpDir("panelMcpPathHeal-missing-storage-");
  try {
    stageCurrentServer(globalStorageDir);
    writeMcpJson(root, {
      mcpServers: {
        "uefn-bridge": {
          command: "node",
          args: ["c:/Users/someone/.vscode/extensions/tycoonagents.tycoonagents-0.0.424/media/uefn-bridge/uefn-server.mjs"],
        },
      },
    });

    heal(root, extensionRoot, globalStorageDir);

    const updated = readMcpJson(root);
    assert.equal(updated.mcpServers["uefn-bridge"].args[0], currentServerPathForward(globalStorageDir));
    assert.equal(updated.mcpServers["uefn-bridge"].command, "node");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
  }
});

test("_autoHealMcpServerPathIfStale rewrites a path inside an OLDER tycoonagents extension dir even when that file still exists", () => {
  const root = tmpDir("panelMcpPathHeal-older-root-");
  const extensionRoot = tmpDir("panelMcpPathHeal-older-ext-");
  const globalStorageDir = tmpDir("panelMcpPathHeal-older-storage-");
  const oldExtParent = tmpDir("panelMcpPathHeal-older-oldparent-");
  try {
    stageCurrentServer(globalStorageDir);
    const oldExtDir = path.join(oldExtParent, "tycoonagents.tycoonagents-0.0.424");
    const oldServerDir = path.join(oldExtDir, "media", "uefn-bridge");
    fs.mkdirSync(oldServerDir, { recursive: true });
    const oldServerPath = path.join(oldServerDir, "uefn-server.mjs");
    fs.writeFileSync(oldServerPath, "// stale old server, still present on disk\n");

    writeMcpJson(root, {
      mcpServers: {
        "uefn-bridge": { command: "node", args: [oldServerPath.replace(/\\/g, "/")] },
      },
    });

    heal(root, extensionRoot, globalStorageDir);

    const updated = readMcpJson(root);
    assert.equal(updated.mcpServers["uefn-bridge"].args[0], currentServerPathForward(globalStorageDir));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
    fs.rmSync(oldExtParent, { recursive: true, force: true });
  }
});

test("_autoHealMcpServerPathIfStale leaves a path outside any tycoonagents dir unchanged when the file exists", () => {
  const root = tmpDir("panelMcpPathHeal-custom-root-");
  const extensionRoot = tmpDir("panelMcpPathHeal-custom-ext-");
  const globalStorageDir = tmpDir("panelMcpPathHeal-custom-storage-");
  const customDir = tmpDir("panelMcpPathHeal-custom-build-");
  try {
    stageCurrentServer(globalStorageDir);
    const customServerPath = path.join(customDir, "uefn-server.mjs");
    fs.writeFileSync(customServerPath, "// deliberate custom build\n");
    const original = {
      mcpServers: {
        "uefn-bridge": { command: "node", args: [customServerPath.replace(/\\/g, "/")] },
      },
    };
    writeMcpJson(root, original);
    const rawBefore = fs.readFileSync(path.join(root, ".mcp.json"), "utf8");

    heal(root, extensionRoot, globalStorageDir);

    const rawAfter = fs.readFileSync(path.join(root, ".mcp.json"), "utf8");
    assert.equal(rawAfter, rawBefore, "file must be left byte-for-byte unchanged");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
    fs.rmSync(customDir, { recursive: true, force: true });
  }
});

test("_autoHealMcpServerPathIfStale does not create .mcp.json when none exists", () => {
  const root = tmpDir("panelMcpPathHeal-nofile-root-");
  const extensionRoot = tmpDir("panelMcpPathHeal-nofile-ext-");
  const globalStorageDir = tmpDir("panelMcpPathHeal-nofile-storage-");
  try {
    stageCurrentServer(globalStorageDir);
    assert.doesNotThrow(() => heal(root, extensionRoot, globalStorageDir));
    assert.equal(fs.existsSync(path.join(root, ".mcp.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
  }
});

test("_autoHealMcpServerPathIfStale leaves an unparseable .mcp.json untouched and does not throw", () => {
  const root = tmpDir("panelMcpPathHeal-badjson-root-");
  const extensionRoot = tmpDir("panelMcpPathHeal-badjson-ext-");
  const globalStorageDir = tmpDir("panelMcpPathHeal-badjson-storage-");
  try {
    stageCurrentServer(globalStorageDir);
    const mcpPath = path.join(root, ".mcp.json");
    fs.writeFileSync(mcpPath, "{ this is not valid json ,,, ");
    const rawBefore = fs.readFileSync(mcpPath, "utf8");

    assert.doesNotThrow(() => heal(root, extensionRoot, globalStorageDir));

    const rawAfter = fs.readFileSync(mcpPath, "utf8");
    assert.equal(rawAfter, rawBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
  }
});

test("_autoHealMcpServerPathIfStale preserves other mcpServers entries verbatim", () => {
  const root = tmpDir("panelMcpPathHeal-preserve-root-");
  const extensionRoot = tmpDir("panelMcpPathHeal-preserve-ext-");
  const globalStorageDir = tmpDir("panelMcpPathHeal-preserve-storage-");
  try {
    stageCurrentServer(globalStorageDir);
    const otherEntry = { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] };
    writeMcpJson(root, {
      mcpServers: {
        filesystem: otherEntry,
        "uefn-bridge": {
          command: "node",
          args: ["c:/Users/someone/.vscode/extensions/tycoonagents.tycoonagents-0.0.424/media/uefn-bridge/uefn-server.mjs"],
        },
      },
    });

    heal(root, extensionRoot, globalStorageDir);

    const updated = readMcpJson(root);
    assert.deepEqual(updated.mcpServers.filesystem, otherEntry);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
  }
});

test("_autoHealMcpServerPathIfStale drops env.UEFN_BRIDGE_DIR on a rewritten entry, keeping other env keys, and removes an emptied env block", () => {
  const root = tmpDir("panelMcpPathHeal-env-root-");
  const extensionRoot = tmpDir("panelMcpPathHeal-env-ext-");
  const globalStorageDir = tmpDir("panelMcpPathHeal-env-storage-");
  try {
    stageCurrentServer(globalStorageDir);
    writeMcpJson(root, {
      mcpServers: {
        "uefn-bridge": {
          command: "node",
          args: ["c:/stale/tycoonagents.tycoonagents-0.0.424/media/uefn-bridge/uefn-server.mjs"],
          env: { UEFN_BRIDGE_DIR: "C:\\custom\\bridge\\dir", KEEP_ME: "1" },
        },
        // A second recognized key (legacy "uefn") whose env becomes fully
        // empty once UEFN_BRIDGE_DIR is the only key -- the whole env block
        // must be dropped, not left as `{}`.
        uefn: {
          command: "node",
          args: ["c:/stale2/tycoonagents.tycoonagents-0.0.423/media/uefn-bridge/uefn-server.mjs"],
          env: { UEFN_BRIDGE_DIR: "C:\\custom\\bridge\\dir" },
        },
      },
    });

    heal(root, extensionRoot, globalStorageDir);

    const updated = readMcpJson(root);
    assert.deepEqual(updated.mcpServers["uefn-bridge"].env, { KEEP_ME: "1" });
    assert.equal(Object.prototype.hasOwnProperty.call(updated.mcpServers.uefn, "env"), false);
    assert.equal(updated.mcpServers["uefn-bridge"].args[0], currentServerPathForward(globalStorageDir));
    assert.equal(updated.mcpServers.uefn.args[0], currentServerPathForward(globalStorageDir));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
  }
});

test("_autoHealMcpServerPathIfStale is a no-op when the recognized entries have no uefn-server.mjs/js arg", () => {
  const root = tmpDir("panelMcpPathHeal-noarg-root-");
  const extensionRoot = tmpDir("panelMcpPathHeal-noarg-ext-");
  const globalStorageDir = tmpDir("panelMcpPathHeal-noarg-storage-");
  try {
    stageCurrentServer(globalStorageDir);
    const original = {
      mcpServers: {
        "uefn-bridge": { type: "http", url: "http://127.0.0.1:9999/mcp" },
      },
    };
    writeMcpJson(root, original);
    const rawBefore = fs.readFileSync(path.join(root, ".mcp.json"), "utf8");

    heal(root, extensionRoot, globalStorageDir);

    const rawAfter = fs.readFileSync(path.join(root, ".mcp.json"), "utf8");
    assert.equal(rawAfter, rawBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
  }
});

test("_autoHealMcpServerPathIfStale never writes when the current shipped server file itself is missing", () => {
  const root = tmpDir("panelMcpPathHeal-noshipped-root-");
  const extensionRoot = tmpDir("panelMcpPathHeal-noshipped-ext-");
  const globalStorageDir = tmpDir("panelMcpPathHeal-noshipped-storage-");
  try {
    // Deliberately do NOT stage anything -- Power Tools is unresolvable on
    // every rung (no installed copy under global storage, no legacy bundled
    // copy under the extension dir), so resolvePowerToolsDir returns null
    // and the existing stale entry must be left untouched.
    const original = {
      mcpServers: {
        "uefn-bridge": { command: "node", args: ["c:/definitely/missing/uefn-server.mjs"] },
      },
    };
    writeMcpJson(root, original);
    const rawBefore = fs.readFileSync(path.join(root, ".mcp.json"), "utf8");

    assert.doesNotThrow(() => heal(root, extensionRoot, globalStorageDir));

    const rawAfter = fs.readFileSync(path.join(root, ".mcp.json"), "utf8");
    assert.equal(rawAfter, rawBefore, "must not write a rewritten path onto a file that isn't actually shipped");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(globalStorageDir, { recursive: true, force: true });
  }
});
