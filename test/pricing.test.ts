/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Direct coverage of media/main.js's pricing helpers (PRICE_TABLE,
// resolvePriceKey, modelPricePerMtok, DEFAULT_PRICE_KEY, costModelClass).
// media/main.js is a hand-authored browser IIFE with no exports and no
// window.* test hooks, so — same technique as test/mainPanelClips.test.ts's
// extractMainJsClips() — this slices out the contiguous source block that
// declares these functions (they're mutually referencing top-level
// `function`/`const` declarations in the same closure, so function-hoisting
// makes evaluating the whole slice as one function body safe) and evaluates
// it with `new Function` to get real references to the actual
// implementations, not reimplementations of them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface PricingModule {
  PRICE_TABLE: Record<string, { perMtok: number; weight: number }>;
  DEFAULT_PRICE_KEY: string;
  SUBSCRIPTION_WEIGHT: number;
  resolvePriceKey: (modelId: string | null | undefined, hint?: string) => string;
  modelPricePerMtok: (model: string | null | undefined) => number | null;
  costModelClass: (model: string | null | undefined, explicit?: string) => string;
}

function loadPricingModule(): PricingModule {
  const mainPath = join(process.cwd(), "media", "main.js");
  const src = readFileSync(mainPath, "utf8");

  const startMarker = "const PRICE_TABLE = {";
  const startIdx = src.indexOf(startMarker);
  assert.ok(startIdx !== -1, 'Could not find "const PRICE_TABLE = {" in media/main.js');

  const endMarker = "function costModelClass(model, explicit) {";
  const fnStart = src.indexOf(endMarker);
  assert.ok(fnStart !== -1, "Could not find costModelClass function in media/main.js");

  // Balanced-brace scan from costModelClass's opening brace to its close.
  const braceStart = src.indexOf("{", fnStart + endMarker.length - 1);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end !== -1, "Could not find closing brace for costModelClass in media/main.js");

  const slice = src.slice(startIdx, end + 1);
  const body = `${slice}\nreturn { PRICE_TABLE, DEFAULT_PRICE_KEY, SUBSCRIPTION_WEIGHT, resolvePriceKey, modelPricePerMtok, costModelClass };`;
  // eslint-disable-next-line no-new-func
  return new Function(body)() as PricingModule;
}

const mod = loadPricingModule();

// ---------------------------------------------------------------------------
// Baseline numbers (must survive the pricing refactor unchanged).
// ---------------------------------------------------------------------------

test("baseline: claude-opus-4-6, 1,000,000 tokens -> $10", () => {
  const price = mod.modelPricePerMtok("claude-opus-4-6");
  assert.equal(price, 10);
  assert.equal((1_000_000 / 1e6) * price!, 10);
});

test("baseline: claude-sonnet-4-6, 2,500,000 tokens -> $10", () => {
  const price = mod.modelPricePerMtok("claude-sonnet-4-6");
  assert.equal(price, 4);
  assert.equal((2_500_000 / 1e6) * price!, 10);
});

test("baseline: claude-haiku-4-5-20251001, 10,000,000 tokens -> $20", () => {
  const price = mod.modelPricePerMtok("claude-haiku-4-5-20251001");
  assert.equal(price, 2);
  assert.equal((10_000_000 / 1e6) * price!, 20);
});

test("baseline: claude-fable-5, 500,000 tokens -> $10", () => {
  const price = mod.modelPricePerMtok("claude-fable-5");
  assert.equal(price, 20);
  assert.equal((500_000 / 1e6) * price!, 10);
});

test("baseline: bare 'sonnet' alias, 100,000 tokens -> $0.4", () => {
  const price = mod.modelPricePerMtok("sonnet");
  assert.equal(price, 4);
  assert.equal((100_000 / 1e6) * price!, 0.4);
});

// ---------------------------------------------------------------------------
// resolvePriceKey / PRICE_TABLE coverage for non-Anthropic providers.
// ---------------------------------------------------------------------------

test("'openai/gpt-5.4-mini' resolves to a non-zero PRICE_TABLE row", () => {
  const key = mod.resolvePriceKey("openai/gpt-5.4-mini");
  assert.equal(key, "openai/gpt-5.4-mini");
  const row = mod.PRICE_TABLE[key];
  assert.ok(row);
  assert.ok(row.perMtok > 0);
  // NOTE: modelPricePerMtok("openai/gpt-5.4-mini") is null, not row.perMtok —
  // costModelClass() classifies any "gpt"-substring model as "subscription"
  // (media/main.js ~13950), so this model's PRICE_TABLE row still exists
  // (used for a different subscription-relative lens elsewhere) but
  // modelPricePerMtok short-circuits to null before ever consulting it. See
  // the subscription-class test below for that path.
});

test("'openai/gpt-5.4-mini-2026' resolves via longest-prefix match to 'openai/gpt-5.4-mini', not the shorter 'openai/gpt-5' key", () => {
  const key = mod.resolvePriceKey("openai/gpt-5.4-mini-2026");
  assert.equal(key, "openai/gpt-5.4-mini");
});

test("'nobody/unknown' resolves to DEFAULT_PRICE_KEY, a non-zero price, never NaN", () => {
  const key = mod.resolvePriceKey("nobody/unknown");
  assert.equal(key, mod.DEFAULT_PRICE_KEY);
  const price = mod.modelPricePerMtok("nobody/unknown");
  assert.ok(typeof price === "number" && Number.isFinite(price) && price > 0, `expected a finite non-zero price, got ${price}`);
});

test("a genuinely unrecognized bare model id also falls back to DEFAULT_PRICE_KEY, never NaN/null for a metered class", () => {
  const price = mod.modelPricePerMtok("some-unknown-model-xyz");
  assert.ok(typeof price === "number" && Number.isFinite(price) && price > 0);
});

