import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Jimp from 'jimp';
import type { ThemeManifest } from '../src/shared/types';
import type { ThemePlan } from '../src/extension/themePlan';

// Regression coverage for p9-t4: a theme with frames.json but no
// review.json/images (the bundled sample theme's shape, and any
// imported/hand-made theme) must recover as ONE magenta board per
// character/rival/object/decor group — the same shape a generated theme
// shows — instead of one loose transparent atlas per frame key. See
// src/extension/themeService.ts's ensureThemeReviewImages /
// recoverBoardAlignedReviewImages and src/extension/themeBoardRecovery.ts.
//
// Same vscode-stub trick as test/themeResumeResliceRecovery.test.ts: this
// file exercises the real file-store pipeline (loadTheme, getThemeImageReview,
// initializeThemeImageReviewDocument) against a real temp directory, so the
// 'vscode' module is stubbed with real fs-backed Uri/workspace.fs members and
// everything else auto-stubs via a lazy Proxy.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require('module');
const originalLoad = NodeModule._load;

class FakeUri {
  readonly fsPath: string;
  readonly path: string;
  constructor(fsPath: string) {
    this.fsPath = fsPath;
    this.path = fsPath.split(path.sep).join('/');
  }
  static file(fsPath: string): FakeUri {
    return new FakeUri(fsPath);
  }
  static joinPath(base: FakeUri, ...segments: string[]): FakeUri {
    return new FakeUri(path.join(base.fsPath, ...segments.map((segment) => segment.split('/').join(path.sep))));
  }
}

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

