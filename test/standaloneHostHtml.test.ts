import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// buildHostHtml() in standalone/src/server.mjs is not exported (no module
// system boundary to import through cleanly without booting the server), so
// this test greps the function body directly out of source — same approach
// as asserting on generated HTML, without needing to start an HTTP server.
// Regression test for: rebirth trophies never rendering in the standalone
// app because buildHostHtml() omitted the #trophy-row markup and its
// #trophyCupGoldGrad gradient that src/host/vscode/panel.ts's HTML includes
// (see panel.ts ~8874-8883).
function extractBuildHostHtmlBody(): string {
  const src = readFileSync(
    join(process.cwd(), 'standalone', 'src', 'server.mjs'),
    'utf8',
  );
  const start = src.indexOf('function buildHostHtml()');
  assert.ok(start >= 0, 'buildHostHtml() should exist in standalone/src/server.mjs');
  // Grab a generous slice past the function start — the template literal
  // that builds the HTML lives entirely within a few hundred lines of it.
  return src.slice(start, start + 20000);
}

test('standalone buildHostHtml includes the rebirth trophy row markup', () => {
  const body = extractBuildHostHtmlBody();
  assert.ok(
    body.includes('id="trophy-row"'),
    'buildHostHtml() output should include id="trophy-row" (updateTrophyRow() in media/main.js reads this element)',
  );
  assert.ok(
    body.includes('id="trophyCupGoldGrad"'),
    'buildHostHtml() output should include the trophyCupGoldGrad gradient referenced by TROPHY_CUP_SVG',
  );
});

test('standalone sends rebirth_state on THEME_INITIALIZED, matching the VS Code host', () => {
  const themeMessagesSrc = readFileSync(
    join(process.cwd(), 'standalone', 'src', 'themeMessages.mjs'),
    'utf8',
  );
  assert.ok(
    /THEME_INITIALIZED[\s\S]{0,400}rebirth_state:\s*getRebirthStateStandalone/.test(themeMessagesSrc),
    'handleSelectTheme() THEME_INITIALIZED payload should include rebirth_state from getRebirthStateStandalone(), mirroring panel.ts\'s getRebirthState()',
  );
});
