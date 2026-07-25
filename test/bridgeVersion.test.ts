/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBridgeVersion, isBridgeVersionNewer, isNumericVersion } from '../src/shared/bridgeVersion';

// parseBridgeVersion ---------------------------------------------------

test('parseBridgeVersion extracts the version from a realistic multi-line file', () => {
  const fileText = '# comment\nBRIDGE_VERSION = "0.0.441"\n';
  assert.equal(parseBridgeVersion(fileText), '0.0.441');
});

test('parseBridgeVersion works with single quotes', () => {
  assert.equal(parseBridgeVersion("BRIDGE_VERSION = '1.2.3'"), '1.2.3');
});

test('parseBridgeVersion tolerates extra whitespace around the =', () => {
  assert.equal(parseBridgeVersion('BRIDGE_VERSION    =     "2.0.0"'), '2.0.0');
});

test('parseBridgeVersion returns null for an empty string', () => {
  assert.equal(parseBridgeVersion(''), null);
});

test('parseBridgeVersion returns null when there is no BRIDGE_VERSION line', () => {
  const fileText = '# just a comment\nSOME_OTHER_CONST = "0.0.441"\n';
  assert.equal(parseBridgeVersion(fileText), null);
});

// isBridgeVersionNewer --------------------------------------------------

test('isBridgeVersionNewer: real upgrade case (0.0.441 > 0.0.429)', () => {
  assert.equal(isBridgeVersionNewer('0.0.441', '0.0.429'), true);
});

test('isBridgeVersionNewer: numeric comparison, not string comparison (0.0.441 > 0.0.9)', () => {
  // A naive string/lexicographic compare gets this wrong ("0.0.441" < "0.0.9"
  // lexicographically because '4' < '9'). Per-component numeric comparison
  // must get it right: 441 > 9.
  assert.equal(isBridgeVersionNewer('0.0.441', '0.0.9'), true);
});

test('isBridgeVersionNewer: older is not newer (0.0.429 vs 0.0.441)', () => {
  assert.equal(isBridgeVersionNewer('0.0.429', '0.0.441'), false);
});

test('isBridgeVersionNewer: equal versions are not strictly newer', () => {
  assert.equal(isBridgeVersionNewer('0.0.441', '0.0.441'), false);
});

test('isBridgeVersionNewer: missing trailing components default to 0 (0.1 > 0.0.9)', () => {
  assert.equal(isBridgeVersionNewer('0.1', '0.0.9'), true);
});

test('isBridgeVersionNewer: missing trailing components default to 0 (1.0.0 is not > 1)', () => {
  assert.equal(isBridgeVersionNewer('1.0.0', '1'), false);
});

test('isBridgeVersionNewer: non-numeric candidate returns false without throwing', () => {
  assert.doesNotThrow(() => isBridgeVersionNewer('abc', '0.0.1'));
  assert.equal(isBridgeVersionNewer('abc', '0.0.1'), false);
});

test('isBridgeVersionNewer: empty candidate returns false without throwing', () => {
  assert.doesNotThrow(() => isBridgeVersionNewer('', '0.0.1'));
  assert.equal(isBridgeVersionNewer('', '0.0.1'), false);
});

// isNumericVersion -------------------------------------------------------

test('isNumericVersion: a well-formed numeric version is true', () => {
  assert.equal(isNumericVersion('0.0.441'), true);
  assert.equal(isNumericVersion('1'), true);
});

test('isNumericVersion: non-numeric text is false', () => {
  assert.equal(isNumericVersion('abc'), false);
});

test('isNumericVersion: empty string is false', () => {
  assert.equal(isNumericVersion(''), false);
});

test('isNumericVersion: a mixed numeric/non-numeric component is false', () => {
  assert.equal(isNumericVersion('1.x'), false);
});
