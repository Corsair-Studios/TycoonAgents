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
const { saveThemePlan, uploadThemeImage, getThemeImageReview, uploadImageRejection } = require('../src/extension/themeService') as typeof import('../src/extension/themeService');
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
    resolveHandle(relativePath: string) {
      return { path: '/' + relativePath, fsPath: resolve(relativePath) } as never;
    },
    async rename(fromRelativePath: string, toRelativePath: string): Promise<void> {
      await fsp.rename(resolve(fromRelativePath), resolve(toRelativePath));
    },
  };
}

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-upload-board-'));
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


// eslint-disable-next-line @typescript-eslint/no-var-requires
const Jimp = require('jimp');

const plan = {
  display_name: 'Upload Keep',
  creative_direction: 'A cozy medieval keep.',
  environment: 'A courtyard with cobblestones.',
  characters: ['Knight'],
  enemies: ['Goblin'],
  decor: ['Banner'],
  objects: ['Anvil'],
};

async function solidPng(color: { r: number; g: number; b: number }): Promise<Buffer> {
  const image = new Jimp(512, 512, Jimp.rgbaToInt(color.r, color.g, color.b, 255));
  return image.getBufferAsync('image/png');
}

test('uploadThemeImage on a never-generated environment board saves it as the current image', async () => {
  await withTempRoot(async (root) => {
    const { theme_id } = await saveThemePlan({} as any, plan as any);
    const before = await getThemeImageReview({} as any, theme_id);
    const env = before.entries.find((entry) => entry.item.kind === 'environment');
    assert.ok(env, 'environment board must exist');
    assert.equal(env!.imageUri, undefined, 'not generated yet');

    const png = await solidPng({ r: 200, g: 10, b: 10 });
    const result = await uploadThemeImage({} as any, theme_id, env!.item.id, png);
    assert.ok(result, 'upload must succeed');

    const after = await getThemeImageReview({} as any, theme_id);
    const entry = after.entries.find((candidate) => candidate.item.id === env!.item.id)!;
    assert.ok(entry.imageUri, 'uploaded board must now have an image');
    assert.equal(entry.generated, true);
    assert.ok(entry.item.revision > env!.item.revision);
    const onDisk = await fsp.readFile(path.join(root, 'themes', theme_id, 'images', entry.item.filename));
    assert.ok(onDisk.length > 0);
    const frames = await readJsonFile(root, 'themes', theme_id, 'frames.json');
    assert.ok(entry.item.frame_keys.length > 0 && entry.item.frame_keys.every((key) => frames[key]?.length > 0));

    // A second upload replaces the first.
    const second = await solidPng({ r: 10, g: 10, b: 200 });
    await uploadThemeImage({} as any, theme_id, env!.item.id, second);
    const replaced = await fsp.readFile(path.join(root, 'themes', theme_id, 'images', entry.item.filename));
    assert.notDeepEqual(replaced, onDisk);
  });
});

test('uploadThemeImage saves a board whose review item was never persisted (card exists only from the plan)', async () => {
  await withTempRoot(async (root) => {
    const { theme_id } = await saveThemePlan({} as any, plan as any);
    const reviewPath = path.join(root, 'themes', theme_id, 'review.json');
    const review = JSON.parse(await fsp.readFile(reviewPath, 'utf8'));
    review.items = review.items.filter((item: any) => item.kind !== 'environment');
    await fsp.writeFile(reviewPath, JSON.stringify(review));

    const png = await solidPng({ r: 20, g: 120, b: 20 });
    const result = await uploadThemeImage({} as any, theme_id, 'environment', png);
    assert.ok(result, 'upload must succeed');

    const after = await getThemeImageReview({} as any, theme_id);
    const entry = after.entries.find((candidate) => candidate.item.kind === 'environment')!;
    assert.ok(entry.imageUri, 'uploaded environment board must now have an image');
    assert.equal(entry.generated, true);
    const saved = JSON.parse(await fsp.readFile(reviewPath, 'utf8'));
    assert.ok(saved.items.some((item: any) => item.id === 'environment'), 'the item must now be persisted');
  });
});

test('uploadThemeImage replaces a character board and retires its legacy name-based file', async () => {
  await withTempRoot(async (root) => {
    const { theme_id } = await saveThemePlan({} as any, plan as any);
    const reviewPath = path.join(root, 'themes', theme_id, 'review.json');
    const review = JSON.parse(await fsp.readFile(reviewPath, 'utf8'));
    const character = review.items.find((item: any) => item.kind === 'character_atlas');
    const imagesDir = path.join(root, 'themes', theme_id, 'images');
    const legacyName = 'agent_00_knight.png';
    character.filename = legacyName;
    await fsp.mkdir(imagesDir, { recursive: true });
    await fsp.writeFile(path.join(imagesDir, legacyName), await solidPng({ r: 1, g: 2, b: 3 }));
    await fsp.writeFile(reviewPath, JSON.stringify(review));

    const result = await uploadThemeImage({} as any, theme_id, character.id, await solidPng({ r: 90, g: 90, b: 200 }));
    assert.ok(result, 'upload must succeed');

    const saved = JSON.parse(await fsp.readFile(reviewPath, 'utf8'));
    const updated = saved.items.find((item: any) => item.id === character.id);
    assert.equal(updated.filename, 'agent_00.png');
    await fsp.access(path.join(imagesDir, 'agent_00.png'));
    await assert.rejects(fsp.access(path.join(imagesDir, legacyName)), 'legacy file must be moved aside');
    assert.ok(updated.revision > character.revision);
  });
});

test('uploadThemeImage rejects non-image and oversized bytes with a clear error and writes nothing', async () => {
  await withTempRoot(async (root) => {
    const { theme_id } = await saveThemePlan({} as any, plan as any);
    await assert.rejects(
      () => uploadThemeImage({} as any, theme_id, 'environment', Buffer.from('definitely not an image')),
      /not a PNG, JPEG or WEBP/,
    );
    await assert.rejects(
      () => uploadThemeImage({} as any, theme_id, 'environment', Buffer.alloc(0)),
      /empty/,
    );
    assert.match(uploadImageRejection(Buffer.alloc(25 * 1024 * 1024 + 1, 0xff)) ?? '', /larger than 25 MB/);
    assert.equal(uploadImageRejection(await solidPng({ r: 1, g: 1, b: 1 })), undefined);
    await assert.rejects(fsp.access(path.join(root, 'themes', theme_id, 'images', 'environment.png')));
  });
});
