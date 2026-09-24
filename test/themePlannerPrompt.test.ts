/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// translator.ts does `import * as vscode from 'vscode'` at module scope
// (needed by expandThemePrompt/resolvePlannerSettings), but this file only
// exercises buildThemePlanningPrompt, a pure string builder with no vscode
// dependency. Node still can't resolve the 'vscode' module outside the real
// extension host, so stub the module loader the same way
// test/imageClient.test.ts and test/reviewSynthesis.test.ts do.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require('module');
const originalLoad = NodeModule._load;
function makeVscodeStub(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === '__esModule') return true;
      if (!(prop in target)) {
        target[prop] = new Proxy(function stub() {}, handler);
      }
      return target[prop];
    },
    apply() {
      return new Proxy({}, handler);
    },
    construct() {
      return new Proxy({}, handler);
    },
  };
  return new Proxy({}, handler);
}
const vscodeStub = makeVscodeStub();
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildThemePlanningPrompt, buildThemeDescriptionsPrompt } = require('../src/extension/translator') as typeof import('../src/extension/translator');
import {
  FIXED_EXPRESSION_LABELS,
  normalizeThemePlan,
} from '../src/extension/themePlan';

// --- buildThemePlanningPrompt -----------------------------------------------

test('buildThemePlanningPrompt embeds the raw user creative direction', () => {
  const prompt = buildThemePlanningPrompt('a cozy cyberpunk noodle shop');
  assert.match(prompt, /a cozy cyberpunk noodle shop/);
});

test('buildThemePlanningPrompt requests expression_descriptions and achievement_descriptions', () => {
  const prompt = buildThemePlanningPrompt('steampunk airship yard');
  assert.match(prompt, /"expression_descriptions"/);
  assert.match(prompt, /"achievement_descriptions"/);
});

test('buildThemePlanningPrompt embeds all 8 FIXED_EXPRESSION_LABELS so the LLM sees the pinned slot order', () => {
  const prompt = buildThemePlanningPrompt('desert trading post');
  assert.equal(FIXED_EXPRESSION_LABELS.length, 8);
  for (const label of FIXED_EXPRESSION_LABELS) {
    assert.ok(
      prompt.includes(label),
      `expected prompt to contain fixed expression label "${label}"`,
    );
  }
});

test('buildThemePlanningPrompt still requests every other *_descriptions field plus the singular crate/poof descriptions', () => {
  const prompt = buildThemePlanningPrompt('arctic research base');
  assert.match(prompt, /"character_descriptions"/);
  assert.match(prompt, /"object_descriptions"/);
  assert.match(prompt, /"enemy_descriptions"/);
  assert.match(prompt, /"decor_descriptions"/);
  assert.match(prompt, /"crate_description"/);
  assert.match(prompt, /"poof_description"/);
});

test('buildThemePlanningPrompt requests projectile_description as the single ranged-combat projectile appearance spec', () => {
  const prompt = buildThemePlanningPrompt('arctic research base');
  assert.match(prompt, /"projectile_description"/);
  assert.match(prompt, /projectile/i);
  assert.match(prompt, /ranged-combat projectile/i);
  // Called out as a single string, not a per-slot array, and its 4-frame
  // launch/flight/hit/blast animation contract is spelled out for the planner.
  assert.match(prompt, /single string \(not an array\)/i);
  assert.match(prompt, /4-frame sequence/i);
});

test('buildThemePlanningPrompt enforces non-empty, exact-count descriptions', () => {
  const prompt = buildThemePlanningPrompt('haunted carnival');
  assert.match(prompt, /non-empty/i);
  assert.match(prompt, /exactly the required count/i);
});

