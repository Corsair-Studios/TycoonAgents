/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// themeService.ts pulls in modules that import 'vscode' at module scope; stub the
// loader so the require below resolves under plain `node --test` (same trick as
// test/themeDiskSizeRawExclusion.test.ts). Storage goes through an injected
// Node-fs-backed ThemeFileStore.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require('module');
const originalLoad = NodeModule._load;
function makeVscodeStub(): unknown {
  const target: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(t, prop) {
      if (prop === '__esModule') return true;
      if (!(prop in t)) t[prop] = new Proxy(function stub() {}, handler);
      return t[prop];
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
const themeService = require('../src/extension/themeService') as typeof import('../src/extension/themeService');
const { createReviewItems, mergeResumedReviewItems, retireSupersededBoard, slotOnlyAgentBoardFilename } = themeService;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  exportThemeArchiveFromStore,
  importThemeArchiveToStore,
} = require('../src/extension/themeArchiveOps') as typeof import('../src/extension/themeArchiveOps');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  configureThemeFileStore,
  resetThemeFileStoreForTests,
} = require('../src/extension/themeFileStore') as typeof import('../src/extension/themeFileStore');
type ThemeFileStore = import('../src/extension/themeFileStore').ThemeFileStore;

function createFsThemeFileStore(root: string): ThemeFileStore {
  const resolve = (relativePath: string): string => path.join(root, ...relativePath.split('/').filter(Boolean));
  return {
    async readFile(relativePath) {
      return fsp.readFile(resolve(relativePath));
    },
    async writeFile(relativePath, data) {
      await fsp.mkdir(path.dirname(resolve(relativePath)), { recursive: true });
      await fsp.writeFile(resolve(relativePath), data);
    },
    async readdir(relativePath) {
      const entries = await fsp.readdir(resolve(relativePath), { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() }));
    },
    async mkdirp(relativePath) {
      await fsp.mkdir(resolve(relativePath), { recursive: true });
    },
    async remove(relativePath, options) {
      await fsp.rm(resolve(relativePath), { recursive: options?.recursive ?? false, force: true });
    },
    async exists(relativePath) {
      try {
        await fsp.access(resolve(relativePath));
        return true;
      } catch {
        return false;
      }
    },
    async stat(relativePath) {
      const stat = await fsp.stat(resolve(relativePath));
      return { isDirectory: stat.isDirectory(), isFile: stat.isFile(), size: stat.size, mtimeMs: stat.mtimeMs };
    },
    async rename(from, to) {
      await fsp.rename(resolve(from), resolve(to));
    },
  };
}

const THEME_ID = 'board_export_theme';

