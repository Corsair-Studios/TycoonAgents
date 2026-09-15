/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  maybeShowProviderKeyMigrationNotice,
  LEGACY_PROVIDER_SECRET_KEYS,
} from "../src/host/vscode/providerKeyMigrationNotice";

function makeGlobalState(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const updateCalls: Array<[string, unknown]> = [];
  return {
    get<T>(key: string, defaultValue: T): T {
      return store.has(key) ? (store.get(key) as T) : defaultValue;
    },
    update(key: string, value: unknown): Thenable<void> {
      store.set(key, value);
      updateCalls.push([key, value]);
      return Promise.resolve();
    },
    updateCalls,
  };
}

function makeSecrets(values: Record<string, string | undefined>) {
  const getCalls: string[] = [];
  const deleteCalls: string[] = [];
  return {
    get(key: string): Thenable<string | undefined> {
      getCalls.push(key);
      return Promise.resolve(values[key]);
    },
    delete(key: string): Thenable<void> {
      deleteCalls.push(key);
      return Promise.resolve();
    },
    getCalls,
    deleteCalls,
  };
}

function makeShowInformationMessage() {
  const calls: Array<[string, string[]]> = [];
  const fn = (message: string, ...items: string[]) => {
    calls.push([message, items]);
    return Promise.resolve("OK");
  };
  return Object.assign(fn, { calls });
}

test("shows the notice once when a legacy key exists, never again on a second call", async () => {
  const secrets = makeSecrets({ "tycoonagents.themeImage.openaiApiKey": "sk-legacy-value" });
  const globalState = makeGlobalState();
  const showInformationMessage = makeShowInformationMessage();

  await maybeShowProviderKeyMigrationNotice({ secrets, globalState, showInformationMessage });
  assert.equal(showInformationMessage.calls.length, 1);

  await maybeShowProviderKeyMigrationNotice({ secrets, globalState, showInformationMessage });
  assert.equal(showInformationMessage.calls.length, 1);
});

test("does not show the notice when no legacy key exists, and sets the flag so the check never repeats", async () => {
  const secrets = makeSecrets({});
  const globalState = makeGlobalState();
  const showInformationMessage = makeShowInformationMessage();

  await maybeShowProviderKeyMigrationNotice({ secrets, globalState, showInformationMessage });
  assert.equal(showInformationMessage.calls.length, 0);
  assert.deepEqual(globalState.updateCalls, [
    ["tycoonagents.themeService.providerKeyNoticeShown", true],
  ]);

  await maybeShowProviderKeyMigrationNotice({ secrets, globalState, showInformationMessage });
  // Second call short-circuits on the flag; get() is not called again.
  assert.equal(secrets.getCalls.length, LEGACY_PROVIDER_SECRET_KEYS.length);
});

test("calls secrets.get only with the legacy key names and never includes the value in the message", async () => {
  const secretValue = "super-secret-do-not-leak-12345";
  const secrets = makeSecrets({ "tycoonagents.themeImage.geminiApiKey": secretValue });
  const globalState = makeGlobalState();
  const showInformationMessage = makeShowInformationMessage();

  await maybeShowProviderKeyMigrationNotice({ secrets, globalState, showInformationMessage });

  assert.deepEqual(secrets.getCalls, [...LEGACY_PROVIDER_SECRET_KEYS]);
  assert.deepEqual(
    new Set(secrets.getCalls),
    new Set(["tycoonagents.themeImage.openaiApiKey", "tycoonagents.themeImage.geminiApiKey"]),
  );

  assert.equal(showInformationMessage.calls.length, 1);
  const [message, buttons] = showInformationMessage.calls[0];
  assert.equal(message.includes(secretValue), false);
  assert.deepEqual(buttons, ["OK"]);
});

test("never deletes the legacy secret", async () => {
  const secrets = makeSecrets({ "tycoonagents.themeImage.openaiApiKey": "sk-legacy-value" });
  const globalState = makeGlobalState();
  const showInformationMessage = makeShowInformationMessage();

  await maybeShowProviderKeyMigrationNotice({ secrets, globalState, showInformationMessage });

  assert.equal(secrets.deleteCalls.length, 0);
});
