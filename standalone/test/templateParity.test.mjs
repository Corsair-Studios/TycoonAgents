// TycoonAgents standalone — drift guard for the #app direct-child order
// between the two HTML templates that must stay structurally in sync:
//   - standalone/src/server.mjs's buildHostHtml() (standalone web host)
//   - src/host/vscode/panel.ts's _getHtmlForWebview() (VS Code extension)
//
// WHY THIS EXISTS: #menu-btn and #menu-popover must be DIRECT children of
// #app, positioned before #stage-area — not nested inside #stage-area.
// #stage-area is position:relative + overflow:hidden (media/style.css),
// which creates its own stacking context and clips anything nested inside
// it (the popover was getting sliced off under #metrics-panel). See the
// block comment above #menu-btn in both templates, and media/style.css
// (~1162-1167, ~1468-1479) for the CSS-side contract. A future edit could
// silently re-nest the popover back inside #stage-area in one template
// without the other; this test makes that drift loud instead of silent.
//
// STRATEGY (source-text regex, same technique as messageContract.test.mjs
// reading src/host/vscode/messages.ts as plain text — no TS compilation):
//   1. Read both template source files as text.
//   2. Slice out the `<div id="app" ...> ... </div><!-- /#app -->` block
//      via its literal boundary markers (present verbatim in both files).
//   3. Within that slice, regex out the ids of elements indented exactly
//      4 spaces — the direct-child indent level both templates use — to
//      get the direct child id order.
//   4. Assert #menu-btn and #menu-popover both appear, in that order,
//      before #stage-area, as direct #app children, in BOTH templates.
//
// Plain ESM, node --test, node:assert/strict — matches messageContract.test.mjs.
// Node built-ins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// standalone/test -> standalone -> repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_MJS_PATH = path.resolve(__dirname, '..', 'src', 'server.mjs');
const PANEL_TS_PATH = path.resolve(REPO_ROOT, 'src', 'host', 'vscode', 'panel.ts');

const APP_BLOCK_START = /<div id="app"[^>]*>/;
const APP_BLOCK_END = /<\/div><!-- \/#app -->/;

/**
 * Extracts the #app element's direct-child id order from a template's
 * source text, by slicing the `<div id="app" ...> ... </div><!-- /#app -->`
 * block and matching elements indented exactly 4 spaces within it.
 *
 * @param {string} sourceText raw template source text
 * @param {string} label file label for error messages
 * @returns {string[]} direct child ids, in document order
 * @throws {Error} if the #app block markers can't be found — this guard
 *   must fail loudly, not silently return an empty/misleading list.
 */
function parseAppDirectChildIds(sourceText, label) {
  const startMatch = sourceText.match(APP_BLOCK_START);
  const endMatch = sourceText.match(APP_BLOCK_END);
  if (!startMatch || !endMatch || endMatch.index <= startMatch.index) {
    throw new Error(
      `[templateParity.test.mjs] Could not locate the #app block (<div id="app" ...> ... </div><!-- /#app -->) ` +
        `in ${label}. Either the file moved/was restructured, or the #app opening/closing markers changed shape. ` +
        'Update APP_BLOCK_START/APP_BLOCK_END in templateParity.test.mjs to match the new markup.',
    );
  }
  const blockStart = startMatch.index + startMatch[0].length;
  const blockEnd = endMatch.index;
  const block = sourceText.slice(blockStart, blockEnd);

  const childIds = [];
  const directChildRe = /^ {4}<(?:button|div)\s+[^>]*\bid="([^"]+)"[^>]*>/gm;
  let m;
  while ((m = directChildRe.exec(block)) !== null) {
    childIds.push(m[1]);
  }
  if (childIds.length === 0) {
    throw new Error(
      `[templateParity.test.mjs] Found the #app block in ${label} but extracted zero direct child ids — the ` +
        '4-space indent assumption for direct children may no longer hold. Update the regex in ' +
        'parseAppDirectChildIds().',
    );
  }
  return childIds;
}

test('parseAppDirectChildIds: standalone and VS Code templates agree on #app direct child id order', () => {
  assert.ok(fs.existsSync(SERVER_MJS_PATH), `server.mjs not found at resolved path: ${SERVER_MJS_PATH}`);
  assert.ok(fs.existsSync(PANEL_TS_PATH), `panel.ts not found at resolved path: ${PANEL_TS_PATH}`);

  const standaloneIds = parseAppDirectChildIds(fs.readFileSync(SERVER_MJS_PATH, 'utf8'), 'standalone/src/server.mjs');
  const vscodeIds = parseAppDirectChildIds(fs.readFileSync(PANEL_TS_PATH, 'utf8'), 'src/host/vscode/panel.ts');

  assert.deepEqual(
    standaloneIds,
    vscodeIds,
    `#app direct child id order drifted between templates.\n  standalone: ${JSON.stringify(standaloneIds)}\n  vscode:     ${JSON.stringify(vscodeIds)}`,
  );
});

