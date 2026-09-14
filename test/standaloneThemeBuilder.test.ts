/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p40-t4: standalone/src/server.mjs's OPEN_THEME_BUILDER_WIRE dispatch
// (~line 1247-1252) broadcasts THEME_BUILDER_OPENED with { signedIn: false },
// mirroring panel.ts's MSG.OPEN_THEME_BUILDER branch (panel.ts:1865-1869).
//
// handleBrowserMessage() and the WebSocket case-switch it lives in are not
// exported from server.mjs (no test/ file starts the real standalone server
// and drives a WS round trip — test/standaloneHostHtml.test.ts, the only
// other standalone-focused test, is also source-level, not a running-server
// harness), so this is a source-level drift guard in the same style: read
// the file text and assert the wire constants, the case label, and the
// broadcast call are wired together correctly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MSG } from '../src/host/vscode/messages';

const SERVER_MJS_PATH = join(process.cwd(), 'standalone', 'src', 'server.mjs');

function readServerMjs(): string {
  return readFileSync(SERVER_MJS_PATH, 'utf8');
}

test('server.mjs OPEN_THEME_BUILDER_WIRE / THEME_BUILDER_OPENED_WIRE constants match MSG wire strings', () => {
  const src = readServerMjs();
  const openMatch = src.match(/const OPEN_THEME_BUILDER_WIRE = '([^']+)'/);
  const openedMatch = src.match(/const THEME_BUILDER_OPENED_WIRE = '([^']+)'/);
  assert.ok(openMatch, 'server.mjs should define OPEN_THEME_BUILDER_WIRE');
  assert.ok(openedMatch, 'server.mjs should define THEME_BUILDER_OPENED_WIRE');
  assert.equal(openMatch![1], MSG.OPEN_THEME_BUILDER);
  assert.equal(openedMatch![1], MSG.THEME_BUILDER_OPENED);
});

test('server.mjs case OPEN_THEME_BUILDER_WIRE broadcasts THEME_BUILDER_OPENED with signedIn: false', () => {
  const src = readServerMjs();
  const caseStart = src.indexOf('case OPEN_THEME_BUILDER_WIRE:');
  assert.ok(caseStart >= 0, 'server.mjs should have a case OPEN_THEME_BUILDER_WIRE branch');
  const caseEnd = src.indexOf('break;', caseStart);
  assert.ok(caseEnd >= 0, 'case OPEN_THEME_BUILDER_WIRE branch should end with break;');
  const body = src.slice(caseStart, caseEnd);

  assert.match(
    body,
    /broadcast\(\s*'message'\s*,\s*\{\s*type:\s*THEME_BUILDER_OPENED_WIRE\s*,\s*payload:\s*\{\s*signedIn:\s*false\s*\}\s*\}\s*\)/,
    `OPEN_THEME_BUILDER_WIRE case should broadcast { type: THEME_BUILDER_OPENED_WIRE, payload: { signedIn: false } }; got:\n${body}`,
  );
});

test('server.mjs does not fall through to the default (unhandled) branch for OPEN_THEME_BUILDER_WIRE', () => {
  const src = readServerMjs();
  const caseStart = src.indexOf('case OPEN_THEME_BUILDER_WIRE:');
  assert.ok(caseStart >= 0);
  const caseEnd = src.indexOf('break;', caseStart);
  assert.ok(caseEnd >= 0);
  const body = src.slice(caseStart, caseEnd);
  assert.doesNotMatch(body, /\(unhandled\)/, 'OPEN_THEME_BUILDER_WIRE should not fall through to the unhandled-log default branch');
});
