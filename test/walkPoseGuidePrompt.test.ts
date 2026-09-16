import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCharacterAtlasPrompt } from '../src/extension/themeAssetPrompts';
import { WALK_POSE_GUIDE_PARAGRAPHS } from '../src/core/walkPoseGuidePrompts';

const HEADING = 'Walk pose guide (row 1, cells 1-4):';
const ROW_2_HEADING = '## Row 2 (Cells 6-10)';

function build(walkPoseGuide?: 'biped' | 'quadruped'): string {
  return buildCharacterAtlasPrompt(
    'test creative direction',
    'Test Character',
    'Test Theme',
    'magenta',
    undefined,
    walkPoseGuide ? { walkPoseGuide } : undefined,
  );
}

test('no walkPoseGuide option yields a prompt without the paragraph', () => {
  const prompt = build();
  assert.ok(!prompt.includes(HEADING));
});

test('walkPoseGuide: biped includes the biped paragraph, not the quadruped one', () => {
  const prompt = build('biped');
  assert.ok(prompt.includes(WALK_POSE_GUIDE_PARAGRAPHS.biped));
  assert.ok(!prompt.includes(WALK_POSE_GUIDE_PARAGRAPHS.quadruped));
});

test('walkPoseGuide: quadruped includes the quadruped paragraph, not the biped one', () => {
  const prompt = build('quadruped');
  assert.ok(prompt.includes(WALK_POSE_GUIDE_PARAGRAPHS.quadruped));
  assert.ok(!prompt.includes(WALK_POSE_GUIDE_PARAGRAPHS.biped));
});

test('the paragraph appears before the row-2 heading', () => {
  const bipedPrompt = build('biped');
  const quadrupedPrompt = build('quadruped');
  const bipedIdx = bipedPrompt.indexOf(WALK_POSE_GUIDE_PARAGRAPHS.biped);
  const quadrupedIdx = quadrupedPrompt.indexOf(WALK_POSE_GUIDE_PARAGRAPHS.quadruped);
  assert.ok(bipedIdx >= 0 && bipedIdx < bipedPrompt.indexOf(ROW_2_HEADING));
  assert.ok(quadrupedIdx >= 0 && quadrupedIdx < quadrupedPrompt.indexOf(ROW_2_HEADING));
});

for (const plan of ['biped', 'quadruped'] as const) {
  test(`the ${plan} paragraph contains the required frame/side/color phrases`, () => {
    const paragraph = WALK_POSE_GUIDE_PARAGRAPHS[plan];
    for (const phrase of ['Frame 1', 'Frame 2', 'Frame 3', 'Frame 4', 'screen-right', 'RED', 'BLUE']) {
      assert.ok(paragraph.includes(phrase), `expected "${plan}" paragraph to include "${phrase}"`);
    }
  });
}
