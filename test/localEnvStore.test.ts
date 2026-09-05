/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveStoreDir,
  setValue,
  getValue,
  hasValue,
  clearValue,
  filePath,
  ENV_NAME_PATTERN,
} from "../src/core/localEnvStore";

function tmpProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "local-env-store-project-"));
}

function tmpAppDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "local-env-store-appdata-"));
}

test("resolveStoreDir: TYCOON_STANDALONE_DATA_DIR override wins on every platform, always suffixed with 'secrets'", () => {
  const dir = tmpAppDataDir();
  for (const platform of ["win32", "darwin", "linux"] as NodeJS.Platform[]) {
    const store = resolveStoreDir({ env: { TYCOON_STANDALONE_DATA_DIR: dir }, platform, homedir: "/home/x" });
    assert.equal(store, path.join(path.resolve(dir), "secrets"));
  }
});

test("resolveStoreDir: win32 uses APPDATA/TycoonAgents/secrets", () => {
  const store = resolveStoreDir({ env: { APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, platform: "win32", homedir: "C:\\Users\\x" });
  assert.equal(store, path.join("C:\\Users\\x\\AppData\\Roaming", "TycoonAgents", "secrets"));
});

test("resolveStoreDir: darwin uses ~/Library/Application Support/TycoonAgents/secrets", () => {
  const store = resolveStoreDir({ env: {}, platform: "darwin", homedir: "/Users/x" });
  assert.equal(store, path.join("/Users/x", "Library", "Application Support", "TycoonAgents", "secrets"));
});

test("resolveStoreDir: linux/XDG uses ~/.local/share/tycoonagents/secrets by default", () => {
  const store = resolveStoreDir({ env: {}, platform: "linux", homedir: "/home/x" });
  assert.equal(store, path.join("/home/x", ".local", "share", "tycoonagents", "secrets"));
});

test("setValue/getValue/hasValue/clearValue: round-trip, and the write lands ONLY under the store dir, never under any project root", () => {
  const appData = tmpAppDataDir();
  const projectRoot = tmpProjectRoot();
  const opts = { env: { TYCOON_STANDALONE_DATA_DIR: appData } };

  assert.equal(hasValue("MY_TOKEN", opts), false);
  assert.equal(getValue("MY_TOKEN", opts), undefined);

  setValue("MY_TOKEN", "super-secret-value", opts);

  assert.equal(hasValue("MY_TOKEN", opts), true);
  assert.equal(getValue("MY_TOKEN", opts), "super-secret-value");

  const p = filePath("MY_TOKEN", opts)!;
  assert.ok(p.startsWith(path.resolve(appData)));

  // The project root tree is untouched by the write — walk it and confirm
  // no file anywhere under it contains the secret or the var name as a filename.
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else out.push(full);
    }
    return out;
  }
  const projectFiles = fs.existsSync(projectRoot) ? walk(projectRoot) : [];
  assert.equal(projectFiles.length, 0);

  clearValue("MY_TOKEN", opts);
  assert.equal(hasValue("MY_TOKEN", opts), false);
  assert.equal(getValue("MY_TOKEN", opts), undefined);
});

test("setValue: rejects a name that doesn't match ENV_NAME_PATTERN", () => {
  const appData = tmpAppDataDir();
  const opts = { env: { TYCOON_STANDALONE_DATA_DIR: appData } };
  assert.throws(() => setValue("not-valid", "x", opts));
  assert.throws(() => setValue("1BAD", "x", opts));
  assert.match("GOOD_NAME", ENV_NAME_PATTERN);
});

test("getValue/hasValue/clearValue: never throw for an invalid name or a missing store dir", () => {
  const opts = { env: { TYCOON_STANDALONE_DATA_DIR: path.join(os.tmpdir(), "local-env-store-never-created-" + Date.now()) } };
  assert.equal(getValue("bad-name", opts), undefined);
  assert.equal(hasValue("bad-name", opts), false);
  assert.doesNotThrow(() => clearValue("bad-name", opts));
  assert.equal(getValue("NEVER_SET", opts), undefined);
  assert.equal(hasValue("NEVER_SET", opts), false);
  assert.doesNotThrow(() => clearValue("NEVER_SET", opts));
});

test("setValue: file mode is 0o600 and dir mode is 0o700 on POSIX (skipped on win32)", { skip: process.platform === "win32" }, () => {
  const appData = tmpAppDataDir();
  const opts = { env: { TYCOON_STANDALONE_DATA_DIR: appData } };
  setValue("MODE_CHECK", "v", opts);
  const dir = resolveStoreDir(opts);
  const p = filePath("MODE_CHECK", opts)!;
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});
