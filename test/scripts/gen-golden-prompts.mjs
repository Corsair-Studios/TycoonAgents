// p59-t4: one-off generator for test/fixtures/prompts/*.txt — run manually
// (`node scripts/gen-golden-prompts.mjs`) after `npx tsc -p .` whenever
// PROMPT_TEMPLATE_VERSION and the fixtures are intentionally re-baselined
// together. test/promptTemplatesGolden.test.ts asserts byte equality against
// these files PLUS that PROMPT_TEMPLATE_VERSION matches VERSION, so a
// template change without regenerating both fails the test suite.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleThemePrompt, PROMPT_TEMPLATE_VERSION } from '../../out/src/core/themePromptTemplates.js';

const DIR = join(process.cwd(), 'test', 'fixtures', 'prompts');

const theme = { description: 'A whimsical steampunk carnival', creativeDirection: 'Brass gears, warm lantern light, playful mischief', palette: ['#8B5E3C', '#D4AF37'] };
const themeName = 'Steampunk Carnival';

const requests = {
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
  'rival_group-mixed': {
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION, theme, themeName,
    boardType: 'rival_group',
    slot: [
      { display_name: 'Rustbolt Goon', visual_description: 'a rusty scrap-metal thug' },
      { display_name: 'Clockwork Hound', visual_description: 'a mechanical guard dog', body_plan: 'quadruped' },
      { display_name: 'Steam Sentry', visual_description: 'a hissing steam-powered guard', body_plan: 'biped' },
      { display_name: 'Brass Panther', visual_description: 'a sleek prowling cat of riveted brass', body_plan: 'quadruped' },
    ],
  },
  objects_01: {
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION, theme, themeName,
    boardType: 'objects_01',
    slot: { items: [
      { display_name: 'Gear Crate', visual_description: 'a wooden crate stamped with a gear' },
      { display_name: 'Weapon Rack', visual_description: 'a rack of steam rifles', is_ranged_rack: true },
    ] },
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
    slot: { expressions: ['happy', 'angry', 'confused', 'excited', 'sleepy', 'love', 'idea', 'dazed'], descriptions: undefined },
  },
  achievements: {
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION, theme, themeName,
    boardType: 'achievements',
    slot: { achievements: ['First Gear', 'Master Tinkerer', 'Steam Powered'], descriptions: undefined },
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

writeFileSync(join(DIR, 'VERSION'), `${PROMPT_TEMPLATE_VERSION}\n`, 'utf8');
for (const [name, req] of Object.entries(requests)) {
  const { prompt } = assembleThemePrompt(req, { walkPoseGuideAttached: true });
  writeFileSync(join(DIR, `${name}.txt`), prompt.replace(/\r\n/g, '\n'), 'utf8');
  console.log('wrote', name);
}
