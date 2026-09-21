/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p80-t2: host-side coverage for the durable AI batch-generation run status
// (src/extension/themeImageReviewState.ts setThemeGenerationStatus ~302-313,
// generation_resumable computed in src/host/vscode/panel.ts ~3598-3608 and
// mirrored in standalone/src/themeMessages.mjs ~600-608) — persistence,
// isolation from manual-upload document writes, and the resumable/completed
// derivation, plus standalone payload-field parity.
//
// vscode module stub reused from test/themeResumeResliceRecovery.test.ts's
// pattern: workspace.fs wired to real Node fs against a real temp directory,
// everything else auto-stubbed via a lazy Proxy.

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
  initializeThemeImageReviewDocument,
  loadThemeImageReviewDocument,
  setThemeGenerationStatus,
  upsertThemeImageReviewItem,
} = require('../src/extension/themeImageReviewState') as typeof import('../src/extension/themeImageReviewState');

function reviewItemFixture(id: string, generated: boolean) {
  return {
    id, filename: `${id}.png`, label: id, kind: 'object_atlas' as const,
    status: 'pending' as const, prompt: 'p', revision: 0, frame_keys: [id],
    ...(generated ? { image_src: `${id}.png` } : {}),
  };
}

async function withTempRoot<T>(fn: (root: FakeUri) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-theme-gen-status-'));
  try {
    return await fn(FakeUri.file(dir) as unknown as FakeUri);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('setThemeGenerationStatus persists the status and is read back by loadThemeImageReviewDocument', async () => {
  await withTempRoot(async (root) => {
    const themeId = 'gen_status_theme';
    await initializeThemeImageReviewDocument(root as never, themeId, 'Gen Status Theme', [
      reviewItemFixture('objects_01', false),
    ]);

    let doc = await loadThemeImageReviewDocument(root as never, themeId);
    assert.equal(doc?.generation, undefined, 'a fresh document has no generation field (idle)');

    await setThemeGenerationStatus(root as never, themeId, 'active');
    doc = await loadThemeImageReviewDocument(root as never, themeId);
    assert.equal(doc?.generation?.status, 'active', 'setThemeGenerationStatus("active") must persist');

    await setThemeGenerationStatus(root as never, themeId, 'stopped');
    doc = await loadThemeImageReviewDocument(root as never, themeId);
    assert.equal(doc?.generation?.status, 'stopped', 'setThemeGenerationStatus("stopped") must persist and overwrite the prior status');
  });
});

test('a document write that is not setThemeGenerationStatus (the mutation uploadThemeImage performs) leaves generation status untouched', async () => {
  // uploadThemeImage (src/extension/themeService.ts ~888) loads the review
  // document, mutates only the uploaded item's fields, and writes the SAME
  // document object back out — it never assigns document.generation. This
  // isolates that same "document round-trip without touching generation"
  // behavior via upsertThemeImageReviewItem, the document-level primitive
  // uploadThemeImage's item write also goes through, without pulling in the
  // full loadTheme/manifest/atlas-slicing pipeline uploadThemeImage requires.
  await withTempRoot(async (root) => {
    const themeId = 'gen_status_upload_theme';
    await initializeThemeImageReviewDocument(root as never, themeId, 'Upload Theme', [
      reviewItemFixture('objects_01', false),
    ]);
    await setThemeGenerationStatus(root as never, themeId, 'active');

    await upsertThemeImageReviewItem(root as never, themeId, 'Upload Theme', reviewItemFixture('objects_01', true));

    const doc = await loadThemeImageReviewDocument(root as never, themeId);
    assert.equal(doc?.generation?.status, 'active', 'a manual-upload-style item write must not change generation status');
  });
});

test('generation_resumable derivation: true for a stopped run with an unfinished item, false once every item is generated', () => {
  // Mirrors the exact derivation in src/host/vscode/panel.ts (~3598-3608) and
  // standalone/src/themeMessages.mjs (~600-608): resumable requires status
  // "stopped" (or "active" with no matching in-memory run) AND at least one
  // unfinished item.
  function generationResumable(
    status: string,
    inMemoryRunForThisTheme: boolean,
    items: Array<{ generated?: boolean }>,
  ): boolean {
    const hasUnfinishedItem = items.some((item) => !item.generated);
    return (status === 'stopped' || (status === 'active' && !inMemoryRunForThisTheme)) && hasUnfinishedItem;
  }

  assert.equal(
    generationResumable('stopped', false, [{ generated: true }, { generated: false }]),
    true,
    'stopped + an unfinished item must be resumable',
  );
  assert.equal(
    generationResumable('completed', false, [{ generated: true }, { generated: true }]),
    false,
    'completed with every item generated must not be resumable',
  );
  assert.equal(
    generationResumable('stopped', false, [{ generated: true }, { generated: true }]),
    false,
    'stopped with every item already generated must not be resumable — nothing left to resume',
  );
  assert.equal(
    generationResumable('active', true, [{ generated: false }]),
    false,
    'an active run still owned by THIS process is not resumable — it is already running',
  );
  assert.equal(
    generationResumable('active', false, [{ generated: false }]),
    true,
    'an "active" status with no in-memory run for this theme means an interrupted run (extension closed mid-run) — resumable',
  );
});

test('standalone parity: standalone/src/themeMessages.mjs computes generation_resumable with the same status+unfinished-item rule as panel.ts', async () => {
  const panelSrc = await fsp.readFile(path.join(process.cwd(), 'src', 'host', 'vscode', 'panel.ts'), 'utf8');
  const standaloneSrc = await fsp.readFile(path.join(process.cwd(), 'standalone', 'src', 'themeMessages.mjs'), 'utf8');

  for (const src of [panelSrc, standaloneSrc]) {
    assert.match(src, /generation_status\s*:\s*generationStatus/, 'expected a generation_status: generationStatus field in the payload');
    assert.match(src, /generation_resumable\s*:\s*generationResumable/, 'expected a generation_resumable: generationResumable field in the payload');
    assert.match(src, /generationStatus\s*===\s*['"]stopped['"]/, 'expected the resumable rule to check for a stopped status');
    assert.match(src, /hasUnfinishedItem/, 'expected the resumable rule to require an unfinished item');
  }
});
