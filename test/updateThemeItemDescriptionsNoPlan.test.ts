import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ThemeManifest } from '../src/shared/types';
import type { ThemeImageReviewItem } from '../src/extension/themeImageReviewState';
import type { ThemePlan } from '../src/extension/themePlan';

// Same vscode stub-with-real-fs trick as test/regenerateThemeDescriptions.test.ts.
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
const { updateThemeItemDescriptionsBatch, buildReplacementRequest, createReviewItems } = require('../src/extension/themeService') as typeof import('../src/extension/themeService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizeThemePlan, manifestToPlanSeed } = require('../src/extension/themePlan') as typeof import('../src/extension/themePlan');

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'updateThemeItemDescriptionsNoPlan-'));
}

function testManifest(): ThemeManifest {
  return {
    manifest_version: '1',
    theme_id: 'legacy_theme',
    display_name: 'Legacy Theme',
    author: 'test',
    viewport: {
      native_width: 533,
      native_height: 751,
      background_asset: 'frames.json#environment',
      walkable_nav_polygon: [[0, 0], [1, 0], [1, 1], [0, 1]],
    },
    roster_agents: [
      { slot_id: 0, name: 'Scout Rick', atlas_asset: 'frames.json#agent_0', preferred_idle_pose: 'pose_crossed' },
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
    ],
    decor_objects: [
      { decor_id: 'seat_01', display_name: 'Seat 01', sprite_asset: 'frames.json#decor_seat_01', anchor_coord: [0.5, 0.5] },
      { decor_id: 'seat_02', display_name: 'Seat 02', sprite_asset: 'frames.json#decor_seat_02', anchor_coord: [0.5, 0.5] },
      { decor_id: 'seat_03', display_name: 'Seat 03', sprite_asset: 'frames.json#decor_seat_03', anchor_coord: [0.5, 0.5] },
      { decor_id: 'seat_04', display_name: 'Seat 04', sprite_asset: 'frames.json#decor_seat_04', anchor_coord: [0.5, 0.5] },
      { decor_id: 'lantern', display_name: 'Lantern', sprite_asset: 'frames.json#decor_lantern', anchor_coord: [0.5, 0.5] },
      { decor_id: 'barrel', display_name: 'Barrel', sprite_asset: 'frames.json#decor_barrel', anchor_coord: [0.5, 0.5] },
      { decor_id: 'banner', display_name: 'Banner', sprite_asset: 'frames.json#decor_banner', anchor_coord: [0.5, 0.5] },
      { decor_id: 'signpost', display_name: 'Signpost', sprite_asset: 'frames.json#decor_signpost', anchor_coord: [0.5, 0.5] },
      { decor_id: 'campfire', display_name: 'Campfire', sprite_asset: 'frames.json#decor_campfire', anchor_coord: [0.5, 0.5] },
    ],
    badges: [],
  };
}

function seedLegacyTheme(root: string, themeId: string, manifest: ThemeManifest): string {
  const dir = path.join(root, 'themes', themeId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify({}, null, 2));
  // Deliberately no plan.json — this is what makes the theme "legacy".
  return dir;
}

function storageUri(root: string) {
  return makeUri(root);
}

test('updateThemeItemDescriptionsBatch synthesizes plan.json (and its .bak) from the manifest when a legacy theme has no saved plan, and persists the description', async () => {
  const root = tmpRoot();
  try {
    const themeDir = seedLegacyTheme(root, 'legacy_theme', testManifest());

    const result = await updateThemeItemDescriptionsBatch(
      storageUri(root) as never,
      'legacy_theme',
      [{ item_kind: 'character', id: 'agent_0', description: 'A grizzled scout in patchwork armor.' }],
    );

    assert.equal(result.applied.length, 1);
    assert.equal(result.rejected.length, 0);

    const planPath = path.join(themeDir, 'plan.json');
    const bakPath = `${planPath}.bak`;
    assert.equal(fs.existsSync(planPath), true, 'plan.json should have been created');
    assert.equal(fs.existsSync(bakPath), true, 'plan.json.bak should have been mirrored');

    const onDisk = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    assert.equal(onDisk.theme_id, 'legacy_theme');
    assert.equal(onDisk.display_name, 'Legacy Theme');
    // Built from the manifest's own roster/object/decor names — nothing invented.
    assert.deepEqual(onDisk.characters.slice(0, 2), ['Scout Rick', 'Agent One']);
    assert.equal(onDisk.character_descriptions[0], 'A grizzled scout in patchwork armor.');

    const onDiskBak = JSON.parse(fs.readFileSync(bakPath, 'utf8'));
    assert.equal(onDiskBak.character_descriptions[0], 'A grizzled scout in patchwork armor.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildReplacementRequest sends a non-empty fallback slot.description for a character with a blank/missing plan description', () => {
  const manifest = testManifest();
  const item: Pick<ThemeImageReviewItem, 'kind' | 'id' | 'frame_keys' | 'subject' | 'label'> = {
    kind: 'character_atlas',
    id: 'agent_0',
    frame_keys: ['agent_0'],
    subject: 'Scout Rick',
    label: 'Scout Rick',
  };

  // No plan at all (legacy retry path).
  const reqNoPlan = buildReplacementRequest(item as ThemeImageReviewItem, 'Legacy Theme creative direction', manifest, undefined, 'magenta');
  assert.equal(reqNoPlan.boardType, 'roster_agent');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slotNoPlan = (reqNoPlan as any).slot;
  assert.equal(typeof slotNoPlan.description, 'string');
  assert.ok(slotNoPlan.description.length > 0);

  // Plan present but this character's description was left blank.
  const reqBlankDescription = buildReplacementRequest(
    item as ThemeImageReviewItem,
    'Legacy Theme creative direction',
    manifest,
    { character_descriptions: ['   ', 'something else'] } as never,
    'magenta',
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slotBlank = (reqBlankDescription as any).slot;
  assert.equal(typeof slotBlank.description, 'string');
  assert.ok(slotBlank.description.length > 0);
});

test('createReviewItems (initial-batch path) never omits the character-atlas description: the assembled prompt falls back to the character name when the plan has no character_descriptions entry', () => {
  const manifest = testManifest();
  // Synthesized from the manifest, same as a legacy theme's first save —
  // manifestToPlanSeed never sets character_descriptions, so every roster_agent
  // slot starts with no description at all (not even a blank string).
  const plan: ThemePlan = normalizeThemePlan(manifestToPlanSeed(manifest), manifest.display_name);
  assert.equal(plan.character_descriptions, undefined);

  const items = createReviewItems(plan, manifest, 'Creative direction: legacy', 'magenta');
  const scoutRick = items.find((item) => item.id === 'agent_0');
  assert.ok(scoutRick, 'expected an agent_0 review item');
  // buildCharacterAtlas only emits the "Appearance — depict this exact
  // design: <text>" line when visualDescription (req.slot.description) is
  // truthy (src/core/themePromptTemplates.ts). Its presence, with the
  // character's own name as the design text, is proof the request carried a
  // non-empty description fallback instead of omitting slot.description.
  assert.ok(scoutRick!.prompt.includes('Appearance — depict this exact design: Scout Rick'));
});
