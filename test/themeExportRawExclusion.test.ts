import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// themeService.ts does `import * as vscode from 'vscode'` at module scope (and so do
// its dependencies themeStorage.ts / themeImageReviewState.ts / themeApproval.ts);
// Node can't resolve the 'vscode' module outside the real extension host. Stub the
// module loader so the require chain below resolves under plain `node --test` — same
// trick as test/themeMigration.test.ts. Unlike that file, exportThemeArchive actually
// walks a real directory tree via vscode.workspace.fs, so the stub's Uri/workspace.fs/
// FileType members are wired to real Node fs calls against a real temp directory;
// everything else auto-stubs via the lazy Proxy (unused by this code path).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require('module');
const originalLoad = NodeModule._load;

function toFsPath(p: string): string {
  return p.split('/').join(path.sep);
}

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
    return new FakeUri(path.join(base.fsPath, ...segments.map(toFsPath)));
  }
}

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

function makeVscodeStub(): unknown {
  const target: Record<string, unknown> = {
    Uri: FakeUri,
    FileType,
    workspace: {
      fs: {
        async readDirectory(uri: FakeUri): Promise<[string, number][]> {
          const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
          return entries.map((entry) => [entry.name, entry.isDirectory() ? FileType.Directory : FileType.File]);
        },
        async readFile(uri: FakeUri): Promise<Uint8Array> {
          return fsp.readFile(uri.fsPath);
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
const { exportThemeArchive } = require('../src/extension/themeService') as typeof import('../src/extension/themeService');

/** Lays out a minimal-but-real theme directory on disk and returns its globalStorageUri (a FakeUri). */
async function setupThemeDirectory(themeId: string): Promise<{ globalStorageUri: FakeUri; cleanup: () => Promise<void> }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-theme-export-'));
  const themeDir = path.join(root, 'themes', themeId);
  await fsp.mkdir(path.join(themeDir, 'images', 'raw'), { recursive: true });

  const manifest = {
    manifest_version: '1.0.0',
    theme_id: themeId,
    display_name: 'Raw Exclusion Theme',
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

  // One accepted review item so getThemeApprovalSummary reports export_ready = true.
  const reviewDocument = {
    version: 1,
    theme_id: themeId,
    display_name: 'Raw Exclusion Theme',
    items: [
      {
        id: 'character_atlas',
        filename: 'agents_atlas.png',
        label: 'Characters',
        kind: 'character_atlas',
        status: 'accepted',
        prompt: 'test prompt',
        revision: 1,
        frame_keys: ['agents_atlas'],
        updated_at: new Date().toISOString(),
      },
    ],
  };
  await fsp.writeFile(path.join(themeDir, 'review.json'), JSON.stringify(reviewDocument));

  // The final, normalized sliced atlas — must survive export.
  await fsp.writeFile(path.join(themeDir, 'images', 'agents_atlas.png'), Buffer.from([1, 2, 3]));
  // A sibling file that merely starts with "raw" (not the images/raw/ directory) —
  // must NOT be caught by an over-eager prefix match.
  await fsp.writeFile(path.join(themeDir, 'images', 'rawother.png'), Buffer.from([4, 5, 6]));
  // The pre-slice raw atlas retained under images/raw/ — must be excluded from export.
  await fsp.writeFile(path.join(themeDir, 'images', 'raw', 'agents_atlas.png'), Buffer.from([9, 9, 9]));

  return {
    globalStorageUri: FakeUri.file(root),
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

test('exportThemeArchive excludes images/raw/ from the exported archive', async () => {
  const { globalStorageUri, cleanup } = await setupThemeDirectory('raw_exclusion_theme');
  try {
    const archiveBytes = await exportThemeArchive(globalStorageUri as unknown as import('vscode').Uri, 'raw_exclusion_theme');
    const files = unzipSync(archiveBytes);
    const paths = Object.keys(files);

    // Excluded: everything under images/raw/.
    assert.ok(!paths.includes('images/raw/agents_atlas.png'), `images/raw/agents_atlas.png must be excluded, got: ${paths.join(', ')}`);
    assert.ok(!paths.some((p) => p.startsWith('images/raw/')), `no path under images/raw/ may survive export, got: ${paths.join(', ')}`);

    // Included: the normalized sliced atlas and the core theme files.
    assert.ok(paths.includes('images/agents_atlas.png'), 'images/agents_atlas.png must be included');
    assert.ok(paths.includes('frames.json'), 'frames.json must be included');
    assert.ok(paths.includes('manifest.json'), 'manifest.json must be included');

    // Guard: a sibling path that merely starts with "raw" (not a images/raw/ path)
    // must survive — proves the exclusion is an exact-dir/slash-prefix match, not a
    // loose substring/prefix match on the name "raw".
    assert.ok(paths.includes('images/rawother.png'), `images/rawother.png must NOT be swept up by the images/raw/ exclusion, got: ${paths.join(', ')}`);
  } finally {
    await cleanup();
  }
});
