/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p81-t2: source-text guards for the p81-t1 fix — the real webview CSP
// (src/host/vscode/panel.ts ~9810, style-src with a nonce and NO
// 'unsafe-inline') silently ignores every inline style="" attribute and
// every runtime .style.cssText / setAttribute("style", ...) write, which is
// why the p81 spacing/layout fixes never applied even though DOM-only tests
// passed. These tests read the source files as plain text (no CSP is
// actually enforced here — this guards against the bug coming back, not
// against a live browser) and fail if any of that reappears.
//
// Paths are overridable via env vars so a single proof run can point them at
// git-extracted copies of an older release (see the sibling
// TYCOON_WEBVIEW_BUNDLE pattern in themeBuilderEntry.test.ts) instead of
// duplicating this file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PANEL_TS_PATH = process.env.TYCOON_PANEL_TS_PATH || join(process.cwd(), 'src', 'host', 'vscode', 'panel.ts');
const SERVER_MJS_PATH = process.env.TYCOON_SERVER_MJS_PATH || join(process.cwd(), 'standalone', 'src', 'server.mjs');
const MEDIA_MAIN_SRC_DIR = process.env.TYCOON_MEDIA_MAIN_SRC_DIR || join(process.cwd(), 'media', 'src', 'main');

function findInlineStyleAttrs(src: string): string[] {
  // Matches an HTML/template-literal attribute `style="..."` (not a CSS
  // property inside a stylesheet or a JS object key like styleFoo=).
  const re = /\sstyle\s*=\s*"/g;
  const hits: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const start = Math.max(0, m.index - 30);
    hits.push(src.slice(start, m.index + 20).replace(/\s+/g, ' ').trim());
  }
  return hits;
}

test('src/host/vscode/panel.ts webview markup has no inline style="" attributes', () => {
  const src = readFileSync(PANEL_TS_PATH, 'utf8');
  const hits = findInlineStyleAttrs(src);
  assert.equal(hits.length, 0, `found inline style="" attributes in panel.ts (CSP style-src has no 'unsafe-inline', so these are silently dropped):\n${hits.join('\n')}`);
});

test('standalone/src/server.mjs webview markup has no inline style="" attributes', () => {
  const src = readFileSync(SERVER_MJS_PATH, 'utf8');
  const hits = findInlineStyleAttrs(src);
  assert.equal(hits.length, 0, `found inline style="" attributes in server.mjs:\n${hits.join('\n')}`);
});

test("media/src/main/*.js has no setAttribute(\"style\" and no .style.cssText writes", () => {
  const files = readdirSync(MEDIA_MAIN_SRC_DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0, `expected .js files under ${MEDIA_MAIN_SRC_DIR}`);
  const offenders: string[] = [];
  for (const file of files) {
    const src = readFileSync(join(MEDIA_MAIN_SRC_DIR, file), 'utf8');
    if (/setAttribute\(\s*["']style["']/.test(src)) offenders.push(`${file}: setAttribute("style"...)`);
    if (/\.style\.cssText\s*=/.test(src)) offenders.push(`${file}: .style.cssText =`);
  }
  assert.equal(offenders.length, 0, `found runtime inline-style writes (silently dropped by the real CSP):\n${offenders.join('\n')}`);
});

// Documents WHY: the real webview CSP's style-src is nonce-based with no
// 'unsafe-inline', so any style="" attribute or .style.cssText/setAttribute
// write the two tests above would have caught renders as if it succeeded in
// JSDOM (which never enforces CSP) but is silently a no-op in the actual
// VS Code / standalone webview — the root cause of the p81 spacing bug.
test("panel.ts webview CSP's style-src contains no 'unsafe-inline'", () => {
  const src = readFileSync(PANEL_TS_PATH, 'utf8');
  const styleSrcMatch = /style-src\s+[^`'"]*/.exec(src);
  assert.ok(styleSrcMatch, 'expected to find a style-src directive in panel.ts CSP');
  assert.doesNotMatch(
    styleSrcMatch![0],
    /unsafe-inline/,
    "style-src must not carry 'unsafe-inline' — inline style attributes/writes must go through media/style.css classes instead, or they silently no-op in the real webview",
  );
});
