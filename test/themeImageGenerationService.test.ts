import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Jimp from 'jimp';
import type { ThemeManifest } from '../src/shared/types';
import type { ThemePlan } from '../src/extension/themePlan';

// Coverage for p43-t1: generation attempts route through the Corsair Theme
// Service (src/core/themeServiceClient.ts's generateAttempt) via the
// ThemeImageGenerator seam in src/extension/themeService.ts, instead of the
// removed direct-provider imageClient.ts. Same vscode-module-stub trick as
// test/themeResumeResliceRecovery.test.ts (themeService.ts imports 'vscode'
// at module scope; the ThemeFileStore adapter genuinely reads/writes a real
// temp directory through the stub's workspace.fs).
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
const themeService = require('../src/extension/themeService') as typeof import('../src/extension/themeService');
const {
  generateTheme, retryThemeImage, resliceThemeImageFromRaw, getThemeImageReview,
  setThemeImageGenerator, boardTypeForItem, createServiceImageGenerator,
} = themeService;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { recordAttemptCharge, themeCreditsSpent } = require('../src/extension/themeImageReviewState') as typeof import('../src/extension/themeImageReviewState');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizeThemePlan } = require('../src/extension/themePlan') as typeof import('../src/extension/themePlan');

function buildPlan(themeId: string): ThemePlan {
  return normalizeThemePlan({
    version: 1,
    theme_id: themeId,
    display_name: 'Attempt Accounting Theme',
    creative_direction: 'test direction',
    characters: [],
    environment: 'test env',
    objects: [],
    decor: [],
    enemies: [],
    expressions: [],
    achievements: [],
  }, 'Attempt Accounting Theme');
}

// p87: encoding a fresh 400x200 PNG via Jimp on every call is real CPU work,
// and a full theme generation calls this once per board item (roster
// agents, rivals, objects, decor...). Tests that run generateTheme several
// times in a loop (e.g. the error-kind matrix below) were repeating that
// encode dozens of times per run, and on this machine enough of them back to
// back reliably starved the event loop long enough to blow past any
// per-test timeout. The encoded bytes are never asserted on here, so cache
// and reuse one buffer instead of re-encoding it every call.
let cachedMagentaAtlas: Buffer | undefined;
async function magentaAtlas(): Promise<Buffer> {
  if (!cachedMagentaAtlas) {
    const atlas = new Jimp(400, 200, 0xff00ffff);
    cachedMagentaAtlas = await atlas.getBufferAsync(Jimp.MIME_PNG);
  }
  return cachedMagentaAtlas;
}

// p59-t4: v3.4 structured request — no free-text `prompt` field (see
// src/extension/themeService.ts's ThemeImageGenerateRequest).
interface FakeGenerateCall {
  idempotencyKey: string;
  boardType: string;
  referenceImages?: string[];
  size: string;
}

/** Counting fake generator (p43-t1): every call succeeds and costs 1 credit unless `fail` says otherwise. */
type FakeErrorKind = 'not_signed_in' | 'insufficient_credits' | 'rate_limited' | 'provider_failed' | 'unavailable' | 'unreachable' | 'server_error' | 'invalid_response';

function makeCountingGenerator(opts: { fail?: (call: FakeGenerateCall, callIndex: number) => { kind: FakeErrorKind; message: string; refunded?: boolean; credits?: number } | undefined } = {}) {
  const calls: FakeGenerateCall[] = [];
  let credits = 100;
  return {
    calls,
    generator: {
      async generate(req: FakeGenerateCall) {
        calls.push(req);
        const failure = opts.fail?.(req, calls.length - 1);
        if (failure) {
          if (failure.refunded === false) credits -= 1;
          return { ok: false as const, error: { kind: failure.kind, message: failure.message, refunded: failure.refunded, credits: failure.credits ?? credits } };
        }
        credits -= 1;
        const image = await magentaAtlas();
        return { ok: true as const, value: { image, attemptCost: 1, credits, refunded: false } };
      },
    },
  };
}

