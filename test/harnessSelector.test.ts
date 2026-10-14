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
const infoMessages: string[] = [];
function makeVscodeStub(): unknown {
  return {
    __esModule: true,
    extensions: { getExtension: () => undefined },
    window: { showInformationMessage: (m: string) => { infoMessages.push(m); return Promise.resolve(undefined); } },
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
const { setOpencodeAvailableForTests, OPENCODE_COMING_SOON_NOTICE } = require("../src/core/providerSelection") as typeof import("../src/core/providerSelection");

// Cases below exercise OpenCode being selectable (gate flipped on); the
// "launch gate" cases at the end restore the shipped gate in-test.
setOpencodeAvailableForTests(true);

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
    _handleGetRouting: () => {},
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
    _codexDispatcherState: (TycoonPanel.prototype as any)._codexDispatcherState,
    _codexDispatcherWarningField: (TycoonPanel.prototype as any)._codexDispatcherWarningField,
    _codexSandboxWarningField: (TycoonPanel.prototype as any)._codexSandboxWarningField,
    _ensureCodexInstallsCurrent: (TycoonPanel.prototype as any)._ensureCodexInstallsCurrent,
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
    { id: "codex", label: "Codex (Experimental)" },
    { id: "opencode", label: "OpenCode (Experimental)" },
  ]);
  assert.equal(result.opencodeAvailable, true);
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
    // The dispatcher stale check treats a missing script as out of date.
    fs.writeFileSync(codexDispatcherScriptPath, "// fake dispatcher\n");
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

// ---------------------------------------------------------------------
// Auto-repoint after an extension update (_ensureCodexInstallsCurrent) and the
// dispatcher stale check / sandbox warning in the harness settings slice.
// ---------------------------------------------------------------------

function versionDir(base: string, version: string): { hook: string; dispatcher: string } {
  const dir = path.join(base, "extensions", `tycoonagents.tycoonagents-${version}`, "hooks");
  fs.mkdirSync(dir, { recursive: true });
  const hook = path.join(dir, "tycoon-codex-hook.cjs");
  const dispatcher = path.join(dir, "tycoon-dispatcher-mcp.cjs");
  fs.writeFileSync(hook, "// hook\n");
  fs.writeFileSync(dispatcher, "// dispatcher\n");
  return { hook, dispatcher };
}

function withCodexHome<T>(fn: (codexHome: string) => T): T {
  const codexHome = tmpCodexHome();
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    return fn(codexHome);
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  }
}

test("_ensureCodexInstallsCurrent: stale hook and dispatcher paths from an old extension version are rewritten to the current version", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  withCodexProvider(root);
  withCodexHome((codexHome) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "extBase-"));
    const oldV = versionDir(base, "0.0.709");
    const newV = versionDir(base, "0.0.710");
    const oldFake = makeFakePanel(root, {
      _codexHookScriptPath: () => oldV.hook,
      _codexDispatcherScriptPath: () => oldV.dispatcher,
      _extensionUri: { fsPath: base },
    });
    (TycoonPanel.prototype as any)._handleInstallCodexHooks.call(oldFake);
    (TycoonPanel.prototype as any)._handleInstallCodexDispatcher.call(oldFake);
    fs.rmSync(path.join(base, "extensions", "tycoonagents.tycoonagents-0.0.709"), { recursive: true, force: true });

    const fake = makeFakePanel(root, {
      _codexHookScriptPath: () => newV.hook,
      _codexDispatcherScriptPath: () => newV.dispatcher,
    });
    let result = (TycoonPanel.prototype as any)._buildHarnessSettings.call(fake, root);
    assert.equal(result.codexDispatcherInstalled, false, "stale dispatcher reads as out of date");
    assert.match(result.codexDispatcherWarning, /old or missing/);
    assert.equal(result.codexHooksInstalled, false, "stale hook reads as not current");

    (TycoonPanel.prototype as any)._ensureCodexInstallsCurrent.call(fake);
    const toml = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    assert.ok(toml.includes(JSON.stringify(newV.hook)), "hook path repointed");
    assert.ok(toml.includes(JSON.stringify(newV.dispatcher)), "dispatcher path repointed");
    assert.ok(!toml.includes("0.0.709"), "old version path is gone");
    result = (TycoonPanel.prototype as any)._buildHarnessSettings.call(fake, root);
    assert.equal(result.codexDispatcherInstalled, true);
    assert.equal(result.codexHooksInstalled, true);
    assert.equal(result.codexDispatcherWarning, undefined);
  });
});

