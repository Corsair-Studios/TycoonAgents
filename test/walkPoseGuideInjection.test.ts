// p58-t3: exercises the pure prompt-assembly side of the walk-pose-guide
// feature — createReviewItems / buildReplacementPrompt (src/extension/themeService.ts)
// deciding, per character_atlas item, whether to thread a walkPoseGuide
// paragraph into item.prompt, gated on attachWalkPoseGuide + extensionRoot +
// the PNG actually existing on disk (poseGuides.ts's loadWalkPoseGuide) and
// effectiveCharacterBodyPlan's explicit-wins-over-inferred resolution.
//
// COVERAGE LIMIT: attachWalkPoseGuideReference — the function that appends
// the loaded PNG into ThemeImageGenerationOptions.referenceImages — is not
// exported from themeService.ts and is only reachable through
// generateAgentAsset/retryThemeImage, which call out to the real image
// generation bridge. Exercising that path would require stubbing the theme
// generation client end to end, which is out of scope here; this file
// instead asserts prompt/image agreement at the level the module exposes:
// the same imageOptions + bodyPlan resolution that gates both the prompt
// paragraph (asserted directly) and the reference-image attachment (verified
// by inspection at src/extension/themeService.ts:3579-3581 and :4399-4402,
// which both call loadWalkPoseGuide with the identical bodyPlan/extensionRoot
// pair used here).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThemeManifest } from '../src/shared/types';
import type { ThemePlan } from '../src/extension/themePlan';

// themeService.ts does `import * as vscode from 'vscode'` at module scope;
// stub it the same way test/themeItemDescriptions.test.ts does so this file's
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
const { createReviewItems, buildReplacementPrompt } = require('../src/extension/themeService') as typeof import('../src/extension/themeService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POSE_GUIDE_FILES } = require('../src/extension/poseGuides') as typeof import('../src/extension/poseGuides');

const HEADING = 'Walk pose guide (row 1, cells 1-4):';
const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeExtensionRootWithGuides(): string {
  const root = mkdtempSync(join(tmpdir(), 'pose-guide-injection-test-'));
  mkdirSync(join(root, 'media', 'pose-guides'), { recursive: true });
  writeFileSync(join(root, POSE_GUIDE_FILES.biped), Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'));
  writeFileSync(join(root, POSE_GUIDE_FILES.quadruped), Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'));
  return root;
}

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

test('character_atlas item with no explicit body_plan infers quadruped from description and attaches the guide', () => {
  const root = makeExtensionRootWithGuides();
  try {
    const manifest = testManifest();
    const plan = testPlan({ character_descriptions: ['a loyal dog companion'] });
    const items = createReviewItems(plan, manifest, plan.creative_direction, 'magenta', {
      attachWalkPoseGuide: true,
      extensionRoot: root,
    });
    const agent = items.find((i) => i.id === 'agent_0')!;
    assert.ok(agent.prompt.includes(HEADING));
    // quadruped paragraph opens with the animal-specific lead-in.
    assert.ok(agent.prompt.includes('show the animal'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing PNG on disk: no paragraph in the prompt (prompt and image attachment agree)', () => {
  // extensionRoot exists but has no media/pose-guides directory at all.
  const root = mkdtempSync(join(tmpdir(), 'pose-guide-injection-missing-'));
  try {
    const manifest = testManifest();
    const plan = testPlan({ character_descriptions: ['a loyal dog companion'] });
    const items = createReviewItems(plan, manifest, plan.creative_direction, 'magenta', {
      attachWalkPoseGuide: true,
      extensionRoot: root,
    });
    const agent = items.find((i) => i.id === 'agent_0')!;
    assert.ok(!agent.prompt.includes(HEADING));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('explicit body_plan "biped" wins over an inferred quadruped description', () => {
  const root = makeExtensionRootWithGuides();
  try {
    const manifest = testManifest();
    const plan = testPlan({
      character_descriptions: ['a loyal dog companion'],
      character_body_plans: ['biped'],
    });
    const items = createReviewItems(plan, manifest, plan.creative_direction, 'magenta', {
      attachWalkPoseGuide: true,
      extensionRoot: root,
    });
    const agent = items.find((i) => i.id === 'agent_0')!;
    assert.ok(agent.prompt.includes(HEADING));
    assert.ok(agent.prompt.includes('the character’s RIGHT side'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('attachWalkPoseGuide: false yields no paragraph', () => {
  const root = makeExtensionRootWithGuides();
  try {
    const manifest = testManifest();
    const plan = testPlan({ character_descriptions: ['a loyal dog companion'] });
    const items = createReviewItems(plan, manifest, plan.creative_direction, 'magenta', {
      attachWalkPoseGuide: false,
      extensionRoot: root,
    });
    const agent = items.find((i) => i.id === 'agent_0')!;
    assert.ok(!agent.prompt.includes(HEADING));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rival item never gets a walk pose guide paragraph', () => {
  const root = makeExtensionRootWithGuides();
  try {
    const manifest = testManifest();
    const plan = testPlan();
    const items = createReviewItems(plan, manifest, plan.creative_direction, 'magenta', {
      attachWalkPoseGuide: true,
      extensionRoot: root,
    });
    const rivalItems = items.filter((i) => i.kind === 'rival_atlas');
    assert.ok(rivalItems.length > 0, 'expected at least one rival_atlas item');
    for (const rival of rivalItems) {
      assert.ok(!rival.prompt.includes(HEADING));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildReplacementPrompt (retry path) agrees with createReviewItems on injection', () => {
  const root = makeExtensionRootWithGuides();
  try {
    const manifest = testManifest();
    const plan = testPlan({ character_descriptions: ['a knight in armor'], character_body_plans: undefined });
    const items = createReviewItems(plan, manifest, plan.creative_direction, 'magenta', {
      attachWalkPoseGuide: true,
      extensionRoot: root,
    });
    const agent = items.find((i) => i.id === 'agent_0')!;
    const retryPrompt = buildReplacementPrompt(
      { ...agent, updated_at: new Date(0).toISOString() },
      plan.creative_direction,
      manifest,
      plan,
      'magenta',
      false,
      { attachWalkPoseGuide: true, extensionRoot: root },
    );
    assert.ok(agent.prompt.includes(HEADING));
    assert.ok(retryPrompt.includes(HEADING));
    assert.ok(retryPrompt.includes('the character’s RIGHT side'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
