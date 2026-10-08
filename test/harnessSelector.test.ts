/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for the p13-t7 "Which tool runs your agents?" Settings dropdown:
// panel.ts's `_buildHarnessSettings`/`_handleSetHarness`. Same require-time
// vscode stub technique as test/panelSetAgentModelCache.test.ts so this
// exercises the REAL production methods, not a reimplementation.
//
// `_buildHarnessSettings` derives `mismatch`/`requiresRestart` fresh, every
// call, from `this._getRunningProviderId()` vs. the freshly-resolved
// `effective` value — never from a one-shot flag set only inside
// `_handleSetHarness` (audit fix: a hand-edited execution.json must show
// "Restart to apply" even with no setHarness round-trip in this window).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require("module");
const originalLoad = NodeModule._load;
let configuredProviderSetting: string | undefined;
function makeVscodeStub(): unknown {
  return {
    __esModule: true,
    workspace: {
      getConfiguration: () => ({
        // Real VS Code's `.get()` always returns the package.json default
        // ("claude-code") once the setting is declared, even when the user
        // never touched it — that's what caused the original bug. `.inspect()`
        // is the only way to tell "explicitly set" from "still default", so
        // it reports `globalValue` only when a test has actually set one.
        get: (key: string) => (key === "provider" ? (configuredProviderSetting ?? "claude-code") : undefined),
        inspect: (key: string) =>
          key === "provider"
            ? { key: "tycoonagents.provider", defaultValue: "claude-code", globalValue: configuredProviderSetting }
            : undefined,
      }),
    },
  };
}
const vscodeStub = makeVscodeStub();
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "vscode") return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TycoonPanel } = require("../src/host/vscode/panel") as typeof import("../src/host/vscode/panel");

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "harnessSelector-"));
}

function readExecutionJson(root: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(root, ".claude", "tycoon", "execution.json"), "utf8"));
}

// `_buildHarnessSettings` dereferences `this._getRunningProviderId`;
// `_handleSetHarness` additionally uses `this._projectRoot`,
// `this._providerSwap`, and `this._handleGetSettings`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakePanel(root: string, extra: Record<string, unknown> = {}): any {
  return {
    _projectRoot: () => root,
    _providerSwap: undefined,
    _getRunningProviderId: undefined,
    _handleGetSettings: () => {},
    // p23-t11: real detection/handler methods live on the prototype and are
    // not reimplemented here — bind them so `this` inside resolves to the
    // fake object like every other method on it.
    _detectCodexHooksInstalled: (TycoonPanel.prototype as any)._detectCodexHooksInstalled,
    _detectCodexDispatcherInstalled: (TycoonPanel.prototype as any)._detectCodexDispatcherInstalled,
    _codexHookScriptPath: (TycoonPanel.prototype as any)._codexHookScriptPath,
    _codexDispatcherScriptPath: (TycoonPanel.prototype as any)._codexDispatcherScriptPath,
    // codex-doctrine-gap follow-up: _handleInstallCodexHooks/_handleSetHarness
    // call this on `this` too — bind it like the others above.
    _runCodexConfigGenerator: (TycoonPanel.prototype as any)._runCodexConfigGenerator,
    _detectCodexNotifyState: (TycoonPanel.prototype as any)._detectCodexNotifyState,
    _codexNotifyStateWarning: (TycoonPanel.prototype as any)._codexNotifyStateWarning,
    _codexHooksWarningField: (TycoonPanel.prototype as any)._codexHooksWarningField,
    ...extra,
  };
}

test("_buildHarnessSettings: defaults to claude-code, source default, no mismatch/restart before any provider has started", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  const fake = makeFakePanel(root);
  const result = (TycoonPanel.prototype as any)._buildHarnessSettings.call(fake, root);
  assert.deepEqual(result.options, [
    { id: "claude-code", label: "Claude Code" },
    { id: "opencode", label: "OpenCode (Experimental)" },
    { id: "codex", label: "Codex (Experimental)" },
  ]);
  assert.equal(result.effective, "claude-code");
  assert.equal(result.source, "default");
  assert.equal(result.running, undefined, "no _getRunningProviderId wired -> running is undefined");
  assert.equal(result.mismatch, false, "undefined running must not count as a mismatch");
  assert.equal(result.requiresRestart, false);
});

test("_buildHarnessSettings: reflects the VS Code setting as source 'setting'", () => {
  configuredProviderSetting = "opencode";
  const root = tmpRoot();
  const fake = makeFakePanel(root, { _getRunningProviderId: () => "opencode" });
  const result = (TycoonPanel.prototype as any)._buildHarnessSettings.call(fake, root);
  assert.equal(result.effective, "opencode");
  assert.equal(result.source, "setting");
  assert.equal(result.mismatch, false);
  configuredProviderSetting = undefined;
});

