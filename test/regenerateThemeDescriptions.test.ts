import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ThemeManifest } from '../src/shared/types';
import type { ThemePlan } from '../src/extension/themePlan';

// regenerateThemeDescriptions (src/extension/themeService.ts) is genuine IO —
// same vscode stub-with-real-fs trick as test/themeCreativeDirection.test.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require('module');
const originalLoad = NodeModule._load;

function makeUri(fsPath: string) {
  return {
    fsPath,
    path: fsPath.split(path.sep).join('/'),
    toString: () => fsPath,
  };
}

function makeVscodeStub(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const target: any = {
    Uri: {
      file: (p: string) => makeUri(p),
      joinPath: (base: { fsPath: string }, ...parts: string[]) => makeUri(path.join(base.fsPath, ...parts)),
    },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    workspace: {
      fs: {
        readFile: async (uri: { fsPath: string }) => new Uint8Array(await fsp.readFile(uri.fsPath)),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        writeFile: async (uri: { fsPath: string }, content: any) => {
          await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fsp.writeFile(uri.fsPath, content);
        },
        createDirectory: async (uri: { fsPath: string }) => {
          await fsp.mkdir(uri.fsPath, { recursive: true });
        },
        stat: async (uri: { fsPath: string }) => {
          const st = await fsp.stat(uri.fsPath);
          return { type: st.isDirectory() ? 2 : 1, ctime: st.ctimeMs, mtime: st.mtimeMs, size: st.size };
        },
        readDirectory: async (uri: { fsPath: string }) => {
          const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
          return entries.map((e) => [e.name, e.isDirectory() ? 2 : 1]);
        },
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(t, prop) {
      if (prop === '__esModule') return true;
      if (prop in t) return t[prop];
      const stub = new Proxy(function stub() {}, handler);
      t[prop] = stub;
      return stub;
    },
    apply() {
      return new Proxy({}, handler);
    },
    construct() {
      return new Proxy({}, handler);
    },
  };
  return new Proxy(target, handler);
}
const vscodeStub = makeVscodeStub();
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { regenerateThemeDescriptions } = require('../src/extension/themeService') as typeof import('../src/extension/themeService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setThemePlanRequester } = require('../src/extension/translator') as typeof import('../src/extension/translator');

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'regenerateThemeDescriptions-'));
}

// Mirrors test/themeCreativeDirection.test.ts's fixtures.
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
      { slot_id: 1, name: 'Agent One', atlas_asset: 'frames.json#agent_1', preferred_idle_pose: 'pose_down' },
    ],
    roster_rivals: [
      { rival_id: 'rival_roadblock', name: 'Roadblock', atlas_asset: 'frames.json#rival_roadblock' },
    ],
    buildable_objects: [
      {
        build_order: 0,
        object_id: 'crate_01',
        display_name: 'Crate 01',
        sprite_asset: 'frames.json#object_crate_01',
        anchor_coord: [0, 0],
        exclusion_radius: 40,
        work_units_required: 10,
      },
      {
        build_order: 1,
        object_id: 'watchtower',
        display_name: 'Watchtower',
        sprite_asset: 'frames.json#object_watchtower',
        anchor_coord: [0, 0],
        exclusion_radius: 40,
        work_units_required: 10,
      },
    ],
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

function testPlan(): ThemePlan {
  return {
    version: 1,
    theme_id: 'test_theme',
    display_name: 'Test Theme',
    creative_direction: 'gritty outpost',
    characters: ['Agent Zero', 'Agent One'],
    environment: 'a dusty outpost',
    objects: ['Crate 01', 'Watchtower'],
    decor: ['Seat 01', 'Lantern', 'Seat 03', 'Seat 04', 'Barrel', 'Banner', 'Crate Stack', 'Signpost', 'Campfire'],
    enemies: ['Roadblock'],
    expressions: ['happy', 'sad'],
    achievements: ['First Build'],
    character_descriptions: ['an old spec', 'another old spec'],
  };
}