test("_ensureCodexInstallsCurrent: up-to-date installs are left untouched", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  withCodexProvider(root);
  withCodexHome((codexHome) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "extBase-"));
    const cur = versionDir(base, "0.0.710");
    const fake = makeFakePanel(root, {
      _codexHookScriptPath: () => cur.hook,
      _codexDispatcherScriptPath: () => cur.dispatcher,
      _extensionUri: { fsPath: base },
    });
    (TycoonPanel.prototype as any)._handleInstallCodexHooks.call(fake);
    (TycoonPanel.prototype as any)._handleInstallCodexDispatcher.call(fake);
    const configPath = path.join(codexHome, "config.toml");
    const before = fs.readFileSync(configPath, "utf8");
    const mtimeBefore = fs.statSync(configPath).mtimeMs;
    (TycoonPanel.prototype as any)._ensureCodexInstallsCurrent.call(fake);
    assert.equal(fs.readFileSync(configPath, "utf8"), before);
    assert.equal(fs.statSync(configPath).mtimeMs, mtimeBefore, "file not rewritten");
  });
});

test("_ensureCodexInstallsCurrent: never installs when the user hasn't installed before, and ignores a foreign notify", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  withCodexProvider(root);
  withCodexHome((codexHome) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "extBase-"));
    const cur = versionDir(base, "0.0.710");
    const fake = makeFakePanel(root, {
      _codexHookScriptPath: () => cur.hook,
      _codexDispatcherScriptPath: () => cur.dispatcher,
    });
    (TycoonPanel.prototype as any)._ensureCodexInstallsCurrent.call(fake);
    assert.equal(fs.existsSync(path.join(codexHome, "config.toml")), false, "no config.toml created");

    const foreign = 'notify = ["some-other-tool", "--flag"]\n\n[projects.x]\ntrust = "trusted"\n';
    fs.writeFileSync(path.join(codexHome, "config.toml"), foreign);
    (TycoonPanel.prototype as any)._ensureCodexInstallsCurrent.call(fake);
    assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), foreign);
    assert.equal(fs.existsSync(path.join(root, ".codex", "hooks.json")), false);
  });
});

test("_ensureCodexInstallsCurrent: refreshes an outdated AGENTS.md managed block, preserves user text, and never creates one", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  withCodexProvider(root);
  withCodexHome(() => {
    const fake = makeFakePanel(root, { _extensionUri: { fsPath: process.cwd() } });
    (TycoonPanel.prototype as any)._ensureCodexInstallsCurrent.call(fake);
    assert.equal(fs.existsSync(path.join(root, "AGENTS.md")), false, "no AGENTS.md created when none had a block");

    const agentsPath = path.join(root, "AGENTS.md");
    const NL = String.fromCharCode(10);
    const startM = "<!-- TYCOON-CODEX-MANAGED:START -->";
    const endM = "<!-- TYCOON-CODEX-MANAGED:END -->";
    const head = ["# Mine", "", "user text", "", ""].join(NL);
    const tail = ["", "", "tail", ""].join(NL);
    fs.writeFileSync(agentsPath, head + startM + NL + "stale" + NL + endM + tail);
    (TycoonPanel.prototype as any)._ensureCodexInstallsCurrent.call(fake);
    const out = fs.readFileSync(agentsPath, "utf8");
    assert.ok(out.startsWith(head));
    assert.ok(out.endsWith(tail));
    assert.ok(!out.includes("stale"));
    assert.ok(out.includes("### Writing the brief"));
  });
});

test("_ensureCodexInstallsCurrent: AGENTS.md with a START marker but no END marker is left untouched", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  withCodexProvider(root);
  withCodexHome(() => {
    const fake = makeFakePanel(root, { _extensionUri: { fsPath: process.cwd() } });
    const agentsPath = path.join(root, "AGENTS.md");
    const text = "# Mine\n\n<!-- TYCOON-CODEX-MANAGED:START -->\nhalf a block\n";
    fs.writeFileSync(agentsPath, text);
    (TycoonPanel.prototype as any)._ensureCodexInstallsCurrent.call(fake);
    assert.equal(fs.readFileSync(agentsPath, "utf8"), text);
  });
});

