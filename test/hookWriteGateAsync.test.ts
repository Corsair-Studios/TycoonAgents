import { test } from "node:test";
import assert from "node:assert/strict";

import { isHookWriteActive, onHookWritesIdle, withHookWrite, withHookWriteAsync } from "../src/core/hookWriteGate";

/* The async gate stays held until the promise settles and is always released. */

test("withHookWriteAsync holds the gate across awaits and releases it afterwards", async () => {
  assert.equal(isHookWriteActive(), false);
  const seen: boolean[] = [];
  const value = await withHookWriteAsync(async () => {
    seen.push(isHookWriteActive());
    await new Promise((r) => setTimeout(r, 5));
    seen.push(isHookWriteActive());
    return 42;
  });
  assert.equal(value, 42);
  assert.deepEqual(seen, [true, true]);
  assert.equal(isHookWriteActive(), false);
});

test("withHookWriteAsync releases the gate when the promise rejects and rethrows", async () => {
  await assert.rejects(
    withHookWriteAsync(async () => {
      await Promise.resolve();
      throw new Error("copy failed");
    }),
    /copy failed/,
  );
  assert.equal(isHookWriteActive(), false);
});

test("withHookWriteAsync releases the gate when fn throws synchronously", async () => {
  await assert.rejects(
    withHookWriteAsync((() => { throw new Error("sync boom"); }) as () => Promise<never>),
    /sync boom/,
  );
  assert.equal(isHookWriteActive(), false);
});

test("overlapping async writes keep the gate until the last one finishes, and idle fires once", async () => {
  let idle = 0;
  const off = onHookWritesIdle(() => { idle++; });
  try {
    let releaseA!: () => void;
    let releaseB!: () => void;
    const a = withHookWriteAsync(() => new Promise<void>((r) => { releaseA = r; }));
    const b = withHookWriteAsync(() => new Promise<void>((r) => { releaseB = r; }));
    assert.equal(isHookWriteActive(), true);
    releaseA();
    await a;
    assert.equal(isHookWriteActive(), true, "B still writing");
    assert.equal(idle, 0);
    releaseB();
    await b;
    assert.equal(isHookWriteActive(), false);
    assert.equal(idle, 1);
  } finally {
    off();
  }
});

test("sync and async gates nest, a throwing idle listener is swallowed, unsubscribe works", async () => {
  let calls = 0;
  const off = onHookWritesIdle(() => { calls++; throw new Error("listener"); });
  await withHookWriteAsync(async () => {
    withHookWrite(() => assert.equal(isHookWriteActive(), true));
    assert.equal(isHookWriteActive(), true, "outer still holds");
  });
  assert.equal(calls, 1);
  assert.equal(isHookWriteActive(), false);
  off();
  await withHookWriteAsync(async () => undefined);
  assert.equal(calls, 1, "unsubscribed");
});
