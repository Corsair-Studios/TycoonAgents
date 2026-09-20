/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p76-t3: tests for saveThemePlan (src/extension/themeService.ts ~2199-2280):
// create path writes plan.json/manifest.json/frames.json/review.json with the
// right slot counts, slug derivation + uniqueness on a second create with the
// same name, an invalid explicit id throws, and the update path (explicit id)
// reuses the same directory, preserves an existing frames.json entry and an
// existing review.json rather than re-seeding them, and rewrites plan.json.
// No network: globalThis.fetch is stubbed to throw if ever called.
//
// Harness follows test/themeDiskSizeRawExclusion.test.ts: stub the 'vscode'
// module loader (so requiring themeService.ts's vscode-importing siblings
// resolves under plain `node --test`) and inject a real Node-fs-backed
// ThemeFileStore via themeFileStore.ts's configureThemeFileStore/
// resetThemeFileStoreForTests test escape hatch, rooted at a real os.tmpdir()
// directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

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
const { saveThemePlan } = require('../src/extension/themeService') as typeof import('../src/extension/themeService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  configureThemeFileStore,
  resetThemeFileStoreForTests,
} = require('../src/extension/themeFileStore') as typeof import('../src/extension/themeFileStore');
type ThemeFileStore = import('../src/extension/themeFileStore').ThemeFileStore;
type ThemeFileStoreEntry = import('../src/extension/themeFileStore').ThemeFileStoreEntry;
type ThemeFileStoreStat = import('../src/extension/themeFileStore').ThemeFileStoreStat;

/** Real-fs-backed ThemeFileStore rooted at `root` (test/themeDiskSizeRawExclusion.test.ts pattern). */
function createFsThemeFileStore(root: string): ThemeFileStore {
  const resolve = (relativePath: string): string => path.join(root, ...relativePath.split('/').filter(Boolean));
  return {
    async readFile(relativePath: string): Promise<Uint8Array> {
      return fsp.readFile(resolve(relativePath));
    },
    async writeFile(relativePath: string, data: Uint8Array | Buffer): Promise<void> {
      await fsp.writeFile(resolve(relativePath), data);
    },
    async readdir(relativePath: string): Promise<ThemeFileStoreEntry[]> {
      const entries = await fsp.readdir(resolve(relativePath), { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      }));
    },
    async mkdirp(relativePath: string): Promise<void> {
      await fsp.mkdir(resolve(relativePath), { recursive: true });
    },
    async remove(relativePath: string, options?: { recursive?: boolean }): Promise<void> {
      await fsp.rm(resolve(relativePath), { recursive: options?.recursive ?? false, force: true });
    },
    async exists(relativePath: string): Promise<boolean> {
      try {
        await fsp.access(resolve(relativePath));
        return true;
      } catch {
        return false;
      }
    },
    async stat(relativePath: string): Promise<ThemeFileStoreStat> {
      const stat = await fsp.stat(resolve(relativePath));
      return {
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    },
    async rename(fromRelativePath: string, toRelativePath: string): Promise<void> {
      await fsp.rename(resolve(fromRelativePath), resolve(toRelativePath));
    },
  };
}

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-save-theme-plan-'));
  configureThemeFileStore(createFsThemeFileStore(root));
  try {
    return await fn(root);
  } finally {
    resetThemeFileStoreForTests();
    await fsp.rm(root, { recursive: true, force: true });
  }
}

async function readJsonFile(root: string, ...segments: string[]): Promise<any> {
  const buf = await fsp.readFile(path.join(root, ...segments), 'utf8');
  return JSON.parse(buf);
}

const sparsePlan = {
  display_name: 'Sparse Castle',
  creative_direction: 'A cozy medieval keep.',
  environment: 'A courtyard with cobblestones.',
  characters: ['Knight'],
  enemies: ['Goblin'],
  decor: ['Banner'],
  objects: ['Anvil'],
};