function installOldThenSwitchToClaude(codexHome: string, root: string, oldVer: string, newVer: string) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "extBase-"));
  const oldV = versionDir(base, oldVer);
  const newV = versionDir(base, newVer);
  withCodexProvider(root);
  const oldFake = makeFakePanel(root, {
    _codexHookScriptPath: () => oldV.hook,
    _codexDispatcherScriptPath: () => oldV.dispatcher,
    _extensionUri: { fsPath: base },
  });
  (TycoonPanel.prototype as any)._handleInstallCodexHooks.call(oldFake);
  (TycoonPanel.prototype as any)._handleInstallCodexDispatcher.call(oldFake);
  fs.rmSync(path.join(base, "extensions", `tycoonagents.tycoonagents-${oldVer}`), { recursive: true, force: true });
  fs.writeFileSync(path.join(root, ".claude", "tycoon", "execution.json"), JSON.stringify({ provider: "claude-code" }));
  return { oldV, newV, configPath: path.join(codexHome, "config.toml") };
}

test("_ensureCodexInstallsCurrent: Claude-harness project repoints stale user-level dispatcher and notify paths, project files untouched", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  withCodexHome((codexHome) => {
    const { oldV, newV, configPath } = installOldThenSwitchToClaude(codexHome, root, "0.0.709", "0.0.710");
    const hooksJson = path.join(root, ".codex", "hooks.json");
    const hooksBefore = fs.existsSync(hooksJson) ? fs.readFileSync(hooksJson, "utf8") : undefined;
    const fake = makeFakePanel(root, { _codexHookScriptPath: () => newV.hook, _codexDispatcherScriptPath: () => newV.dispatcher });
    (TycoonPanel.prototype as any)._ensureCodexInstallsCurrent.call(fake);
    const toml = fs.readFileSync(configPath, "utf8");
    assert.ok(toml.includes(JSON.stringify(newV.dispatcher)), "dispatcher repointed");
    assert.ok(toml.includes(JSON.stringify(newV.hook)), "notify hook repointed");
    assert.ok(!toml.includes(oldV.hook) && !toml.includes("0.0.709"), "old path gone");
    assert.equal(fs.existsSync(hooksJson) ? fs.readFileSync(hooksJson, "utf8") : undefined, hooksBefore, "project hooks.json untouched");
    // Second run is a no-op: no rewrite.
    const mtime = fs.statSync(configPath).mtimeMs;
    (TycoonPanel.prototype as any)._ensureCodexInstallsCurrent.call(fake);
    assert.equal(fs.statSync(configPath).mtimeMs, mtime, "unchanged config is not rewritten");
  });
});

test("_ensureCodexInstallsCurrent: Claude-harness project with no tycoon entries leaves config.toml alone", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  withCodexHome((codexHome) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "extBase-"));
    const cur = versionDir(base, "0.0.710");
    const fake = makeFakePanel(root, { _codexHookScriptPath: () => cur.hook, _codexDispatcherScriptPath: () => cur.dispatcher });
    (TycoonPanel.prototype as any)._ensureCodexInstallsCurrent.call(fake);
    assert.equal(fs.existsSync(path.join(codexHome, "config.toml")), false, "no config.toml created");
    const foreign = '[mcp_servers.other]\ncommand = "x"\n';
    fs.writeFileSync(path.join(codexHome, "config.toml"), foreign);
    (TycoonPanel.prototype as any)._ensureCodexInstallsCurrent.call(fake);
    assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), foreign);
  });
});

test("_ensureCodexInstallsCurrent: Claude-harness project never rewrites entries that point at a newer extension", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  withCodexHome((codexHome) => {
    const { configPath, newV } = installOldThenSwitchToClaude(codexHome, root, "0.0.711", "0.0.710");
    // Recreate the newer folder so its paths exist, as another window's install would.
    const base2 = path.dirname(path.dirname(path.dirname(path.dirname(newV.hook))));
    versionDir(base2, "0.0.711");
    const before = fs.readFileSync(configPath, "utf8");
    const fake = makeFakePanel(root, { _codexHookScriptPath: () => newV.hook, _codexDispatcherScriptPath: () => newV.dispatcher });
    (TycoonPanel.prototype as any)._ensureCodexInstallsCurrent.call(fake);
    assert.equal(fs.readFileSync(configPath, "utf8"), before);
  });
});

