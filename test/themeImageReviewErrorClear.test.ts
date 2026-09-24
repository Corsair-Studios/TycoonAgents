/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Follow-up fix (stale error notices persisting through "Generating..." and
// across a VS Code restart): coverage for clearThemeImageReviewItemError
// (src/extension/themeImageReviewState.ts) — the persisted-state clear
// called at the start of a new attempt (themeService.ts's retryThemeImage).
//
// vscode module stub + temp-root harness copied verbatim from
// test/themeGenerationStatusPersistence.test.ts's pattern.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

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
  clearThemeImageReviewItemError,
  initializeThemeImageReviewDocument,
  loadThemeImageReviewDocument,
  setThemeImageReviewErrorKind,
} = require('../src/extension/themeImageReviewState') as typeof import('../src/extension/themeImageReviewState');

function reviewItemFixture(id: string) {
  return {
    id, filename: `${id}.png`, label: id, kind: 'object_atlas' as const,
    status: 'pending' as const, prompt: 'p', revision: 0, frame_keys: [id],
  };
}

async function withTempRoot<T>(fn: (root: FakeUri) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-theme-error-clear-'));
  try {
    return await fn(FakeUri.file(dir) as unknown as FakeUri);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('clearThemeImageReviewItemError wipes error_kind and its detail fields, marking the write time', async () => {
  await withTempRoot(async (root) => {
    const themeId = 'clear_error_theme';
    await initializeThemeImageReviewDocument(root as never, themeId, 'Clear Error Theme', [
      reviewItemFixture('objects_01'),
    ]);
    await setThemeImageReviewErrorKind(
      root as never, themeId, 'objects_01', 'unavailable', undefined, undefined, undefined, undefined, undefined, 'session-abc',
    );
    let doc = await loadThemeImageReviewDocument(root as never, themeId);
    assert.equal(doc?.items[0].error_kind, 'unavailable', 'expected the error to be persisted first');
    assert.equal(doc?.items[0].error_session, 'session-abc', 'expected the session stamp to be persisted');

    await clearThemeImageReviewItemError(root as never, themeId, 'objects_01');
    doc = await loadThemeImageReviewDocument(root as never, themeId);
    const item = doc?.items[0];
    assert.equal(item?.error_kind, undefined, 'error_kind should be cleared');
    assert.equal(item?.error_code, undefined);
    assert.equal(item?.error_categories, undefined);
    assert.equal(item?.error_fields, undefined);
    assert.equal(item?.error_session, undefined, 'error_session should be cleared too — a new attempt clears the old error');
    assert.equal(item?.generation_error, undefined);
  });
});

test('clearThemeImageReviewItemError clears a content_blocked error too — a NEW attempt starting always clears the previous one, durable or not', async () => {
  await withTempRoot(async (root) => {
    const themeId = 'clear_error_blocked_theme';
    await initializeThemeImageReviewDocument(root as never, themeId, 'Clear Error Blocked Theme', [
      reviewItemFixture('objects_01'),
    ]);
    await setThemeImageReviewErrorKind(
      root as never, themeId, 'objects_01', 'content_blocked', undefined, undefined, undefined, ['illicit'], ['theme.description'],
    );
    let doc = await loadThemeImageReviewDocument(root as never, themeId);
    assert.equal(doc?.items[0].error_kind, 'content_blocked');

    await clearThemeImageReviewItemError(root as never, themeId, 'objects_01');
    doc = await loadThemeImageReviewDocument(root as never, themeId);
    assert.equal(doc?.items[0].error_kind, undefined, 'a new attempt clears the old error regardless of kind');
    assert.equal(doc?.items[0].error_categories, undefined);
  });
});

test('clearThemeImageReviewItemError is a no-op (no extra write) when the item already has no error', async () => {
  await withTempRoot(async (root) => {
    const themeId = 'clear_error_noop_theme';
    const initial = await initializeThemeImageReviewDocument(root as never, themeId, 'Clear Error Noop Theme', [
      reviewItemFixture('objects_01'),
    ]);
    const before = initial.items[0].updated_at;

    const result = await clearThemeImageReviewItemError(root as never, themeId, 'objects_01');
    assert.equal(result?.items[0].updated_at, before, 'no error present means no write, so updated_at is untouched');
  });
});

test('clearThemeImageReviewItemError on an unknown theme/item is a safe no-op', async () => {
  await withTempRoot(async (root) => {
    const result = await clearThemeImageReviewItemError(root as never, 'nonexistent_theme', 'nonexistent_item');
    assert.equal(result, undefined);
  });
});