async function withTempStore<T>(fn: (globalStorageUri: FakeUri) => Promise<T>): Promise<T> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-theme-svc-'));
  try {
    return await fn(FakeUri.file(root));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

// A full successful generateTheme run costs ~4s of real Jimp slicing/encoding
// in the product pipeline, which is what pushed this file toward the CI
// per-file limit. Tests that only need "a theme generated by the default
// counting generator" share one run: read-only tests use it in place, and
// tests that mutate it (reslice, retry, charge accounting) work on a copy.
const BASELINE_THEME_ID = 'shared_baseline_theme';
interface Baseline { root: string; calls: FakeGenerateCall[] }
let baselinePromise: Promise<Baseline> | undefined;
const copiedRoots: string[] = [];
function sharedBaseline(): Promise<Baseline> {
  if (!baselinePromise) {
    baselinePromise = (async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-theme-svc-base-'));
      const plan = buildPlan(BASELINE_THEME_ID);
      plan.theme_id = BASELINE_THEME_ID;
      const { calls, generator } = makeCountingGenerator();
      setThemeImageGenerator(generator);
      try {
        await generateTheme(FakeUri.file(root) as unknown as import('vscode').Uri, plan, () => {});
      } finally {
        setThemeImageGenerator(undefined);
      }
      return { root, calls: [...calls] };
    })();
  }
  return baselinePromise;
}
async function copyOfBaseline(): Promise<{ globalStorageUri: FakeUri; calls: FakeGenerateCall[] }> {
  const base = await sharedBaseline();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-theme-svc-copy-'));
  await fsp.cp(base.root, root, { recursive: true });
  copiedRoots.push(root);
  return { globalStorageUri: FakeUri.file(root), calls: [...base.calls] };
}
after(async () => {
  const roots = [...copiedRoots];
  if (baselinePromise) roots.push((await baselinePromise.catch(() => undefined))?.root ?? '');
  for (const r of roots) if (r) await fsp.rm(r, { recursive: true, force: true });
});

test('a full plan run debits the Theme Service exactly once per board, each with a distinct idempotency key', async () => {
  const { root, calls } = await sharedBaseline();
  const globalStorageUri = FakeUri.file(root);
  const review = await getThemeImageReview(globalStorageUri as unknown as import('vscode').Uri, BASELINE_THEME_ID);
  // One attempt per generated board item (an empty roster still pads to
  // the fixed 21-object/16-character contract — see themePlan.ts — so
  // the exact count is read from the review rather than hardcoded).
  assert.equal(calls.length, review.entries.length, `expected one attempt per board, got calls: ${JSON.stringify(calls.map((c) => c.boardType))}`);
  const keys = new Set(calls.map((c) => c.idempotencyKey));
  assert.equal(keys.size, calls.length, 'every attempt must carry a distinct idempotency key');
  // Sanitized-and-hyphenated format (p85-t5) — must also match the backend's IDEMPOTENCY_KEY_RE.
  for (const key of keys) {
    assert.match(key, /^shared_baseline_theme-[^-]+-\d+-.+$/);
    assert.match(key, /^[A-Za-z0-9_-]{8,128}$/);
  }

  assert.equal(review.creditsSpent, calls.length, 'creditsSpent must sum every successful attemptCost');
  for (const entry of review.entries) {
    assert.equal(entry.item.attemptCost, 1, `${entry.item.id} must record its attemptCost`);
    assert.equal(entry.item.lastAttemptRefunded, false);
  }
});

