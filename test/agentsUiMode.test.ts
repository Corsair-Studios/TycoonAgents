import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentsUiMode, singleProviderTiers, CODEX_ACCEPTED_MODELS } from '../src/core/agentsUiMode';
import { MODEL_ALIASES } from '../src/core/modelAliases';

// p74-t3: coverage for resolveAgentsUiMode's harness/flag matrix and
// singleProviderTiers' per-vendor shapes.

test('resolveAgentsUiMode: opencode is always multi regardless of the flag', () => {
  assert.equal(resolveAgentsUiMode({ harness: 'opencode', multiProvider: false }), 'multi');
  assert.equal(resolveAgentsUiMode({ harness: 'opencode', multiProvider: true }), 'multi');
});

test('resolveAgentsUiMode: standalone is always multi regardless of the flag', () => {
  assert.equal(resolveAgentsUiMode({ harness: 'standalone', multiProvider: false }), 'multi');
  assert.equal(resolveAgentsUiMode({ harness: 'standalone', multiProvider: true }), 'multi');
});

test('resolveAgentsUiMode: claude-code follows the flag', () => {
  assert.equal(resolveAgentsUiMode({ harness: 'claude-code', multiProvider: false }), 'single');
  assert.equal(resolveAgentsUiMode({ harness: 'claude-code', multiProvider: true }), 'multi');
});

test('resolveAgentsUiMode: "claude" alias follows the flag', () => {
  assert.equal(resolveAgentsUiMode({ harness: 'claude', multiProvider: false }), 'single');
  assert.equal(resolveAgentsUiMode({ harness: 'claude', multiProvider: true }), 'multi');
});

test('resolveAgentsUiMode: codex follows the flag', () => {
  assert.equal(resolveAgentsUiMode({ harness: 'codex', multiProvider: false }), 'single');
  assert.equal(resolveAgentsUiMode({ harness: 'codex', multiProvider: true }), 'multi');
});

test('resolveAgentsUiMode: an unrecognized harness follows the flag too (only opencode/standalone are pinned to multi)', () => {
  assert.equal(resolveAgentsUiMode({ harness: 'some-future-harness', multiProvider: false }), 'single');
  assert.equal(resolveAgentsUiMode({ harness: 'some-future-harness', multiProvider: true }), 'multi');
});

test('resolveAgentsUiMode: harness matching is case-insensitive', () => {
  assert.equal(resolveAgentsUiMode({ harness: 'OpenCode', multiProvider: false }), 'multi');
  assert.equal(resolveAgentsUiMode({ harness: 'STANDALONE', multiProvider: false }), 'multi');
  assert.equal(resolveAgentsUiMode({ harness: 'Claude-Code', multiProvider: false }), 'single');
});

test('resolveAgentsUiMode: empty/missing harness follows the flag', () => {
  assert.equal(resolveAgentsUiMode({ harness: '', multiProvider: false }), 'single');
  assert.equal(resolveAgentsUiMode({ harness: '', multiProvider: true }), 'multi');
});

test('singleProviderTiers: claude-code returns the anthropic vendor with fable/opus/sonnet/haiku tiers sourced from MODEL_ALIASES', () => {
  const result = singleProviderTiers('claude-code');
  assert.equal(result.vendor, 'anthropic');
  assert.deepEqual(
    result.tiers.map((t) => t.id),
    ['fable', 'opus', 'sonnet', 'haiku'],
  );
  for (const tier of result.tiers) {
    assert.equal(tier.model, MODEL_ALIASES[tier.id], `tier ${tier.id} model must equal MODEL_ALIASES.${tier.id}`);
  }
});

test('singleProviderTiers: "claude" alias returns the same anthropic tiers as "claude-code"', () => {
  assert.deepEqual(singleProviderTiers('claude'), singleProviderTiers('claude-code'));
});

test('singleProviderTiers: codex returns the openai vendor with exact sol/astra slugs', () => {
  const result = singleProviderTiers('codex');
  assert.equal(result.vendor, 'openai');
  assert.deepEqual(result.tiers, [
    { id: 'astra', label: 'Astra', model: 'openai/gpt-6-astra', description: 'Most capable; frontier work' },
    { id: 'sol', label: 'Sol', model: 'openai/gpt-6.1-sol', description: 'Near-Astra at lower cost' },
    { id: 'terra', label: 'Terra', model: 'openai/gpt-6.1-terra', description: 'Balanced model for straightforward work' },
    { id: 'luna', label: 'Luna', model: 'openai/gpt-6-luna', description: 'Cheap, high-volume work' },
  ]);
});

test('singleProviderTiers: an unknown harness returns empty tiers and an empty vendor', () => {
  assert.deepEqual(singleProviderTiers('opencode'), { vendor: '', tiers: [] });
  assert.deepEqual(singleProviderTiers('standalone'), { vendor: '', tiers: [] });
  assert.deepEqual(singleProviderTiers('nonsense'), { vendor: '', tiers: [] });
  assert.deepEqual(singleProviderTiers(''), { vendor: '', tiers: [] });
});

test('singleProviderTiers: harness matching is case-insensitive', () => {
  assert.equal(singleProviderTiers('Codex').vendor, 'openai');
  assert.equal(singleProviderTiers('CLAUDE-CODE').vendor, 'anthropic');
});

test('CODEX_ACCEPTED_MODELS is the codex tier source: Astra, Sol, Terra and Luna (most to least capable; ids from codex debug models)', () => {
  assert.deepEqual(CODEX_ACCEPTED_MODELS.map((t) => t.model), ['openai/gpt-6-astra', 'openai/gpt-6.1-sol', 'openai/gpt-6.1-terra', 'openai/gpt-6-luna']);
  assert.ok(CODEX_ACCEPTED_MODELS.every((t) => !!t.description), 'every tier carries a one-line description');
  assert.deepEqual(singleProviderTiers('codex').tiers, CODEX_ACCEPTED_MODELS);
});
