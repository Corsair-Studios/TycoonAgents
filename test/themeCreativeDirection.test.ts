import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ThemeManifest } from '../src/shared/types';
import type { ThemePlan } from '../src/extension/themePlan';

// updateThemeCreativeDirection (src/extension/themeService.ts) is genuine IO:
// it round-trips through vscode.Uri.joinPath + vscode.workspace.fs.readFile/
// writeFile to load/rewrite a theme's plan.json. Unlike the pure-function
// tests in test/themeItemDescriptions.test.ts (which stub 'vscode' with an
// inert Proxy because their functions under test never touch the vscode API),
// this file needs Uri/workspace.fs to actually work — so the stub backs them
// with real node:fs against a real temp directory, while every OTHER vscode
// API the module references at load time still falls back to the same inert
// Proxy trick used elsewhere in the suite (this code path never calls them).
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
const { updateThemeCreativeDirection } = require('../src/extension/themeService') as typeof import('../src/extension/themeService');

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'themeCreativeDirection-'));
}

// Mirrors test/themeItemDescriptions.test.ts's testManifest/testPlan fixtures
// (a proven-good minimal shape for these load/normalize paths): 9 decor
// entries (createDecorBoardRows requires exactly 9), 2 agents, 1 rival, 2
// buildables.
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

test('updateThemeCreativeDirection trims the input, writes plan.creative_direction, and returns ok:true with the trimmed value', async () => {
  const root = tmpRoot();
  try {
    const planPath = seedTheme(root, 'test_theme', testManifest(), testPlan());

    const result = await updateThemeCreativeDirection(
      storageUri(root) as never,
      'test_theme',
      '   a moody neon skyline over a rain-slicked outpost   ',
    );

    assert.deepEqual(result, { ok: true, creative_direction: 'a moody neon skyline over a rain-slicked outpost' });

    const onDisk = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    assert.equal(onDisk.creative_direction, 'a moody neon skyline over a rain-slicked outpost');
    // The rest of the plan survives (normalizeThemePlan legitimately pads
    // `objects`/`decor`/etc. to their fixed contract counts on every load —
    // see reserveRangedWeaponRackSlot — so only fields it passes through
    // unchanged are asserted here).
    assert.equal(onDisk.theme_id, 'test_theme');
    assert.equal(onDisk.environment, 'a dusty outpost');
    assert.equal(onDisk.characters[0], 'Agent Zero');
    assert.equal(onDisk.characters[1], 'Agent One');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('updateThemeCreativeDirection rejects an empty value with ok:false and does not write', async () => {
  const root = tmpRoot();
  try {
    const planPath = seedTheme(root, 'test_theme', testManifest(), testPlan());
    const before = fs.readFileSync(planPath, 'utf8');

    const result = await updateThemeCreativeDirection(storageUri(root) as never, 'test_theme', '');

    assert.deepEqual(result, { ok: false, error: 'Creative direction cannot be empty.' });
    assert.equal(fs.readFileSync(planPath, 'utf8'), before, 'plan.json must be byte-unchanged on rejection');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('updateThemeCreativeDirection rejects a whitespace-only value with ok:false and does not write', async () => {
  const root = tmpRoot();
  try {
    const planPath = seedTheme(root, 'test_theme', testManifest(), testPlan());
    const before = fs.readFileSync(planPath, 'utf8');

    const result = await updateThemeCreativeDirection(storageUri(root) as never, 'test_theme', '   \n\t  ');

    assert.deepEqual(result, { ok: false, error: 'Creative direction cannot be empty.' });
    assert.equal(fs.readFileSync(planPath, 'utf8'), before, 'plan.json must be byte-unchanged on rejection');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('updateThemeCreativeDirection throws on an invalid theme id before touching disk', async () => {
  const root = tmpRoot();
  try {
    await assert.rejects(
      updateThemeCreativeDirection(storageUri(root) as never, 'Not A Valid Id!', 'x'),
      /Invalid theme ID/,
    );
    // Nothing was created under themes/ for the bogus id.
    assert.equal(fs.existsSync(path.join(root, 'themes')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
