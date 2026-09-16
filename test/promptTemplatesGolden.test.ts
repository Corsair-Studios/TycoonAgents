// p59-t4: golden-file coverage for assembleThemePrompt
// (src/core/themePromptTemplates.ts). Fixtures generated once by
// test/scripts/gen-golden-prompts.mjs from the fixed StructuredGenerateRequest
// objects below (kept in sync with that script) and stored at
// test/fixtures/prompts/<boardType>[-<bodyPlan>].txt. A byte-for-byte diff
// here means the assembled prompt text changed without deliberately
// regenerating the fixture; a version mismatch means the template changed
// without bumping PROMPT_TEMPLATE_VERSION (see test/fixtures/prompts/VERSION).
//
// Regenerate: `npx tsc -p .` then `node test/scripts/gen-golden-prompts.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assembleThemePrompt,
  PROMPT_TEMPLATE_VERSION,
  type StructuredGenerateRequest,
} from '../src/core/themePromptTemplates';

const FIXTURES_DIR = join(process.cwd(), 'test', 'fixtures', 'prompts');

const theme = {
  description: 'A whimsical steampunk carnival',
  creativeDirection: 'Brass gears, warm lantern light, playful mischief',
  palette: ['#8B5E3C', '#D4AF37'],
};
const themeName = 'Steampunk Carnival';

// Must exactly mirror test/scripts/gen-golden-prompts.mjs's `requests` map.
const REQUESTS: Record<string, StructuredGenerateRequest> = {
  'roster_agent-biped': {
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION, theme, themeName,
    boardType: 'roster_agent',
    slot: { name: 'Gear Knight', description: 'a brass-plated automaton knight', bodyPlan: 'biped' },
  },
  'roster_agent-quadruped': {
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION, theme, themeName,
    boardType: 'roster_agent',
    slot: { name: 'Clockwork Hound', description: 'a mechanical dog companion', bodyPlan: 'quadruped' },
  },
  rival_group: {
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION, theme, themeName,
    boardType: 'rival_group',
    slot: [
      { display_name: 'Rustbolt Goon', visual_description: 'a rusty scrap-metal thug' },
      { display_name: 'Steam Sentry', visual_description: 'a hissing steam-powered guard' },
    ],
  },
  objects_01: {
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION, theme, themeName,
    boardType: 'objects_01',
    slot: {
      items: [
        { display_name: 'Gear Crate', visual_description: 'a wooden crate stamped with a gear' },
        { display_name: 'Weapon Rack', visual_description: 'a rack of steam rifles', is_ranged_rack: true },
      ],
    },
  },
  objects_02: {
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION, theme, themeName,
    boardType: 'objects_02',
    slot: {
      animated: [
        { display_name: 'Steam Valve', motion_hint: 'periodic steam puffs' },
        { display_name: 'Signal Lantern', motion_hint: 'pulsing glow' },
      ],
      static: [
        { display_name: 'Anvil' },
        { display_name: 'Toolbox' },
        { display_name: 'Spare Gears' },
      ],
      poofDescription: 'brass confetti burst',
      crateDescription: 'a riveted iron crate',
    },
  },
  expressions: {
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION, theme, themeName,
    boardType: 'expressions',
    slot: { expressions: ['happy', 'angry', 'confused', 'excited', 'sleepy', 'love', 'idea', 'dazed'] },
  },
  achievements: {
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION, theme, themeName,
    boardType: 'achievements',
    slot: { achievements: ['First Gear', 'Master Tinkerer', 'Steam Powered'] },
  },
  environment: {
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION, theme, themeName,
    boardType: 'environment',
  },
  background_decor: {
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION, theme, themeName,
    boardType: 'background_decor',
    slot: {
      seats: [{ display_name: 'Iron Stool' }, { display_name: 'Crate Seat' }, { display_name: 'Bench' }, { display_name: 'Barrel Seat' }],
      statics: [{ display_name: 'Lantern Post' }, { display_name: 'Gear Sculpture' }, { display_name: 'Pipe Stack' }, { display_name: 'Sign' }],
      animated: { display_name: 'Steam Vent', visual_description: 'a slow venting steam pipe' },
      projectileDescription: 'a glowing steam bolt',
    },
  },
  emotes: {
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION, theme, themeName,
    boardType: 'emotes',
  },
};

test('PROMPT_TEMPLATE_VERSION matches the golden fixtures\' recorded VERSION', () => {
  const recorded = readFileSync(join(FIXTURES_DIR, 'VERSION'), 'utf8').trim();
  assert.equal(
    PROMPT_TEMPLATE_VERSION,
    recorded,
    'src/core/themePromptTemplates.ts PROMPT_TEMPLATE_VERSION changed without regenerating test/fixtures/prompts (see test/scripts/gen-golden-prompts.mjs)',
  );
});

for (const [name, req] of Object.entries(REQUESTS)) {
  test(`assembleThemePrompt(${name}) matches its golden fixture byte for byte`, () => {
    const expected = readFileSync(join(FIXTURES_DIR, `${name}.txt`), 'utf8');
    const { prompt, templateVersion } = assembleThemePrompt(req, { walkPoseGuideAttached: true });
    assert.equal(prompt, expected);
    assert.equal(templateVersion, PROMPT_TEMPLATE_VERSION);
  });
}
