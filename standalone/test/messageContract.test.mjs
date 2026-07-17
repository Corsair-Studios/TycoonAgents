// TycoonAgents standalone — drift guard for the MSG.STATE wire-string
// duplication (independent-review follow-up).
//
// WHY THE DUPLICATION EXISTS (do not "fix" it by importing messages.ts):
// src/host/vscode/messages.ts is the single source of truth for
// webview<->host `message.type` wire strings, but it imports `zod` and
// `./projectPlan` — outside the standalone's verified vscode-free bridge
// surface (see stateFeed.mjs's module header). So standalone/src/stateFeed.mjs
// hardcodes MSG.STATE's wire value ("state") as its own local `MSG_STATE`
// constant instead of importing MSG. That is a deliberate, accepted
// duplication of a STRING only, never logic.
//
// THE RISK THIS GUARDS: if messages.ts's MSG.STATE is ever renamed, the
// standalone would keep emitting the OLD string. media/main.js's
// `window.addEventListener("message", ...)` listener matches
// `e.data.type === "state"` by hand, so a drifted standalone would silently
// stop being recognized — no exception, no visible symptom, just a frozen
// board. This test makes that drift LOUD instead of silent.
//
// STRATEGY (source-of-truth vs actual-behavior, not two hardcoded literals):
//   1. Read src/host/vscode/messages.ts as TEXT (path resolved at runtime
//      from import.meta.url — never a hardcoded absolute machine path) and
//      regex out the `STATE: "..."` value from the MSG object. This is the
//      SOURCE OF TRUTH.
//   2. Drive a REAL createStateFeed() (same fixture pattern as
//      stateFeed.test.mjs) and read the `.type` of an ACTUAL emitted
//      broadcast/getStateMessage() payload — the standalone's ACTUAL
//      BEHAVIOR, not a re-declared literal.
//   3. Assert the two match. A mismatch (or a parse failure on either side)
//      fails LOUDLY with a message naming both sides and what to fix — this
//      guard must never silently no-op.
//
// Plain ESM, node --test, node:assert/strict — matches projectRoots.test.mjs
// and stateFeed.test.mjs. Node built-ins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStateFeed } from '../src/stateFeed.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// standalone/test -> standalone -> repo root -> src/host/vscode/messages.ts
const MESSAGES_TS_PATH = path.resolve(__dirname, '..', '..', 'src', 'host', 'vscode', 'messages.ts');

/**
 * Parses the `STATE: "<value>"` entry out of the MSG object in
 * messages.ts's source text. Pure string->string parse (no TS compilation),
 * exported implicitly via this module for the synthetic-string test below.
 *
 * @param {string} sourceText raw text of messages.ts
 * @returns {string} the parsed wire value
 * @throws {Error} if the STATE entry cannot be found — a guard that can't
 *   locate what it's supposed to compare against must fail, not pass.
 */
function parseMsgStateValue(sourceText) {
  const match = sourceText.match(/\bSTATE:\s*"([^"]+)"/);
  if (!match) {
    throw new Error(
      '[messageContract.test.mjs] Could not find `STATE: "..."` inside src/host/vscode/messages.ts\'s MSG ' +
        'object — either the file moved/was restructured, or MSG.STATE was renamed to something this regex ' +
        "doesn't match. This guard must fail loudly rather than silently skip the drift check; update the " +
        'regex in parseMsgStateValue() (standalone/test/messageContract.test.mjs) to match the new shape.',
    );
  }
  return match[1];
}

test('parseMsgStateValue: extracts MSG.STATE\'s wire value from real messages.ts source text', () => {
  assert.ok(fs.existsSync(MESSAGES_TS_PATH), `messages.ts not found at resolved path: ${MESSAGES_TS_PATH}`);
  const sourceText = fs.readFileSync(MESSAGES_TS_PATH, 'utf8');
  const value = parseMsgStateValue(sourceText);
  assert.equal(typeof value, 'string');
  assert.ok(value.length > 0, 'parsed MSG.STATE value must be non-empty');
});

test('parseMsgStateValue: throws (does not silently return undefined) when STATE is absent — robustness of the guard itself', () => {
  const fixtureWithoutState = `
    export const MSG = {
      READY: "ready",
      SOMETHING_ELSE: "somethingElse",
    };
  `;
  assert.throws(() => parseMsgStateValue(fixtureWithoutState), /Could not find/);
});

