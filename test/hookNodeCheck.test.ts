import { test } from "node:test";
import assert from "node:assert/strict";
import { checkHookInterpreter, MINIMAL_POSIX_PATH } from "../src/host/vscode/hookNodeCheck";

test("win32 always passes without spawning", () => {
  let spawned = 0;
  const r = checkHookInterpreter("node", { platform: "win32", run: () => { spawned++; return { status: 1 }; } });
  assert.equal(r.ok, true);
  assert.equal(spawned, 0);
});

test("bare node runs through /bin/sh under the minimal PATH; failure reports not ok", () => {
  const calls: Array<{ file: string; args: string[]; env: Record<string, string> }> = [];
  const r = checkHookInterpreter("node", { platform: "darwin", cache: new Map(), run: (file, args, env) => { calls.push({ file, args, env }); return { status: 127 }; } });
  assert.equal(r.ok, false);
  assert.equal(calls[0].file, "/bin/sh");
  assert.equal(calls[0].env.PATH, MINIMAL_POSIX_PATH);
});

test("absolute node: existing and runnable is ok; missing file is not ok without spawning", () => {
  let spawned = 0;
  const run = () => { spawned++; return { status: 0 }; };
  assert.equal(checkHookInterpreter("/opt/homebrew/bin/node", { platform: "darwin", cache: new Map(), fileExists: () => true, run }).ok, true);
  assert.equal(checkHookInterpreter("/gone/node", { platform: "darwin", cache: new Map(), fileExists: () => false, run }).ok, false);
  assert.equal(spawned, 1);
});

test("success is cached; failure is retried after the TTL", () => {
  const cache = new Map();
  let n = 0;
  let t = 1000;
  const opts = { platform: "linux" as const, cache, now: () => t, fileExists: () => true, run: () => { n++; return { status: n === 1 ? 1 : 0 }; } };
  assert.equal(checkHookInterpreter("/a/node", opts).ok, false);
  assert.equal(checkHookInterpreter("/a/node", opts).ok, false); // cached failure
  assert.equal(n, 1);
  t += 31_000;
  assert.equal(checkHookInterpreter("/a/node", opts).ok, true);
  assert.equal(checkHookInterpreter("/a/node", opts).ok, true);
  assert.equal(n, 2);
});

import { checkHookInterpreterAsync, peekHookInterpreterCheck } from "../src/host/vscode/hookNodeCheck";

test("async check shares cache semantics and never uses the sync runner", async () => {
  const cache = new Map();
  let n = 0;
  const opts = { platform: "linux" as const, cache, fileExists: () => true, run: () => { throw new Error("sync used"); }, runAsync: async () => { n++; return { status: 0 }; } };
  assert.equal(peekHookInterpreterCheck("/a/node", opts), undefined);
  assert.equal((await checkHookInterpreterAsync("/a/node", opts)).ok, true);
  assert.equal((await checkHookInterpreterAsync("/a/node", opts)).ok, true);
  assert.equal(n, 1);
  assert.equal(peekHookInterpreterCheck("/a/node", opts)?.ok, true);
  const bad = await checkHookInterpreterAsync("/b/node", { ...opts, runAsync: async () => ({ status: 1 }) });
  assert.equal(bad.ok, false);
});
