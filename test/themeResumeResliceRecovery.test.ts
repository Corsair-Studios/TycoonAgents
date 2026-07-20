import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Jimp from 'jimp';
import type { ThemeManifest } from '../src/shared/types';
import type { ThemePlan } from '../src/extension/themePlan';

// Regression coverage for the resume-recovery fix in generateOrResumeThemeItem
// (src/extension/themeService.ts, ~2367-2402): when resume hits an INCOMPLETE
// review item (its frame_keys are not all populated in frames.json) that has no
// generation_error, is a RESLICEABLE_ATLAS_KIND, and a raw atlas is saved on
// disk, it re-slices from that raw image (persistRaw=false) instead of paying
// for another AI image-generation call, and PRESERVES the item's existing
// status (an 'accepted' board must stay 'accepted', never bounce to 'pending').
// If no raw image exists, it must fall through to the real AI-generation path.
//
// themeService.ts does `import * as vscode from 'vscode'` at module scope (and
// so do themeImageReviewState.ts / themeStorage.ts / themeMigration.ts); Node
// can't resolve the 'vscode' module outside the real extension host. Stub the
// module loader so the require chain resolves under plain `node --test` — same
// trick as test/themeExportRawExclusion.test.ts. Unlike the vscode-free-only
// stubs elsewhere, resumeThemeGeneration's full pipeline (loadTheme,
// loadThemeImageReviewDocument, writeThemeFiles, the ThemeFileStore vscode
// adapter) genuinely reads/writes real files, so this stub's Uri/workspace.fs
// members are wired to real Node fs calls against a real temp directory;
// everything else auto-stubs via the lazy Proxy (unused by this code path).
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
const { resumeThemeGeneration, createReviewItems } = require('../src/extension/themeService') as typeof import('../src/extension/themeService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizeThemePlan } = require('../src/extension/themePlan') as typeof import('../src/extension/themePlan');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  themeManifestPath, themeFramesPath, themePlanPath, themeReviewPath,
  themeImagesDirectoryPath, themeRawImagesDirectoryPath, themeDirectoryPath,
} = require('../src/extension/themeFileStore') as typeof import('../src/extension/themeFileStore');

function absPath(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split('/'));
}

function buildManifest(themeId: string): ThemeManifest {
  return {
    manifest_version: '1',
    theme_id: themeId,
    display_name: 'Reslice Test Theme',
    author: 'Test',
    viewport: {
      native_width: 533,
      native_height: 751,
      background_asset: 'frames.json#environment_background',
      walkable_nav_polygon: [[0, 0], [1, 0], [1, 1], [0, 1]],
    },
    // Empty agents/rivals/objects rosters keep the fixture to the minimal
    // unconditional board set (environment, decor, objects_01/02 — object
    // boards are always synthesized because themeObjectSpecs pads a legacy/
    // empty roster up to the fixed 21-object contract — expressions,
    // achievements). Decor MUST be exactly 9 items or createReviewItems
    // throws outright (createDecorBoardRows requires exactly 9, unconditional).
    roster_agents: [],
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
    display_name: 'Reslice Test Theme',
    creative_direction: 'test direction',
    characters: [],
    environment: 'test env',
    objects: [],
    decor: [],
    enemies: [],
    expressions: [],
    achievements: [],
  }, 'Reslice Test Theme');
}

async function buildMagentaAtlasBuffer(): Promise<Buffer> {
  // Mirrors test/slicer.test.ts's fixture style: a plain magenta chroma-key
  // canvas is a real, Jimp-decodable atlas that optimizeSpriteBoardCanvas /
  // sliceAndNormalizeAtlas can process without needing sprite content.
  const atlas = new Jimp(400, 200, 0xff00ffff);
  return atlas.getBufferAsync(Jimp.MIME_PNG);
}

interface Fixture {
  root: string;
  globalStorageUri: FakeUri;
  cleanup: () => Promise<void>;
}

/**
 * Lays out a minimal-but-real theme directory: manifest + normalized plan +
 * frames.json + review.json, where every board EXCEPT 'expressions' is marked
 * fully complete (image file present + every frame_key populated), and
 * 'expressions' is accepted-but-incomplete (frame_keys expression_0/1 absent
 * from frames.json) — reproducing "a board that was ACCEPTED in review but
 * whose sliced frames.json entry was lost" (see the fix's own comment).
 * `withRawImage` controls whether images/raw/expressions.png exists, which is
 * exactly the branch generateOrResumeThemeItem's new code decides on.
 */