test("_buildHarnessSettings: codexSandboxWarning appears only while a sandbox record is newer than the last good Codex run", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  withCodexProvider(root);
  withCodexHome(() => {
    const build = (state: unknown) =>
      (TycoonPanel.prototype as any)._buildHarnessSettings.call(makeFakePanel(root, { _runtime: { getState: () => state } }), root);
    assert.equal(build({}).codexSandboxWarning, undefined);
    const w = build({ codexSandboxUnavailableAt: 200 }).codexSandboxWarning;
    assert.match(w, /Windows sandbox couldn't start/);
    assert.match(w, /windows\.sandbox = "unelevated"/);
    assert.equal(build({ codexSandboxUnavailableAt: 200, lastCodexWorkerOkAt: 100 }).codexSandboxWarning, w);
    assert.equal(build({ codexSandboxUnavailableAt: 200, lastCodexWorkerOkAt: 300 }).codexSandboxWarning, undefined);
  });
});

// ---------------------------------------------------------------------
// Harness-aware "is TycoonAgents installed" gate (_handleCheckInstall) and
// first-run Install routing (_handleInstallHooks) on the Codex harness.
// ---------------------------------------------------------------------

function makeCheckInstallFake(root: string, hookPath: string, posted: any[]): any {
  const proto = TycoonPanel.prototype as any;
  return makeFakePanel(root, {
    _codexHookScriptPath: () => hookPath,
    _effectiveHarness: proto._effectiveHarness,
    _codexHookSettingsSlice: proto._codexHookSettingsSlice,
    _hooksInstalledForRoot: proto._hooksInstalledForRoot,
    _settingsReferencesHook: proto._settingsReferencesHook,
    _readMcpConfig: proto._readMcpConfig,
    _effectiveMcpConfig: () => ({}),
    _uefnBridgeEntry: proto._uefnBridgeEntry,
    _mcpInstalled: () => false,
    _handleInstallCodexHooks: proto._handleInstallCodexHooks,
    _panel: { webview: { postMessage: (m: unknown) => { posted.push(m); return Promise.resolve(true); } } },
  });
}

test("_handleCheckInstall: Codex harness with no settings.local.json is installed once the Codex notify hook is; not before", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  withCodexProvider(root);
  withCodexHome(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "extBase-"));
    const cur = versionDir(base, "0.0.710");
    const posted: any[] = [];
    const fake = makeCheckInstallFake(root, cur.hook, posted);
    assert.equal(fs.existsSync(path.join(root, ".claude", "settings.local.json")), false);

    (TycoonPanel.prototype as any)._handleCheckInstall.call(fake);
    let msg = posted.find((m) => m.type === "installState");
    assert.equal(msg.installed, false, "no Codex hook yet -> first-run screen");
    assert.equal(msg.harness, "codex");

    posted.length = 0;
    (TycoonPanel.prototype as any)._handleInstallCodexHooks.call(fake);
    (TycoonPanel.prototype as any)._handleCheckInstall.call(fake);
    msg = posted.find((m) => m.type === "installState");
    assert.equal(msg.installed, true, "Codex hook installed -> not gated, without any .claude hooks");
    assert.equal(fs.existsSync(path.join(root, ".claude", "settings.local.json")), false, "Claude hooks untouched");
  });
});

test("_handleCheckInstall: Claude harness still keys off the Claude hooks file", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  const posted: any[] = [];
  const fake = makeCheckInstallFake(root, "unused", posted);
  (TycoonPanel.prototype as any)._handleCheckInstall.call(fake);
  let msg = posted.find((m) => m.type === "installState");
  assert.equal(msg.installed, false);
  assert.equal(msg.harness, "claude-code");
  fs.writeFileSync(
    path.join(root, ".claude", "settings.local.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node .claude/tycoon/tycoon-claude-hook.cjs" }] }] } }),
  );
  posted.length = 0;
  (TycoonPanel.prototype as any)._handleCheckInstall.call(fake);
  msg = posted.find((m) => m.type === "installState");
  assert.equal(msg.installed, true);
});

