/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p77-t3: host-side coverage for phase p77 —
//  1) themeBoardCountsFromFrames (src/extension/themeService.ts ~645) counts
//     frames.json board keys only.
//  2) listThemes() entries carry hasBoards/boardCount (via
//     themeBoardCountsFromFrames inside listThemes' per-theme mapping).
//  3) panel.ts / server.mjs markup uses the "Tycoon Themes" / "Tycoon Theme
//     Builder" labels and no longer contains the old bare ">Themes<" /
//     ">Theme Builder<" button/heading text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PANEL_TS_PATH = path.join(process.cwd(), 'src', 'host', 'vscode', 'panel.ts');
const SERVER_MJS_PATH = path.join(process.cwd(), 'standalone', 'src', 'server.mjs');

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
const {
  themeBoardCountsFromFrames,
  saveThemePlan,
  listThemes,
} = require('../src/extension/themeService') as typeof import('../src/extension/themeService');
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
  };
}

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-theme-labels-boardcounts-'));
  configureThemeFileStore(createFsThemeFileStore(root));
  try {
    return await fn(root);
  } finally {
    resetThemeFileStoreForTests();
    await fsp.rm(root, { recursive: true, force: true });
  }
}

// ── themeBoardCountsFromFrames ──────────────────────────────────────────────

test('themeBoardCountsFromFrames: undefined/null/empty frames report hasBoards:false, boardCount:0', () => {
  assert.deepEqual(themeBoardCountsFromFrames(undefined), { hasBoards: false, boardCount: 0 });
  assert.deepEqual(themeBoardCountsFromFrames(null), { hasBoards: false, boardCount: 0 });
  assert.deepEqual(themeBoardCountsFromFrames({}), { hasBoards: false, boardCount: 0 });
});

test('themeBoardCountsFromFrames: counts every key present in frames.json as one board', () => {
  const frames = {
    environment_background: ['data:image/png;base64,AA=='],
    character_captain: ['data:image/png;base64,BB=='],
    crate: ['data:image/png;base64,CC=='],
  };
  assert.deepEqual(themeBoardCountsFromFrames(frames), { hasBoards: true, boardCount: 3 });
});

test('themeBoardCountsFromFrames: a single board key still reports hasBoards:true, boardCount:1', () => {
  assert.deepEqual(
    themeBoardCountsFromFrames({ environment_background: ['data:image/png;base64,AA=='] }),
    { hasBoards: true, boardCount: 1 },
  );
});

// ── listThemes() carries hasBoards/boardCount per entry ─────────────────────

test('listThemes: entries carry hasBoards:false/boardCount:0 for a freshly saved plan with no boards', async () => {
  await withTempRoot(async () => {
    await saveThemePlan({} as any, { display_name: 'No Boards Yet' });
    const themes = await listThemes({} as any);
    const entry = themes.find((t: any) => t.theme_id === 'no_boards_yet');
    assert.ok(entry, 'expected the saved theme in listThemes()');
    assert.equal((entry as any).hasBoards, false);
    assert.equal((entry as any).boardCount, 0);
  });
});

test('listThemes: entries report hasBoards:true/boardCount matching frames.json once a board is written', async () => {
  await withTempRoot(async (root) => {
    await saveThemePlan({} as any, { display_name: 'Has A Board' });
    const framesPath = path.join(root, 'themes', 'has_a_board', 'frames.json');
    await fsp.writeFile(
      framesPath,
      JSON.stringify({ environment_background: ['data:image/png;base64,AA=='] }),
    );
    const themes = await listThemes({} as any);
    const entry = themes.find((t: any) => t.theme_id === 'has_a_board');
    assert.ok(entry, 'expected the saved theme in listThemes()');
    assert.equal((entry as any).hasBoards, true);
    assert.equal((entry as any).boardCount, 1);
  });
});

// ── Host markup: "Tycoon Themes" / "Tycoon Theme Builder" labels ───────────

for (const [label, filePath] of [
  ['panel.ts', PANEL_TS_PATH],
  ['server.mjs', SERVER_MJS_PATH],
] as const) {
  test(`${label}: markup uses "Tycoon Themes" and "Tycoon Theme Builder" labels, not the old bare button/heading text`, () => {
    const src = readFileSync(filePath, 'utf8');

    assert.ok(src.includes('Tycoon Themes'), `${label} should contain the "Tycoon Themes" label`);
    assert.ok(src.includes('Tycoon Theme Builder'), `${label} should contain the "Tycoon Theme Builder" label`);

    assert.ok(!src.includes('>Themes<'), `${label} must not still render the old bare ">Themes<" button/heading text`);
    assert.ok(
      !src.includes('>Theme Builder<'),
      `${label} must not still render the old bare ">Theme Builder<" button/heading text`,
    );
  });
}