async function setupFixtureTheme(themeId: string, withRawImage: boolean): Promise<Fixture> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-reslice-'));
  const globalStorageUri = FakeUri.file(root);

  const manifest = buildManifest(themeId);
  const plan = buildPlan(themeId);
  const expectedItems = createReviewItems(plan, manifest, plan.creative_direction);
  assert.ok(expectedItems.some((item) => item.id === 'expressions'), 'fixture sanity: expressions board must exist');

  const frames: Record<string, string[]> = {};
  for (const item of expectedItems) {
    await fsp.mkdir(path.dirname(absPath(root, `${themeImagesDirectoryPath(themeId)}/${item.filename}`)), { recursive: true });
    await fsp.writeFile(absPath(root, `${themeImagesDirectoryPath(themeId)}/${item.filename}`), Buffer.from([1, 2, 3]));
    if (item.id === 'expressions') continue; // the target item: leave its frame keys missing
    for (const key of item.frame_keys) frames[key] = ['dummy-frame-data'];
  }

  const now = new Date().toISOString();
  const reviewItems = expectedItems.map((item) => ({
    ...item,
    status: 'accepted' as const,
    revision: 1,
    updated_at: now,
    generation_error: undefined,
  }));
  const reviewDoc = { version: 1, theme_id: themeId, display_name: plan.display_name, items: reviewItems };

  await fsp.mkdir(absPath(root, themeDirectoryPath(themeId)), { recursive: true });
  await fsp.writeFile(absPath(root, themeManifestPath(themeId)), JSON.stringify(manifest));
  await fsp.writeFile(absPath(root, themeFramesPath(themeId)), JSON.stringify(frames));
  await fsp.writeFile(absPath(root, themePlanPath(themeId)), JSON.stringify(plan));
  await fsp.writeFile(absPath(root, themeReviewPath(themeId)), JSON.stringify(reviewDoc));

  if (withRawImage) {
    const rawPath = absPath(root, `${themeRawImagesDirectoryPath(themeId)}/expressions.png`);
    await fsp.mkdir(path.dirname(rawPath), { recursive: true });
    await fsp.writeFile(rawPath, await buildMagentaAtlasBuffer());
  }

  return { root, globalStorageUri, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

test('resume recovers an accepted-but-incomplete expression board by re-slicing its saved raw image, never calling the AI generator, and status stays accepted', async () => {
  const themeId = 'reslice_recovery_theme';
  const fixture = await setupFixtureTheme(themeId, true);
  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;
  globalThis.fetch = (async () => {
    fetchCallCount++;
    throw new Error('generateThemeImage must not be called: a raw atlas is available for reslice recovery');
  }) as typeof fetch;

  try {
    const progressMessages: string[] = [];
    await resumeThemeGeneration(
      fixture.globalStorageUri as unknown as import('vscode').Uri,
      themeId,
      (message) => progressMessages.push(message),
    );

    assert.equal(fetchCallCount, 0, 'the AI image generator must not be invoked when a raw atlas can be re-sliced');
    assert.ok(
      progressMessages.some((message) => message.includes('frames recovered from the saved original')),
      `expected a frame-recovery progress message, got: ${JSON.stringify(progressMessages)}`,
    );

    const frames = JSON.parse(await fsp.readFile(absPath(fixture.root, themeFramesPath(themeId)), 'utf8')) as Record<string, string[]>;
    assert.ok(Array.isArray(frames.expression_0) && frames.expression_0.length > 0, 'expression_0 must be recovered into frames.json');
    assert.ok(Array.isArray(frames.expression_1) && frames.expression_1.length > 0, 'expression_1 must be recovered into frames.json');

    const review = JSON.parse(await fsp.readFile(absPath(fixture.root, themeReviewPath(themeId)), 'utf8')) as { items: Array<{ id: string; status: string }> };
    const expressionsItem = review.items.find((item) => item.id === 'expressions');
    assert.ok(expressionsItem, 'expressions review item must still be present after resume');
    assert.equal(expressionsItem?.status, 'accepted', 'an accepted board must stay accepted after frame recovery, never bounce to pending');
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});

test('resume falls through to real AI generation for an incomplete item with no saved raw image', async () => {
  const themeId = 'reslice_no_raw_theme';
  const fixture = await setupFixtureTheme(themeId, false);
  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;
  const atlasBuffer = await buildMagentaAtlasBuffer();
  globalThis.fetch = (async () => {
    fetchCallCount++;
    return new Response(JSON.stringify({ data: [{ b64_json: atlasBuffer.toString('base64') }] }), { status: 200 });
  }) as typeof fetch;

  try {
    const progressMessages: string[] = [];
    await resumeThemeGeneration(
      fixture.globalStorageUri as unknown as import('vscode').Uri,
      themeId,
      (message) => progressMessages.push(message),
      undefined,
      undefined,
      { provider: 'openai', apiKey: 'test-key' },
    );

    assert.ok(fetchCallCount >= 1, 'the AI image generator must be invoked when no raw atlas is available to re-slice from');
    assert.ok(
      progressMessages.some((message) => message.includes('8-expression sprite sheet')),
      `expected the AI-generation progress message, got: ${JSON.stringify(progressMessages)}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});