function seedTheme(root: string, themeId: string, manifest: ThemeManifest, plan: ThemePlan): string {
  const dir = path.join(root, 'themes', themeId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify({}, null, 2));
  const planPath = path.join(dir, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  return planPath;
}

function storageUri(root: string) {
  return makeUri(root);
}

// Stubs translator.ts's ThemePlanRequester seam (p43-t7) — regenerate now
// routes through Theme Service /api/plan instead of a direct provider
// fetch, so this injects a fake requester rather than mocking global.fetch.
function stubFetchWithDescriptions() {
  setThemePlanRequester({
    async request() {
      // regenerateThemeDescriptionsFromPlan now requires each *_descriptions
      // array to match the NORMALIZED plan's fixed slot count exactly (see
      // requireDescriptionsArray in translator.ts) — normalizeThemePlan pads
      // characters/objects/enemies/achievements up to their fixed contract
      // counts (16/21/4/25) before this call, so the stub must return that
      // many entries, not just the handful testPlan() seeds.
      return {
        ok: true,
        value: {
          output: {
            character_descriptions: ['a fresh spec', 'another fresh spec', ...new Array(14).fill('a fresh spec')],
            object_descriptions: ['a fresh crate spec', 'a fresh tower spec', ...new Array(19).fill('a fresh object spec')],
            crate_description: 'a fresh crate',
            poof_description: 'a fresh poof',
            projectile_description: 'a fresh bolt',
            decor_descriptions: new Array(9).fill('a fresh decor spec'),
            enemy_descriptions: ['a fresh enemy spec', ...new Array(3).fill('a fresh enemy spec')],
            expression_descriptions: new Array(8).fill('a fresh icon'),
            achievement_descriptions: ['a fresh badge spec', ...new Array(24).fill('a fresh badge spec')],
          },
          attemptCost: 1,
          credits: 1,
          refunded: false,
        },
      };
    },
  });
  return () => setThemePlanRequester(undefined);
}

test('regenerateThemeDescriptions snapshots the old descriptions into previous_descriptions, writes fresh descriptions, and sets descriptions_direction to the current creative_direction', async () => {
  const root = tmpRoot();
  const restoreFetch = stubFetchWithDescriptions();
  try {
    const planPath = seedTheme(root, 'test_theme', testManifest(), testPlan());

    const { plan } = await regenerateThemeDescriptions(
      storageUri(root) as never,
      'test_theme',
      {},
    );

    // normalizeThemePlan pads character_descriptions to the fixed 16-slot
    // contract on load, so only the first two (the values actually seeded)
    // are asserted rather than the whole padded array.
    assert.equal(plan.character_descriptions?.[0], 'a fresh spec');
    assert.equal(plan.character_descriptions?.[1], 'another fresh spec');
    assert.equal(plan.descriptions_direction, 'gritty outpost');
    assert.equal(plan.previous_descriptions?.character_descriptions?.[0], 'an old spec');
    assert.equal(plan.previous_descriptions?.character_descriptions?.[1], 'another old spec');

    const onDisk = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    assert.equal(onDisk.character_descriptions[0], 'a fresh spec');
    assert.equal(onDisk.character_descriptions[1], 'another fresh spec');
    assert.equal(onDisk.descriptions_direction, 'gritty outpost');
    assert.equal(onDisk.previous_descriptions.character_descriptions[0], 'an old spec');
    assert.equal(onDisk.previous_descriptions.character_descriptions[1], 'another old spec');
    assert.equal(onDisk.crate_description, 'a fresh crate');
  } finally {
    restoreFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('regenerateThemeDescriptions throws on an invalid theme id before touching disk', async () => {
  const root = tmpRoot();
  const restoreFetch = stubFetchWithDescriptions();
  try {
    await assert.rejects(
      regenerateThemeDescriptions(storageUri(root) as never, 'Not A Valid Id!', {}),
      /Invalid theme ID/,
    );
    assert.equal(fs.existsSync(path.join(root, 'themes')), false);
  } finally {
    restoreFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('regenerateThemeDescriptions throws when no plan.json exists for the theme', async () => {
  const root = tmpRoot();
  const restoreFetch = stubFetchWithDescriptions();
  try {
    const dir = path.join(root, 'themes', 'test_theme');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(testManifest(), null, 2));
    fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify({}, null, 2));

    await assert.rejects(
      regenerateThemeDescriptions(storageUri(root) as never, 'test_theme', {}),
      /no saved plan/,
    );
  } finally {
    restoreFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
