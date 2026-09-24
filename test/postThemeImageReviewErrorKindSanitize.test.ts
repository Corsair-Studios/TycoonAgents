/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Review follow-up (v0.0.661 investigation): coverage for panel.ts's
// _postThemeImageReview error_kind sanitization (~3688-3706), which blanks a
// persisted item.error_kind of "not_signed_in" on the OUTGOING payload only
// when this._themeServiceHost.getCachedOrPendingStatus().signedIn === true,
// and leaves it untouched (including the "signedIn undefined" transient
// case) otherwise. Follows test/themeServiceSavePlanMessage.test.ts's
// "source guard" pattern: instantiating the vscode-coupled TycoonPanel class
// isn't practical here, so this reads panel.ts's real source, asserts the
// exact sanitization expression is present at the map site, and exercises a
// verbatim copy of that one-line computation (paste-checked below) against
// every status shape that can reach it.
//
// Follow-up fix (stale error notices after a restart): the same site now
// ALSO blanks a TRANSIENT error_kind (unavailable/unreachable/rate_limited/
// provider_failed — isTransientThemeImageReviewErrorKind in
// src/extension/themeImageReviewState.ts) — a fetch hiccup must never
// resurface just because nothing retried the item since, including across a
// VS Code restart.
//
// Review fix (session-stamp, replacing an earlier per-panel-instance Set
// gate): the Set-based "first post for this theme_id == reload" heuristic
// missed a fresh FIRST-TIME generation failure — generateAndReviewThemeItem
// (themeService.ts) posts no THEME_IMAGE_REVIEW before its own failure, so
// that failure's first-ever post already carried a live error and the Set
// wrongly dropped it. Replaced with a session stamp: THEME_SERVICE_HOST_SESSION_ID
// (src/extension/themeServiceHostSession.ts) is one random id per
// extension-host activation; every transient error_kind write
// (setThemeImageReviewErrorKind, from recordUserCorrectableGenerationError —
// covers both a fresh generation failure and a retry failure) stamps the
// CURRENT id as item.error_session. _postThemeImageReview drops a transient
// error_kind only when its error_session is missing or differs from the
// CURRENT run's id — a failure recorded this run always matches (shown
// live); one left over from an earlier process (a real restart, new id
// each activation) never matches (dropped).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { isTransientThemeImageReviewErrorKind } from '../src/extension/themeImageReviewState';

const PANEL_TS_PATH = path.join(process.cwd(), 'src', 'host', 'vscode', 'panel.ts');

test('source guard: panel.ts _postThemeImageReview still blanks error_kind "not_signed_in" only when getCachedOrPendingStatus().signedIn === true, and a transient kind only on a session mismatch', () => {
  const src = readFileSync(PANEL_TS_PATH, 'utf8');
  const mapStart = src.indexOf('review.entries.map(async ({ item, imageUri, generated })');
  assert.ok(mapStart >= 0, 'expected the review.entries.map call to still exist');
  const returnIdx = src.indexOf('return {', mapStart);
  assert.ok(returnIdx >= 0, 'expected a return object literal inside the map callback');
  const slice = src.slice(returnIdx, returnIdx + 2200);
  assert.match(
    slice,
    /error_kind:\s*item\.error_kind\s*===\s*"not_signed_in"\s*&&\s*this\._themeServiceHost\.getCachedOrPendingStatus\(\)\.signedIn\s*===\s*true\s*\?\s*undefined\s*:\s*\(isTransientThemeImageReviewErrorKind\(item\.error_kind\)\s*&&\s*item\.error_session\s*!==\s*THEME_SERVICE_HOST_SESSION_ID\)\s*\?\s*undefined\s*:\s*item\.error_kind/,
    'expected the exact not_signed_in + session-stamp transient-kind sanitization ternary in the outgoing item spread',
  );
});

test('source guard: the earlier per-instance Set gate (_themeImageReviewLoadedThemeIds) is gone', () => {
  const src = readFileSync(PANEL_TS_PATH, 'utf8');
  assert.doesNotMatch(src, /_themeImageReviewLoadedThemeIds/, 'the Set-based gate should be fully removed, replaced by the session stamp');
});

test('source guard: panel.ts imports isTransientThemeImageReviewErrorKind and THEME_SERVICE_HOST_SESSION_ID', () => {
  const src = readFileSync(PANEL_TS_PATH, 'utf8');
  assert.match(
    src,
    /import\s*\{\s*isTransientThemeImageReviewErrorKind\s*\}\s*from\s*"\.\.\/\.\.\/extension\/themeImageReviewState"/,
  );
  assert.match(
    src,
    /import\s*\{\s*THEME_SERVICE_HOST_SESSION_ID\s*\}\s*from\s*"\.\.\/\.\.\/extension\/themeServiceHostSession"/,
  );
});

test('source guard: setThemeImageReviewErrorKind is called with THEME_SERVICE_HOST_SESSION_ID as its errorSession argument', () => {
  const src = readFileSync(path.join(process.cwd(), 'src', 'extension', 'themeService.ts'), 'utf8');
  const callStart = src.indexOf('await setThemeImageReviewErrorKind(');
  assert.ok(callStart >= 0, 'expected a setThemeImageReviewErrorKind call in themeService.ts');
  const slice = src.slice(callStart, callStart + 700);
  assert.match(slice, /THEME_SERVICE_HOST_SESSION_ID/, 'expected the call to stamp the current session id');
});

// Mirrors isTransientThemeImageReviewErrorKind in
// src/extension/themeImageReviewState.ts — kept in lockstep by the "same
// set" test below (imports the real function and cross-checks every kind).
const TRANSIENT_KINDS = new Set(['unavailable', 'unreachable', 'rate_limited', 'provider_failed']);
function isTransientKindMirror(kind: string | undefined): boolean {
  return typeof kind === 'string' && TRANSIENT_KINDS.has(kind);
}