test('retrying a board debits the Theme Service again with a new idempotency key and bumped revision', async () => {
  const { globalStorageUri, calls: baselineCalls } = await copyOfBaseline();
  const themeId = BASELINE_THEME_ID;
  const { calls, generator } = makeCountingGenerator();
  setThemeImageGenerator(generator);
  try {
    const review = await getThemeImageReview(globalStorageUri as unknown as import('vscode').Uri, themeId);
    assert.equal(baselineCalls.length, review.entries.length);

    const environmentEntry = review.entries.find((entry) => entry.item.id === 'environment')!;
    assert.ok(environmentEntry, 'environment board must exist');
    const revisionBefore = environmentEntry.item.revision;
    const originalEnvironmentKey = baselineCalls.find((c) => c.boardType === 'environment')!.idempotencyKey;

    await retryThemeImage(globalStorageUri as unknown as import('vscode').Uri, themeId, 'environment', '', 'retry', {});
    assert.equal(calls.length, 1, 'retry must place exactly one more attempt');
    assert.notEqual(calls[0].idempotencyKey, originalEnvironmentKey, 'a new user-initiated retry must use a fresh idempotency key');

    const reviewAfter = await getThemeImageReview(globalStorageUri as unknown as import('vscode').Uri, themeId);
    const environmentAfter = reviewAfter.entries.find((entry) => entry.item.id === 'environment')!;
    assert.equal(environmentAfter.item.revision, revisionBefore + 1);
    assert.equal(environmentAfter.item.attemptCost, 1);
  } finally {
    setThemeImageGenerator(undefined);
  }
});

test('resliceThemeImageFromRaw makes no Theme Service generator call', async () => {
  const { globalStorageUri, calls: baselineCalls } = await copyOfBaseline();
  const { calls, generator } = makeCountingGenerator();
  setThemeImageGenerator(generator);
  try {
    assert.ok(baselineCalls.length > 0);
    const result = await resliceThemeImageFromRaw(globalStorageUri as unknown as import('vscode').Uri, BASELINE_THEME_ID, 'expressions');
    assert.equal(calls.length, 0, 'resliceThemeImageFromRaw must never call the generator');
    // 'expressions' has no raw atlas persisted by this fixture path unless
    // generation itself saved one — either a successful re-slice or an
    // explicit "no saved original" failure is acceptable; a generator call
    // is not.
    void result;
  } finally {
    setThemeImageGenerator(undefined);
  }
});

test('an ok:true attempt with refunded:true is excluded from creditsSpent and recorded with attemptCost 0', async () => {
  await withTempStore(async (globalStorageUri) => {
    const themeId = 'refunded_ok_theme';
    const plan = buildPlan(themeId);
    plan.theme_id = themeId;
    const calls: FakeGenerateCall[] = [];
    setThemeImageGenerator({
      async generate(req: FakeGenerateCall) {
        calls.push(req);
        const image = await magentaAtlas();
        const refunded = req.boardType === 'environment';
        return { ok: true as const, value: { image, attemptCost: 1, credits: 99, refunded } };
      },
    });
    try {
      await generateTheme(globalStorageUri as unknown as import('vscode').Uri, plan, () => {});
      const review = await getThemeImageReview(globalStorageUri as unknown as import('vscode').Uri, themeId);
      const environmentEntry = review.entries.find((entry) => entry.item.id === 'environment')!;
      assert.equal(environmentEntry.item.lastAttemptRefunded, true);
      assert.equal(environmentEntry.item.attemptCost, 0, 'a refunded successful attempt must record attemptCost 0');

      const nonRefundedTotal = review.entries
        .filter((entry) => entry.item.id !== 'environment')
        .reduce((sum, entry) => sum + (entry.item.attemptCost ?? 0), 0);
      assert.equal(review.creditsSpent, nonRefundedTotal, 'creditsSpent must exclude the refunded attempt entirely');
      assert.ok(review.creditsSpent < calls.length, 'creditsSpent must be strictly less than the raw attempt count once one attempt is refunded');
    } finally {
      setThemeImageGenerator(undefined);
    }
  });
});

