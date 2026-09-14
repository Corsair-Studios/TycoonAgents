/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for the two host adapters implementing
// src/core/themeServiceClient.ts's ThemeServiceTokenStore contract (p41-t3):
//   - src/host/vscode/themeServiceToken.ts  (vscode.SecretStorage)
//   - standalone/src/themeServiceToken.mjs  (localEnvStore-backed app-data secrets)

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createVsCodeThemeServiceTokenStore, THEME_SERVICE_SECRET_KEY } from "../src/host/vscode/themeServiceToken";

// Minimal fake of vscode.SecretStorage — no `vscode` import needed since the
// adapter accepts the object as a parameter (type-only import in the source).
class FakeSecretStorage {
  private map = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.map.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

test("vscode adapter: key name is tycoonagents.themeService.deviceToken", () => {
  assert.equal(THEME_SERVICE_SECRET_KEY, "tycoonagents.themeService.deviceToken");
});

test("vscode adapter: set/get/clear round trip via SecretStorage only", async () => {
  const secrets = new FakeSecretStorage() as any;
  const store = createVsCodeThemeServiceTokenStore(secrets);

  assert.equal(await store.get(), null);

  await store.set("device-token-abc");
  assert.equal(await store.get(), "device-token-abc");
  assert.equal(await secrets.get(THEME_SERVICE_SECRET_KEY), "device-token-abc");

  await store.clear();
  assert.equal(await store.get(), null);
  assert.equal(await secrets.get(THEME_SERVICE_SECRET_KEY), undefined);
});

function tmpAppDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "theme-service-token-appdata-"));
}

// tsc (module: CommonJS) downlevels a plain `await import(...)` into
// `require()`, which cannot load a real ESM .mjs file — go through
// `Function` so the dynamic import survives compilation unchanged.
const dynamicImport: (specifier: string) => Promise<any> = new Function(
  "specifier",
  "return import(specifier);"
) as (specifier: string) => Promise<any>;

// Resolve from this compiled test file's own location (out/test/*.js ->
// repo root -> standalone/src/...) rather than process.cwd(), so the test
// resolves correctly regardless of the working directory it's invoked from
// (matches the repo-root-relative resolution standalone/src/sharedLogic.mjs
// uses for its out/ bridge).
async function loadStandaloneModule() {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const mjsPath = path.join(repoRoot, "standalone", "src", "themeServiceToken.mjs");
  return dynamicImport(pathToFileURL(mjsPath).href);
}

test("standalone adapter: set/get/clear round trip in a temp app-data dir", async () => {
  const { createStandaloneThemeServiceTokenStore } = await loadStandaloneModule();
  const appDataDir = tmpAppDataDir();
  const store = createStandaloneThemeServiceTokenStore({ appDataDir });

  assert.equal(await store.get(), null);

  await store.set("standalone-token-xyz");
  assert.equal(await store.get(), "standalone-token-xyz");

  const tokenFile = path.join(appDataDir, "secrets", "THEME_SERVICE_DEVICE_TOKEN");
  assert.ok(fs.existsSync(tokenFile), "token file should exist under <appDataDir>/secrets/");

  if (process.platform !== "win32") {
    const mode = fs.statSync(tokenFile).mode & 0o777;
    assert.equal(mode, 0o600, `expected file mode 0o600, got 0${mode.toString(8)}`);
  } else {
    // POSIX permission bits are not meaningful on win32 — skip the mode assertion.
  }

  await store.clear();
  assert.equal(await store.get(), null);
  assert.equal(fs.existsSync(tokenFile), false, "token file should be removed after clear()");
});

test("adapter sources contain no console. or globalState usage", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const vscodeSrc = fs.readFileSync(path.join(repoRoot, "src", "host", "vscode", "themeServiceToken.ts"), "utf8");
  const standaloneSrc = fs.readFileSync(path.join(repoRoot, "standalone", "src", "themeServiceToken.mjs"), "utf8");
  for (const [label, src] of [
    ["src/host/vscode/themeServiceToken.ts", vscodeSrc],
    ["standalone/src/themeServiceToken.mjs", standaloneSrc],
  ] as const) {
    assert.ok(!src.includes("console."), `${label} must not use console.*`);
    assert.ok(!src.includes("globalState"), `${label} must not use globalState`);
  }
});
