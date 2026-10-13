import { test } from "node:test";
import assert from "node:assert/strict";
import { HOOK_WAIT_GRACE_MS, isWaitingForFirstHookEvent } from "../src/host/vscode/hookWait";

const OPEN = 10_000_000;
const stale = OPEN - 5_000_000; // change stamp from long before the panel opened
const base = { installed: true, changedAt: stale, lastEventAt: null as number | null, observedSince: OPEN };

test("grace is 120s", () => assert.equal(HOOK_WAIT_GRACE_MS, 120_000));

test("no banner before 120s from the first panel open", () => {
  assert.equal(isWaitingForFirstHookEvent({ ...base, now: OPEN }), false);
  assert.equal(isWaitingForFirstHookEvent({ ...base, now: OPEN + 119_999 }), false);
});

test("banner shows after 120s with a real change and no events", () => {
  assert.equal(isWaitingForFirstHookEvent({ ...base, now: OPEN + 120_000 }), true);
});

test("a change made after the panel opened counts from the change, not from open", () => {
  const changedAt = OPEN + 50_000;
  const a = { ...base, changedAt };
  assert.equal(isWaitingForFirstHookEvent({ ...a, now: changedAt + 119_999 }), false);
  assert.equal(isWaitingForFirstHookEvent({ ...a, now: changedAt + 120_000 }), true);
});

test("an event after the change, no install, or no recorded change never shows the banner", () => {
  const now = OPEN + 999_999;
  assert.equal(isWaitingForFirstHookEvent({ ...base, lastEventAt: stale + 1, now }), false);
  assert.equal(isWaitingForFirstHookEvent({ ...base, installed: false, now }), false);
  assert.equal(isWaitingForFirstHookEvent({ ...base, changedAt: null, now }), false, "a version change alone records no change stamp");
});