test("_buildHarnessSettings: setting left at its package.json default (never explicitly set) is not source 'setting' and doesn't mask execution.json (audit fix: inspect() vs get())", () => {
  configuredProviderSetting = undefined; // inspect() reports no globalValue -> only defaultValue exists
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, ".claude", "tycoon"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "tycoon", "execution.json"), JSON.stringify({ provider: "opencode" }));
  const fake = makeFakePanel(root);
  const result = (TycoonPanel.prototype as any)._buildHarnessSettings.call(fake, root);
  assert.notEqual(result.source, "setting");
  assert.equal(result.source, "execution");
  assert.equal(result.effective, "opencode");
});

test("_buildHarnessSettings: setting explicitly set overrides execution.json as source 'setting'", () => {
  configuredProviderSetting = "opencode"; // simulates inspect().globalValue actually set by the user
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, ".claude", "tycoon"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "tycoon", "execution.json"), JSON.stringify({ provider: "claude-code" }));
  const fake = makeFakePanel(root);
  const result = (TycoonPanel.prototype as any)._buildHarnessSettings.call(fake, root);
  assert.equal(result.source, "setting");
  assert.equal(result.effective, "opencode");
  configuredProviderSetting = undefined;
});

test("_buildHarnessSettings: reports mismatch/requiresRestart whenever running differs from effective, with no setHarness call involved", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, ".claude", "tycoon"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "tycoon", "execution.json"), JSON.stringify({ provider: "opencode" }), "utf8");
  // Simulates a hand-edited execution.json (or another window's write) that
  // a running window hasn't picked up: `running` still reports the OLD id.
  const fake = makeFakePanel(root, { _getRunningProviderId: () => "claude-code" });
  const result = (TycoonPanel.prototype as any)._buildHarnessSettings.call(fake, root);
  assert.equal(result.effective, "opencode");
  assert.equal(result.running, "claude-code");
  assert.equal(result.mismatch, true);
  assert.equal(result.requiresRestart, true);
});

test("_handleSetHarness: writes execution.json and calls _handleGetSettings; with no swap hook wired, a later _buildHarnessSettings call reports mismatch", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  let settingsCalls = 0;
  const fake = makeFakePanel(root, {
    _handleGetSettings: () => { settingsCalls++; },
    _getRunningProviderId: () => "claude-code", // never updated: no swap hook wired
  });

  (TycoonPanel.prototype as any)._handleSetHarness.call(fake, "opencode");

  assert.deepEqual(readExecutionJson(root), { provider: "opencode" });
  assert.equal(settingsCalls, 1);
  const settings = (TycoonPanel.prototype as any)._buildHarnessSettings.call(fake, root);
  assert.equal(settings.mismatch, true, "running (claude-code) still differs from the newly-written effective (opencode)");
});

test("_handleSetHarness: a successful live swap updates the running id, so a later build reports no mismatch", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  let runningId = "claude-code";
  let swapCalledWith: string | undefined;
  const fake = makeFakePanel(root, {
    _providerSwap: (id: string) => {
      swapCalledWith = id;
      runningId = id; // mirrors extension.ts's currentProviderId update on success
      return true;
    },
    _getRunningProviderId: () => runningId,
  });

  (TycoonPanel.prototype as any)._handleSetHarness.call(fake, "opencode");

  assert.equal(swapCalledWith, "opencode");
  assert.deepEqual(readExecutionJson(root), { provider: "opencode" });
  const settings = (TycoonPanel.prototype as any)._buildHarnessSettings.call(fake, root);
  assert.equal(settings.running, "opencode");
  assert.equal(settings.mismatch, false);
  assert.equal(settings.requiresRestart, false);
});

test("_handleSetHarness: a failed live swap (returns false, running id unchanged) still writes the file but a later build reports mismatch", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  const fake = makeFakePanel(root, {
    _providerSwap: () => false, // mirrors extension.ts leaving the old provider running on failure
    _getRunningProviderId: () => "claude-code",
  });

  (TycoonPanel.prototype as any)._handleSetHarness.call(fake, "opencode");

  assert.deepEqual(readExecutionJson(root), { provider: "opencode" });
  const settings = (TycoonPanel.prototype as any)._buildHarnessSettings.call(fake, root);
  assert.equal(settings.running, "claude-code", "a failed swap must leave the previously-running id unchanged");
  assert.equal(settings.mismatch, true);
  assert.equal(settings.requiresRestart, true);
});

test("_handleSetHarness: rejects an unknown provider id without writing or calling _handleGetSettings", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  let settingsCalls = 0;
  const fake = makeFakePanel(root, { _handleGetSettings: () => { settingsCalls++; } });

  (TycoonPanel.prototype as any)._handleSetHarness.call(fake, "bogus-provider");

  assert.equal(settingsCalls, 0);
  assert.throws(() => readExecutionJson(root));
});

