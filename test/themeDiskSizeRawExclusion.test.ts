/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// themeService.ts's own module scope is vscode-free, but it pulls in sibling
// modules (themeImageReviewState.ts etc.) that do `import * as vscode from
// 'vscode'` -- Node can't resolve that outside the real extension host. Stub
// the module loader the same way test/themeExportRawExclusion.test.ts does,
// purely so `require('../src/extension/themeService')` resolves. Unlike that
// test, we never let anything reach real vscode.workspace.fs: instead we
// inject a plain Node-fs-backed ThemeFileStore via `configureThemeFileStore`
// (themeFileStore.ts's documented test escape hatch), so `resolveThemeFileStore`
// returns it regardless of what `globalStorageUri` value is passed around.
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
const { listThemes } = require('../src/extension/themeService') as typeof import('../src/extension/themeService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  configureThemeFileStore,
  resetThemeFileStoreForTests,
} = require('../src/extension/themeFileStore') as typeof import('../src/extension/themeFileStore');
type ThemeFileStore = import('../src/extension/themeFileStore').ThemeFileStore;
type ThemeFileStoreEntry = import('../src/extension/themeFileStore').ThemeFileStoreEntry;
type ThemeFileStoreStat = import('../src/extension/themeFileStore').ThemeFileStoreStat;

/** Minimal real-fs-backed ThemeFileStore rooted at `root`, for exercising getThemeDiskSize via listThemes. */
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

/**
 * Lays out a real theme directory: manifest.json + a couple of real images/
 * files (real content), a large file under images/raw/ (intermediate, must
 * be excluded), and a manifest.json.<ts>.bak backup sibling (also excluded).
 */
async function setupThemeDirectory(root: string, themeId: string): Promise<void> {
  const themeDir = path.join(root, 'themes', themeId);
  await fsp.mkdir(path.join(themeDir, 'images', 'raw'), { recursive: true });

  const manifest = {
    manifest_version: '1.0.0',
    theme_id: themeId,
    display_name: 'Disk Size Theme',
    author: 'Test',
    viewport: {
      native_width: 800,
      native_height: 600,
      background_asset: 'environment_background',
      walkable_nav_polygon: [[0, 0], [800, 0], [800, 600], [0, 600]],
    },
    roster_agents: [],
    roster_rivals: [],
    buildable_objects: [],
    badges: [],
  };
  await fsp.writeFile(path.join(themeDir, 'manifest.json'), JSON.stringify(manifest));
  await fsp.writeFile(path.join(themeDir, 'frames.json'), JSON.stringify({ agents_atlas: ['data:image/png;base64,abc'] }));

  // Real, shippable content.
  await fsp.writeFile(path.join(themeDir, 'images', 'agents_atlas.png'), Buffer.alloc(1_000, 1));
  await fsp.writeFile(path.join(themeDir, 'images', 'objects_atlas.png'), Buffer.alloc(2_000, 2));

  // Intermediate raw atlas -- must be excluded, and is deliberately much
  // larger than the real content so a leak would be obvious in the assert.
  await fsp.writeFile(path.join(themeDir, 'images', 'raw', 'agents_atlas_raw.png'), Buffer.alloc(50_000, 9));

  // Backup sidecar -- must be excluded.
  await fsp.writeFile(path.join(themeDir, `manifest.json.${Date.now()}.bak`), Buffer.alloc(5_000, 5));
}

test('listThemes size_bytes counts real content and excludes images/raw/ + .bak backups', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-theme-disksize-'));
  try {
    await setupThemeDirectory(root, 'castle_theme');
    configureThemeFileStore(createFsThemeFileStore(root));
    try {
      const themes = await listThemes({});
      const theme = themes.find((t) => t.theme_id === 'castle_theme');
      assert.ok(theme, 'castle_theme must be listed');
      // manifest.json + frames.json + the two real images -- NOT the 50000-byte
      // raw file or the 5000-byte .bak sidecar.
      const manifestBytes = JSON.stringify({
        manifest_version: '1.0.0',
        theme_id: 'castle_theme',
        display_name: 'Disk Size Theme',
        author: 'Test',
        viewport: {
          native_width: 800,
          native_height: 600,
          background_asset: 'environment_background',
          walkable_nav_polygon: [[0, 0], [800, 0], [800, 600], [0, 600]],
        },
        roster_agents: [],
        roster_rivals: [],
        buildable_objects: [],
        badges: [],
      }).length;
      const framesBytes = JSON.stringify({ agents_atlas: ['data:image/png;base64,abc'] }).length;
      const expected = manifestBytes + framesBytes + 1_000 + 2_000;
      assert.equal(theme!.size_bytes, expected, `size_bytes must equal real content only, got ${theme!.size_bytes}`);
      assert.ok(theme!.size_bytes < 50_000, 'size_bytes must not include the raw atlas');
    } finally {
      resetThemeFileStoreForTests();
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a theme id containing "raw" as a substring is not affected by the raw/ directory exclusion', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-theme-disksize-rawid-'));
  try {
    // "raw_frontier" contains "raw" as a substring of the theme id itself --
    // must not be mistaken for the images/raw/ directory-name match.
    await setupThemeDirectory(root, 'raw_frontier');
    configureThemeFileStore(createFsThemeFileStore(root));
    try {
      const themes = await listThemes({});
      const theme = themes.find((t) => t.theme_id === 'raw_frontier');
      assert.ok(theme, 'raw_frontier must be listed');
      assert.ok(theme!.size_bytes > 0, 'raw_frontier must still report its real content size');
      assert.ok(theme!.size_bytes < 50_000, 'raw_frontier must still exclude its own images/raw/ contents');
    } finally {
      resetThemeFileStoreForTests();
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
