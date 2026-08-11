/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// themeImageSettings.ts does `import * as vscode from "vscode"` at module
// scope. Stub the module loader (same technique as
// test/panelOpenHandbook.test.ts) so this file's require resolves under
// plain `node --test`, without needing a real Extension Host.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require("module");
const originalLoad = NodeModule._load;

type ConfigUpdate = { key: string; value: unknown; target: unknown };
let configUpdates: ConfigUpdate[] = [];
let configStore: Record<string, string> = {};

function makeVscodeStub(): unknown {
  return {
    ConfigurationTarget: { Global: 1 },
    workspace: {
      getConfiguration(_section?: string) {
        return {
          get(key: string, defaultValue?: unknown) {
            return key in configStore ? configStore[key] : defaultValue;
          },
          // Truthy inspect() result mimics a registered package.json
          // contribution, matching the real gate in saveThemeImagePreference.
          inspect(key: string) {
            return { key, defaultValue: undefined };
          },
          update(key: string, value: unknown, target: unknown) {
            configUpdates.push({ key, value, target });
            configStore[key] = value as string;
            return Promise.resolve();
          },
        };
      },
    },
  };
}
const vscodeStub = makeVscodeStub();
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "vscode") return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const themeImageSettingsModule = require("../src/extension/themeImageSettings") as typeof import("../src/extension/themeImageSettings") & {
  // resolveThemeImageQuality is not yet implemented as of this writing. Its
  // name and shape are specified by the contract: "A resolver in
  // themeImageSettings.ts mirrors the existing resolveThemeImageModel()...
  // reads the config key, and falls back to 'medium' when blank, missing,
  // OR INVALID." It takes no provider argument (quality is OpenAI-only, not
  // per-provider) per the contract's OPENAI ONLY clause.
  resolveThemeImageQuality?: () => string;
};
const { saveThemeImagePreference } = themeImageSettingsModule;

function makeFakeSecrets() {
  const store: Record<string, string> = {};
  const storeCalls: Array<{ key: string; value: string }> = [];
  return {
    store(key: string, value: string) {
      storeCalls.push({ key, value });
      store[key] = value;
      return Promise.resolve();
    },
    get(key: string) {
      return Promise.resolve(store[key]);
    },
    delete(key: string) {
      delete store[key];
      return Promise.resolve();
    },
    onDidChange: () => ({ dispose() {} }),
    _storeCalls: storeCalls,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

test("saveThemeImagePreference (gemini) persists the provider secret + config mirror, and the model to geminiModel, without touching any api key secret", async () => {
  configUpdates = [];
  configStore = {};
  const secrets = makeFakeSecrets();

  const provider = await saveThemeImagePreference(secrets, { provider: "gemini", model: "gemini-3.1-flash-image" });

  assert.equal(provider, "gemini");
  assert.deepEqual(secrets._storeCalls, [
    { key: "tycoonagents.themeImage.provider", value: "gemini" },
  ]);
  assert.ok(
    !secrets._storeCalls.some((c: { key: string }) => /apikey/i.test(c.key)),
    "must never write an api key secret",
  );

  const providerUpdate = configUpdates.find((u) => u.key === "themeImageProvider");
  assert.ok(providerUpdate, "must mirror provider to config");
  assert.equal(providerUpdate?.value, "gemini");

  const modelUpdate = configUpdates.find((u) => u.key === "geminiModel");
  assert.ok(modelUpdate, "must persist model to the geminiModel config key");
  assert.equal(modelUpdate?.value, "gemini-3.1-flash-image");
  assert.equal(configUpdates.some((u) => u.key === "openaiModel"), false, "must not touch the other provider's model key");
});

test("saveThemeImagePreference (openai) writes the model to openaiModel, not geminiModel", async () => {
  configUpdates = [];
  configStore = {};
  const secrets = makeFakeSecrets();

  await saveThemeImagePreference(secrets, { provider: "openai", model: "gpt-image-2" });

  const modelUpdate = configUpdates.find((u) => u.key === "openaiModel");
  assert.ok(modelUpdate);
  assert.equal(modelUpdate?.value, "gpt-image-2");
  assert.equal(configUpdates.some((u) => u.key === "geminiModel"), false);
});

test("saveThemeImagePreference trims the model id and normalizes an unrecognized provider to openai", async () => {
  configUpdates = [];
  configStore = {};
  const secrets = makeFakeSecrets();

  const provider = await saveThemeImagePreference(secrets, { provider: "not-a-real-provider", model: "  some-id  " });

  assert.equal(provider, "openai");
  const modelUpdate = configUpdates.find((u) => u.key === "openaiModel");
  assert.equal(modelUpdate?.value, "some-id");
});

// --- resolveThemeImageQuality (OpenAI image `quality` setting) ---
// Contract: mirrors resolveThemeImageModel -- reads config key
// `tycoonagents.openaiImageQuality`, falls back to 'medium' when blank,
// missing, OR INVALID. Config key read via the same
// workspace.getConfiguration('tycoonagents').get(...) stub used everywhere
// else in this file (configStore), so this exercises the REAL resolver
// against the REAL vscode-config stub, not a local reimplementation.

test("resolveThemeImageQuality falls back to 'medium' when the config key is missing entirely", () => {
  configStore = {};
  assert.equal(themeImageSettingsModule.resolveThemeImageQuality!(), "medium");
});

test("resolveThemeImageQuality falls back to 'medium' when the config value is blank", () => {
  configStore = { openaiImageQuality: "" };
  assert.equal(themeImageSettingsModule.resolveThemeImageQuality!(), "medium");
});

test("resolveThemeImageQuality returns an explicit 'low' unchanged", () => {
  configStore = { openaiImageQuality: "low" };
  assert.equal(themeImageSettingsModule.resolveThemeImageQuality!(), "low");
});

test("resolveThemeImageQuality returns an explicit 'high' unchanged", () => {
  configStore = { openaiImageQuality: "high" };
  assert.equal(themeImageSettingsModule.resolveThemeImageQuality!(), "high");
});

test("resolveThemeImageQuality falls back to 'medium' for a GARBAGE config value -- never passed through to the API", () => {
  configStore = { openaiImageQuality: "ultra" };
  assert.equal(
    themeImageSettingsModule.resolveThemeImageQuality!(),
    "medium",
    "an invalid stored quality string must never reach the OpenAI API unvalidated",
  );
});
