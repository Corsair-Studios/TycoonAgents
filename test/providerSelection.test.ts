/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  resolveProviderId,
  PROVIDER_IDS,
  describeProviderSelection,
  writeProviderSelection,
  buildHarnessOptions,
  setOpencodeAvailableForTests,
  OPENCODE_HARNESS_AVAILABLE,
  OPENCODE_COMING_SOON_NOTICE,
} from "../src/core/providerSelection";

// Existing cases below exercise the OpenCode-available behaviour (gate flipped
// on); the "launch gate" cases at the end restore the shipped gate explicitly.
setOpencodeAvailableForTests(true);

async function makeProjectDir(executionJson?: unknown): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tycoon-provider-selection-"));
  if (executionJson !== undefined) {
    const tycoonDir = path.join(dir, ".claude", "tycoon");
    await fsp.mkdir(tycoonDir, { recursive: true });
    await fsp.writeFile(
      path.join(tycoonDir, "execution.json"),
      typeof executionJson === "string" ? executionJson : JSON.stringify(executionJson),
    );
  }
  return dir;
}

test("resolveProviderId defaults to claude-code with no signals", async () => {
  const dir = await makeProjectDir();
  assert.equal(resolveProviderId({ env: {}, projectDir: dir }), "claude-code");
});

test("resolveProviderId reads the provider key from execution.json", async () => {
  const dir = await makeProjectDir({ provider: "opencode" });
  assert.equal(resolveProviderId({ env: {}, projectDir: dir }), "opencode");
});

test("resolveProviderId tolerates a missing/invalid execution.json", async () => {
  const dir = await makeProjectDir("not json");
  assert.equal(resolveProviderId({ env: {}, projectDir: dir }), "claude-code");
});

test("resolveProviderId: settingValue beats execution.json", async () => {
  const dir = await makeProjectDir({ provider: "opencode" });
  assert.equal(
    resolveProviderId({ settingValue: "claude-code", env: {}, projectDir: dir }),
    "claude-code",
  );
});

test("resolveProviderId: TYCOON_PROVIDER env beats settingValue and execution.json", async () => {
  const dir = await makeProjectDir({ provider: "claude-code" });
  assert.equal(
    resolveProviderId({
      settingValue: "claude-code",
      env: { TYCOON_PROVIDER: "opencode" },
      projectDir: dir,
    }),
    "opencode",
  );
});

test("resolveProviderId throws on an unknown env value, naming valid ids", async () => {
  const dir = await makeProjectDir();
  assert.throws(
    () => resolveProviderId({ env: { TYCOON_PROVIDER: "bogus" }, projectDir: dir }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /bogus/);
      for (const id of PROVIDER_IDS) assert.match(err.message, new RegExp(id));
      assert.match(err.message, /TYCOON_PROVIDER/);
      return true;
    },
  );
});

test("resolveProviderId throws on an unknown settingValue", async () => {
  const dir = await makeProjectDir();
  assert.throws(() => resolveProviderId({ settingValue: "bogus", env: {}, projectDir: dir }));
});

test("resolveProviderId throws on an unknown execution.json provider value", async () => {
  const dir = await makeProjectDir({ provider: "bogus" });
  assert.throws(() => resolveProviderId({ env: {}, projectDir: dir }), /execution\.json/);
});

// --- createProvider (providerFactory.ts) --------------------------------
//
// providerFactory.ts imports ../../providers/claude-code, which pulls in a
// chain of modules; none of them import `vscode` (verified: claudeCodeProvider
// .ts / mapHookRecord.ts / hookRecord.ts are Node-only), so no vscode stub is
// needed here — unlike test/bundledThemeDefault.test.ts, which stubs vscode
// because bundledThemeSeeds.ts genuinely uses the vscode API.

test("createProvider('claude-code', ...) returns a ClaudeCodeProvider", async () => {
  const { createProvider } = await import("../src/host/vscode/providerFactory");
  const { ClaudeCodeProvider } = await import("../src/providers/claude-code");
  const provider = createProvider("claude-code", path.join(os.tmpdir(), "activity.jsonl"));
  assert.ok(provider instanceof ClaudeCodeProvider);
  assert.equal(provider.id, "claude-code");
});

