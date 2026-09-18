/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

// openExternalUrl.ts does `import * as vscode from "vscode"` and
// `import { spawn } from "node:child_process"` at module scope. Stub both
// module loaders (same technique as scripts/run-tests.mjs's sibling files,
// e.g. test/panelOpenHandbook.test.ts) so this file's require of
// openExternalUrl.js resolves under plain `node --test` without a real VS
// Code host or a real child process being spawned.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require("module");
const originalLoad = NodeModule._load;

let openExternalResult: boolean | Promise<boolean> = true;
let openExternalThrows: unknown = null;
const openExternalCalls: string[] = [];
const parseRoundTripsIdentically = { value: true };

function makeVscodeStub(): unknown {
  return {
    __esModule: true,
    Uri: {
      parse(url: string, _strict?: boolean) {
        return {
          toString(skipEncoding?: boolean) {
            if (skipEncoding && !parseRoundTripsIdentically.value) {
              return `${url}#mangled`;
            }
            return url;
          },
        };
      },
    },
    env: {
      openExternal(uri: { toString(skipEncoding?: boolean): string }) {
        openExternalCalls.push(uri.toString());
        if (openExternalThrows) {
          const err = openExternalThrows;
          openExternalThrows = null;
          return Promise.reject(err);
        }
        return Promise.resolve(openExternalResult);
      },
    },
  };
}

type FakeChild = EventEmitter & { unref(): void };
let lastSpawnCall: { command: string; args: string[]; options: unknown } | null = null;
let spawnBehavior: "spawn" | "error" = "spawn";

function makeSpawn() {
  return function fakeSpawn(command: string, args: string[], options: unknown) {
    lastSpawnCall = { command, args, options };
    const child = new EventEmitter() as FakeChild;
    child.unref = () => {};
    queueMicrotask(() => {
      if (spawnBehavior === "spawn") {
        child.emit("spawn");
      } else {
        child.emit("error", new Error("spawn failed"));
      }
    });
    return child;
  };
}

const vscodeStub = makeVscodeStub();
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "vscode") return vscodeStub;
  if (request === "node:child_process" || request === "child_process") {
    return { spawn: makeSpawn() };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { openExternalUrl } = require("../src/host/vscode/openExternalUrl");

function reset() {
  openExternalCalls.length = 0;
  openExternalResult = true;
  openExternalThrows = null;
  parseRoundTripsIdentically.value = true;
  lastSpawnCall = null;
  spawnBehavior = "spawn";
}

function collectLogs(): { logs: string[]; log: (msg: string) => void } {
  const logs: string[] = [];
  return { logs, log: (msg: string) => logs.push(msg) };
}

test("(a) plain https URL that round-trips identically uses openExternal and does not spawn", async () => {
  reset();
  const { logs, log } = collectLogs();
  const url = "https://example.com/callback?code=abc123";
  const result = await openExternalUrl(url, log);
  assert.equal(result, true);
  assert.deepEqual(openExternalCalls, [url]);
  assert.equal(lastSpawnCall, null);
  for (const line of logs) assert.doesNotMatch(line, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("(b1) Stripe-shaped URL with # fragment containing %2B takes the spawn path with byte-identical argv, no shell option", async () => {
  reset();
  parseRoundTripsIdentically.value = false;
  const { log } = collectLogs();
  const url = "https://checkout.stripe.com/pay/cs_test_abc#fidkdWxOYHwnPyd1blpxYHZxWjA0SW9%2BQ0JQZ1BOZ1JKN3JtRlZjPTVhVjV0";
  const result = await openExternalUrl(url, log);
  assert.equal(result, true);
  assert.equal(openExternalCalls.length, 0);
  assert.ok(lastSpawnCall, "expected platform opener to be spawned");
  assert.ok(lastSpawnCall!.args.includes(url), "argv should contain the byte-identical URL");
  const options = lastSpawnCall!.options as Record<string, unknown>;
  assert.equal(options.shell, undefined, "no shell option should be passed");
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
});

test("(b2) Supabase authorize URL with redirect_to=vscode%3A%2F%2F takes the spawn path with byte-identical argv, no shell option", async () => {
  reset();
  parseRoundTripsIdentically.value = false;
  const { log } = collectLogs();
  const url = "https://xyzproj.supabase.co/auth/v1/authorize?provider=google&redirect_to=vscode%3A%2F%2Fcorsair.tycoonagents%2Fauth";
  const result = await openExternalUrl(url, log);
  assert.equal(result, true);
  assert.equal(openExternalCalls.length, 0);
  assert.ok(lastSpawnCall, "expected platform opener to be spawned");
  assert.ok(lastSpawnCall!.args.includes(url), "argv should contain the byte-identical URL");
  const options = lastSpawnCall!.options as Record<string, unknown>;
  assert.equal(options.shell, undefined, "no shell option should be passed");
});

test("(c) child emits 'error' resolves false", async () => {
  reset();
  parseRoundTripsIdentically.value = false;
  spawnBehavior = "error";
  const { log } = collectLogs();
  const url = "https://example.com/needs-spawn#frag";
  const result = await openExternalUrl(url, log);
  assert.equal(result, false);
  assert.ok(lastSpawnCall, "spawn should still have been attempted");
});

test("(d) file: and javascript: URLs return false, nothing spawned or opened", async () => {
  reset();
  const { log } = collectLogs();

  const fileResult = await openExternalUrl("file:///etc/passwd", log);
  assert.equal(fileResult, false);
  assert.equal(openExternalCalls.length, 0);
  assert.equal(lastSpawnCall, null);

  const jsResult = await openExternalUrl("javascript:alert(1)", log);
  assert.equal(jsResult, false);
  assert.equal(openExternalCalls.length, 0);
  assert.equal(lastSpawnCall, null);
});

test("(e) captured log lines never contain the URL string, across all paths", async () => {
  reset();
  const { logs, log } = collectLogs();
  const url1 = "https://example.com/round-trip?token=abc";
  await openExternalUrl(url1, log);

  parseRoundTripsIdentically.value = false;
  const url2 = "https://example.com/needs-spawn?redirect_to=vscode%3A%2F%2F";
  await openExternalUrl(url2, log);

  await openExternalUrl("file:///secret", log);

  assert.ok(logs.length > 0, "expected some log lines to be captured");
  for (const line of logs) {
    assert.doesNotMatch(line, /example\.com/, `log line should not leak the URL: ${line}`);
  }
});