test('#menu-btn and #menu-popover are direct #app children, in order, before #stage-area (standalone)', () => {
  const ids = parseAppDirectChildIds(fs.readFileSync(SERVER_MJS_PATH, 'utf8'), 'standalone/src/server.mjs');
  const btnIdx = ids.indexOf('menu-btn');
  const popoverIdx = ids.indexOf('menu-popover');
  const stageIdx = ids.indexOf('stage-area');
  assert.ok(btnIdx !== -1, 'menu-btn must be a direct #app child');
  assert.ok(popoverIdx !== -1, 'menu-popover must be a direct #app child');
  assert.ok(stageIdx !== -1, 'stage-area must be a direct #app child');
  assert.ok(btnIdx < popoverIdx, 'menu-btn must precede menu-popover');
  assert.ok(popoverIdx < stageIdx, 'menu-btn/menu-popover must precede stage-area (not nested inside it)');
});

test('#menu-btn and #menu-popover are direct #app children, in order, before #stage-area (VS Code)', () => {
  const ids = parseAppDirectChildIds(fs.readFileSync(PANEL_TS_PATH, 'utf8'), 'src/host/vscode/panel.ts');
  const btnIdx = ids.indexOf('menu-btn');
  const popoverIdx = ids.indexOf('menu-popover');
  const stageIdx = ids.indexOf('stage-area');
  assert.ok(btnIdx !== -1, 'menu-btn must be a direct #app child');
  assert.ok(popoverIdx !== -1, 'menu-popover must be a direct #app child');
  assert.ok(stageIdx !== -1, 'stage-area must be a direct #app child');
  assert.ok(btnIdx < popoverIdx, 'menu-btn must precede menu-popover');
  assert.ok(popoverIdx < stageIdx, 'menu-btn/menu-popover must precede stage-area (not nested inside it)');
});

test('parseAppDirectChildIds: throws (does not silently return empty) when #app markers are absent', () => {
  const fixtureWithoutApp = `<div id="other">\n    <div id="thing"></div>\n</div>`;
  assert.throws(() => parseAppDirectChildIds(fixtureWithoutApp, 'fixture'), /Could not locate the #app block/);
});

// ---------------------------------------------------------------------------
// p19-t3: the Settings "Agents" and "Keyword routing" sections moved into
// what used to be the Routing modal — #menu-routing's id is kept (webview
// message wiring and every existing test's `getElementById("menu-routing")`
// depend on it), but its VISIBLE label changed from "Routing" to "Agents"
// in both hosts' static markup. A future edit could silently revert one
// template's label without the other (or without media/main.js's own
// `title.textContent = "Agents"` for the modal heading it builds) — this
// guard makes that drift loud.
// ---------------------------------------------------------------------------

/**
 * Extracts the visible label text of `<button ... id="menu-routing">LABEL</button>`
 * from a template's source text.
 *
 * @param {string} sourceText raw template source text
 * @param {string} label file label for error messages
 * @returns {string} the button's inner text
 * @throws {Error} if #menu-routing can't be found — fail loudly, not silently.
 */
function parseMenuRoutingLabel(sourceText, label) {
  const m = sourceText.match(/<button[^>]*\bid="menu-routing"[^>]*>([^<]*)<\/button>/);
  if (!m) {
    throw new Error(
      `[templateParity.test.mjs] Could not locate a '<button ... id="menu-routing">...</button>' element in ` +
        `${label}. Either the element moved/was restructured, or its id changed. Update the regex in ` +
        'parseMenuRoutingLabel() to match the new shape.',
    );
  }
  return m[1].trim();
}

test('#menu-routing renders the label "Agents" (not "Routing") in the standalone template', () => {
  const label = parseMenuRoutingLabel(fs.readFileSync(SERVER_MJS_PATH, 'utf8'), 'standalone/src/server.mjs');
  assert.equal(label, 'Agents', '#menu-routing kept its id (webview wiring depends on it) but its visible label must read "Agents"');
});

test('#menu-routing renders the label "Agents" (not "Routing") in the VS Code template', () => {
  const label = parseMenuRoutingLabel(fs.readFileSync(PANEL_TS_PATH, 'utf8'), 'src/host/vscode/panel.ts');
  assert.equal(label, 'Agents', '#menu-routing kept its id (webview wiring depends on it) but its visible label must read "Agents"');
});

test('#menu-routing label is byte-identical between both templates', () => {
  const standaloneLabel = parseMenuRoutingLabel(fs.readFileSync(SERVER_MJS_PATH, 'utf8'), 'standalone/src/server.mjs');
  const vscodeLabel = parseMenuRoutingLabel(fs.readFileSync(PANEL_TS_PATH, 'utf8'), 'src/host/vscode/panel.ts');
  assert.equal(standaloneLabel, vscodeLabel, `#menu-routing label drifted between templates: standalone="${standaloneLabel}" vscode="${vscodeLabel}"`);
});

test('parseMenuRoutingLabel: throws (does not silently return empty) when #menu-routing is absent', () => {
  const fixtureWithoutButton = `<button id="menu-settings">Settings</button>`;
  assert.throws(() => parseMenuRoutingLabel(fixtureWithoutButton, 'fixture'), /Could not locate/);
});