test("createProvider('opencode', ...) returns an OpenCodeProvider", async () => {
  const { createProvider } = await import("../src/host/vscode/providerFactory");
  const { OpenCodeProvider } = await import("../src/providers/opencode");
  const provider = createProvider("opencode", path.join(os.tmpdir(), "activity.jsonl"));
  assert.ok(provider instanceof OpenCodeProvider);
  assert.equal(provider.id, "opencode");
});

test("createProvider('codex', ...) returns a CodexProvider (p22-t4)", async () => {
  const { createProvider } = await import("../src/host/vscode/providerFactory");
  const { CodexProvider } = await import("../src/providers/codex");
  const provider = createProvider("codex", path.join(os.tmpdir(), "activity.jsonl"));
  assert.ok(provider instanceof CodexProvider);
  assert.equal(provider.id, "codex");
});

test("standalone provider resolution accepts TYCOON_PROVIDER=codex (p22-t4)", async () => {
  const dir = await makeProjectDir({ provider: "claude-code" });
  assert.equal(
    resolveProviderId({ env: { TYCOON_PROVIDER: "codex" }, projectDir: dir }),
    "codex",
  );
});

test("switching Claude->Codex->Claude via resolveProviderId/createProvider leaves settings.local.json bytes unchanged (p22-t4)", async () => {
  const { createProvider } = await import("../src/host/vscode/providerFactory");
  const dir = await makeProjectDir({ provider: "claude-code" });
  const claudeDir = path.join(dir, ".claude");
  const settingsPath = path.join(claudeDir, "settings.local.json");
  const settingsContent = JSON.stringify(
    { hooks: { Stop: [{ hooks: [{ type: "command", command: "node hooks/tycoon-hook.cjs" }] }] } },
    null,
    2,
  );
  await fsp.writeFile(settingsPath, settingsContent, "utf8");
  const before = await fsp.readFile(settingsPath);

  for (const id of ["claude-code", "codex", "claude-code"] as const) {
    assert.equal(resolveProviderId({ settingValue: id, env: {}, projectDir: dir }), id);
    const provider = createProvider(id, path.join(os.tmpdir(), "activity.jsonl"));
    assert.equal(provider.id, id);
  }

  const after = await fsp.readFile(settingsPath);
  assert.ok(before.equals(after), "settings.local.json bytes must be byte-identical across Claude->Codex->Claude selection");
});

// --- describeProviderSelection / writeProviderSelection (p13-t7) --------

test("describeProviderSelection: default with nothing set", async () => {
  const dir = await makeProjectDir();
  const d = describeProviderSelection({ env: {}, cwd: dir });
  assert.deepEqual(d, { effective: "claude-code", source: "default", fileValue: undefined });
});

test("describeProviderSelection: execution.json wins over default and is reported as fileValue", async () => {
  const dir = await makeProjectDir({ provider: "opencode" });
  const d = describeProviderSelection({ env: {}, cwd: dir });
  assert.deepEqual(d, { effective: "opencode", source: "execution", fileValue: "opencode" });
});

test("describeProviderSelection: settingValue beats execution.json but fileValue still reflects the file", async () => {
  const dir = await makeProjectDir({ provider: "opencode" });
  const d = describeProviderSelection({ settingValue: "claude-code", env: {}, cwd: dir });
  assert.deepEqual(d, { effective: "claude-code", source: "setting", fileValue: "opencode" });
});

test("describeProviderSelection: env beats setting and execution.json", async () => {
  const dir = await makeProjectDir({ provider: "opencode" });
  const d = describeProviderSelection({
    settingValue: "opencode",
    env: { TYCOON_PROVIDER: "claude-code" },
    cwd: dir,
  });
  assert.equal(d.effective, "claude-code");
  assert.equal(d.source, "env");
  assert.equal(d.fileValue, "opencode");
});

test("describeProviderSelection: throws on unknown env value", async () => {
  const dir = await makeProjectDir();
  assert.throws(() => describeProviderSelection({ env: { TYCOON_PROVIDER: "bogus" }, cwd: dir }));
});

