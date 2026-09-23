import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvironmentRequest, buildEmoteAtlasRequest } from '../src/extension/themeAssetPrompts';
import { themePlanCreativeDirection, normalizeThemePlan } from '../src/extension/themePlan';

/** No lone (unpaired) UTF-16 surrogate anywhere in `text`. */
function assertNoLoneSurrogate(text: string): void {
  // A high surrogate not immediately followed by a low surrogate, or a low
  // surrogate not immediately preceded by a high surrogate.
  assert.doesNotMatch(
    text,
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    'result contains a lone/broken surrogate half',
  );
}

// Backend contract cap: contract/theme-service-api.md v3.5, "POST /api/generate"
// and "Backend input handling" — theme.creativeDirection max 1000 chars.
// corsair-theme-service/src/validate.mjs enforces this and rejects the whole
// request with a bare 400 bad_request (no code, nothing logged) when it's
// exceeded — surfaced to the user as "The Theme Service rejected this
// request." with no further detail.
const BACKEND_CREATIVE_DIRECTION_MAX_CHARS = 1000;

test('buildEnvironmentRequest caps theme.creativeDirection at the backend max, even for a long creative direction + environment description', () => {
  const longCreativeDirection = 'A '.repeat(600) + 'moody neon skyline.'; // well over 1000 chars
  const req = buildEnvironmentRequest(longCreativeDirection, 'Test Theme');
  assert.ok(
    req.theme.creativeDirection!.length <= BACKEND_CREATIVE_DIRECTION_MAX_CHARS,
    `expected theme.creativeDirection <= ${BACKEND_CREATIVE_DIRECTION_MAX_CHARS} chars, got ${req.theme.creativeDirection!.length}`,
  );
});

test('buildEnvironmentRequest leaves a short creative direction untouched', () => {
  const req = buildEnvironmentRequest('A moody neon skyline.', 'Test Theme');
  assert.equal(req.theme.creativeDirection!, 'A moody neon skyline.');
});

test('the real environment-board creativeDirection string (plan-derived, three-line join) can exceed the backend cap before capping', () => {
  // Reproduces the actual environment-board request path: themePlanCreativeDirection()
  // joins "Theme: <name>", "Creative direction: <creative_direction>" and
  // "Environment direction: <environment>" — the string every non-character
  // board (environment included) sends as-is. A detailed plan easily exceeds
  // 1000 chars once joined, which is exactly what reached production and was
  // rejected pre-fix (only character_atlas overrides with a shorter string).
  const plan = normalizeThemePlan(
    {
      display_name: 'Neon Foundry',
      creative_direction: 'A '.repeat(300) + 'gritty cyberpunk industrial aesthetic with volumetric fog.',
      environment: 'B '.repeat(300) + 'a sprawling isometric factory floor with catwalks and neon signage.',
    },
    'Neon Foundry',
  );
  const combined = themePlanCreativeDirection(plan);
  assert.ok(combined.length > BACKEND_CREATIVE_DIRECTION_MAX_CHARS, 'test setup: combined direction should exceed the cap pre-fix');

  const req = buildEnvironmentRequest(combined, plan.display_name);
  assert.ok(
    req.theme.creativeDirection!.length <= BACKEND_CREATIVE_DIRECTION_MAX_CHARS,
    `expected the built request to cap creativeDirection, got ${req.theme.creativeDirection!.length}`,
  );
});

/** Same 1379-ish-char production-like plan text used in themeServiceEndToEnd.test.ts's environment body-contract test. */
function productionLikePlan() {
  return normalizeThemePlan(
    {
      display_name: 'Neon Foundry',
      creative_direction: 'A gritty cyberpunk industrial aesthetic, volumetric fog, neon signage. '.repeat(8),
      environment: 'A sprawling isometric factory floor with catwalks, conveyor belts, and glowing reactor cores. '.repeat(8),
    },
    'Neon Foundry',
  );
}