function reviewItem(id: string, filename: string, kind: string): Record<string, unknown> {
  return {
    id,
    filename,
    label: id,
    kind,
    status: 'accepted',
    prompt: 'p',
    revision: 1,
    frame_keys: [id],
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

/** A theme whose agent_0 / agent_1 boards were renamed, leaving stale duplicates on disk. */
async function setupStaleTheme(root: string): Promise<string> {
  const themeDir = path.join(root, 'themes', THEME_ID);
  await fsp.mkdir(path.join(themeDir, 'images', 'raw'), { recursive: true });
  const manifest = {
    manifest_version: '1.0.0',
    theme_id: THEME_ID,
    display_name: 'Board Export Theme',
    author: 'Test',
    viewport: {
      native_width: 800,
      native_height: 600,
      background_asset: 'frames.json#environment_background',
      walkable_nav_polygon: [[0, 0], [800, 0], [800, 600], [0, 600]],
    },
    roster_agents: [],
    roster_rivals: [],
    buildable_objects: [],
    badges: [],
  };
  await fsp.writeFile(path.join(themeDir, 'manifest.json'), JSON.stringify(manifest));
  await fsp.writeFile(path.join(themeDir, 'frames.json'), JSON.stringify({ agent_0: ['data:image/png;base64,abc'] }));
  await fsp.writeFile(path.join(themeDir, 'review.json'), JSON.stringify({
    version: 1,
    theme_id: THEME_ID,
    display_name: 'Board Export Theme',
    items: [
      reviewItem('agent_0', 'agent_01_cali_the_rogue.png', 'character_atlas'),
      reviewItem('agent_5', 'agent_06_tiger_the_guard.png', 'character_atlas'),
      reviewItem('rivals_01', 'rivals_01.png', 'rival_atlas'),
      reviewItem('environment', 'environment.png', 'environment'),
    ],
  }));
  const write = (name: string, byte: number) => fsp.writeFile(path.join(themeDir, 'images', name), Buffer.from([byte]));
  await write('agent_01_cali_the_rogue.png', 1); // current
  await write('agent_01_cali.png', 2); // stale
  await write('agent_06_tiger_the_guard.png', 3); // current
  await write('agent_06_salem_the_magnificent.png', 4); // stale
  await write('agent_02_unreferenced_only.png', 5); // orphan, but its slot has no current file: kept
  await write('rivals_01.png', 6);
  await write('rivals_02.png', 7); // no current file for rivals_02: kept
  await write('environment.png', 8);
  await write('notes.png', 9); // not a board pattern: kept
  await fsp.writeFile(path.join(themeDir, 'images', 'raw', 'agent_01_cali.png'), Buffer.from([9]));
  return themeDir;
}

async function withStaleTheme<T>(run: (store: ThemeFileStore, root: string) => Promise<T>): Promise<T> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-board-export-'));
  try {
    await setupStaleTheme(root);
    const store = createFsThemeFileStore(root);
    configureThemeFileStore(store);
    return await run(store, root);
  } finally {
    resetThemeFileStoreForTests();
    await fsp.rm(root, { recursive: true, force: true });
  }
}

function reviewFrom(files: Record<string, Uint8Array>): { items: Array<{ id: string; filename: string }> } {
  return JSON.parse(Buffer.from(files['review.json']).toString('utf8'));
}

test('export includes only current boards and drops stale duplicates of the same slot', async () => {
  await withStaleTheme(async (store) => {
    const files = unzipSync(await exportThemeArchiveFromStore(store, THEME_ID));
    const paths = Object.keys(files).sort();
    assert.ok(!paths.includes('images/agent_01_cali.png'), paths.join(', '));
    assert.ok(!paths.includes('images/agent_06_salem_the_magnificent.png'), paths.join(', '));
    assert.ok(paths.includes('images/agent_01.png'));
    assert.ok(paths.includes('images/agent_06.png'));
    // Conservative cases survive.
    assert.ok(paths.includes('images/agent_02_unreferenced_only.png'));
    assert.ok(paths.includes('images/rivals_01.png'));
    assert.ok(paths.includes('images/rivals_02.png'));
    assert.ok(paths.includes('images/environment.png'));
    assert.ok(paths.includes('images/notes.png'));
    assert.ok(paths.includes('manifest.json') && paths.includes('frames.json') && paths.includes('review.json'));
    assert.ok(!paths.some((p) => p.startsWith('images/raw/')));
  });
});

test('export writes agent boards as agent_NN.png and rewrites review references consistently', async () => {
  await withStaleTheme(async (store) => {
    const files = unzipSync(await exportThemeArchiveFromStore(store, THEME_ID));
    const review = reviewFrom(files);
    const byId = new Map(review.items.map((item) => [item.id, item.filename]));
    assert.equal(byId.get('agent_0'), 'agent_01.png');
    assert.equal(byId.get('agent_5'), 'agent_06.png');
    assert.equal(byId.get('rivals_01'), 'rivals_01.png');
    // The renamed file carries the CURRENT board's bytes, not the stale one's.
    assert.deepEqual([...files['images/agent_01.png']], [1]);
    assert.deepEqual([...files['images/agent_06.png']], [3]);
    // Every referenced board resolves to a file in the archive.
    for (const item of review.items) assert.ok(files[`images/${item.filename}`], `${item.filename} must exist`);
  });
});

test('export does not touch the theme on disk', async () => {
  await withStaleTheme(async (store, root) => {
    await exportThemeArchiveFromStore(store, THEME_ID);
    const onDisk = await fsp.readdir(path.join(root, 'themes', THEME_ID, 'images'));
    assert.ok(onDisk.includes('agent_01_cali.png'));
    assert.ok(onDisk.includes('agent_01_cali_the_rogue.png'));
  });
});

test('round trip: an exported theme imports and its review items resolve to image files', async () => {
  await withStaleTheme(async (store, root) => {
    const archive = await exportThemeArchiveFromStore(store, THEME_ID);
    await fsp.rm(path.join(root, 'themes', THEME_ID), { recursive: true, force: true });
    await importThemeArchiveToStore(store, archive, false);
    const themeDir = path.join(root, 'themes', THEME_ID);
    const review = JSON.parse(await fsp.readFile(path.join(themeDir, 'review.json'), 'utf8'));
    for (const item of review.items) {
      await fsp.access(path.join(themeDir, 'images', item.filename));
    }
    assert.equal(review.items.find((item: { id: string }) => item.id === 'agent_0').filename, 'agent_01.png');
  });
});

test('an old-format archive (name-based boards, name-based review) still imports and resolves', async () => {
  await withStaleTheme(async (store, root) => {
    // Hand-build an old-style zip by copying the on-disk theme verbatim (no export filter).
    const themeDir = path.join(root, 'themes', THEME_ID);
    const { zipSync } = await import('fflate');
    const entries: Record<string, Uint8Array> = {};
    for (const name of ['manifest.json', 'frames.json', 'review.json']) {
      entries[name] = await fsp.readFile(path.join(themeDir, name));
    }
    for (const name of ['agent_01_cali_the_rogue.png', 'agent_06_tiger_the_guard.png', 'rivals_01.png', 'environment.png']) {
      entries[`images/${name}`] = await fsp.readFile(path.join(themeDir, 'images', name));
    }
    await fsp.rm(themeDir, { recursive: true, force: true });
    await importThemeArchiveToStore(store, zipSync(entries), false);
    const review = JSON.parse(await fsp.readFile(path.join(themeDir, 'review.json'), 'utf8'));
    for (const item of review.items) {
      await fsp.access(path.join(themeDir, 'images', item.filename));
    }
    assert.equal(review.items[0].filename, 'agent_01_cali_the_rogue.png');
  });
});

test('createReviewItems names agent boards by slot only', () => {
  const plan = {
    version: 1,
    theme_id: 'slot_theme',
    display_name: 'Slot Theme',
    creative_direction: 'gritty wasteland',
    characters: ['Cali the Rogue', 'Tiger the Guard'],
    environment: 'a dusty outpost',
    objects: Array.from({ length: 12 }, (_unused, index) => `Object ${index}`),
    decor: Array.from({ length: 9 }, (_unused, index) => `Decor ${index}`),
    enemies: Array.from({ length: 3 }, (_unused, index) => `Rival ${index}`),
    expressions: ['happy', 'sad'],
    achievements: ['First Build'],
  } as unknown as import('../src/extension/themePlan').ThemePlan;
  const manifest = {
    manifest_version: '1',
    theme_id: 'slot_theme',
    display_name: 'Slot Theme',
    author: 'test',
    viewport: {
      native_width: 533,
      native_height: 751,
      background_asset: 'frames.json#environment',
      walkable_nav_polygon: [[0, 0], [1, 0], [1, 1], [0, 1]],
    },
    roster_agents: [
      { slot_id: 0, name: 'Cali the Rogue', atlas_asset: 'frames.json#agent_0', preferred_idle_pose: 'pose_crossed' },
      { slot_id: 5, name: 'Tiger the Guard', atlas_asset: 'frames.json#agent_5', preferred_idle_pose: 'pose_crossed' },
    ],
    roster_rivals: [],
    buildable_objects: [],
    decor_objects: Array.from({ length: 9 }, (_unused, index) => ({
      decor_id: `decor_${index}`,
      display_name: `Decor ${index}`,
      sprite_asset: `frames.json#decor_${index}`,
      anchor_coord: [0.5, 0.5],
    })),
    badges: [],
  } as unknown as import('../src/shared/types').ThemeManifest;
  const items = createReviewItems(plan, manifest, 'direction');
  const agents = items.filter((item) => item.id.startsWith('agent_'));
  assert.deepEqual(agents.map((item) => item.filename), ['agent_01.png', 'agent_06.png']);
});

test('slotOnlyAgentBoardFilename converts legacy names and leaves slot-only ones alone', () => {
  assert.equal(slotOnlyAgentBoardFilename({ kind: 'character_atlas', filename: 'agent_03_zed.png' }), 'agent_03.png');
  assert.equal(slotOnlyAgentBoardFilename({ kind: 'character_atlas', filename: 'agent_03.png' }), undefined);
  assert.equal(slotOnlyAgentBoardFilename({ kind: 'rival_atlas', filename: 'rivals_01.png' }), undefined);
});

test('mergeResumedReviewItems keeps a character board saved filename so resume finds the existing image', () => {
  const expected = [{ ...reviewItem('agent_0', 'agent_01.png', 'character_atlas'), prompt: 'new' }];
  const saved = [{ ...reviewItem('agent_0', 'agent_01_cali.png', 'character_atlas') }];
  const merged = mergeResumedReviewItems(expected as never, saved as never);
  assert.equal(merged[0].filename, 'agent_01_cali.png');
});

test('retireSupersededBoard moves the replaced board into the export-excluded images/raw/ area', async () => {
  await withStaleTheme(async (store, root) => {
    const imagesDir = path.join(root, 'themes', THEME_ID, 'images');
    await retireSupersededBoard({} as never, THEME_ID, 'agent_01_cali.png', 'agent_01.png');
    const remaining = await fsp.readdir(imagesDir);
    assert.ok(!remaining.includes('agent_01_cali.png'));
    const moved = await fsp.readFile(path.join(imagesDir, 'raw', 'superseded', 'agent_01_cali.png'));
    assert.deepEqual([...moved], [2]);
    // The moved file is not exported.
    const files = unzipSync(await exportThemeArchiveFromStore(store, THEME_ID));
    assert.ok(!Object.keys(files).some((p) => p.includes('superseded')));
  });
});

test('retireSupersededBoard is a no-op when the filename did not change or the file is missing', async () => {
  await withStaleTheme(async (_store, root) => {
    const imagesDir = path.join(root, 'themes', THEME_ID, 'images');
    await retireSupersededBoard({} as never, THEME_ID, 'agent_01.png', 'agent_01.png');
    await retireSupersededBoard({} as never, THEME_ID, 'agent_09_gone.png', 'agent_09.png');
    assert.ok((await fsp.readdir(imagesDir)).includes('agent_01_cali.png'));
  });
});

test('export excludes .bak backups but keeps current files', async () => {
  await withStaleTheme(async (store, root) => {
    const themeDir = path.join(root, 'themes', THEME_ID);
    await fsp.writeFile(path.join(themeDir, 'manifest.json.1700000000.bak'), 'old');
    await fsp.writeFile(path.join(themeDir, 'plan.json.bak'), 'old');
    const paths = Object.keys(unzipSync(await exportThemeArchiveFromStore(store, THEME_ID)));
    assert.ok(!paths.some((p) => p.endsWith('.bak')), paths.join(', '));
    assert.ok(paths.includes('manifest.json'));
  });
});

test('board matching is case-consistent: a case-differing reference never drops its file', async () => {
  await withStaleTheme(async (store, root) => {
    const themeDir = path.join(root, 'themes', THEME_ID);
    const review = JSON.parse(await fsp.readFile(path.join(themeDir, 'review.json'), 'utf8'));
    review.items.find((i: { id: string }) => i.id === 'rivals_01').filename = 'Rivals_01.PNG';
    await fsp.writeFile(path.join(themeDir, 'review.json'), JSON.stringify(review));
    const paths = Object.keys(unzipSync(await exportThemeArchiveFromStore(store, THEME_ID)));
    assert.ok(paths.includes('images/rivals_01.png'), paths.join(', '));
  });
});