test("_buildHarnessSettings: an unknown provider id in execution.json (e.g. a future build's id this build doesn't know) falls back to claude-code with a warning instead of throwing", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, ".claude", "tycoon"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "tycoon", "execution.json"), JSON.stringify({ provider: "future-provider" }));
  const fake = makeFakePanel(root);
  const result = (TycoonPanel.prototype as any)._buildHarnessSettings.call(fake, root);
  assert.equal(result.effective, "claude-code");
  assert.equal(result.source, "default");
  assert.equal(typeof result.warning, "string");
  assert.match(result.warning, /future-provider/i);
});

// ---------------------------------------------------------------------
// p23-t11: Codex hooks/dispatcher install-state (harness.codexHooksInstalled
// / codexDispatcherInstalled) and the INSTALL/UNINSTALL_CODEX_* handlers.
// Real filesystem, temp CODEX_HOME + temp project dir.
// ---------------------------------------------------------------------

function withCodexProvider(root: string): void {
  fs.mkdirSync(path.join(root, ".claude", "tycoon"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "tycoon", "execution.json"), JSON.stringify({ provider: "codex" }));
}

function tmpCodexHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codexHome-"));
}

const codexHookScriptPath = path.join(os.tmpdir(), "tycoon-codex-hook.cjs");
const codexDispatcherScriptPath = path.join(os.tmpdir(), "tycoon-dispatcher-mcp.cjs");

test("_buildHarnessSettings: omits codexHooksInstalled/codexDispatcherInstalled when the effective provider isn't codex", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  const fake = makeFakePanel(root);
  const result = (TycoonPanel.prototype as any)._buildHarnessSettings.call(fake, root);
  assert.equal(result.effective, "claude-code");
  assert.equal(result.codexHooksInstalled, undefined);
  assert.equal(result.codexDispatcherInstalled, undefined);
});

test("_buildHarnessSettings + INSTALL/UNINSTALL_CODEX_HOOKS: install sets the marker and flips codexHooksInstalled true; uninstall restores byte-identical and flips it back", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  withCodexProvider(root);
  const codexHome = tmpCodexHome();
  const savedCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const fake = makeFakePanel(root, {
      _extensionUri: { fsPath: os.tmpdir() },
      _codexHookScriptPath: () => codexHookScriptPath,
    });

    let result = (TycoonPanel.prototype as any)._buildHarnessSettings.call(fake, root);
    assert.equal(result.codexHooksInstalled, false);

    (TycoonPanel.prototype as any)._handleInstallCodexHooks.call(fake);
    const configTomlPath = path.join(codexHome, "config.toml");
    const afterInstall = fs.readFileSync(configTomlPath, "utf8");
    assert.match(afterInstall, /tycoon-codex-hook: managed notify entry/);

    result = (TycoonPanel.prototype as any)._buildHarnessSettings.call(fake, root);
    assert.equal(result.codexHooksInstalled, true);

    (TycoonPanel.prototype as any)._handleUninstallCodexHooks.call(fake);
    const afterUninstall = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, "utf8") : "";
    assert.doesNotMatch(afterUninstall, /tycoon-codex-hook: managed notify entry/);
    assert.equal(fs.existsSync(path.join(root, ".codex", "hooks.json")), false, "our own hooks.json (no foreign content) is removed on uninstall");

    result = (TycoonPanel.prototype as any)._buildHarnessSettings.call(fake, root);
    assert.equal(result.codexHooksInstalled, false);
  } finally {
    process.env.CODEX_HOME = savedCodexHome;
  }
});

test("_buildHarnessSettings + INSTALL/UNINSTALL_CODEX_DISPATCHER: install sets the dispatcher marker and flips codexDispatcherInstalled true; uninstall clears it", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  withCodexProvider(root);
  const codexHome = tmpCodexHome();
  const savedCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const fake = makeFakePanel(root, {
      _extensionUri: { fsPath: os.tmpdir() },
      _codexDispatcherScriptPath: () => codexDispatcherScriptPath,
    });

    let result = (TycoonPanel.prototype as any)._buildHarnessSettings.call(fake, root);
    assert.equal(result.codexDispatcherInstalled, false);

    (TycoonPanel.prototype as any)._handleInstallCodexDispatcher.call(fake);
    result = (TycoonPanel.prototype as any)._buildHarnessSettings.call(fake, root);
    assert.equal(result.codexDispatcherInstalled, true);

    (TycoonPanel.prototype as any)._handleUninstallCodexDispatcher.call(fake);
    result = (TycoonPanel.prototype as any)._buildHarnessSettings.call(fake, root);
    assert.equal(result.codexDispatcherInstalled, false);
  } finally {
    process.env.CODEX_HOME = savedCodexHome;
  }
});
