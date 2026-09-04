import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogSummary } from "../src/shared/catalogSummary";

test("authored summary wins over description", () => {
  const s = catalogSummary({
    summary: "Short authored line.",
    description: "A much longer description. With a second sentence too.",
  });
  assert.equal(s, "Short authored line.");
});

test("falls back to first sentence of description when summary absent", () => {
  const s = catalogSummary({
    description: "First sentence here. Second sentence should not appear.",
  });
  assert.equal(s, "First sentence here.");
});

test("falls back to first sentence when summary is empty string", () => {
  const s = catalogSummary({
    summary: "",
    description: "Only sentence, no trailing punctuation needed",
  });
  assert.equal(s, "Only sentence, no trailing punctuation needed");
});

test("handles ! and ? sentence terminators", () => {
  assert.equal(
    catalogSummary({ description: "Stop right there! This part is dropped." }),
    "Stop right there!",
  );
  assert.equal(
    catalogSummary({ description: "Is this it? Yes, this part is dropped." }),
    "Is this it?",
  );
});

test("does not split on a mid-sentence abbreviation period followed by a lowercase word", () => {
  const s = catalogSummary({
    description: "Uses e.g. a few tools to get the job done. Second real sentence.",
  });
  assert.equal(s, "Uses e.g. a few tools to get the job done.");
});

test("strips markdown backticks", () => {
  const s = catalogSummary({ description: "Runs `npm test` to verify. Ignored." });
  assert.equal(s, "Runs npm test to verify.");
});

test("collapses internal whitespace/newlines", () => {
  const s = catalogSummary({ description: "Line one\n  has   extra   spaces. Ignored." });
  assert.equal(s, "Line one has extra spaces.");
});

test("truncates a long authored summary at 120 chars on a word boundary with an ellipsis", () => {
  const long = "This authored summary sentence is deliberately written to be far longer than the one hundred and twenty character budget allowed for a catalog summary field.";
  const s = catalogSummary({ summary: long });
  assert.ok(s.length <= 120, `expected <=120, got ${s.length}`);
  assert.ok(s.endsWith("…"));
});

test("truncates a long fallback sentence at 120 chars", () => {
  const long = "This single sentence with no early terminator just keeps going and going and going well past the one hundred and twenty character limit that summaries must respect";
  const s = catalogSummary({ description: long });
  assert.ok(s.length <= 120, `expected <=120, got ${s.length}`);
  assert.ok(s.endsWith("…"));
});

test("returns empty string for entry with no summary and no description", () => {
  assert.equal(catalogSummary({}), "");
});
