import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAchievementAtlasPrompt,
  buildCharacterAtlasPrompt,
  buildEnvironmentPrompt,
  buildExpressionAtlasPrompt,
  buildObjectAtlasPrompt,
  CHARACTER_TARGET_CONTENT_HEIGHT,
  CHARACTER_TARGET_CONTENT_PERCENT,
} from '../src/extension/themeAssetPrompts';

test('character prompt enforces the production sprite-board mime contracts', () => {
  const prompt = buildCharacterAtlasPrompt('neon cyberpunk', 'Nova', 'Night Grid');
  assert.match(prompt, /EXACT SAME character[\s\S]*\*\*"Nova"\*\* from the \*\*Night Grid\*\* theme/i);
  assert.match(prompt, /exact \*\*5-column by 4-row grid\*\* containing \*\*20 equal-sized cells\*\*/i);
  assert.match(prompt, /outer image canvas is exactly \*\*512 x 512 pixels \(1:1\)\*\*/i);
  assert.match(prompt, /TOOL HANDLING ANIMATION[\s\S]*tool always swings through empty magenta space/i);
  assert.match(prompt, /INVISIBLE CHAIR CONTRACT \(ABSOLUTE\)[\s\S]*support is completely invisible/i);
  assert.match(prompt, /EMPTY TARGET CONTRACT \(HIGHEST PRIORITY\)[\s\S]*No construction result/i);
  assert.match(prompt, /playful, non-graphic, non-contact actions/i);
  assert.equal(CHARACTER_TARGET_CONTENT_HEIGHT, 104);
  assert.equal(CHARACTER_TARGET_CONTENT_PERCENT, 81.25);
  assert.match(prompt, /complete character from head to feet occupies exactly 81\.25% of the cell height/i);
  assert.match(prompt, /81\.25% against each individual cell/i);
  assert.match(prompt, /below 78% or above 85%.*incorrect result/i);
  assert.match(prompt, /Do not leave oversized magenta margins/i);
  assert.match(prompt, /visible magenta gutter at every horizontal row boundary/i);
  assert.match(prompt, /safety padding below both feet/i);
  assert.doesNotMatch(prompt, /Melee strike|Ranged fire/i);
  assert.match(prompt, /solid \*\*#FF00FF\*\*/i);
  assert.match(prompt, /Theme: Night Grid[\s\S]*neon cyberpunk/i);
  assert.doesNotMatch(prompt, /Circuit Broker|Cyberpunk 2049/i);
  assert.doesNotMatch(prompt, /place\/build object|inspect finished work/i);
});

test('environment prompt treats the reference as an opaque geometry guide', () => {
  const prompt = buildEnvironmentPrompt('neon cyberpunk', 'Night Grid');
  assert.match(prompt, /OPAQUE GEOMETRY GUIDE/);
  assert.match(prompt, /OUTSIDE THE ASSET.*cyan \(#00FFFF\)/i);
  assert.match(prompt, /exact outer hexagonal stage silhouette/i);
  assert.match(prompt, /No characters/i);
});

test('aggregate prompts define the 12 object, 16 expression, and 20 badge contracts', () => {
  const objects = buildObjectAtlasPrompt(
    'industrial',
    'Factory',
    Array.from({ length: 12 }, (_unused, index) => ({
      object_id: `object_${index + 1}`,
      display_name: `Object ${index + 1}`,
    })),
  );
  assert.match(objects, /outer image canvas is exactly \*\*512 x 512 pixels \(1:1\)\*\*/i);
  assert.match(objects, /exact 4-column by 3-row grid with 12 equal cells/i);
  assert.match(objects, /Cell 12: Object 12/);

  const expressions = buildExpressionAtlasPrompt(
    'industrial',
    'Factory',
    Array.from({ length: 16 }, (_unused, index) => `Expression ${index + 1}`),
  );
  assert.match(expressions, /outer image canvas is exactly \*\*512 x 512 pixels \(1:1\)\*\*/i);
  assert.match(expressions, /exact 4-column by 4-row grid with 16 equal cells/i);
  assert.match(expressions, /Cell 16: Expression 16/);

  const achievements = buildAchievementAtlasPrompt(
    'industrial',
    'Factory',
    Array.from({ length: 20 }, (_unused, index) => `Badge ${index + 1}`),
  );
  assert.match(achievements, /outer image canvas is exactly \*\*512 x 512 pixels \(1:1\)\*\*/i);
  assert.match(achievements, /exact 5-column by 4-row grid with 20 equal cells/i);
  assert.match(achievements, /Cell 20: Badge 20/);
  assert.match(achievements, /do not include unlock requirements/i);
});
