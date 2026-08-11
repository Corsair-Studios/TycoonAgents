/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IMAGE_MODELS,
  defaultImageModel,
  resolveImageModel,
  // The quality-options contract (OpenAI-only low/medium/high, default
  // medium) is not yet implemented as of this writing — these three names
  // follow the exact naming convention already established by this same
  // file (IMAGE_MODELS / defaultImageModel / resolveImageModel). If the
  // implementing agent names them differently, update these imports to
  // match rather than the reverse — the behavior contract below is what
  // matters, not these particular identifiers.
  IMAGE_QUALITY_OPTIONS,
  defaultImageQuality,
  resolveImageQuality,
} from "../src/extension/imageModels";

test("defaultImageModel('gemini') returns the latest Gemini model id", () => {
  assert.equal(defaultImageModel("gemini"), "gemini-3.1-flash-image");
});

test("defaultImageModel('openai') returns the latest OpenAI model id", () => {
  assert.equal(defaultImageModel("openai"), "gpt-image-2");
});

test("IMAGE_MODELS.gemini is non-empty and its index-0 note marks it the recommended/latest default", () => {
  const list = IMAGE_MODELS.gemini;
  assert.ok(list.length > 0, "gemini model list must not be empty");
  assert.equal(list[0].id, "gemini-3.1-flash-image");
  assert.match(list[0].note ?? "", /latest/i);
  assert.match(list[0].note ?? "", /recommended/i);
});

test("IMAGE_MODELS.openai is non-empty and its index-0 note marks it the recommended/latest default", () => {
  const list = IMAGE_MODELS.openai;
  assert.ok(list.length > 0, "openai model list must not be empty");
  assert.equal(list[0].id, "gpt-image-2");
  assert.match(list[0].note ?? "", /latest/i);
  assert.match(list[0].note ?? "", /recommended/i);
});

test("resolveImageModel returns a non-empty stored id unchanged (trimmed value wins over the default)", () => {
  assert.equal(resolveImageModel("gemini", "some-stored-id"), "some-stored-id");
  assert.equal(resolveImageModel("openai", "another-stored-id"), "another-stored-id");
});

test("resolveImageModel trims surrounding whitespace off a stored id but keeps the id itself", () => {
  assert.equal(resolveImageModel("gemini", "  padded-id  "), "padded-id");
});

test("resolveImageModel falls back to the provider default for an empty string", () => {
  assert.equal(resolveImageModel("gemini", ""), defaultImageModel("gemini"));
  assert.equal(resolveImageModel("openai", ""), defaultImageModel("openai"));
});

test("resolveImageModel falls back to the provider default for a whitespace-only string", () => {
  assert.equal(resolveImageModel("gemini", "   "), defaultImageModel("gemini"));
  assert.equal(resolveImageModel("openai", "\t\n  "), defaultImageModel("openai"));
});

test("resolveImageModel falls back to the provider default for undefined", () => {
  assert.equal(resolveImageModel("gemini", undefined), defaultImageModel("gemini"));
  assert.equal(resolveImageModel("openai", undefined), defaultImageModel("openai"));
});

test("resolveImageModel falls back to the provider default for null", () => {
  assert.equal(resolveImageModel("gemini", null), defaultImageModel("gemini"));
  assert.equal(resolveImageModel("openai", null), defaultImageModel("openai"));
});

test("resolveImageModel is permissive: an unknown/brand-new model id not present in IMAGE_MODELS is returned as-is, unvalidated", () => {
  const unknownId = "gemini-9000-ultra-image-not-in-the-list";
  assert.ok(
    !IMAGE_MODELS.gemini.some((m) => m.id === unknownId),
    "sanity check: this id must not already be in IMAGE_MODELS.gemini",
  );
  assert.equal(resolveImageModel("gemini", unknownId), unknownId);
});

// --- OpenAI image `quality` setting (low/medium/high, default medium) ---
// Contract: a quality options list lives alongside IMAGE_MODELS, OpenAI-only,
// default 'medium'. Unlike resolveImageModel (permissive passthrough),
// resolveImageQuality MUST reject invalid values -- an unvalidated quality
// string reaching the OpenAI API would be a request-time error.

test("defaultImageQuality is 'medium'", () => {
  assert.equal(defaultImageQuality(), "medium");
});

test("IMAGE_QUALITY_OPTIONS contains exactly low, medium, high", () => {
  assert.ok(Array.isArray(IMAGE_QUALITY_OPTIONS), "IMAGE_QUALITY_OPTIONS must be an array");
  const ids = IMAGE_QUALITY_OPTIONS.map((o: { id: string }) => o.id).sort();
  assert.deepEqual(ids, ["high", "low", "medium"]);
});

test("resolveImageQuality returns a valid explicit value unchanged", () => {
  assert.equal(resolveImageQuality("low"), "low");
  assert.equal(resolveImageQuality("medium"), "medium");
  assert.equal(resolveImageQuality("high"), "high");
});

test("resolveImageQuality falls back to 'medium' for empty/whitespace/undefined/null", () => {
  assert.equal(resolveImageQuality(""), "medium");
  assert.equal(resolveImageQuality("   "), "medium");
  assert.equal(resolveImageQuality(undefined), "medium");
  assert.equal(resolveImageQuality(null), "medium");
});

test("resolveImageQuality falls back to 'medium' for a GARBAGE/invalid value -- never passes it through to the API", () => {
  assert.equal(resolveImageQuality("ultra"), "medium");
  assert.equal(resolveImageQuality("low-ish"), "medium");
  assert.equal(resolveImageQuality(123 as unknown as string), "medium");
  assert.equal(resolveImageQuality({} as unknown as string), "medium");
});
