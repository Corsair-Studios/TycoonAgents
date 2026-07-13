import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OBJECT_CLIPS } from '../src/extension/themePlan';

// media/main.js is a hand-edited browser file that embeds a copy of OBJECT_CLIPS
// (it can't import from src/ — it's loaded directly by the webview with no
// bundler). Tests run from repo root (process.cwd()), so we can read it
// directly. This mirrors test/webviewAtlasClips.test.ts so the buildable-object
// animation clip contract (poof/object_idle/crate) cannot drift between
// src/extension/themePlan.ts and media/main.js.

function extractMainJsObjectClips(): Record<string, unknown> {
  const mainPath = join(process.cwd(), 'media', 'main.js');
  const src = readFileSync(mainPath, 'utf8');

  const declIdx = src.indexOf('const OBJECT_CLIPS = {');
  assert.ok(declIdx !== -1, 'Could not find "const OBJECT_CLIPS = {" in media/main.js');

  const braceStart = src.indexOf('{', declIdx + 'const OBJECT_CLIPS ='.length);
  assert.ok(braceStart !== -1, 'Could not find opening brace after "const OBJECT_CLIPS =" in media/main.js');

  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end !== -1, 'Could not find closing brace for OBJECT_CLIPS object in media/main.js');

  const literal = src.slice(braceStart, end + 1);
  // eslint-disable-next-line no-new-func
  return new Function('return (' + literal + ')')() as Record<string, unknown>;
}

test('media/main.js OBJECT_CLIPS has the same keys as canonical themePlan.ts', () => {
  const embedded = extractMainJsObjectClips();
  const canonicalKeys = Object.keys(OBJECT_CLIPS).sort();
  const embeddedKeys = Object.keys(embedded).sort();
  assert.deepEqual(embeddedKeys, canonicalKeys,
    `Key mismatch — canonical: [${canonicalKeys}], embedded: [${embeddedKeys}]`);
});

test('media/main.js OBJECT_CLIPS matches canonical OBJECT_CLIPS in themePlan.ts', () => {
  const embedded = extractMainJsObjectClips();
  assert.deepEqual(embedded, OBJECT_CLIPS as unknown as Record<string, unknown>,
    'media/main.js OBJECT_CLIPS has drifted from src/extension/themePlan.ts OBJECT_CLIPS');
});
