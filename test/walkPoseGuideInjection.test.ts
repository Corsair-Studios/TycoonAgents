// p59-t4: exercises the walk-pose-guide side of createReviewItems /
// buildReplacementPrompt (src/extension/themeService.ts) after the v3.4
// migration removed client-side reference-image attachment: the service now
// always attaches its own pose-guide image for roster_agent attempts
// (docs/theme-service-api.md Migration), so createReviewItems/
// buildReplacementPrompt no longer take attachWalkPoseGuide/extensionRoot —
// the local preview prompt always includes the walk-pose-guide paragraph for
// character boards, keyed only on effectiveCharacterBodyPlan's
// explicit-wins-over-inferred bodyPlan resolution (src/core/bodyPlan.ts).
//
// The cases asserting client-side referenceImages PNG attachment
// (attachWalkPoseGuide: false/PNG-missing-on-disk) are gone with that
// feature; see test/helpers/fakeThemeService.ts / docs/theme-service-api.md
// for the server-side attachment this replaced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ThemeManifest } from '../src/shared/types';
import type { ThemePlan } from '../src/extension/themePlan';

// themeService.ts does `import * as vscode from 'vscode'` at module scope;
// stub it the same way other themeService.ts test files do so this file's
// require chain resolves under plain `node --test`.
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
const { createReviewItems, buildReplacementPrompt, effectiveCharacterBodyPlan } =
  require('../src/extension/themeService') as typeof import('../src/extension/themeService');

const HEADING = 'Walk pose guide (row 1, cells 1-4):';

function testManifest(): ThemeManifest {
  return {
    manifest_version: '1',
    theme_id: 'test_theme',
    display_name: 'Test Theme',
    author: 'test',
    viewport: {
      native_width: 533,
      native_height: 751,
      background_asset: 'frames.json#environment',
      walkable_nav_polygon: [[0, 0], [1, 0], [1, 1], [0, 1]],
    },
    roster_agents: [
      { slot_id: 0, name: 'Agent Zero', atlas_asset: 'frames.json#agent_0', preferred_idle_pose: 'pose_crossed' },
    ],
    roster_rivals: [
      { rival_id: 'rival_roadblock', name: 'Roadblock', atlas_asset: 'frames.json#rival_roadblock' },
    ],
    buildable_objects: [],
    decor_objects: [
      { decor_id: 'seat_01', display_name: 'Seat 01', sprite_asset: 'frames.json#decor_seat_01', anchor_coord: [0.5, 0.5] },
      { decor_id: 'lantern', display_name: 'Lantern', sprite_asset: 'frames.json#decor_lantern', anchor_coord: [0.5, 0.5] },
      { decor_id: 'seat_03', display_name: 'Seat 03', sprite_asset: 'frames.json#decor_seat_03', anchor_coord: [0.5, 0.5] },
      { decor_id: 'seat_04', display_name: 'Seat 04', sprite_asset: 'frames.json#decor_seat_04', anchor_coord: [0.5, 0.5] },
      { decor_id: 'barrel', display_name: 'Barrel', sprite_asset: 'frames.json#decor_barrel', anchor_coord: [0.5, 0.5] },
      { decor_id: 'banner', display_name: 'Banner', sprite_asset: 'frames.json#decor_banner', anchor_coord: [0.5, 0.5] },
      { decor_id: 'crate_stack', display_name: 'Crate Stack', sprite_asset: 'frames.json#decor_crate_stack', anchor_coord: [0.5, 0.5] },
      { decor_id: 'signpost', display_name: 'Signpost', sprite_asset: 'frames.json#decor_signpost', anchor_coord: [0.5, 0.5] },
      { decor_id: 'campfire', display_name: 'Campfire', sprite_asset: 'frames.json#decor_campfire', anchor_coord: [0.5, 0.5] },
    ],
    badges: [],
  };
}

function testPlan(overrides: Partial<ThemePlan> = {}): ThemePlan {
  return {
    version: 1,
    theme_id: 'test_theme',
    display_name: 'Test Theme',
    creative_direction: 'gritty outpost',
    characters: ['Agent Zero'],
    environment: 'a dusty outpost',
    objects: [],
    decor: ['Seat 01', 'Lantern', 'Seat 03', 'Seat 04', 'Barrel', 'Banner', 'Crate Stack', 'Signpost', 'Campfire'],
    enemies: ['Roadblock'],
    expressions: ['happy'],
    achievements: ['First Build'],
    ...overrides,
  };
}

test('body plan with no explicit override infers quadruped from description ("dog") and the local preview prompt includes the walk pose guide paragraph', () => {
  const manifest = testManifest();
  const plan = testPlan({ character_descriptions: ['a loyal dog companion'] });
  assert.equal(effectiveCharacterBodyPlan(plan, 0), 'quadruped');

  const items = createReviewItems(plan, manifest, plan.creative_direction, 'magenta');
  const agent = items.find((i) => i.id === 'agent_0')!;
  assert.ok(agent.prompt.includes(HEADING));
  // quadruped paragraph opens with the animal-specific lead-in.
  assert.ok(agent.prompt.includes('show the animal'));
});

test('explicit body_plan "biped" wins over an inferred quadruped description', () => {
  const manifest = testManifest();
  const plan = testPlan({
    character_descriptions: ['a loyal dog companion'],
    character_body_plans: ['biped'],
  });
  assert.equal(effectiveCharacterBodyPlan(plan, 0), 'biped', 'explicit bodyPlan must win over the inferred description');

  const items = createReviewItems(plan, manifest, plan.creative_direction, 'magenta');
  const agent = items.find((i) => i.id === 'agent_0')!;
  assert.ok(agent.prompt.includes(HEADING));
  assert.ok(agent.prompt.includes('the character’s RIGHT side'));
});

test('rival item never gets a walk pose guide paragraph (roster_agent only)', () => {
  const manifest = testManifest();
  const plan = testPlan();
  const items = createReviewItems(plan, manifest, plan.creative_direction, 'magenta');
  const rivalItems = items.filter((i) => i.kind === 'rival_atlas');
  assert.ok(rivalItems.length > 0, 'expected at least one rival_atlas item');
  for (const rival of rivalItems) {
    assert.ok(!rival.prompt.includes(HEADING));
  }
});

test('non-character boards (environment, objects, decor, expressions, achievements) never get the walk pose guide paragraph', () => {
  const manifest = testManifest();
  const plan = testPlan();
  const items = createReviewItems(plan, manifest, plan.creative_direction, 'magenta');
  for (const item of items) {
    if (item.kind === 'character_atlas') continue;
    assert.ok(!item.prompt.includes(HEADING), `${item.id} (${item.kind}) must not carry the walk pose guide paragraph`);
  }
});

test('buildReplacementPrompt (retry path) agrees with createReviewItems on the walk pose guide paragraph and bodyPlan', () => {
  const manifest = testManifest();
  const plan = testPlan({ character_descriptions: ['a knight in armor'], character_body_plans: undefined });
  const items = createReviewItems(plan, manifest, plan.creative_direction, 'magenta');
  const agent = items.find((i) => i.id === 'agent_0')!;
  const retryPrompt = buildReplacementPrompt(
    { ...agent, updated_at: new Date(0).toISOString() },
    plan.creative_direction,
    manifest,
    plan,
    'magenta',
    false,
  );
  assert.ok(agent.prompt.includes(HEADING));
  assert.ok(retryPrompt.includes(HEADING));
  assert.ok(retryPrompt.includes('the character’s RIGHT side'));
});
