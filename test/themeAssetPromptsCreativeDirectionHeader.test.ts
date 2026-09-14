import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAchievementAtlasPrompt,
  buildBackgroundDecorPrompt,
  buildCharacterAtlasPrompt,
  buildEmoteAtlasPrompt,
  buildEnvironmentPrompt,
  buildExpressionAtlasPrompt,
  buildObjectBoard1Prompt,
  buildObjectBoard2Prompt,
  buildRivalAtlasPrompt,
  createDecorBoardRows,
  createObjectBoard1Rows,
  createObjectBoard2Rows,
  createRivalBoardRows,
  OBJECT_ANIMATED_COUNT,
  OBJECT_BOARD1_STATIC_COUNT,
  OBJECT_BOARD2_STATIC_COUNT,
} from '../src/extension/themeAssetPrompts';

const HEADER = 'Art direction (governs everything below): a moody neon skyline';

function decorSpecs() {
  return Array.from({ length: 9 }, (_unused, index) => ({
    decor_id: `d_${index + 1}`,
    display_name: `Decor ${index + 1}`,
  }));
}

function rivalSpecs(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    rival_id: `r_${index + 1}`,
    display_name: `Rival ${index + 1}`,
  }));
}

function staticObjectSpecs(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    object_id: `o_${index + 1}`,
    display_name: `Object ${index + 1}`,
  }));
}

function animatedObjectSpecs(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    object_id: `a_${index + 1}`,
    display_name: `Animated ${index + 1}`,
  }));
}

function board2StaticObjectSpecs(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    object_id: `s_${index + 1}`,
    display_name: `Static ${index + 1}`,
  }));
}

const builders: Array<[string, () => string]> = [
  ['buildRivalAtlasPrompt', () => buildRivalAtlasPrompt(
    'a moody neon skyline', 'Night Grid', createRivalBoardRows(rivalSpecs(4))[0],
  )],
  ['buildEnvironmentPrompt', () => buildEnvironmentPrompt('a moody neon skyline', 'Night Grid')],
  ['buildObjectBoard1Prompt', () => buildObjectBoard1Prompt(
    'a moody neon skyline', 'Night Grid', createObjectBoard1Rows(staticObjectSpecs(OBJECT_BOARD1_STATIC_COUNT)),
  )],
  ['buildObjectBoard2Prompt', () => buildObjectBoard2Prompt(
    'a moody neon skyline', 'Night Grid',
    createObjectBoard2Rows(animatedObjectSpecs(OBJECT_ANIMATED_COUNT), board2StaticObjectSpecs(OBJECT_BOARD2_STATIC_COUNT)),
  )],
  ['buildBackgroundDecorPrompt', () => buildBackgroundDecorPrompt(
    'a moody neon skyline', 'Night Grid', createDecorBoardRows(decorSpecs()),
  )],
  ['buildExpressionAtlasPrompt', () => buildExpressionAtlasPrompt(
    'a moody neon skyline', 'Night Grid', new Array(8).fill('happy'),
  )],
  ['buildAchievementAtlasPrompt', () => buildAchievementAtlasPrompt(
    'a moody neon skyline', 'Night Grid', ['First Build'],
  )],
  ['buildEmoteAtlasPrompt', () => buildEmoteAtlasPrompt('a moody neon skyline', 'Night Grid')],
];

for (const [name, build] of builders) {
  test(`${name} opens with the creative-direction header and has no trailing "Creative direction:" line`, () => {
    const prompt = build();
    assert.ok(
      prompt.startsWith(HEADER),
      `${name} should start with the shared creativeDirectionHeader, got: ${prompt.slice(0, 120)}`,
    );
    const lines = prompt.split('\n');
    assert.notEqual(lines[lines.length - 1].trim().startsWith('Creative direction:'), true,
      `${name} should not end with a trailing "Creative direction:" line`);
    assert.doesNotMatch(prompt, /\nCreative direction: /,
      `${name} should not contain a "Creative direction:" line anywhere in the body`);
  });
}

test('buildCharacterAtlasPrompt remains unchanged: no creativeDirectionHeader and no trailing "Creative direction:" line', () => {
  const prompt = buildCharacterAtlasPrompt('a moody neon skyline', 'Hero', 'Night Grid');
  assert.doesNotMatch(prompt, /^Art direction \(governs everything below\):/);
  assert.doesNotMatch(prompt, /Creative direction: /);
});