test('(a) environment board: creativeDirection stays <= 1000 chars and keeps the full Environment direction line intact', () => {
  const plan = productionLikePlan();
  const combined = themePlanCreativeDirection(plan);
  assert.ok(combined.length > BACKEND_CREATIVE_DIRECTION_MAX_CHARS, 'test setup: input should exceed the cap pre-fix');

  const req = buildEnvironmentRequest(combined, plan.display_name);
  const result = req.theme.creativeDirection!;
  assert.ok(result.length <= BACKEND_CREATIVE_DIRECTION_MAX_CHARS, `expected <= 1000 chars, got ${result.length}`);
  assert.ok(
    result.includes(`Environment direction: ${plan.environment}`),
    'expected the full, untrimmed Environment direction line to survive capping for the environment board',
  );
});

test('(b) a non-environment board keeps Theme and Creative direction, trims Environment direction first', () => {
  const plan = productionLikePlan();
  const combined = themePlanCreativeDirection(plan);
  assert.ok(combined.length > BACKEND_CREATIVE_DIRECTION_MAX_CHARS, 'test setup: input should exceed the cap pre-fix');

  const req = buildEmoteAtlasRequest(combined, plan.display_name);
  const result = req.theme.creativeDirection!;
  assert.ok(result.length <= BACKEND_CREATIVE_DIRECTION_MAX_CHARS, `expected <= 1000 chars, got ${result.length}`);
  assert.ok(
    result.includes(`Theme: ${plan.display_name}`),
    'expected the full Theme line to survive capping for a non-environment board',
  );
  assert.ok(
    result.includes(`Creative direction: ${plan.creative_direction}`),
    'expected the full Creative direction line to survive capping for a non-environment board',
  );
  assert.ok(
    !result.includes(plan.environment.trim()),
    'expected the Environment direction line to be the one trimmed for a non-environment board',
  );
});

test('(d) an edited plan.environment text flows into buildEnvironmentRequest\'s creativeDirection via the "Environment direction" line, staying <= 1000 chars', () => {
  const plan = normalizeThemePlan(
    {
      display_name: 'Neon Foundry',
      creative_direction: 'A gritty cyberpunk industrial aesthetic, volumetric fog, neon signage. '.repeat(8),
      environment: 'original environment text',
    },
    'Neon Foundry',
  );
  // Simulate the applyThemeItemDescriptionChanges 'environment' branch edit.
  plan.environment = 'a moody neon skyline over a rain-slick industrial rooftop. '.repeat(6);

  const combined = themePlanCreativeDirection(plan);
  assert.ok(combined.includes(`Environment direction: ${plan.environment}`));

  const req = buildEnvironmentRequest(combined, plan.display_name);
  const result = req.theme.creativeDirection!;
  assert.ok(result.length <= BACKEND_CREATIVE_DIRECTION_MAX_CHARS, `expected <= 1000 chars, got ${result.length}`);
  assert.ok(
    result.includes(plan.environment),
    'expected the edited environment text to survive in the environment board\'s capped creativeDirection',
  );
});

test('(c) trimming never splits a surrogate pair, even when an emoji sits right at the cut boundary', () => {
  // Single-line input (no '\n'), so this exercises the flat trimToChars
  // fallback directly: 999 filler chars then a surrogate-pair emoji
  // straddling the 1000-char cut point.
  const longCreativeDirection = 'x'.repeat(999) + '\u{1F600}' + 'y'.repeat(50); // 😀
  assert.ok(longCreativeDirection.length > BACKEND_CREATIVE_DIRECTION_MAX_CHARS);

  const req = buildEnvironmentRequest(longCreativeDirection, 'Test Theme');
  const result = req.theme.creativeDirection!;
  assert.ok(result.length <= BACKEND_CREATIVE_DIRECTION_MAX_CHARS, `expected <= 1000 chars, got ${result.length}`);
  assertNoLoneSurrogate(result);
});
