import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATLAS_CLIPS } from '../src/extension/themePlan';

// test/*.ts compiles to out/test/*.js (see tsconfig.json outDir "out").
// From out/test/animationLabClips.test.js, two '../' reach the repo root
// (out/test/ -> out/ -> root), then into tools/animation-lab/clips.js.
// tools/animation-lab/clips.js is intentionally NOT part of the TS build
// (outside tsconfig include) so it can be loaded unmodified by index.html.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ATLAS_CLIPS: LAB_ATLAS_CLIPS } = require('../../tools/animation-lab/clips.js');

test('lab clips.js ATLAS_CLIPS matches canonical themePlan.ts ATLAS_CLIPS', () => {
  assert.deepEqual(LAB_ATLAS_CLIPS, ATLAS_CLIPS);
});
