/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { IMAGE_MODELS, defaultImageModel, resolveImageModel } from "../src/extension/imageModels";

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
