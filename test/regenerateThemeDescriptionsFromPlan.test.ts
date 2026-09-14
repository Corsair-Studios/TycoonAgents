/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Same vscode-module stub as test/themePlannerPrompt.test.ts — translator.ts
// imports 'vscode' at module scope but this file never touches that path.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require('module');
const originalLoad = NodeModule._load;
function makeVscodeStub(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === '__esModule') return true;
      if (!(prop in target)) {
        target[prop] = new Proxy(function stub() {}, handler);
      }
      return target[prop];
    },
    apply() {
      return new Proxy({}, handler);
    },
    construct() {
      return new Proxy({}, handler);
    },
  };
  return new Proxy({}, handler);
}
const vscodeStub = makeVscodeStub();
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { regenerateThemeDescriptionsFromPlan } = require('../src/extension/translator') as typeof import('../src/extension/translator');
import { normalizeThemePlan } from '../src/extension/themePlan';
import type { ThemePlan } from '../src/extension/themePlan';

function basePlan(): ThemePlan {
  return normalizeThemePlan({
    display_name: 'Neon Noodles',
    creative_direction: 'a moody neon skyline',
    characters: ['Chef Nova', 'Waiter Bolt'],
    objects: ['Rack', 'Fryer'],
    decor: ['Stool'],
    enemies: ['Health Inspector'],
    achievements: ['First Sale'],
  });
}

function mockFetchOnce(responseObject: unknown) {
  const original = (global as unknown as { fetch: typeof fetch }).fetch;
  (global as unknown as { fetch: typeof fetch }).fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content: JSON.stringify(responseObject) } }],
    }),
  })) as unknown as typeof fetch;
  return () => {
    (global as unknown as { fetch: typeof fetch }).fetch = original;
  };
}

function fullValidResponse(plan: ThemePlan) {
  return {
    character_descriptions: plan.characters.map((name) => `${name} description`),
    object_descriptions: plan.objects.map((name) => `${name} description`),
    crate_description: 'a crate',
    poof_description: 'a poof',
    projectile_description: 'a bolt',
    decor_descriptions: plan.decor.map((name) => `${name} description`),
    enemy_descriptions: plan.enemies.map((name) => `${name} description`),
    expression_descriptions: plan.expressions.map(() => 'an icon'),
    achievement_descriptions: plan.achievements.map((name) => `${name} description`),
  };
}

test('regenerateThemeDescriptionsFromPlan: fewer entries than the plan\'s name array rejects', async () => {
  const plan = basePlan();
  const response = fullValidResponse(plan);
  response.character_descriptions = response.character_descriptions.slice(0, plan.characters.length - 1);
  const restore = mockFetchOnce(response);
  try {
    await assert.rejects(
      () => regenerateThemeDescriptionsFromPlan(plan, { provider: 'openai', apiKey: 'test-key' }),
      /character_descriptions.*returned \d+ entries.*plan has \d+/s,
    );
  } finally {
    restore();
  }
});

test('regenerateThemeDescriptionsFromPlan: extra entries beyond the plan\'s name array rejects', async () => {
  const plan = basePlan();
  const response = fullValidResponse(plan);
  response.object_descriptions = [...response.object_descriptions, 'one too many'];
  const restore = mockFetchOnce(response);
  try {
    await assert.rejects(
      () => regenerateThemeDescriptionsFromPlan(plan, { provider: 'openai', apiKey: 'test-key' }),
      /object_descriptions.*returned \d+ entries.*plan has \d+/s,
    );
  } finally {
    restore();
  }
});

test('regenerateThemeDescriptionsFromPlan: exact-count entries are accepted', async () => {
  const plan = basePlan();
  const response = fullValidResponse(plan);
  const restore = mockFetchOnce(response);
  try {
    const result = await regenerateThemeDescriptionsFromPlan(plan, { provider: 'openai', apiKey: 'test-key' });
    assert.deepEqual(result.character_descriptions, response.character_descriptions);
    assert.deepEqual(result.object_descriptions, response.object_descriptions);
    assert.deepEqual(result.decor_descriptions, response.decor_descriptions);
    assert.deepEqual(result.enemy_descriptions, response.enemy_descriptions);
    assert.deepEqual(result.expression_descriptions, response.expression_descriptions);
    assert.deepEqual(result.achievement_descriptions, response.achievement_descriptions);
    assert.equal(result.crate_description, 'a crate');
    assert.equal(result.poof_description, 'a poof');
    assert.equal(result.projectile_description, 'a bolt');
    assert.equal(result.descriptions_direction, plan.creative_direction);
  } finally {
    restore();
  }
});

test('regenerateThemeDescriptionsFromPlan: a blank entry in an otherwise correct-count array rejects', async () => {
  const plan = basePlan();
  const response = fullValidResponse(plan);
  response.enemy_descriptions = plan.enemies.map(() => '   ');
  const restore = mockFetchOnce(response);
  try {
    await assert.rejects(
      () => regenerateThemeDescriptionsFromPlan(plan, { provider: 'openai', apiKey: 'test-key' }),
      /enemy_descriptions.*blank or non-string entry/s,
    );
  } finally {
    restore();
  }
});