// Note: generateTheme runs every board through runNonFatalBoardStep
// (themeService.ts), which swallows a non-cancellation board failure (logs
// "<label> failed and was skipped" via onProgress and continues to the next
// board) rather than rejecting the whole run — so these failure-path tests
// assert on the review item's persisted error_kind/lastAttemptRefunded, not
// on generateTheme throwing.
test('a provider_failed attempt surfaces error_kind:"provider_failed" and the refunded flag on the review item', async () => {
  await withTempStore(async (globalStorageUri) => {
    const themeId = 'provider_failed_theme';
    const plan = buildPlan(themeId);
    plan.theme_id = themeId;
    const { generator } = makeCountingGenerator({
      fail: (call) => (call.boardType === 'environment'
        ? { kind: 'provider_failed', message: 'upstream image model failed', refunded: true, credits: 99 }
        : undefined),
    });
    setThemeImageGenerator(generator);
    const progress: string[] = [];
    try {
      await generateTheme(globalStorageUri as unknown as import('vscode').Uri, plan, (m) => progress.push(m));
      assert.ok(progress.some((m) => m.includes('failed and was skipped')), 'a non-cancellation board failure must be logged and skipped, not crash the run');

      const review = await getThemeImageReview(globalStorageUri as unknown as import('vscode').Uri, themeId);
      const environmentEntry = review.entries.find((entry) => entry.item.id === 'environment')!;
      assert.equal(environmentEntry.item.error_kind, 'provider_failed');
      assert.equal(environmentEntry.item.lastAttemptRefunded, true);
    } finally {
      setThemeImageGenerator(undefined);
    }
  });
});