const CURRENT_SESSION = 'session-current';

// Verbatim copy of panel.ts's ternary, kept in lockstep with the source
// guard above so a change to the real logic that isn't mirrored here fails
// the source guard instead of silently going untested. `currentSession`
// mirrors THEME_SERVICE_HOST_SESSION_ID — a test passing a DIFFERENT value
// than the error's own errorSession simulates a restart (a new id each
// activation).
function sanitizeOutgoingErrorKind(
  itemErrorKind: string | undefined,
  itemErrorSession: string | undefined,
  cachedStatus: { signedIn?: boolean },
  currentSession: string = CURRENT_SESSION,
): string | undefined {
  return itemErrorKind === 'not_signed_in' && cachedStatus.signedIn === true
    ? undefined
    : (isTransientKindMirror(itemErrorKind) && itemErrorSession !== currentSession)
      ? undefined
      : itemErrorKind;
}

test('signed-in cached status blanks a persisted not_signed_in error_kind', () => {
  assert.equal(sanitizeOutgoingErrorKind('not_signed_in', undefined, { signedIn: true }), undefined);
});

test('signed-out cached status leaves not_signed_in intact', () => {
  assert.equal(sanitizeOutgoingErrorKind('not_signed_in', undefined, { signedIn: false }), 'not_signed_in');
});

test('a transient cached status (signedIn undefined/unknown) leaves not_signed_in intact', () => {
  assert.equal(sanitizeOutgoingErrorKind('not_signed_in', undefined, {}), 'not_signed_in');
});

test('a non-not_signed_in error_kind is never touched, signed in or out', () => {
  assert.equal(sanitizeOutgoingErrorKind('insufficient_credits', undefined, { signedIn: true }), 'insufficient_credits');
  assert.equal(sanitizeOutgoingErrorKind('insufficient_credits', undefined, { signedIn: false }), 'insufficient_credits');
});

test('an undefined error_kind stays undefined regardless of status', () => {
  assert.equal(sanitizeOutgoingErrorKind(undefined, undefined, { signedIn: true }), undefined);
  assert.equal(sanitizeOutgoingErrorKind(undefined, undefined, { signedIn: false }), undefined);
});

// ── Follow-up fix: transient kinds never restored across a real restart, durable kinds preserved ──

test('the local mirror set matches the real isTransientThemeImageReviewErrorKind for every known error_kind', () => {
  const allKinds = [
    'not_signed_in', 'insufficient_credits', 'content_blocked', 'account_locked',
    'unavailable', 'unreachable', 'provider_failed', 'rate_limited', 'bad_request',
    undefined,
  ] as const;
  for (const kind of allKinds) {
    assert.equal(isTransientKindMirror(kind), isTransientThemeImageReviewErrorKind(kind), `mismatch for kind=${kind}`);
  }
});

test('a transient error_kind with no error_session at all is blanked (older data / never stamped)', () => {
  for (const kind of ['unavailable', 'unreachable', 'rate_limited', 'provider_failed']) {
    assert.equal(sanitizeOutgoingErrorKind(kind, undefined, { signedIn: true }), undefined, `${kind} should be blanked with no session`);
    assert.equal(sanitizeOutgoingErrorKind(kind, undefined, {}), undefined, `${kind} should be blanked with no session, signed-in status unknown`);
  }
});

test('a durable error_kind (content_blocked) is never blanked by the transient/session check', () => {
  assert.equal(sanitizeOutgoingErrorKind('content_blocked', undefined, {}), 'content_blocked');
  assert.equal(sanitizeOutgoingErrorKind('content_blocked', 'some-other-session', {}), 'content_blocked');
});

test('other durable error_kinds (account_locked, insufficient_credits, bad_request) are never blanked', () => {
  for (const kind of ['account_locked', 'insufficient_credits', 'bad_request']) {
    assert.equal(sanitizeOutgoingErrorKind(kind, undefined, {}), kind);
  }
});

// ── Review fix: live failures (current session) are shown; only a stale/mismatched session is dropped ──

test('a first-time (or any) LIVE transient failure recorded THIS session reaches the webview unblanked', () => {
  // Simulates generateAndReviewThemeItem's fresh-generation failure — its
  // FIRST post already carries the error, stamped with the current run's id.
  assert.equal(
    sanitizeOutgoingErrorKind('rate_limited', CURRENT_SESSION, {}),
    'rate_limited',
    'a live rate_limited failure recorded this run must not be blanked — its real message (minute/day/provider) needs to reach the webview',
  );
  assert.equal(sanitizeOutgoingErrorKind('unavailable', CURRENT_SESSION, {}), 'unavailable', 'same for a live cold-start unavailable failure');
});

test('the same persisted transient error with a DIFFERENT session id (a real restart) is dropped', () => {
  assert.equal(
    sanitizeOutgoingErrorKind('unavailable', 'session-from-a-previous-run', {}, CURRENT_SESSION),
    undefined,
    'an error stamped with an earlier run\'s session id must be dropped once this run has a different id',
  );
});

test('content_blocked survives regardless of error_session — durable kinds are session-independent', () => {
  assert.equal(sanitizeOutgoingErrorKind('content_blocked', 'session-from-a-previous-run', {}, CURRENT_SESSION), 'content_blocked');
  assert.equal(sanitizeOutgoingErrorKind('content_blocked', CURRENT_SESSION, {}, CURRENT_SESSION), 'content_blocked');
  assert.equal(sanitizeOutgoingErrorKind('content_blocked', undefined, {}, CURRENT_SESSION), 'content_blocked');
});
