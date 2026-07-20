import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ThemeManifest } from '../src/shared/types';

// Regression coverage for the per-theme write mutex added around
// writeThemeFiles (src/extension/themeService.ts, runExclusivePerTheme ~3979,
// writeThemeFiles ~3995): two concurrent writeThemeFiles calls for the SAME
// theme, each scoped via ownedFrameKeys to a different frames.json key, must
// BOTH survive. Before the mutex, each call's merge-safe read (mergeOwnedFrames,
// ~3952) happens before its own slow write; if call A's write lands, then call
// B — which read its on-disk snapshot BEFORE A wrote — overwrites frames.json
// with a merge that never saw A's key, silently deleting it (a real lost
// update: this is exactly the "board retry" race the mutex closes, see
// retryThemeImage -> applySlicedAtlasFromBuffer -> writeThemeFiles).
//
// To make the race deterministic without depending on real scheduler timing,
// the stubbed vscode.workspace.fs.readFile yields the event loop (setImmediate)
// specifically on reads of frames.json. That forces both concurrent calls to
// finish their frames.json READ before either call's WRITE can land — the
// exact interleaving the mutex must prevent. Serialized (mutex present), the
// second call can't even start its read until the first call's write has
// completed, so this interleaving can never cause a clobber.
//
// Same 'vscode' module-loader stub trick as test/themeResumeResliceRecovery.test.ts
// and test/themeExportRawExclusion.test.ts (themeService.ts imports vscode at
// module scope; Node can't resolve it outside a real extension host).
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
          // Deterministic race window: only frames.json reads yield, so both
          // concurrent calls' reads interleave before either write lands.
          if (uri.fsPath.endsWith('frames.json')) {
            await new Promise((resolve) => setImmediate(resolve));
          }
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
const { writeThemeFiles } = require('../src/extension/themeService') as typeof import('../src/extension/themeService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { themeFramesPath, themeDirectoryPath } = require('../src/extension/themeFileStore') as typeof import('../src/extension/themeFileStore');

function absPath(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split('/'));
}

function buildManifest(themeId: string): ThemeManifest {
  return {
    manifest_version: '1',
    theme_id: themeId,
    display_name: 'Mutex Test Theme',
    author: 'Test',
    viewport: {
      native_width: 533,
      native_height: 751,
      background_asset: 'frames.json#environment_background',
      walkable_nav_polygon: [[0, 0], [1, 0], [1, 1], [0, 1]],
    },
    roster_agents: [],
    roster_rivals: [],
    buildable_objects: [],
    decor_objects: [],
    badges: [],
  };
}

async function setupEmptyTheme(themeId: string): Promise<{ root: string; globalStorageUri: FakeUri; cleanup: () => Promise<void> }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-frames-mutex-'));
  const globalStorageUri = FakeUri.file(root);
  await fsp.mkdir(absPath(root, themeDirectoryPath(themeId)), { recursive: true });
  await fsp.writeFile(absPath(root, themeFramesPath(themeId)), JSON.stringify({}));
  return { root, globalStorageUri, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

test('two concurrent merge-safe writeThemeFiles calls for the SAME theme both survive (no lost update)', async () => {
  const themeId = 'mutex_same_theme';
  const fixture = await setupEmptyTheme(themeId);
  try {
    const manifest = buildManifest(themeId);

    await Promise.all([
      writeThemeFiles(
        fixture.globalStorageUri as unknown as import('vscode').Uri,
        manifest,
        { agent_A: ['frame-a-1', 'frame-a-2'] },
        ['agent_A'],
      ),
      writeThemeFiles(
        fixture.globalStorageUri as unknown as import('vscode').Uri,
        manifest,
        { agent_B: ['frame-b-1'] },
        ['agent_B'],
      ),
    ]);

    const frames = JSON.parse(
      await fsp.readFile(absPath(fixture.root, themeFramesPath(themeId)), 'utf8'),
    ) as Record<string, string[]>;

    assert.ok(
      Array.isArray(frames.agent_A) && frames.agent_A.length === 2,
      `agent_A must survive the concurrent write, got: ${JSON.stringify(frames)}`,
    );
    assert.ok(
      Array.isArray(frames.agent_B) && frames.agent_B.length === 1,
      `agent_B must survive the concurrent write, got: ${JSON.stringify(frames)}`,
    );
    assert.deepEqual(frames.agent_A, ['frame-a-1', 'frame-a-2']);
    assert.deepEqual(frames.agent_B, ['frame-b-1']);
  } finally {
    await fixture.cleanup();
  }
});

test('concurrent writeThemeFiles calls for DIFFERENT themes are unaffected by the per-theme mutex', async () => {
  const themeIdOne = 'mutex_theme_one';
  const themeIdTwo = 'mutex_theme_two';
  const fixtureOne = await setupEmptyTheme(themeIdOne);
  const fixtureTwo = await setupEmptyTheme(themeIdTwo);
  try {
    const manifestOne = buildManifest(themeIdOne);
    const manifestTwo = buildManifest(themeIdTwo);

    await Promise.all([
      writeThemeFiles(
        fixtureOne.globalStorageUri as unknown as import('vscode').Uri,
        manifestOne,
        { agent_X: ['frame-x-1'] },
        ['agent_X'],
      ),
      writeThemeFiles(
        fixtureTwo.globalStorageUri as unknown as import('vscode').Uri,
        manifestTwo,
        { agent_Y: ['frame-y-1'] },
        ['agent_Y'],
      ),
    ]);

    const framesOne = JSON.parse(
      await fsp.readFile(absPath(fixtureOne.root, themeFramesPath(themeIdOne)), 'utf8'),
    ) as Record<string, string[]>;
    const framesTwo = JSON.parse(
      await fsp.readFile(absPath(fixtureTwo.root, themeFramesPath(themeIdTwo)), 'utf8'),
    ) as Record<string, string[]>;

    assert.deepEqual(framesOne.agent_X, ['frame-x-1']);
    assert.deepEqual(framesTwo.agent_Y, ['frame-y-1']);
  } finally {
    await fixtureOne.cleanup();
    await fixtureTwo.cleanup();
  }
});
