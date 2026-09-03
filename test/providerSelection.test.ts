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

import { resolveProviderId, PROVIDER_IDS } from "../src/core/providerSelection";

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
