// TycoonAgents standalone — drift guard for the badge HUD "unseen" dot
// element between the two HTML templates that must stay structurally in
// sync:
//   - standalone/src/server.mjs's buildHostHtml() (standalone web host)
//   - src/host/vscode/panel.ts's _getHtmlForWebview() (VS Code extension)
//
// WHY THIS EXISTS: media/main.js's badge-unlock notification toggles a
// `.has-unseen` class on `#badge-hud-btn` and relies entirely on CSS
// (`.badge-hud.has-unseen .badge-hud-dot`, media/style.css ~1336) to render
// the dot — there is no JS-side createElement for the aggregate dot (unlike
// the per-badge `.badge-card-dot`, which IS created dynamically). If either
// template's `#badge-hud-btn` markup is missing the
// `<span class="badge-hud-dot">` child, the dot can never render no matter
// how correct the unseen-tracking logic is. The standalone template was
// missing this span (only had `.badge-hud-count`), which silently broke
// the "new achievement" indicator in the standalone panel while the VS
// Code panel worked fine. This test makes that drift loud instead of
// silent.
//
// STRATEGY: source-text regex, same technique as templateParity.test.mjs /
// messageContract.test.mjs — no build step, no DOM, no server boot.
//
// Plain ESM, node --test, node:assert/strict. Node built-ins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_MJS_PATH = path.resolve(__dirname, '..', 'src', 'server.mjs');
const PANEL_TS_PATH = path.resolve(REPO_ROOT, 'src', 'host', 'vscode', 'panel.ts');

/**
 * Slices out the `<button id="badge-hud-btn" ...> ... </button>` block from
 * a template's source text.
 *
 * @param {string} sourceText raw template source text
 * @param {string} label file label for error messages
 * @returns {string} the button's inner+outer markup
 */
function extractBadgeHudButtonBlock(sourceText, label) {
  const startMatch = sourceText.match(/<button id="badge-hud-btn"[^>]*>/);
  assert.ok(startMatch, `${label}: could not find #badge-hud-btn opening tag`);
  const startIdx = startMatch.index;
  const endIdx = sourceText.indexOf('</button>', startIdx);
  assert.ok(endIdx !== -1, `${label}: could not find closing </button> for #badge-hud-btn`);
  return sourceText.slice(startIdx, endIdx + '</button>'.length);
}

test('standalone server.mjs #badge-hud-btn includes the .badge-hud-dot span (parity with panel.ts)', () => {
  const serverSrc = fs.readFileSync(SERVER_MJS_PATH, 'utf8');
  const panelSrc = fs.readFileSync(PANEL_TS_PATH, 'utf8');

  const serverBlock = extractBadgeHudButtonBlock(serverSrc, 'server.mjs');
  const panelBlock = extractBadgeHudButtonBlock(panelSrc, 'panel.ts');

  // Sanity: panel.ts (the known-working VS Code implementation) has the dot.
  assert.match(panelBlock, /<span class="badge-hud-dot"/, 'panel.ts unexpectedly missing .badge-hud-dot — update this guard if the VS Code markup changed');

  // The actual regression guard: standalone must match.
  assert.match(
    serverBlock,
    /<span class="badge-hud-dot"/,
    'standalone/src/server.mjs #badge-hud-btn is missing <span class="badge-hud-dot">. ' +
    'media/main.js toggles .has-unseen purely via CSS (.badge-hud.has-unseen .badge-hud-dot) ' +
    'with no JS fallback that creates this element — without it the "new achievement" dot can ' +
    'never render in the standalone panel even though the unseen-tracking state is correct.'
  );

  // Also confirm the aggregate count span is present in both (already-known-good
  // sibling element), to catch a wholesale template rewrite that drops the dot
  // along with everything else rather than reporting a narrow false negative.
  assert.match(serverBlock, /<span class="badge-hud-count">/, 'server.mjs missing .badge-hud-count sibling span');
  assert.match(panelBlock, /<span class="badge-hud-count">/, 'panel.ts missing .badge-hud-count sibling span');
});
