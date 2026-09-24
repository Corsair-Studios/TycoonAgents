/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Review follow-up (v0.0.661 investigation): coverage for panel.ts's
// _postThemeImageReview error_kind sanitization (~3654-3665), which blanks a
// persisted item.error_kind of "not_signed_in" on the OUTGOING payload only
// when this._themeServiceHost.getCachedOrPendingStatus().signedIn === true,
// and leaves it untouched (including the "signedIn undefined" transient
// case) otherwise. Follows test/themeServiceSavePlanMessage.test.ts's
// "source guard" pattern: instantiating the vscode-coupled TycoonPanel class
// isn't practical here, so this reads panel.ts's real source, asserts the
// exact sanitization expression is present at the map site, and exercises a
// verbatim copy of that one-line computation (paste-checked below) against
// every status shape that can reach it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const PANEL_TS_PATH = path.join(process.cwd(), 'src', 'host', 'vscode', 'panel.ts');

test('source guard: panel.ts _postThemeImageReview still blanks error_kind "not_signed_in" only when getCachedOrPendingStatus().signedIn === true', () => {
  const src = readFileSync(PANEL_TS_PATH, 'utf8');
  const mapStart = src.indexOf('review.entries.map(async ({ item, imageUri, generated })');
  assert.ok(mapStart >= 0, 'expected the review.entries.map call to still exist');
  const returnIdx = src.indexOf('return {', mapStart);
  assert.ok(returnIdx >= 0, 'expected a return object literal inside the map callback');
  const slice = src.slice(returnIdx, returnIdx + 900);
  assert.match(
    slice,
    /error_kind:\s*item\.error_kind\s*===\s*"not_signed_in"\s*&&\s*this\._themeServiceHost\.getCachedOrPendingStatus\(\)\.signedIn\s*===\s*true\s*\?\s*undefined\s*:\s*item\.error_kind/,
    'expected the exact not_signed_in sanitization ternary in the outgoing item spread',
  );
});

// Verbatim copy of panel.ts's ~3663-3665 expression, kept in lockstep with
// the source guard above so a change to the real logic that isn't mirrored
// here fails the source guard instead of silently going untested.
function sanitizeOutgoingErrorKind(
  itemErrorKind: string | undefined,
  cachedStatus: { signedIn?: boolean },
): string | undefined {
  return itemErrorKind === 'not_signed_in' && cachedStatus.signedIn === true ? undefined : itemErrorKind;
}

test('signed-in cached status blanks a persisted not_signed_in error_kind', () => {
  assert.equal(sanitizeOutgoingErrorKind('not_signed_in', { signedIn: true }), undefined);
});

test('signed-out cached status leaves not_signed_in intact', () => {
  assert.equal(sanitizeOutgoingErrorKind('not_signed_in', { signedIn: false }), 'not_signed_in');
});

test('a transient cached status (signedIn undefined/unknown) leaves not_signed_in intact', () => {
  assert.equal(sanitizeOutgoingErrorKind('not_signed_in', {}), 'not_signed_in');
});

test('a non-not_signed_in error_kind is never touched, signed in or out', () => {
  assert.equal(sanitizeOutgoingErrorKind('insufficient_credits', { signedIn: true }), 'insufficient_credits');
  assert.equal(sanitizeOutgoingErrorKind('insufficient_credits', { signedIn: false }), 'insufficient_credits');
});

test('an undefined error_kind stays undefined regardless of status', () => {
  assert.equal(sanitizeOutgoingErrorKind(undefined, { signedIn: true }), undefined);
  assert.equal(sanitizeOutgoingErrorKind(undefined, { signedIn: false }), undefined);
});
