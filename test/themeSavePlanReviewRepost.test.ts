/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p79-t3: host coverage for the p79-t2 re-save fix — panel.ts's
// MSG.SAVE_THEME_PLAN branch (~2775-2802) now posts THEME_PLAN_SAVED, then
// THEMES_LIST, then re-posts THEME_IMAGE_REVIEW via _postThemeImageReview so
// the redesigned builder's autosave-after-every-upload refreshes board
// labels/prompts. Exercises the real saveThemePlan + getThemeImageReview
// (src/extension/themeService.ts) against a temp fs-backed ThemeFileStore —
// same harness as test/themeServiceSavePlan.test.ts and
// test/themeServiceSavePlanMessage.test.ts (this task may not edit
// panel.ts, so it drives the underlying service functions directly rather
// than instantiating the vscode-coupled TycoonPanel class).

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
const { saveThemePlan, listThemes, getThemeBoardCounts, getThemeImageReview } = require('../src/extension/themeService') as typeof import('../src/extension/themeService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  configureThemeFileStore,
  resetThemeFileStoreForTests,
} = require('../src/extension/themeFileStore') as typeof import('../src/extension/themeFileStore');
type ThemeFileStore = import('../src/extension/themeFileStore').ThemeFileStore;
type ThemeFileStoreEntry = import('../src/extension/themeFileStore').ThemeFileStoreEntry;
type ThemeFileStoreStat = import('../src/extension/themeFileStore').ThemeFileStoreStat;

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
      return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() }));
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
      return { isDirectory: stat.isDirectory(), isFile: stat.isFile(), size: stat.size, mtimeMs: stat.mtimeMs };
    },
    async rename(fromRelativePath: string, toRelativePath: string): Promise<void> {
      await fsp.rename(resolve(fromRelativePath), resolve(toRelativePath));
    },
    resolveHandle(relativePath: string) {
      return { path: resolve(relativePath).split(path.sep).join('/') };
    },
  };
}

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-save-theme-plan-repost-'));
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

/** Replica of panel.ts's SAVE_THEME_PLAN branch's message sequence
 *  (THEME_PLAN_SAVED, THEMES_LIST, THEME_IMAGE_REVIEW) using the real
 *  saveThemePlan/listThemes/getThemeBoardCounts/getThemeImageReview. */
async function handleSaveThemePlanWithRepost(planPayload: { plan: unknown; theme_id?: string }): Promise<Array<{ type: string; payload: unknown }>> {
  const posted: Array<{ type: string; payload: unknown }> = [];
  const { theme_id, plan } = await saveThemePlan({} as any, planPayload.plan as any, planPayload.theme_id);
  const savedBoardCounts = await getThemeBoardCounts({} as any, theme_id);
  posted.push({ type: 'THEME_PLAN_SAVED', payload: { theme_id, plan, ...savedBoardCounts } });
  const themes = await listThemes({} as any);
  posted.push({ type: 'THEMES_LIST', payload: { themes } });
  const review = await getThemeImageReview({} as any, theme_id);
  posted.push({ type: 'THEME_IMAGE_REVIEW', payload: { theme_id, items: review.entries.map((e) => e.item) } });
  return posted;
}

const sparsePlan = {
  display_name: 'Repost Castle',
  creative_direction: 'A cozy medieval keep.',
  environment: 'A courtyard with cobblestones.',
  characters: ['Knight'],
  enemies: ['Goblin'],
  decor: ['Banner'],
  objects: ['Anvil'],
};

test('re-saving an existing theme posts THEME_PLAN_SAVED, THEMES_LIST, then THEME_IMAGE_REVIEW (in that order), refreshes the display label, and keeps a tweaked prompt plus existing frames/statuses', async () => {
  await withTempRoot(async (root) => {
    const created = await handleSaveThemePlanWithRepost({ plan: sparsePlan, theme_id: 'repost_castle' });
    assert.equal(created.length, 3);
    assert.equal(created[0].type, 'THEME_PLAN_SAVED');
    assert.equal(created[1].type, 'THEMES_LIST');
    assert.equal(created[2].type, 'THEME_IMAGE_REVIEW');

    const themeDir = path.join(root, 'themes', 'repost_castle');

    // Tweak one review item's prompt and mark an uploaded board's status/
    // frame_keys, as a real upload + autosave cycle would leave behind.
    const reviewBefore = await readJsonFile(root, 'themes', 'repost_castle', 'review.json');
    const targetItem = reviewBefore.items[0];
    targetItem.prompt = 'A hand-tweaked prompt the user wrote.';
    targetItem.status = 'accepted';
    targetItem.frame_keys = ['agents_atlas'];
    await fsp.writeFile(path.join(themeDir, 'review.json'), JSON.stringify(reviewBefore));
    await fsp.writeFile(
      path.join(themeDir, 'frames.json'),
      JSON.stringify({ agents_atlas: ['data:image/png;base64,uploaded'] }),
    );

    // Re-save with a changed display name — mirrors the builder's Save
    // theme / autosave-after-upload re-save.
    const updatedPlan = { ...sparsePlan, display_name: 'Repost Castle Renamed' };
    const posted = await handleSaveThemePlanWithRepost({ plan: updatedPlan, theme_id: 'repost_castle' });

    assert.equal(posted.length, 3, 'expected exactly THEME_PLAN_SAVED, THEMES_LIST, THEME_IMAGE_REVIEW');
    assert.equal(posted[0].type, 'THEME_PLAN_SAVED');
    assert.equal(posted[1].type, 'THEMES_LIST');
    assert.equal(posted[2].type, 'THEME_IMAGE_REVIEW');

    // Label refreshed.
    const manifest = await readJsonFile(root, 'themes', 'repost_castle', 'manifest.json');
    assert.equal(manifest.display_name, 'Repost Castle Renamed');
    const listedTheme = ((posted[1].payload as any).themes as any[]).find((t) => t.theme_id === 'repost_castle');
    assert.ok(listedTheme, 'expected the renamed theme in THEMES_LIST');

    // Tweaked prompt, frames and status survive the re-save untouched.
    const reviewAfter = await readJsonFile(root, 'themes', 'repost_castle', 'review.json');
    const survivedItem = reviewAfter.items.find((i: any) => i.id === targetItem.id);
    assert.ok(survivedItem, 'expected the tweaked item to still exist after re-save');
    assert.equal(survivedItem.prompt, 'A hand-tweaked prompt the user wrote.', 'a tweaked prompt must survive re-save, not be reset to the template default');
    assert.equal(survivedItem.status, 'accepted', 'status must survive re-save');
    assert.deepEqual(survivedItem.frame_keys, ['agents_atlas'], 'frame_keys must survive re-save');
    const frames = await readJsonFile(root, 'themes', 'repost_castle', 'frames.json');
    assert.deepEqual(frames, { agents_atlas: ['data:image/png;base64,uploaded'] }, 'frames.json must survive re-save');

    // THEME_IMAGE_REVIEW payload reflects the survived tweak (proves the
    // re-post actually reads the fresh review, not stale cached state).
    const reviewItems = (posted[2].payload as any).items as any[];
    const repostedItem = reviewItems.find((i: any) => i.id === targetItem.id);
    assert.ok(repostedItem, 'expected the tweaked item in the reposted THEME_IMAGE_REVIEW');
    assert.equal(repostedItem.prompt, 'A hand-tweaked prompt the user wrote.');
    assert.equal(repostedItem.status, 'accepted');
  });
});
