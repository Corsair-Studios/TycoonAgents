import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// themeService.ts does `import * as vscode from 'vscode'` at module scope; Node can't
// resolve the 'vscode' module outside the real extension host. Stub the module loader
// so the require chain below resolves under plain `node --test` — same trick as
// test/themeMigration.test.ts / test/themeExportRawExclusion.test.ts. Unlike the
// migration test, resolveUniqueNewThemeId actually reads a real directory tree via
// vscode.workspace.fs.readDirectory, so (mirroring themeExportRawExclusion.test.ts)
// the stub's Uri/workspace.fs/FileType members are wired to real Node fs calls against
// a real temp directory; everything else auto-stubs via the lazy Proxy (unused here).
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
const { resolveUniqueNewThemeId } = require('../src/extension/themeService') as typeof import('../src/extension/themeService');

/** Creates a temp globalStorage root with a themes/ dir containing the given theme-id subfolders. */
async function setupThemesDirectory(existingThemeIds: string[]): Promise<{ globalStorageUri: FakeUri; cleanup: () => Promise<void> }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-theme-id-'));
  const themesDir = path.join(root, 'themes');
  await fsp.mkdir(themesDir, { recursive: true });
  for (const id of existingThemeIds) {
    await fsp.mkdir(path.join(themesDir, id), { recursive: true });
  }
  return {
    globalStorageUri: FakeUri.file(root),
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

test('resolveUniqueNewThemeId returns the base id unchanged when no folder collides', async () => {
  const { globalStorageUri, cleanup } = await setupThemesDirectory(['other_theme']);
  try {
    const result = await resolveUniqueNewThemeId(globalStorageUri as unknown as import('vscode').Uri, 'castle');
    assert.equal(result, 'castle');
  } finally {
    await cleanup();
  }
});

test('resolveUniqueNewThemeId appends _2 when the base id folder already exists', async () => {
  const { globalStorageUri, cleanup } = await setupThemesDirectory(['cobra_command']);
  try {
    const result = await resolveUniqueNewThemeId(globalStorageUri as unknown as import('vscode').Uri, 'cobra_command');
    assert.equal(result, 'cobra_command_2');

    // The returned id must not itself collide with an existing folder.
    const themesDir = path.join(globalStorageUri.fsPath, 'themes');
    const existing = await fsp.readdir(themesDir);
    assert.ok(!existing.includes(result), `resolved id "${result}" must not already exist on disk, got: ${existing.join(', ')}`);
  } finally {
    await cleanup();
  }
});

test('resolveUniqueNewThemeId increments past multiple collisions (base and _2 both exist) to _3', async () => {
  const { globalStorageUri, cleanup } = await setupThemesDirectory(['cobra_command', 'cobra_command_2']);
  try {
    const result = await resolveUniqueNewThemeId(globalStorageUri as unknown as import('vscode').Uri, 'cobra_command');
    assert.equal(result, 'cobra_command_3');

    const themesDir = path.join(globalStorageUri.fsPath, 'themes');
    const existing = await fsp.readdir(themesDir);
    assert.ok(!existing.includes(result), `resolved id "${result}" must not already exist on disk, got: ${existing.join(', ')}`);
  } finally {
    await cleanup();
  }
});

test('resolveUniqueNewThemeId returns the base id unchanged when the themes directory does not exist yet', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-theme-id-'));
  // Deliberately do NOT create a themes/ subdirectory (first-ever theme scenario).
  try {
    const result = await resolveUniqueNewThemeId(FakeUri.file(root) as unknown as import('vscode').Uri, 'brand_new');
    assert.equal(result, 'brand_new');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