function makeVscodeStub(): unknown {
  const target: Record<string, unknown> = {
    Uri: FakeUri,
    FileType,
    window: {
      createOutputChannel: () => ({
        appendLine: () => {},
        append: () => {},
        show: () => {},
        dispose: () => {},
      }),
    },
    workspace: {
      fs: {
        async readFile(uri: FakeUri): Promise<Uint8Array> {
          return fsp.readFile(uri.fsPath);
        },
        async writeFile(uri: FakeUri, data: Uint8Array): Promise<void> {
          await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fsp.writeFile(uri.fsPath, Buffer.from(data));
        },
        async readDirectory(uri: FakeUri): Promise<[string, number][]> {
          const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
          return entries.map((entry) => [entry.name, entry.isDirectory() ? FileType.Directory : FileType.File]);
        },
        async createDirectory(uri: FakeUri): Promise<void> {
          await fsp.mkdir(uri.fsPath, { recursive: true });
        },
        async stat(uri: FakeUri): Promise<{ type: number; size: number; mtime: number; ctime: number }> {
          const info = await fsp.stat(uri.fsPath);
          return {
            type: info.isDirectory() ? FileType.Directory : FileType.File,
            size: info.size,
            mtime: info.mtimeMs,
            ctime: info.mtimeMs,
          };
        },
        async delete(uri: FakeUri, options?: { recursive?: boolean }): Promise<void> {
          await fsp.rm(uri.fsPath, { recursive: options?.recursive ?? false, force: false });
        },
        async rename(from: FakeUri, to: FakeUri, options?: { overwrite?: boolean }): Promise<void> {
          if (options?.overwrite === false) {
            try {
              await fsp.stat(to.fsPath);
              throw new Error(`Destination already exists: ${to.fsPath}`);
            } catch (err) {
              if ((err as { code?: string }).code !== 'ENOENT') throw err;
            }
          }
          await fsp.mkdir(path.dirname(to.fsPath), { recursive: true });
          await fsp.rename(from.fsPath, to.fsPath);
        },
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(t, prop) {
      if (prop === '__esModule') return true;
      if (!(prop in t)) {
        t[prop] = new Proxy(function stub() {}, handler);
      }
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
  getThemeImageReview, createReviewItems, ensureThemeReviewImages,
} = require('../src/extension/themeService') as typeof import('../src/extension/themeService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizeThemePlan } = require('../src/extension/themePlan') as typeof import('../src/extension/themePlan');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  themeManifestPath, themeFramesPath, themePlanPath, themeReviewPath, themeDirectoryPath,
} = require('../src/extension/themeFileStore') as typeof import('../src/extension/themeFileStore');

function absPath(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split('/'));
}

async function dataUri(width: number, height: number, color: number): Promise<string> {
  const buffer = await new Jimp(width, height, color).getBufferAsync(Jimp.MIME_PNG);
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

function buildManifest(themeId: string): ThemeManifest {
  return {
    manifest_version: '1',
    theme_id: themeId,
    display_name: 'Recovery Test Theme',
    author: 'Test',
    viewport: {
      native_width: 533,
      native_height: 751,
      background_asset: 'frames.json#environment_background',
      walkable_nav_polygon: [[0, 0], [1, 0], [1, 1], [0, 1]],
    },
    roster_agents: [
      { slot_id: 0, name: 'Hero', atlas_asset: 'frames.json#agent_0', preferred_idle_pose: 'pose_up' },
    ],
    roster_rivals: [],
    buildable_objects: [],
    decor_objects: Array.from({ length: 9 }, (_unused, index) => ({
      decor_id: `decor_${index}`,
      display_name: `Decor ${index}`,
      sprite_asset: `frames.json#decor_decor_${index}`,
      anchor_coord: [0.5, 0.5] as [number, number],
    })),
    badges: [],
  };
}

function buildPlan(themeId: string): ThemePlan {
  return normalizeThemePlan({
    version: 1,
    theme_id: themeId,
    display_name: 'Recovery Test Theme',
    creative_direction: 'test direction',
    characters: ['Hero'],
    environment: 'test env',
    objects: [],
    decor: [],
    enemies: [],
    expressions: [],
    achievements: [],
  }, 'Recovery Test Theme');
}

interface Fixture {
  root: string;
  globalStorageUri: FakeUri;
  cleanup: () => Promise<void>;
}

/**
 * Lays out ONLY manifest + plan + frames.json — no review.json, no images —
 * reproducing the bundled/imported-theme shape this fix targets. The
 * character board (agent_0) gets 20 real frame images (a full character
 * atlas); every other board is left with no frames at all (still-pending).
 */
async function setupFramesOnlyTheme(themeId: string): Promise<Fixture> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-board-recovery-'));
  const globalStorageUri = FakeUri.file(root);

  const manifest = buildManifest(themeId);
  const plan = buildPlan(themeId);

  const frames: Record<string, string[]> = {
    agent_0: await Promise.all(Array.from({ length: 20 }, (_unused, index) => dataUri(8, 8, 0x00ff00ff + index))),
    environment_background: [await dataUri(12, 7, 0x123456ff)],
  };

  await fsp.mkdir(absPath(root, themeDirectoryPath(themeId)), { recursive: true });
  await fsp.writeFile(absPath(root, themeManifestPath(themeId)), JSON.stringify(manifest));
  await fsp.writeFile(absPath(root, themeFramesPath(themeId)), JSON.stringify(frames));
  await fsp.writeFile(absPath(root, themePlanPath(themeId)), JSON.stringify(plan));

  return { root, globalStorageUri, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

test('getThemeImageReview recovers a frames-only theme into the SAME board contract createReviewItems synthesizes, with one composed image per populated board', async () => {
  const themeId = 'board_recovery_theme';
  const fixture = await setupFramesOnlyTheme(themeId);
  try {
    const review = await getThemeImageReview(fixture.globalStorageUri as never, themeId);

    const manifest = buildManifest(themeId);
    const plan = buildPlan(themeId);
    const expectedItems = createReviewItems(plan, manifest, plan.creative_direction);

    // Schema parity: recovered review.json's item ids/kinds/filenames match
    // the generator's own createReviewItems output exactly (no per-key loose
    // ids like a filename stem).
    const recoveredDoc = JSON.parse(await fsp.readFile(absPath(fixture.root, themeReviewPath(themeId)), 'utf8'));
    const recoveredIds = recoveredDoc.items.map((item: { id: string }) => item.id).sort();
    const expectedIds = expectedItems.map((item) => item.id).sort();
    assert.deepEqual(recoveredIds, expectedIds);
    for (const expected of expectedItems) {
      const recovered = recoveredDoc.items.find((item: { id: string }) => item.id === expected.id);
      assert.ok(recovered, `missing recovered item for ${expected.id}`);
      assert.equal(recovered.kind, expected.kind);
      assert.equal(recovered.filename, expected.filename);
      assert.deepEqual(recovered.frame_keys, expected.frame_keys);
    }

    // The populated character board got a composed image; boards with no
    // stored frames (e.g. objects/decor/expressions/achievements — this
    // fixture never wrote their frame keys) stay imageless/pending, exactly
    // like an ungenerated board on a freshly-created theme.
    const characterEntry = review.entries.find((entry) => entry.item.id === 'agent_0');
    assert.ok(characterEntry?.imageUri, 'character board should have a composed image');

    const objectsEntry = review.entries.find((entry) => entry.item.id === 'objects_01');
    assert.equal(objectsEntry?.imageUri, undefined, 'ungenerated board must stay imageless');

    const environmentEntry = review.entries.find((entry) => entry.item.id === 'environment');
    assert.ok(environmentEntry?.imageUri, 'environment board should recover its single stored frame');
  } finally {
    await fixture.cleanup();
  }
});

test('ensureThemeReviewImages does not clobber an existing review.json when images were removed out-of-band', async () => {
  // Regression for p9-t4: the board-recovery branch used to overwrite
  // review.json any time the images dir was empty, even when a review
  // document already existed with user accept/reject state — wiping that
  // state out just because someone deleted the images folder. Recovery must
  // only synthesize (and write) review.json when NO review document exists
  // yet. Matches the standalone guard in standalone/src/themeMessages.mjs's
  // handleGetThemeImageReview (`if (!effectiveReviewDoc && manifest)`).
  const themeId = 'board_recovery_preserve_theme';
  const fixture = await setupFramesOnlyTheme(themeId);
  try {
    const existingReviewDoc = {
      version: 1,
      theme_id: themeId,
      display_name: 'Recovery Test Theme',
      items: [
        {
          id: 'agent_0', kind: 'character', filename: 'agent_0.png', frame_keys: ['agent_0'],
          status: 'accepted', updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'environment', kind: 'environment', filename: 'environment.png', frame_keys: ['environment_background'],
          status: 'rejected', updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    const reviewPath = absPath(fixture.root, themeReviewPath(themeId));
    await fsp.mkdir(path.dirname(reviewPath), { recursive: true });
    const originalReviewJson = JSON.stringify(existingReviewDoc, null, 2);
    await fsp.writeFile(reviewPath, originalReviewJson, 'utf8');

    // No images directory contents exist for this theme (setupFramesOnlyTheme
    // never wrote any images/ dir), reproducing "images removed out-of-band"
    // while review.json with user statuses survives.
    await ensureThemeReviewImages(fixture.globalStorageUri as never, themeId);

    const reviewJsonAfter = await fsp.readFile(reviewPath, 'utf8');
    assert.equal(reviewJsonAfter, originalReviewJson, 'review.json must be byte-identical: existing statuses preserved');
  } finally {
    await fixture.cleanup();
  }
});