test("'xai/grok-4.7' (flagship reasoning Grok, OpenCode-only) resolves to a non-zero, metered price", () => {
  const key = mod.resolvePriceKey("xai/grok-4.7");
  assert.equal(key, "xai/grok-4.7");
  assert.equal(mod.costModelClass("xai/grok-4.7"), "metered");
  assert.equal(mod.modelPricePerMtok("xai/grok-4.7"), 3);
});

test("'xai/grok-build-0.1' (fast/cheap Grok) resolves to a non-zero, metered price", () => {
  const key = mod.resolvePriceKey("xai/grok-build-0.1");
  assert.equal(key, "xai/grok-build-0.1");
  assert.equal(mod.modelPricePerMtok("xai/grok-build-0.1"), 1.25);
});

// ---------------------------------------------------------------------------
// subscription / local cost classes: null price, distinct label.
// ---------------------------------------------------------------------------

test("subscription-class model (gpt-5.4-mini) -> null price (never a fabricated $/Mtok figure)", () => {
  assert.equal(mod.costModelClass("gpt-5.4-mini"), "subscription");
  assert.equal(mod.modelPricePerMtok("gpt-5.4-mini"), null);
});

test("subscription-class model (codex-auto-review) -> null price", () => {
  assert.equal(mod.costModelClass("codex-auto-review"), "subscription");
  assert.equal(mod.modelPricePerMtok("codex-auto-review"), null);
});

test("local-class model (ollama:llama3) -> price 0 semantics: modelPricePerMtok returns null, caller renders 'local' not a fabricated $ figure", () => {
  assert.equal(mod.costModelClass("ollama:llama3"), "local");
  assert.equal(mod.modelPricePerMtok("ollama:llama3"), null);
});

test("local-class model (lmstudio-qwen2.5) -> null price, class 'local'", () => {
  assert.equal(mod.costModelClass("lmstudio-qwen2.5"), "local");
  assert.equal(mod.modelPricePerMtok("lmstudio-qwen2.5"), null);
});

// ---------------------------------------------------------------------------
// Current exact model ids and alias rows (2026-09): aliases price the newest
// model per family; exact ids win over the alias row.
// ---------------------------------------------------------------------------

test("claude-sonnet-5-5 has an explicit row priced $2/$10 -> blended 4, and the 'anthropic/sonnet' alias row matches it", () => {
  assert.equal(mod.resolvePriceKey("claude-sonnet-5-5"), "anthropic/claude-sonnet-5-5");
  assert.equal(mod.resolvePriceKey("anthropic/claude-sonnet-5-5"), "anthropic/claude-sonnet-5-5");
  assert.equal(mod.modelPricePerMtok("claude-sonnet-5-5"), 4);
  assert.equal(mod.PRICE_TABLE["anthropic/sonnet"].perMtok, mod.PRICE_TABLE["anthropic/claude-sonnet-5-5"].perMtok);
  assert.equal(mod.modelPricePerMtok("sonnet"), mod.modelPricePerMtok("claude-sonnet-5-5"));
});

test("claude-opus-5-5 ($4/$20) resolves to its own row, blended 8", () => {
  assert.equal(mod.resolvePriceKey("claude-opus-5-5"), "anthropic/claude-opus-5-5");
  assert.equal(mod.modelPricePerMtok("claude-opus-5-5"), 8);
});

test("claude-fable-5-1 ($10/$50) resolves to its own row, blended 20", () => {
  assert.equal(mod.resolvePriceKey("claude-fable-5-1"), "anthropic/claude-fable-5-1");
  assert.equal(mod.modelPricePerMtok("anthropic/claude-fable-5-1"), 20);
});

test("dated haiku id resolves via the claude-haiku-4-5 exact row; an older ids keep their real rate; an id without a row uses its family row", () => {
  assert.equal(mod.resolvePriceKey("claude-haiku-4-5-20251001"), "anthropic/claude-haiku-4-5");
  assert.equal(mod.resolvePriceKey("claude-opus-4-6"), "anthropic/claude-opus-4-6");
  assert.equal(mod.modelPricePerMtok("claude-opus-4-6"), 10);
  assert.equal(mod.modelPricePerMtok("opus"), mod.modelPricePerMtok("claude-opus-5-5"));
  assert.equal(mod.resolvePriceKey("claude-fable-5"), "anthropic/fable");
});

test("claude-opus-4-7 / 4-8 / 5 keep the $5/$25 rate (10) via explicit rows; claude-sonnet-5 is $2/$10 (4)", () => {
  for (const id of ["claude-opus-4-7", "claude-opus-4-8", "claude-opus-5"]) {
    assert.equal(mod.resolvePriceKey(id), `anthropic/${id}`);
    assert.equal(mod.modelPricePerMtok(id), 10);
  }
  assert.equal(mod.resolvePriceKey("claude-sonnet-5"), "anthropic/claude-sonnet-5");
  assert.equal(mod.modelPricePerMtok("claude-sonnet-5"), 4);
  assert.equal(mod.resolvePriceKey("claude-opus-5-5"), "anthropic/claude-opus-5-5");
});

test("claude-opus-4 and claude-opus-4-1 keep their real $15/$75 rate (30), not the opus alias row", () => {
  for (const id of ["claude-opus-4", "claude-opus-4-1", "claude-opus-4-20250514"]) {
    assert.equal(mod.modelPricePerMtok(id), 30, id);
  }
  assert.equal(mod.resolvePriceKey("claude-opus-4-1"), "anthropic/claude-opus-4-1");
  assert.equal(mod.modelPricePerMtok("claude-opus-4-6"), 10);
});