test('saveThemePlan (create) writes plan.json/manifest.json/frames.json/review.json with correct slot counts', async () => {
  // Guard: no network at all on this path.
  const originalFetch = globalThis.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = async () => {
    throw new Error('saveThemePlan must never call fetch');
  };
  try {
    await withTempRoot(async (root) => {
      const result = await saveThemePlan({} as any, sparsePlan as any);
      assert.equal(result.theme_id, 'sparse_castle');
      assert.equal(result.plan.display_name, 'Sparse Castle');
      assert.equal(result.plan.characters.length, 16);
      assert.equal(result.plan.enemies.length, 4);
      assert.equal(result.plan.decor.length, 9);
      assert.equal(result.plan.objects.length, 21);
      assert.equal(result.plan.expressions.length, 8);
      assert.equal(result.plan.achievements.length, 25);

      const themeDir = path.join(root, 'themes', 'sparse_castle');
      const plan = await readJsonFile(root, 'themes', 'sparse_castle', 'plan.json');
      assert.equal(plan.theme_id, 'sparse_castle');
      assert.equal(plan.characters.length, 16);

      const manifest = await readJsonFile(root, 'themes', 'sparse_castle', 'manifest.json');
      assert.equal(manifest.theme_id, 'sparse_castle');
      assert.equal(manifest.display_name, 'Sparse Castle');
      assert.ok(Array.isArray(manifest.badges) && manifest.badges.length > 0);

      const frames = await readJsonFile(root, 'themes', 'sparse_castle', 'frames.json');
      assert.deepEqual(frames, {}, 'a brand-new create must write an empty frames.json');

      const review = await readJsonFile(root, 'themes', 'sparse_castle', 'review.json');
      assert.ok(Array.isArray(review.items) && review.items.length > 0);
      assert.ok(review.items.every((item: any) => item.status === 'pending'));

      await fsp.access(themeDir);
    });
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
});

test('saveThemePlan (create) derives a unique id on a second save with the same display name', async () => {
  await withTempRoot(async () => {
    const first = await saveThemePlan({} as any, sparsePlan as any);
    const second = await saveThemePlan({} as any, sparsePlan as any);
    assert.equal(first.theme_id, 'sparse_castle');
    assert.equal(second.theme_id, 'sparse_castle_2');
  });
});

test('saveThemePlan rejects an invalid explicit theme_id without writing anything', async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(
      () => saveThemePlan({} as any, sparsePlan as any, 'Not A Valid Id!'),
      /Invalid theme ID/,
    );
    await assert.rejects(fsp.access(path.join(root, 'themes', 'Not A Valid Id!')));
  });
});

test('saveThemePlan (update, explicit id) reuses the directory, preserves existing frames.json and review.json, and rewrites plan.json', async () => {
  await withTempRoot(async (root) => {
    const created = await saveThemePlan({} as any, sparsePlan as any, 'castle_theme');
    assert.equal(created.theme_id, 'castle_theme');

    // Seed frames.json with an uploaded board and review.json with a
    // non-pending status BEFORE the update save, to prove both survive.
    const themeDir = path.join(root, 'themes', 'castle_theme');
    await fsp.writeFile(
      path.join(themeDir, 'frames.json'),
      JSON.stringify({ agents_atlas: ['data:image/png;base64,uploaded'] }),
    );
    const existingReview = await readJsonFile(root, 'themes', 'castle_theme', 'review.json');
    existingReview.items[0].status = 'accepted';
    existingReview.items[0].frame_keys = ['agents_atlas'];
    await fsp.writeFile(path.join(themeDir, 'review.json'), JSON.stringify(existingReview));

    const updatedPlan = { ...sparsePlan, display_name: 'Castle Theme Updated', environment: 'A rebuilt courtyard.' };
    const updated = await saveThemePlan({} as any, updatedPlan as any, 'castle_theme');

    assert.equal(updated.theme_id, 'castle_theme', 'update must reuse the same theme_id/directory');

    const plan = await readJsonFile(root, 'themes', 'castle_theme', 'plan.json');
    assert.equal(plan.environment, 'A rebuilt courtyard.', 'plan.json must be rewritten with the new content');

    const frames = await readJsonFile(root, 'themes', 'castle_theme', 'frames.json');
    assert.deepEqual(
      frames,
      { agents_atlas: ['data:image/png;base64,uploaded'] },
      'an existing frames.json entry must be preserved on update, not clobbered with {}',
    );

    const review = await readJsonFile(root, 'themes', 'castle_theme', 'review.json');
    assert.equal(review.items[0].status, 'accepted', 'an existing review.json must be left untouched on update, not re-seeded to pending');
    assert.deepEqual(review.items[0].frame_keys, ['agents_atlas']);
  });
});