test("_handleInstallHooks on the Codex harness installs the Codex hook, not the Claude hooks, and reports installed", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  withCodexProvider(root);
  withCodexHome((codexHome) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "extBase-"));
    const cur = versionDir(base, "0.0.710");
    const posted: any[] = [];
    const fake = makeCheckInstallFake(root, cur.hook, posted);
    infoMessages.length = 0;
    (TycoonPanel.prototype as any)._handleInstallHooks.call(fake, "flat");
    assert.deepEqual(infoMessages.filter((m) => /Start a new Codex session/.test(m)).length, 1, "first Codex install shows the new-session notice");
    (TycoonPanel.prototype as any)._handleInstallHooks.call(fake, "flat");
    assert.equal(infoMessages.length, 1, "a re-run with the hook already installed stays silent");
    const last = [...posted].reverse().find((m) => m.type === "installState" && m.busy !== true);
    assert.equal(last.installed, true);
    assert.equal(last.harness, "codex");
    assert.match(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), /tycoon-codex-hook: managed notify entry/);
    assert.equal(fs.existsSync(path.join(root, ".claude", "settings.local.json")), false, "no Claude hooks written");
  });
});

test("_codexHookSettingsSlice: reports out-of-date for a stale managed hook", () => {
  configuredProviderSetting = undefined;
  const root = tmpRoot();
  withCodexProvider(root);
  withCodexHome(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "extBase-"));
    const oldV = versionDir(base, "0.0.709");
    const newV = versionDir(base, "0.0.710");
    const posted: any[] = [];
    (TycoonPanel.prototype as any)._handleInstallCodexHooks.call(makeCheckInstallFake(root, oldV.hook, posted));
    fs.rmSync(path.join(base, "extensions", "tycoonagents.tycoonagents-0.0.709"), { recursive: true, force: true });
    const slice = (TycoonPanel.prototype as any)._codexHookSettingsSlice.call(makeCheckInstallFake(root, newV.hook, posted));
    assert.equal(slice.status, "out-of-date");
    assert.equal(slice.healthy, false);
    assert.equal(slice.label, "Codex hook out of date");
  });
});

test("launch gate: _buildHarnessSettings marks OpenCode disabled/Coming Soon and a stored opencode resolves to claude-code with the notice", () => {
  setOpencodeAvailableForTests(false);
  try {
    configuredProviderSetting = undefined;
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, ".claude", "tycoon"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "tycoon", "execution.json"), JSON.stringify({ provider: "opencode" }), "utf8");
    const fake = makeFakePanel(root);
    const result = (TycoonPanel.prototype as any)._buildHarnessSettings.call(fake, root);
    assert.deepEqual(result.options.find((o: any) => o.id === "opencode"), { id: "opencode", label: "OpenCode (Coming Soon)", disabled: true });
    assert.equal(result.effective, "claude-code");
    assert.equal(result.opencodeAvailable, false);
    assert.equal(result.notice, OPENCODE_COMING_SOON_NOTICE);
    assert.equal((TycoonPanel.prototype as any)._resolveEffectiveHarness.call(fake, root), "claude-code");
    assert.equal((TycoonPanel.prototype as any)._effectiveHarness.call(fake, root), "claude-code");
    assert.deepEqual(readExecutionJson(root), { provider: "opencode" }, "stored setting is not rewritten");
  } finally {
    setOpencodeAvailableForTests(true);
  }
});

test("launch gate: _handleSetHarness rejects opencode server-side without writing, and re-posts settings", () => {
  setOpencodeAvailableForTests(false);
  try {
    configuredProviderSetting = undefined;
    const root = tmpRoot();
    let settingsCalls = 0;
    let swapped = false;
    const fake = makeFakePanel(root, { _handleGetSettings: () => { settingsCalls++; }, _providerSwap: () => { swapped = true; return true; } });
    (TycoonPanel.prototype as any)._handleSetHarness.call(fake, "opencode");
    assert.equal(fs.existsSync(path.join(root, ".claude", "tycoon", "execution.json")), false);
    assert.equal(swapped, false);
    assert.equal(settingsCalls, 1);
  } finally {
    setOpencodeAvailableForTests(true);
  }
});
