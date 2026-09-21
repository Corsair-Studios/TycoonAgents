import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CSS-aware visibility helper for JSDOM tests.
 *
 * JSDOM does not apply stylesheets, so a test that only inspects inline
 * `style.display` or the `hidden` attribute can miss an element hidden by a
 * class/id rule in media/style.css (see the v0.0.647 #metrics-table bug:
 * `.metrics-table-hidden { display: none }` was added to a class that
 * renderMetricsTable() never removed, and no test caught it because JSDOM
 * ignores CSS).
 *
 * This parses media/style.css for `display: none` rules whose selector is a
 * SIMPLE class (`.foo`) or id (`#foo`) selector — including simple
 * comma-separated lists of those — and ignores anything more complex
 * (descendant/combinator selectors, pseudo-classes, attribute selectors,
 * media queries' inner content still counts as a rule but the query itself
 * is not evaluated). That is enough to catch "this element (or one of its
 * classes) has a rule that hides it" without building a real CSS engine.
 */

const DEFAULT_CSS_PATH = join(process.cwd(), 'media', 'style.css');

export interface HiddenSelectors {
  classes: Set<string>;
  ids: Set<string>;
}

/**
 * Parse a stylesheet and return the set of simple class names / element ids
 * that have a `display: none` declaration in a simple selector rule.
 *
 * @param cssPath defaults to media/style.css, override with TYCOON_WEBVIEW_CSS
 */
export function parseHiddenSelectors(cssPath?: string): HiddenSelectors {
  const path = cssPath || process.env.TYCOON_WEBVIEW_CSS || DEFAULT_CSS_PATH;
  const src = readFileSync(path, 'utf8');
  // Strip comments so `/* .foo { display: none } */` examples in comments
  // (there are several in this codebase) never get parsed as real rules.
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '');

  const classes = new Set<string>();
  const ids = new Set<string>();

  // Match `<selector-list> { ...declarations... }` blocks.
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(stripped)) !== null) {
    const selectorList = m[1].trim();
    const body = m[2];
    if (!selectorList) continue;
    // Only treat as "display: none" if that exact declaration is present
    // (allow whitespace, trailing !important).
    if (!/display\s*:\s*none\s*(!important)?\s*;?/.test(body)) continue;

    for (const rawSelector of selectorList.split(',')) {
      const sel = rawSelector.trim();
      // Simple selector only: exactly one `.class` or `#id` token, nothing
      // else (no descendant combinators, attribute selectors, pseudo-*,
      // element-type prefixes). This deliberately ignores complex
      // selectors per the task's "ignore complex selectors" instruction.
      const classMatch = /^\.([A-Za-z0-9_-]+)$/.exec(sel);
      const idMatch = /^#([A-Za-z0-9_-]+)$/.exec(sel);
      if (classMatch) classes.add(classMatch[1]);
      else if (idMatch) ids.add(idMatch[1]);
    }
  }

  return { classes, ids };
}

/**
 * True if the element is visible: not hidden via the `hidden` attribute/
 * property, and none of its classes or its id matches a simple
 * `display: none` rule found by parseHiddenSelectors().
 */
export function isVisible(el: { hidden?: boolean; id?: string; className?: string } | null | undefined, hiddenSelectors: HiddenSelectors): boolean {
  if (!el) return false;
  if (el.hidden) return false;
  if (el.id && hiddenSelectors.ids.has(el.id)) return false;
  const classList = (el.className || '').split(/\s+/).filter(Boolean);
  for (const cls of classList) {
    if (hiddenSelectors.classes.has(cls)) return false;
  }
  return true;
}