test('parseMsgStateValue: synthetic drift fixture proves the guard DETECTS a rename (not just a happy path)', () => {
  // Simulates messages.ts having been edited to rename MSG.STATE, WITHOUT
  // touching the real src/ file (hard project rule: never edit src/, even
  // temporarily). This proves the comparison in the next test would fail
  // loudly on real drift, by exercising the same parse fn against a
  // deliberately-mutated synthetic copy of the relevant source shape.
  const driftedFixture = `
    export const MSG = {
      READY: "ready",
      STATE: "STATE_V2",
    };
  `;
  const driftedValue = parseMsgStateValue(driftedFixture);
  assert.equal(driftedValue, 'STATE_V2');
  assert.notEqual(
    driftedValue,
    'state',
    'sanity check: the synthetic drifted fixture must actually differ from the standalone\'s current MSG_STATE',
  );
});

function mkTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-msgcontract-'));
}

function fakeBroadcast(calls) {
  return (eventName, data) => {
    calls.push({ eventName, data });
  };
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test('DRIFT GUARD: the standalone\'s ACTUAL emitted message.type matches messages.ts\'s SOURCE-OF-TRUTH MSG.STATE value', async () => {
  // Side A — source of truth: parse the real messages.ts on disk.
  assert.ok(
    fs.existsSync(MESSAGES_TS_PATH),
    `[messageContract] src/host/vscode/messages.ts not found at ${MESSAGES_TS_PATH} — cannot verify the ` +
      'standalone\'s duplicated MSG_STATE constant against its source of truth. This guard must fail rather ' +
      'than silently skip.',
  );
  const sourceOfTruth = parseMsgStateValue(fs.readFileSync(MESSAGES_TS_PATH, 'utf8'));

  // Side B — actual behavior: drive a real createStateFeed() and read what
  // it actually emits, rather than re-declaring the literal here.
  const projectRoot = mkTempProject();
  const calls = [];
  let feed;
  try {
    feed = createStateFeed({ projectRoot, broadcast: fakeBroadcast(calls) });
    // createStateFeed() calls recompute() synchronously before returning
    // (see stateFeed.mjs), but postState()/broadcast only fires from the
    // watcher's onRecords batch — for an empty fixture project (no
    // activity.jsonl) that never fires, so assert against getStateMessage(),
    // which is populated synchronously and used verbatim by server.mjs for
    // late-connecting clients (same { type, state } contract).
    const actual = feed.getStateMessage();

    assert.equal(
      actual.type,
      sourceOfTruth,
      `[messageContract] DRIFT DETECTED: src/host/vscode/messages.ts's MSG.STATE is now "${sourceOfTruth}" but ` +
        `standalone/src/stateFeed.mjs's MSG_STATE constant still emits "${actual.type}". These two MUST stay ` +
        'byte-identical (media/main.js matches the wire string by hand and cannot import messages.ts — see ' +
        "stateFeed.mjs's module header). FIX: update the `const MSG_STATE = '...'` literal in " +
        'standalone/src/stateFeed.mjs to match messages.ts\'s new MSG.STATE value.',
    );

    // Also verify a live (post-batch) broadcast payload agrees, using the
    // exact fixture-driven pattern stateFeed.test.mjs already establishes,
    // so this guard covers both emission paths stateFeed.mjs has (postState()
    // via broadcast, and getStateMessage() for late joiners).
    const { dir, activityPath } = (() => {
      const d = path.join(projectRoot, '.claude', 'tycoon');
      return { dir: d, activityPath: path.join(d, 'activity.jsonl') };
    })();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(activityPath, JSON.stringify({ event: 'UserPromptSubmit', at: Date.now(), sessionId: 's' }) + '\n', 'utf8');

    await waitFor(() => calls.length > 0);
    const lastBroadcastType = calls[calls.length - 1].data.type;
    assert.equal(
      lastBroadcastType,
      sourceOfTruth,
      `[messageContract] DRIFT DETECTED in the live broadcast path: messages.ts's MSG.STATE is ` +
        `"${sourceOfTruth}" but stateFeed.mjs's broadcast() call emitted "${lastBroadcastType}". Update ` +
        "standalone/src/stateFeed.mjs's MSG_STATE constant.",
    );
  } finally {
    if (feed) feed.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
