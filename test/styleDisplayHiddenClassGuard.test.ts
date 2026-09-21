import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseHiddenSelectors } from './helpers/cssVisibility';

/*
 * Static guard for the v0.0.647 regression pattern (commit 09396c8):
 * an element id whose markup carries a class that a media/style.css rule
 * hides with `display: none` must never be shown from JS via
 * `<el>.style.display = <non-"none">` — that assignment cannot override a
 * class rule, so the element stays hidden. The fix is always to toggle the
 * class, or (as done for #metrics-table) use the plain `hidden` attribute
 * instead of a class.
 *
 * For every id in the webview's static markup (src/host/vscode/panel.ts's
 * _getHtmlForWebview()) that has a class matching a `display: none` rule in
 * media/style.css, this fails if any media/src/main/*.js file assigns to
 * `.style.display` on a getElementById lookup of that id, OR on a variable
 * bound directly from `getElementById("<id>")`.
 */

const PANEL_TS_PATH = process.env.TYCOON_PANEL_TS_PATH || join(process.cwd(), 'src', 'host', 'vscode', 'panel.ts');
const MAIN_SRC_DIR = process.env.TYCOON_WEBVIEW_SRC_DIR || join(process.cwd(), 'media', 'src', 'main');

interface MarkupIdInfo {
  id: string;
  classes: string[];
}

function extractMarkupIds(panelTsSrc: string): MarkupIdInfo[] {
  const out: MarkupIdInfo[] = [];
  // Match opening tags carrying both id="..." and class="..." in either order.
  const tagRe = /<[a-zA-Z][^>]*\bid="([^"]+)"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(panelTsSrc)) !== null) {
    const tag = m[0];
    const id = m[1];
    const classMatch = /\bclass="([^"]+)"/.exec(tag);
    const classes = classMatch ? classMatch[1].split(/\s+/).filter(Boolean) : [];
    out.push({ id, classes });
  }
  return out;
}

function listJsFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => join(dir, f));
}

test('no JS in media/src/main sets .style.display on an id whose class rule sets display:none', () => {
  const panelSrc = readFileSync(PANEL_TS_PATH, 'utf8');
  const hiddenSelectors = parseHiddenSelectors();
  const markupIds = extractMarkupIds(panelSrc);

  // ids whose static markup carries a class matched by a display:none rule.
  const riskyIds = markupIds
    .filter((info) => info.classes.some((c) => hiddenSelectors.classes.has(c)))
    .map((info) => info.id);

  if (riskyIds.length === 0) return; // nothing currently at risk

  const jsFiles = listJsFiles(MAIN_SRC_DIR);
  const violations: string[] = [];

  for (const file of jsFiles) {
    const src = readFileSync(file, 'utf8');
    for (const id of riskyIds) {
      // Pattern A: getElementById("id") ... .style.display = ... chained
      // directly (covers `document.getElementById("id").style.display = x`).
      const directRe = new RegExp(
        String.raw`getElementById\(\s*["']${id}["']\s*\)[^;]*\.style\.display\s*=`,
        'g'
      );
      if (directRe.test(src)) {
        violations.push(`${file}: getElementById("${id}") chained directly to .style.display = ...`);
      }

      // Pattern B: a variable assigned from getElementById("id"), later
      // used as `<var>.style.display = ...`. Find variable name(s) bound to
      // this id, then search for `.style.display =` on that identifier.
      const varRe = new RegExp(
        String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;]*getElementById\(\s*["']${id}["']\s*\)`,
        'g'
      );
      let vm2: RegExpExecArray | null;
      while ((vm2 = varRe.exec(src)) !== null) {
        const varName = vm2[1];
        const useRe = new RegExp(String.raw`\b${varName}\s*\.\s*style\s*\.\s*display\s*=`);
        if (useRe.test(src)) {
          violations.push(`${file}: variable "${varName}" (bound to getElementById("${id}")) is assigned via .style.display = ...`);
        }
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Found id(s) whose static class rule hides them with display:none, but JS still toggles ` +
    `visibility via .style.display (which cannot override a class rule):\n${violations.join('\n')}`
  );
});
