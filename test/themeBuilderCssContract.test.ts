/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p80-t2: JSDOM never applies CSS, so DOM-only tests can pass while the real
// UI shows elements whose `hidden` attribute is overridden by author CSS
// (e.g. `.tsp-build-choice-row { display:flex }` beating the UA
// `[hidden]{display:none}`). These tests read media/style.css as source text
// and assert the contract directly, so a regression in the stylesheet fails
// even though jsdom-based DOM tests would still pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS_PATH = process.env.TYCOON_WEBVIEW_CSS || join(process.cwd(), 'media', 'style.css');

function loadCss(): string {
  return readFileSync(CSS_PATH, 'utf8');
}

// Very small CSS rule splitter: good enough for this stylesheet's simple
// selector/declaration-block structure (no nested @media of interest beyond
// what we scan separately), not a general-purpose parser.
function splitRules(css: string): Array<{ selector: string; body: string }> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutComments)) !== null) {
    rules.push({ selector: m[1].trim(), body: m[2] });
  }
  return rules;
}

test('media/style.css declares the global [hidden] { display: none !important; } rule', () => {
  const css = loadCss();
  const rules = splitRules(css);
  const globalHidden = rules.find((r) => r.selector === '[hidden]');
  assert.ok(globalHidden, 'expected a bare [hidden] rule in media/style.css');
  assert.match(globalHidden!.body, /display\s*:\s*none\s*!important/, '[hidden] rule must be display:none !important');
});

test('#themes-dialog has no min-width above 0 and no fixed min-height of 600px or more', () => {
  const css = loadCss();
  const rules = splitRules(css);
  const dialogRules = rules.filter((r) => r.selector.split(',').some((s) => s.trim() === '#themes-dialog'));
  assert.ok(dialogRules.length > 0, 'expected at least one #themes-dialog rule');

  for (const rule of dialogRules) {
    const minWidthMatch = /min-width\s*:\s*([0-9.]+)px/.exec(rule.body);
    if (minWidthMatch) {
      const value = parseFloat(minWidthMatch[1]);
      assert.equal(value, 0, `#themes-dialog min-width must be 0, found ${value}px`);
    }
    const minHeightMatch = /min-height\s*:\s*([0-9.]+)px/.exec(rule.body);
    if (minHeightMatch) {
      const value = parseFloat(minHeightMatch[1]);
      assert.ok(value < 600, `#themes-dialog min-height must be below 600px, found ${value}px`);
    }
  }
});

// p81-t2 / p93: proves the p81-t1 spacing fix (space below the "Back to
// themes" row, moved to CSS since the real webview CSP has no
// 'unsafe-inline' — see themeBuilderCspGuard.test.ts) actually lands in the
// stylesheet. p93 moved this spacing from #tab-theme-picker's own
// margin-bottom onto #theme-builder-topbar's padding-bottom, so the button
// stays vertically centered with the credits pill next to it instead of
// pushing itself down inside the flex row.
test('#theme-builder-topbar declares a padding-bottom of at least 10px (Back to themes spacing)', () => {
  const css = loadCss();
  const rules = splitRules(css);
  const rule = rules.find((r) => r.selector.split(',').some((s) => s.trim() === '#theme-builder-topbar'));
  assert.ok(rule, 'expected a #theme-builder-topbar rule in media/style.css');
  let bottomPx: number | undefined;
  const longhand = /padding-bottom\s*:\s*([0-9.]+)px/.exec(rule!.body);
  if (longhand) {
    bottomPx = parseFloat(longhand[1]);
  } else {
    const shorthand = /(?:^|[;{\s])padding\s*:\s*([^;]+);/.exec(rule!.body);
    assert.ok(shorthand, '#theme-builder-topbar must declare a padding or padding-bottom in px');
    const parts = shorthand![1].trim().split(/\s+/);
    // padding shorthand: top [right [bottom [left]]] — bottom is the 3rd
    // value (index 2) when 3+ values are given, else it mirrors top.
    const bottomToken = parts.length >= 3 ? parts[2] : parts[0];
    const pxMatch = /([0-9.]+)px/.exec(bottomToken);
    assert.ok(pxMatch, `#theme-builder-topbar padding-bottom value must be in px, found "${bottomToken}"`);
    bottomPx = parseFloat(pxMatch![1]);
  }
  assert.ok(bottomPx! >= 10, `#theme-builder-topbar padding-bottom must be >= 10px, found ${bottomPx}px`);
});

test('the review header and action rows declare flex-wrap: wrap', () => {
  const css = loadCss();
  const rules = splitRules(css);

  const headerRule = rules.find((r) =>
    r.selector.split(',').some((s) => s.trim() === '.theme-image-review-header'),
  );
  assert.ok(headerRule, 'expected a .theme-image-review-header rule');
  assert.match(headerRule!.body, /flex-wrap\s*:\s*wrap/, '.theme-image-review-header must declare flex-wrap: wrap');

  const actionsRule = rules.find((r) =>
    r.selector.split(',').some((s) => s.trim() === '.theme-image-review-header-actions'),
  );
  assert.ok(actionsRule, 'expected a .theme-image-review-header-actions rule');
  assert.match(actionsRule!.body, /flex-wrap\s*:\s*wrap/, '.theme-image-review-header-actions must declare flex-wrap: wrap');
});

// Generic guard: any rule targeting one of these builder ids/classes that
// sets `display:` must coexist with the global [hidden]!important rule
// remaining present in the file — i.e. we never regress by deleting the
// global override while author rules still set display on these selectors
// (the exact bug this phase fixed: an author display rule silently beating
// [hidden] because the global !important override was missing/weakened).
test('guard: every builder display rule on hidden-capable selectors coexists with the global [hidden] !important override', () => {
  const css = loadCss();
  const rules = splitRules(css);
  const guardedSelectors = [
    '#theme-prompt-container',
    '.tsp-build-choice-row',
    '.theme-image-settings',
    '.theme-plan-editor',
    '.theme-image-review',
    '#theme-builder-status-chip',
  ];

  const globalHidden = rules.find((r) => r.selector === '[hidden]');
  const hasGlobalHiddenImportant =
    Boolean(globalHidden) && /display\s*:\s*none\s*!important/.test(globalHidden!.body);

  const offendingSelectors: string[] = [];
  for (const rule of rules) {
    const selectors = rule.selector.split(',').map((s) => s.trim());
    for (const guarded of guardedSelectors) {
      const matches = selectors.some((s) => s === guarded || s.startsWith(`${guarded}.`) || s.startsWith(`${guarded} `));
      if (matches && /display\s*:/.test(rule.body) && !hasGlobalHiddenImportant) {
        offendingSelectors.push(`${rule.selector} { ${rule.body.trim()} }`);
      }
    }
  }

  assert.equal(
    offendingSelectors.length,
    0,
    `found display: rules on hidden-capable builder selectors with no global [hidden]!important override present:\n${offendingSelectors.join('\n')}`,
  );
});
