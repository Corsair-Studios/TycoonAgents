import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATLAS_CLIPS } from '../src/extension/themePlan';

// media/main.js is a hand-edited browser file that embeds a copy of ATLAS_CLIPS.
// Tests run from repo root (process.cwd()), so we can read it directly.

function extractMainJsClips(): Record<string, unknown> {
  const mainPath = join(process.cwd(), 'media', 'main.js');
  const src = readFileSync(mainPath, 'utf8');

  // Find the declaration
  const declIdx = src.indexOf('const ATLAS_CLIPS = {');
  assert.ok(declIdx !== -1, 'Could not find "const ATLAS_CLIPS = {" in media/main.js');

  // Find the opening brace of the object literal
  const braceStart = src.indexOf('{', declIdx + 'const ATLAS_CLIPS ='.length);
  assert.ok(braceStart !== -1, 'Could not find opening brace after "const ATLAS_CLIPS =" in media/main.js');

  // Balanced-brace scan to find the matching closing brace
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
  assert.ok(end !== -1, 'Could not find closing brace for ATLAS_CLIPS object in media/main.js');

  const literal = src.slice(braceStart, end + 1);
  // Safely evaluate the plain JS object literal
  // eslint-disable-next-line no-new-func
  return new Function('return (' + literal + ')')() as Record<string, unknown>;
}

test('media/main.js ATLAS_CLIPS has the same keys as canonical themePlan.ts', () => {
  const embedded = extractMainJsClips();
  const canonicalKeys = Object.keys(ATLAS_CLIPS).sort();
  const embeddedKeys = Object.keys(embedded).sort();
  assert.deepEqual(embeddedKeys, canonicalKeys,
    `Key mismatch — canonical: [${canonicalKeys}], embedded: [${embeddedKeys}]`);
});

test('media/main.js ATLAS_CLIPS matches canonical ATLAS_CLIPS in themePlan.ts', () => {
  const embedded = extractMainJsClips();
  assert.deepEqual(embedded, ATLAS_CLIPS as unknown as Record<string, unknown>,
    'media/main.js ATLAS_CLIPS has drifted from src/extension/themePlan.ts ATLAS_CLIPS');
});
