// TycoonAgents standalone — drift guard for the theme-message wire-string
// duplication (project-plan task pB-t1).
//
// WHY THE DUPLICATION EXISTS (do not "fix" it by importing messages.ts):
// src/host/vscode/messages.ts is the single source of truth for
// webview<->host `message.type` wire strings, but it imports `zod` and
// `./projectPlan` — outside the standalone's verified vscode-free bridge
// surface (see stateFeed.mjs's module header, and messageContract.test.mjs,
// which already guards MSG.STATE the same way). So
// standalone/src/themeMessages.mjs hardcodes its own MSG_WIRE object instead
// of importing MSG. That is a deliberate, accepted duplication of STRINGS
// only, never logic.
//
// THE RISK THIS GUARDS: if any of these MSG.* wire values are ever renamed
// in messages.ts, the standalone would keep emitting/matching the OLD
// string. media/main.js matches `e.data.type` by hand (e.g.
// `msg.type === "THEME_IMAGE_REVIEW"`), so a drifted standalone would
// silently stop being recognized there too — no exception, just theme
// list/select/delete/review going quiet. This test makes that drift LOUD.
//
// STRATEGY: parse `KEY: "value"` entries out of src/host/vscode/messages.ts's
// MSG object as TEXT (SOURCE OF TRUTH) and assert each one matches the
// corresponding entry in themeMessages.mjs's actual exported MSG_WIRE object
// (ACTUAL BEHAVIOR) — same two-sided comparison shape as
// messageContract.test.mjs's MSG.STATE guard.
//
// Plain ESM, node --test, node:assert/strict. Node built-ins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MSG_WIRE } from '../src/themeMessages.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// standalone/test -> standalone -> repo root -> src/host/vscode/messages.ts
const MESSAGES_TS_PATH = path.resolve(__dirname, '..', '..', 'src', 'host', 'vscode', 'messages.ts');

/**
 * Parses a `<KEY>: "<value>"` entry out of messages.ts's source text.
 *
 * @param {string} sourceText raw text of messages.ts
 * @param {string} key the MSG object key to look up (e.g. "THEMES_LIST")
 * @returns {string} the parsed wire value
 * @throws {Error} if the entry cannot be found — a guard that can't locate
 *   what it's supposed to compare against must fail, not pass.
 */
function parseMsgValue(sourceText, key) {
  const pattern = new RegExp(`\\b${key}:\\s*"([^"]+)"`);
  const match = sourceText.match(pattern);
  if (!match) {
    throw new Error(
      `[themeMessageContract.test.mjs] Could not find \`${key}: "..."\` inside src/host/vscode/messages.ts's MSG ` +
        'object — either the file moved/was restructured, or this key was renamed to something this regex ' +
        `doesn't match. Update the pattern in parseMsgValue() (standalone/test/themeMessageContract.test.mjs) to ` +
        'match the new shape.',
    );
  }
  return match[1];
}

test('parseMsgValue: throws (does not silently return undefined) for a key absent from a fixture — robustness of the guard itself', () => {
  const fixtureWithoutKey = `
    export const MSG = {
      READY: "ready",
      SOMETHING_ELSE: "somethingElse",
    };
  `;
  assert.throws(() => parseMsgValue(fixtureWithoutKey, 'THEMES_LIST'), /Could not find/);
});

test('parseMsgValue: synthetic drift fixture proves the guard DETECTS a rename (not just a happy path)', () => {
  const driftedFixture = `
    export const MSG = {
      THEMES_LIST: "THEMES_LIST_V2",
    };
  `;
  const driftedValue = parseMsgValue(driftedFixture, 'THEMES_LIST');
  assert.equal(driftedValue, 'THEMES_LIST_V2');
  assert.notEqual(
    driftedValue,
    'THEMES_LIST',
    'sanity check: the synthetic drifted fixture must actually differ from the standalone\'s current value',
  );
});

test('DRIFT GUARD: every wire string duplicated in themeMessages.mjs\'s MSG_WIRE matches messages.ts\'s SOURCE-OF-TRUTH MSG object', () => {
  assert.ok(
    fs.existsSync(MESSAGES_TS_PATH),
    `[themeMessageContract] src/host/vscode/messages.ts not found at ${MESSAGES_TS_PATH} — cannot verify the ` +
      'standalone\'s duplicated MSG_WIRE constants against their source of truth. This guard must fail rather ' +
      'than silently skip.',
  );
  const sourceText = fs.readFileSync(MESSAGES_TS_PATH, 'utf8');

  // Every key MSG_WIRE duplicates, mapped to its MSG.<key> name in
  // messages.ts (identical spelling for all of these — see themeMessages.mjs's
  // MSG_WIRE object, which was named to match 1:1).
  const keysToCheck = Object.keys(MSG_WIRE);
  assert.ok(keysToCheck.length > 0, 'MSG_WIRE must not be empty — nothing to guard');

  for (const key of keysToCheck) {
    const sourceOfTruth = parseMsgValue(sourceText, key);
    const actual = MSG_WIRE[key];
    assert.equal(
      actual,
      sourceOfTruth,
      `[themeMessageContract] DRIFT DETECTED: src/host/vscode/messages.ts's MSG.${key} is now "${sourceOfTruth}" ` +
        `but standalone/src/themeMessages.mjs's MSG_WIRE.${key} still says "${actual}". These MUST stay ` +
        "byte-identical (media/main.js matches the wire string by hand and cannot import messages.ts). FIX: " +
        `update MSG_WIRE.${key} in standalone/src/themeMessages.mjs to match messages.ts's new value.`,
    );
  }
});
