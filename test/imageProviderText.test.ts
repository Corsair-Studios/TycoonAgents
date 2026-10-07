import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeImageProviderText } from '../src/core/imageProviderText';

test('replaces provider names with the image provider', () => {
  assert.equal(
    sanitizeImageProviderText('OpenAI blocked this image request.'),
    'The image provider blocked this image request.',
  );
  assert.equal(
    sanitizeImageProviderText("Blocked by OpenAI's content policy"),
    "Blocked by the image provider's content policy",
  );
  assert.equal(
    sanitizeImageProviderText('gpt-image-2 rejected the prompt'),
    'The image provider rejected the prompt',
  );
  assert.equal(
    sanitizeImageProviderText('Google Gemini and Imagen 3, Stability AI, Midjourney, DALL·E 3 failed'),
    'the image provider and the image provider, the image provider, the image provider, the image provider failed'
      .replace(/^the/, 'The'),
  );
});

test('leaves neutral text and empty values unchanged', () => {
  assert.equal(sanitizeImageProviderText('Too many requests. No credits were charged.'), 'Too many requests. No credits were charged.');
  assert.equal(sanitizeImageProviderText(undefined), undefined);
  assert.equal(sanitizeImageProviderText(''), '');
});

test('does not leave provider names in OpenAI GPT Image API error text', () => {
  const out = sanitizeImageProviderText('OpenAI GPT Image API error 500: boom');
  assert.ok(!/openai|gpt/i.test(out));
});

test('absorbs full GPT Image suffix and keeps possessive', () => {
  assert.equal(sanitizeImageProviderText('openai gpt-image-1 error'), 'The image provider error');
  assert.equal(sanitizeImageProviderText("OpenAI's policy"), "The image provider's policy");
});

test('does not half-replace hyphenated names', () => {
  assert.equal(sanitizeImageProviderText('gemini-reviewer is idle'), 'gemini-reviewer is idle');
  assert.equal(sanitizeImageProviderText('Flux.1 is down'), 'The image provider is down');
});
