// p59-t4: coverage for the v3.4 prompt-drift notice — generateBoardImage
// (src/extension/themeService.ts:363) sha256-compares its local preview
// prompt against the response's assembledPromptSha256 and, on a mismatch,
// calls the notifier registered via setThemePromptMismatchNotifier. Exercised
// through generateTheme's environment board (simplest structured request, no
// character/object rows) with a fake generator that computes its own
// "server-assembled" hash from assembleThemePrompt so the equal/mismatch
// cases are controlled directly, rather than depending on exact byte
// equality between two independent prompt builders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import Jimp from 'jimp';
import type { ThemePlan } from '../src/extension/themePlan';

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
    return new FakeUri(path.join(base.fsPath, ...segments.map((s) => s.split('/').join(path.sep))));
  }
}
const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
function makeVscodeStub(): unknown {
  const target: Record<string, unknown> = {
    Uri: FakeUri,
    FileType,
    workspace: {
      fs: {
        async readFile(uri: FakeUri): Promise<Uint8Array> { return fsp.readFile(uri.fsPath); },
        async writeFile(uri: FakeUri, data: Uint8Array): Promise<void> {
          await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fsp.writeFile(uri.fsPath, Buffer.from(data));
        },
        async readDirectory(uri: FakeUri): Promise<[string, number][]> {
          const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
          return entries.map((e) => [e.name, e.isDirectory() ? FileType.Directory : FileType.File]);
        },
        async createDirectory(uri: FakeUri): Promise<void> { await fsp.mkdir(uri.fsPath, { recursive: true }); },
        async stat(uri: FakeUri): Promise<{ type: number; size: number; mtime: number; ctime: number }> {
          const info = await fsp.stat(uri.fsPath);
          return { type: info.isDirectory() ? FileType.Directory : FileType.File, size: info.size, mtime: info.mtimeMs, ctime: info.mtimeMs };
        },
        async delete(uri: FakeUri, options?: { recursive?: boolean }): Promise<void> {
          await fsp.rm(uri.fsPath, { recursive: options?.recursive ?? false, force: false });
        },
        async rename(from: FakeUri, to: FakeUri): Promise<void> {
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
      if (!(prop in t)) t[prop] = new Proxy(function stub() {}, handler);
      return t[prop];
    },
    apply() { return new Proxy({}, handler); },
    construct() { return new Proxy({}, handler); },
  };
  return new Proxy(target, handler);
}
const vscodeStub = makeVscodeStub();
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const themeService = require('../src/extension/themeService') as typeof import('../src/extension/themeService');
const { generateTheme, retryThemeImage, setThemeImageGenerator, setThemePromptMismatchNotifier } = themeService;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizeThemePlan } = require('../src/extension/themePlan') as typeof import('../src/extension/themePlan');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assembleThemePrompt } = require('../src/core/themePromptTemplates') as typeof import('../src/core/themePromptTemplates');

function buildPlan(themeId: string): ThemePlan {
  return normalizeThemePlan({
    version: 1,
    theme_id: themeId,
    display_name: 'Mismatch Notifier Theme',
    creative_direction: 'test direction',
    characters: [],
    environment: 'test env',
    objects: [],
    decor: [],
    enemies: [],
    expressions: [],
    achievements: [],
  }, 'Mismatch Notifier Theme');
}

async function withTempStore<T>(fn: (globalStorageUri: FakeUri) => Promise<T>): Promise<T> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-prompt-mismatch-'));
  try {
    return await fn(FakeUri.file(root));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSelfHashingGenerator(opts: { corrupt?: boolean }) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async generate(req: any) {
      const { prompt } = assembleThemePrompt(req);
      const hash = opts.corrupt ? sha256Hex(`${prompt}-CORRUPTED`) : sha256Hex(prompt);
      const image = await magentaAtlas();
      return {
        ok: true as const,
        value: {
          image,
          attemptCost: 1,
          credits: 99,
          refunded: false,
          promptTemplateVersion: 'server-v-next',
          assembledPromptSha256: hash,
        },
      };
    },
  };
}

// Both cases retry the SAME single 'environment' board (buildReplacementPrompt
// and buildReplacementRequest's environment branches call
// buildEnvironmentPrompt/buildEnvironmentRequest with identical arguments —
// see src/extension/themeService.ts ~4413/4505 — so their outputs agree
// exactly, isolating the assertion to the notifier's own equal/not-equal
// behavior rather than depending on many boards' prompt builders agreeing.
async function magentaAtlas(): Promise<Buffer> {
  const atlas = new Jimp(400, 200, 0xff00ffff);
  return atlas.getBufferAsync(Jimp.MIME_PNG);
}

async function setupThemeWithFrames(themeId: string, globalStorageUri: FakeUri): Promise<ThemePlan> {
  const plan = buildPlan(themeId);
  plan.theme_id = themeId;
  setThemeImageGenerator({
    async generate() {
      const image = await magentaAtlas();
      return { ok: true as const, value: { image, attemptCost: 1, credits: 99, refunded: false } };
    },
  });
  try {
    await generateTheme(globalStorageUri as unknown as import('vscode').Uri, plan, () => {});
  } finally {
    setThemeImageGenerator(undefined);
  }
  return plan;
}

test('mismatch notifier fires when assembledPromptSha256 differs from the local preview hash', async () => {
  await withTempStore(async (globalStorageUri) => {
    const themeId = 'mismatch_fires_theme';
    await setupThemeWithFrames(themeId, globalStorageUri);
    const messages: string[] = [];
    setThemePromptMismatchNotifier((m) => messages.push(m));
    setThemeImageGenerator(makeSelfHashingGenerator({ corrupt: true }));
    try {
      await retryThemeImage(globalStorageUri as unknown as import('vscode').Uri, themeId, 'environment', '', 'retry', {});
      assert.equal(messages.length, 1, `expected exactly one mismatch notice, got: ${JSON.stringify(messages)}`);
      assert.ok(messages[0].includes('newer prompt template'), `unexpected notice text: ${messages[0]}`);
    } finally {
      setThemeImageGenerator(undefined);
      setThemePromptMismatchNotifier(undefined);
    }
  });
});

test('mismatch notifier does not fire when assembledPromptSha256 equals the local preview hash', async () => {
  await withTempStore(async (globalStorageUri) => {
    const themeId = 'mismatch_silent_theme';
    await setupThemeWithFrames(themeId, globalStorageUri);
    const messages: string[] = [];
    setThemePromptMismatchNotifier((m) => messages.push(m));
    setThemeImageGenerator(makeSelfHashingGenerator({ corrupt: false }));
    try {
      await retryThemeImage(globalStorageUri as unknown as import('vscode').Uri, themeId, 'environment', '', 'retry', {});
      assert.equal(messages.length, 0, `expected no mismatch notices, got: ${JSON.stringify(messages)}`);
    } finally {
      setThemeImageGenerator(undefined);
      setThemePromptMismatchNotifier(undefined);
    }
  });
});
