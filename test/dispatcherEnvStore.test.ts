/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Tests p23-t10: hooks/dispatcherAdapters.cjs's resolveVendorEnv() falls
// back to the per-user local env value store (hooks/localEnvStore.js) when
// a vendor env var is absent from process.env, and never leaks the stored
// value into error text, activity records, or the MCP result.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const dispatcherAdapters = require("../../hooks/dispatcherAdapters.cjs") as {
  resolveVendorEnv: (name: string, env?: Record<string, string | undefined>) => string | undefined;
  missingVendorEnvMessage: (name: string) => string;
  openaiCompatibleAdapter: (task: string, agentInfo: unknown) => Promise<{ text?: string; error?: string }>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const localEnvStore = require("../../hooks/localEnvStore.js") as {
  setValue: (name: string, value: string, opts?: { env?: Record<string, string | undefined> }) => void;
  clearValue: (name: string, opts?: { env?: Record<string, string | undefined> }) => void;
};

function makeStoreDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-envstore-test-"));
}

test("resolveVendorEnv: value only in the local store is picked up when process env lacks it", () => {
  const storeDir = makeStoreDir();
  const env = { TYCOON_STANDALONE_DATA_DIR: storeDir } as Record<string, string | undefined>;
  localEnvStore.setValue("OPENAI_COMPAT_BASE_URL", "http://example-secret-host.invalid:9999", { env });
  try {
    const resolved = dispatcherAdapters.resolveVendorEnv("OPENAI_COMPAT_BASE_URL", env);
    assert.equal(resolved, "http://example-secret-host.invalid:9999");
  } finally {
    localEnvStore.clearValue("OPENAI_COMPAT_BASE_URL", { env });
  }
});

test("resolveVendorEnv: process env wins over a stored value", () => {
  const storeDir = makeStoreDir();
  const env = { TYCOON_STANDALONE_DATA_DIR: storeDir, OPENAI_COMPAT_BASE_URL: "http://from-env.invalid" } as Record<string, string | undefined>;
  localEnvStore.setValue("OPENAI_COMPAT_BASE_URL", "http://from-store.invalid", { env });
  try {
    assert.equal(dispatcherAdapters.resolveVendorEnv("OPENAI_COMPAT_BASE_URL", env), "http://from-env.invalid");
  } finally {
    localEnvStore.clearValue("OPENAI_COMPAT_BASE_URL", { env });
  }
});

test("resolveVendorEnv: neither source set resolves undefined and the adapter names both sources, no value", async () => {
  const storeDir = makeStoreDir();
  const env = { TYCOON_STANDALONE_DATA_DIR: storeDir } as Record<string, string | undefined>;
  assert.equal(dispatcherAdapters.resolveVendorEnv("OPENAI_COMPAT_BASE_URL", env), undefined);
  const msg = dispatcherAdapters.missingVendorEnvMessage("OPENAI_COMPAT_BASE_URL");
  assert.match(msg, /OPENAI_COMPAT_BASE_URL/);
  assert.match(msg, /Codex process environment/);
  assert.match(msg, /TycoonAgents local env store/);
});

test("openaiCompatibleAdapter: store-only OPENAI_COMPAT_BASE_URL is used, real HTTP attempted with Authorization header, error text never contains the stored value", async () => {
  const storeDir = makeStoreDir();
  const savedEnv = { ...process.env };
  const savedDataDir = process.env.TYCOON_STANDALONE_DATA_DIR;
  process.env.TYCOON_STANDALONE_DATA_DIR = storeDir;
  delete process.env.OPENAI_COMPAT_BASE_URL;
  delete process.env.OPENAI_COMPAT_API_KEY;
  const secretKey = "sk-super-secret-value-should-never-appear";
  // Point at a port nothing listens on so the request fails fast and
  // deterministically (offline test) while still proving the stored
  // base URL/key were picked up and an Authorization header was attempted.
  localEnvStore.setValue("OPENAI_COMPAT_BASE_URL", "http://127.0.0.1:1", { env: process.env as Record<string, string | undefined> });
  localEnvStore.setValue("OPENAI_COMPAT_API_KEY", secretKey, { env: process.env as Record<string, string | undefined> });
  try {
    const result = await dispatcherAdapters.openaiCompatibleAdapter("hello", { vendor: "moonshot", model: "kimi-k2" });
    assert.ok(result.error, "expected a connection failure against the unused port");
    assert.ok(!String(result.error).includes(secretKey), "error text must never contain the stored API key value");
  } finally {
    localEnvStore.clearValue("OPENAI_COMPAT_BASE_URL", { env: process.env as Record<string, string | undefined> });
    localEnvStore.clearValue("OPENAI_COMPAT_API_KEY", { env: process.env as Record<string, string | undefined> });
    if (savedDataDir === undefined) delete process.env.TYCOON_STANDALONE_DATA_DIR;
    else process.env.TYCOON_STANDALONE_DATA_DIR = savedDataDir;
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete (process.env as Record<string, string | undefined>)[k];
    }
    Object.assign(process.env, savedEnv);
  }
});