test('each Theme Service error kind surfaces as its own distinct error_kind, never a generic message', async () => {
  const kinds: Array<{ kind: FakeErrorKind; expected: string }> = [
    { kind: 'not_signed_in', expected: 'not_signed_in' },
    { kind: 'insufficient_credits', expected: 'insufficient_credits' },
    { kind: 'unavailable', expected: 'unavailable' },
    { kind: 'unreachable', expected: 'unreachable' },
    { kind: 'provider_failed', expected: 'provider_failed' },
    { kind: 'rate_limited', expected: 'rate_limited' }, // its own distinct review state — see mapToReviewErrorKind
    { kind: 'server_error', expected: 'unavailable' }, // folded — no table entry of its own
    { kind: 'invalid_response', expected: 'unavailable' }, // folded — no table entry of its own
  ];

  // p87: each iteration used to mkdtemp a brand-new tempdir and recursively
  // `rm` it in withTempStore's finally, 8 times in a tight loop. On Windows
  // that create/write/recursive-delete churn (compounded by AV real-time
  // scanning of the freshly written review/manifest files) reliably wedged
  // the process after ~6-7 iterations — the delete of one iteration's dir
  // races the next iteration's writes to a same-named theme, and the run
  // never returns. One shared tempdir + a distinct themeId per kind gives
  // every iteration the same isolation (no on-disk state carries over
  // between kinds) without the repeated mkdtemp/rm-recursive cycle.
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-theme-svc-'));
  try {
    const globalStorageUri = FakeUri.file(root);
    for (const { kind, expected } of kinds) {
      const themeId = `error_kind_theme_${kind}`;
      const plan = buildPlan(themeId);
      plan.theme_id = themeId;
      const { generator } = makeCountingGenerator({
        fail: () => ({ kind, message: `${kind} failure` }),
      });
      setThemeImageGenerator(generator);
      try {
        await generateTheme(globalStorageUri as unknown as import('vscode').Uri, plan, () => {});
        const review = await getThemeImageReview(globalStorageUri as unknown as import('vscode').Uri, themeId);
        const environmentEntry = review.entries.find((entry) => entry.item.id === 'environment')!;
        assert.equal(environmentEntry.item.error_kind, expected, `kind ${kind} must map to error_kind ${expected}`);
      } finally {
        setThemeImageGenerator(undefined);
      }
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('generation fails explicitly when no generator has been configured, never silently', async () => {
  await withTempStore(async (globalStorageUri) => {
    const themeId = 'unconfigured_generator_theme';
    const plan = buildPlan(themeId);
    plan.theme_id = themeId;
    setThemeImageGenerator(undefined);
    const progress: string[] = [];
    await generateTheme(globalStorageUri as unknown as import('vscode').Uri, plan, (m) => progress.push(m));
    const review = await getThemeImageReview(globalStorageUri as unknown as import('vscode').Uri, themeId);
    const environmentEntry = review.entries.find((entry) => entry.item.id === 'environment')!;
    assert.equal(environmentEntry.item.error_kind, 'unavailable', 'an unconfigured generator must surface an explicit "unavailable" error_kind, never fail silently or produce a placeholder image');
  });
});

test('themeService.ts and panel.ts host wiring never reference a direct image-provider endpoint or SDK (p43-t1)', async () => {
  const forbidden = [/api\.openai\.com/i, /generativelanguage\.googleapis\.com/i, /from ['"]openai['"]/, /@google\/generative-ai/i];
  const files = [
    path.join(process.cwd(), 'src', 'extension', 'themeService.ts'),
    path.join(process.cwd(), 'src', 'host', 'vscode', 'panel.ts'),
    path.join(process.cwd(), 'src', 'host', 'vscode', 'themeServiceHost.ts'),
  ];
  for (const file of files) {
    const contents = await fsp.readFile(file, 'utf8');
    for (const pattern of forbidden) {
      assert.equal(pattern.test(contents), false, `${path.basename(file)} must not reference ${pattern} — image generation routes through the Theme Service only`);
    }
  }
  await assert.rejects(fsp.stat(path.join(process.cwd(), 'src', 'extension', 'imageClient.ts')), 'imageClient.ts must be deleted (p43-t1: direct-provider generation removed)');
});

test('every review payload item carries its Theme Service boardType, matching boardTypeForItem, for pricing lookups (review fix)', async () => {
  const { root } = await sharedBaseline();
  const globalStorageUri = FakeUri.file(root);
  const review = await getThemeImageReview(globalStorageUri as unknown as import('vscode').Uri, BASELINE_THEME_ID);
  assert.ok(review.entries.length > 0, 'fixture sanity: the theme must have review items');

  const expectedBoardTypesByKind: Record<string, string> = {
    character_atlas: 'roster_agent',
    rival_atlas: 'rival_group',
    environment: 'environment',
    background_decor_atlas: 'objects_01',
    expression_atlas: 'expressions',
    achievement_atlas: 'achievements',
    emote_atlas: 'expressions',
  };

  for (const { item } of review.entries) {
    assert.equal(item.boardType, boardTypeForItem(item), `${item.id} (${item.kind}) payload boardType must equal boardTypeForItem(item)`);
    if (item.kind === 'object_atlas') {
      assert.equal(item.boardType, item.id === 'objects_02' ? 'objects_02' : 'objects_01');
    } else if (item.kind in expectedBoardTypesByKind) {
      assert.equal(item.boardType, expectedBoardTypesByKind[item.kind], `${item.kind} must map to its documented pricing key`);
    }
  }
});

test('createServiceImageGenerator reports the response balance (success and balance-carrying errors) with the attempt token', async () => {
  const seen: Array<[number, unknown]> = [];
  const hooks = { begin: () => 'tok', credits: (c: number, t: unknown) => { seen.push([c, t]); } };
  const okClient = {
    async generateAttempt() {
      return { ok: true as const, value: { image: 'data:image/png;base64,AAAA', attemptCost: 3, credits: 199, refunded: false } };
    },
  };
  const failClient = {
    async generateAttempt() {
      return { ok: false as const, error: { kind: 'provider_failed' as const, message: 'x', refunded: true, credits: 5 } };
    },
  };
  const noBalanceClient = {
    async generateAttempt() {
      return { ok: false as const, error: { kind: 'content_blocked' as const, message: 'x' } };
    },
  };
  const req = {} as never;
  assert.equal((await createServiceImageGenerator(okClient as never, hooks).generate(req)).ok, true);
  assert.equal((await createServiceImageGenerator(failClient as never, hooks).generate(req)).ok, false);
  await createServiceImageGenerator(noBalanceClient as never, hooks).generate(req);
  assert.deepEqual(seen, [[199, 'tok'], [5, 'tok']]);
  const throwing = await createServiceImageGenerator(okClient as never, { credits: () => { throw new Error('boom'); } }).generate(req);
  assert.equal(throwing.ok, true, 'a balance-refresh failure must not fail a successful attempt');
});

test('recordAttemptCharge accumulates across retries; refunded attempts add 0; themeCreditsSpent sums the running totals', () => {
  const first = recordAttemptCharge({}, { attemptCost: 3, refunded: false });
  assert.deepEqual(first, { attemptCost: 3, lastAttemptRefunded: false, creditsCharged: 3 });
  const second = recordAttemptCharge(first, { attemptCost: 3, refunded: false });
  assert.equal(second.creditsCharged, 6);
  const refunded = recordAttemptCharge(second, { attemptCost: 3, refunded: true });
  assert.deepEqual(refunded, { attemptCost: 0, lastAttemptRefunded: true, creditsCharged: 6 });
  // legacy item (no creditsCharged) seeds from its recorded attemptCost
  assert.equal(recordAttemptCharge({ attemptCost: 2 }, { attemptCost: 3, refunded: false }).creditsCharged, 5);
  assert.equal(themeCreditsSpent([{ creditsCharged: 6, attemptCost: 0 }, { attemptCost: 2 }, {}]), 8);
});

test('a charged failure (refunded:false) adds the quoted cost to creditsCharged; refunded:true and pre-screen (no flag) add 0; the legacy seed survives', async () => {
  {
    const copy = await copyOfBaseline();
    const root = copy.globalStorageUri as unknown as import('vscode').Uri;
    const themeId = BASELINE_THEME_ID;
    themeService.setThemeAttemptCostResolver((boardType) => (boardType === 'environment' ? 4 : undefined));
    try {
      const before = await getThemeImageReview(root, themeId);
      const envBefore = before.entries.find((e) => e.item.id === 'environment')!.item;
      assert.equal(envBefore.creditsCharged, 1);
      const fail = (refunded: boolean | undefined) => themeService.recordUserCorrectableGenerationError(
        root, themeId, 'environment',
        new themeService.ThemeGenerationServiceError({ kind: 'provider_failed', message: 'x', refunded }),
      );
      const total = async () => (await getThemeImageReview(root, themeId)).entries.find((e) => e.item.id === 'environment')!.item.creditsCharged;
      await fail(true);
      assert.equal(await total(), 1, 'refunded:true counts 0 and the seed survives');
      await fail(undefined);
      assert.equal(await total(), 1, 'no refunded flag counts 0');
      await themeService.recordUserCorrectableGenerationError(
        root, themeId, 'environment',
        new themeService.ThemeGenerationServiceError({ kind: 'content_blocked', message: 'x' }),
      );
      assert.equal(await total(), 1, 'pre-screen content_blocked counts 0');
      await fail(false);
      assert.equal(await total(), 5, 'refunded:false adds the quoted cost (4)');
    } finally {
      themeService.setThemeAttemptCostResolver(undefined);
    }
  }
});

test('setThemeImageReviewErrorKind seeds creditsCharged from a legacy attemptCost before overwriting it', async () => {
  await withTempStore(async (globalStorageUri) => {
    const state = require('../src/extension/themeImageReviewState') as typeof import('../src/extension/themeImageReviewState');
    const root = globalStorageUri as unknown as import('vscode').Uri;
    await state.upsertThemeImageReviewItem(root, 'legacy_seed', 'Legacy', {
      id: 'environment', filename: 'environment.png', label: 'Env', kind: 'environment', status: 'pending', prompt: '', revision: 1, frame_keys: [], attemptCost: 3,
    });
    const doc = await state.setThemeImageReviewErrorKind(root, 'legacy_seed', 'environment', 'content_blocked', false, 0);
    const item = doc!.items[0];
    assert.equal(item.attemptCost, 0);
    assert.equal(item.creditsCharged, 3, 'the legacy seed must survive the attemptCost overwrite');
  });
});