test('buildThemePlanningPrompt instructs descriptions to omit the entry\'s own name', () => {
  const prompt = buildThemePlanningPrompt('haunted carnival');
  assert.match(prompt, /must NOT include or start with the entry's own name/i);
});

test('buildThemePlanningPrompt does not request editable expression NAMES (labels are fixed, only appearance is asked for)', () => {
  const prompt = buildThemePlanningPrompt('retro diner');
  // The JSON shape must not ask for an "expressions" name array anymore —
  // only "expression_descriptions" (appearance text keyed to the fixed labels).
  assert.doesNotMatch(prompt, /"expressions"\s*:/);
  assert.match(prompt, /fixed/i);
  assert.match(prompt, /MUST NOT be renamed or reordered/);
});

// --- normalizeThemePlan: expression_descriptions / achievement_descriptions -

test('buildThemePlanningPrompt requests expression_descriptions as standalone symbolic ICONS, not a character/face/body', () => {
  const prompt = buildThemePlanningPrompt('pirate cove');
  assert.match(prompt, /\bICON\b/i);
  assert.match(prompt, /NOT a character, face, head, or body/i);
  // At least one concrete icon example is present.
  assert.match(prompt, /heart/i);
  assert.match(prompt, /thumbs/i);
  // Must not instruct the model to draw a character's pose or facial expression.
  assert.doesNotMatch(prompt, /depict a character's (pose|face)/i);
});

test('buildThemePlanningPrompt demands EXACTLY 21 objects, never fewer', () => {
  const prompt = buildThemePlanningPrompt('robot repair yard');
  const lines = prompt.split('\n');
  const objectsLine = lines.find((line) => line.includes('"objects":'));
  const motionHintsLine = lines.find((line) => line.includes('"object_motion_hints":'));
  const descriptionsLine = lines.find((line) => line.includes('"object_descriptions":'));
  for (const line of [objectsLine, motionHintsLine, descriptionsLine]) {
    assert.ok(line, 'expected the line to be present in the prompt');
    assert.match(line as string, /EXACTLY 21/);
    assert.match(line as string, /never fewer/i);
  }
});

test('normalizeThemePlan aligns full-length expression_descriptions(8) and achievement_descriptions(25) by index', () => {
  const expressionDescriptions = Array.from({ length: 8 }, (_, i) => `Expression appearance ${i + 1}`);
  const achievementDescriptions = Array.from({ length: 25 }, (_, i) => `Achievement appearance ${i + 1}`);
  const plan = normalizeThemePlan({
    display_name: 'Full Set',
    expressions: FIXED_EXPRESSION_LABELS.slice(),
    expression_descriptions: expressionDescriptions,
    achievements: Array.from({ length: 25 }, (_, i) => `Badge ${i + 1}`),
    achievement_descriptions: achievementDescriptions,
  });

  assert.equal(plan.expression_descriptions?.length, 8);
  assert.equal(plan.achievement_descriptions?.length, 25);
  for (let i = 0; i < 8; i += 1) {
    assert.equal(plan.expression_descriptions?.[i], `Expression appearance ${i + 1}`);
  }
  for (let i = 0; i < 25; i += 1) {
    assert.equal(plan.achievement_descriptions?.[i], `Achievement appearance ${i + 1}`);
  }
});

test('normalizeThemePlan pads short expression_descriptions/achievement_descriptions to the exact count with empty strings, never dropping or misaligning supplied entries', () => {
  const plan = normalizeThemePlan({
    display_name: 'Short Set',
    expression_descriptions: ['e0', 'e1', 'e2', 'e3', 'e4'], // only 5 of 8
    achievement_descriptions: Array.from({ length: 10 }, (_, i) => `a${i}`), // only 10 of 25
  });

  assert.equal(plan.expression_descriptions?.length, 8);
  for (let i = 0; i < 5; i += 1) assert.equal(plan.expression_descriptions?.[i], `e${i}`);
  for (let i = 5; i < 8; i += 1) assert.equal(plan.expression_descriptions?.[i], '');

  assert.equal(plan.achievement_descriptions?.length, 25);
  for (let i = 0; i < 10; i += 1) assert.equal(plan.achievement_descriptions?.[i], `a${i}`);
  for (let i = 10; i < 25; i += 1) assert.equal(plan.achievement_descriptions?.[i], '');
});

test('normalizeThemePlan leaves expression_descriptions/achievement_descriptions undefined when neither is supplied', () => {
  const plan = normalizeThemePlan({ display_name: 'No Descriptions' });
  assert.equal(plan.expression_descriptions, undefined);
  assert.equal(plan.achievement_descriptions, undefined);
});

test('buildThemeDescriptionsPrompt instructs descriptions to omit the entry\'s own name', () => {
  const plan = normalizeThemePlan({ display_name: 'Neon Harbor', characters: ['Dockmaster'] });
  const prompt = buildThemeDescriptionsPrompt(plan);
  assert.match(prompt, /must NOT include or start with the entry's own name/i);
});
