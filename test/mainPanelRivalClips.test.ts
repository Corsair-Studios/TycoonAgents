import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RIVAL_CLIPS } from '../src/extension/themePlan';

// media/main.js is a hand-edited browser file that embeds a copy of RIVAL_CLIPS.
// Tests run from repo root (process.cwd()), so we can read it directly. This
// mirrors test/mainPanelClips.test.ts so the compact rival clip contract cannot
// drift between src/extension/themePlan.ts and media/main.js.

function extractMainJsRivalClips(): Record<string, unknown> {
  const mainPath = join(process.cwd(), 'media', 'main.js');
  const src = readFileSync(mainPath, 'utf8');

  const declIdx = src.indexOf('const RIVAL_CLIPS = {');
  assert.ok(declIdx !== -1, 'Could not find "const RIVAL_CLIPS = {" in media/main.js');

  const braceStart = src.indexOf('{', declIdx + 'const RIVAL_CLIPS ='.length);
  assert.ok(braceStart !== -1, 'Could not find opening brace after "const RIVAL_CLIPS =" in media/main.js');

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
  assert.ok(end !== -1, 'Could not find closing brace for RIVAL_CLIPS object in media/main.js');

  const literal = src.slice(braceStart, end + 1);
  // eslint-disable-next-line no-new-func
  return new Function('return (' + literal + ')')() as Record<string, unknown>;
}

test('media/main.js RIVAL_CLIPS has the same keys as canonical themePlan.ts', () => {
  const embedded = extractMainJsRivalClips();
  const canonicalKeys = Object.keys(RIVAL_CLIPS).sort();
  const embeddedKeys = Object.keys(embedded).sort();
  assert.deepEqual(embeddedKeys, canonicalKeys,
    `Key mismatch — canonical: [${canonicalKeys}], embedded: [${embeddedKeys}]`);
});

test('media/main.js RIVAL_CLIPS matches canonical RIVAL_CLIPS in themePlan.ts', () => {
  const embedded = extractMainJsRivalClips();
  assert.deepEqual(embedded, RIVAL_CLIPS as unknown as Record<string, unknown>,
    'media/main.js RIVAL_CLIPS has drifted from src/extension/themePlan.ts RIVAL_CLIPS');
});

test('RIVAL_CLIPS is the compact 5-frame contract (2 walk + 3 attack)', () => {
  assert.deepEqual(RIVAL_CLIPS.walk.frames, [0, 1]);
  assert.deepEqual(RIVAL_CLIPS.attack.frames, [2, 3, 4]);
  assert.equal(RIVAL_CLIPS.walk.loop, true);
  assert.equal(RIVAL_CLIPS.attack.loop, false);
  assert.equal(RIVAL_CLIPS.attack.pingpong, undefined);
  assert.equal(RIVAL_CLIPS.walk.flippable, true);
  assert.equal(RIVAL_CLIPS.attack.flippable, true);
});