test("writeProviderSelection: creates execution.json when absent", async () => {
  const dir = await makeProjectDir();
  writeProviderSelection(dir, "opencode");
  const raw = await fsp.readFile(path.join(dir, ".claude", "tycoon", "execution.json"), "utf8");
  assert.deepEqual(JSON.parse(raw), { provider: "opencode" });
});

test("writeProviderSelection: preserves other keys", async () => {
  const dir = await makeProjectDir({ provider: "claude-code", delegation_mode: "team_leads" });
  writeProviderSelection(dir, "opencode");
  const raw = await fsp.readFile(path.join(dir, ".claude", "tycoon", "execution.json"), "utf8");
  assert.deepEqual(JSON.parse(raw), { provider: "opencode", delegation_mode: "team_leads" });
});

test("writeProviderSelection: throws on an unknown provider id and writes nothing", async () => {
  const dir = await makeProjectDir();
  assert.throws(() => writeProviderSelection(dir, "bogus"));
  await assert.rejects(fsp.readFile(path.join(dir, ".claude", "tycoon", "execution.json"), "utf8"));
});

// ── Launch gate: OpenCode is "Coming Soon" ─────────────────────────────────
test("launch gate: OPENCODE_HARNESS_AVAILABLE ships false", () => {
  assert.equal(OPENCODE_HARNESS_AVAILABLE, false);
});

test("launch gate: buildHarnessOptions disables OpenCode with the Coming Soon label; gate=true restores Experimental", () => {
  const gated = buildHarnessOptions(false);
  const oc = gated.find((o) => o.id === "opencode");
  assert.deepEqual(oc, { id: "opencode", label: "OpenCode (Coming Soon)", disabled: true });
  assert.equal(gated.find((o) => o.id === "claude-code")?.disabled, undefined);
  assert.equal(gated.find((o) => o.id === "codex")?.label, "Codex (Experimental)");
  assert.deepEqual(gated.map((o) => o.id), ["claude-code", "codex", "opencode"]);
  assert.deepEqual(buildHarnessOptions(true).map((o) => o.id), ["claude-code", "codex", "opencode"]);
  assert.deepEqual(buildHarnessOptions(true).find((o) => o.id === "opencode"), { id: "opencode", label: "OpenCode (Experimental)" });
});

test("launch gate: stored opencode resolves to claude-code with gatedFrom, from every source", async () => {
  const dir = await makeProjectDir({ provider: "opencode" });
  const fromFile = describeProviderSelection({ env: {}, cwd: dir, opencodeAvailable: false });
  assert.deepEqual(fromFile, { effective: "claude-code", source: "execution", fileValue: "opencode", gatedFrom: "opencode" });
  const fromSetting = describeProviderSelection({ settingValue: "opencode", env: {}, cwd: dir, opencodeAvailable: false });
  assert.equal(fromSetting.effective, "claude-code");
  assert.equal(fromSetting.gatedFrom, "opencode");
  const fromEnv = describeProviderSelection({ env: { TYCOON_PROVIDER: "opencode" }, cwd: dir, opencodeAvailable: false });
  assert.equal(fromEnv.effective, "claude-code");
  assert.equal(resolveProviderId({ env: {}, projectDir: dir, opencodeAvailable: false }), "claude-code");
  // The user's stored setting is not rewritten.
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(dir, ".claude", "tycoon", "execution.json"), "utf8")), { provider: "opencode" });
});

test("launch gate: gate=true restores opencode resolution and no gatedFrom", async () => {
  const dir = await makeProjectDir({ provider: "opencode" });
  const d = describeProviderSelection({ env: {}, cwd: dir, opencodeAvailable: true });
  assert.deepEqual(d, { effective: "opencode", source: "execution", fileValue: "opencode" });
});

test("launch gate: writeProviderSelection rejects opencode when gated and does not write", async () => {
  const dir = await makeProjectDir();
  assert.throws(() => writeProviderSelection(dir, "opencode", false), (e: Error) => e.message === OPENCODE_COMING_SOON_NOTICE);
  await assert.rejects(fsp.readFile(path.join(dir, ".claude", "tycoon", "execution.json"), "utf8"));
  writeProviderSelection(dir, "codex", false);
});
