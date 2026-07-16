/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectForeignManagedBlocks, stripManagedBlock } from "../src/host/vscode/legacyDoctrine";

const LEGACYTOOL_BLOCK =
  "<!-- legacytool:begin — managed by a previous setup; do not edit between markers -->\n" +
  "## Routing table\n" +
  "\n" +
  "| kind | agent |\n" +
  "| --- | --- |\n" +
  "| search | search-retrieval |\n" +
  "<!-- legacytool:end -->";

// ---------------------------------------------------------------------------
// detectForeignManagedBlocks
// ---------------------------------------------------------------------------

const FOO_BLOCK = "<!-- foo:begin — managed by Foo -->\nFoo config body.\n<!-- foo:end -->";
const BAR_BLOCK = "<!-- bar:begin -->\nBar line one.\nBar line two.\nBar line three.\n<!-- bar:end -->";

test("detectForeignManagedBlocks: absent markers -> []", () => {
  const result = detectForeignManagedBlocks("# Project Instructions\n\nNo managed block here.\n");
  assert.deepEqual(result, []);
});

test("detectForeignManagedBlocks: detects a legacy namespace alongside tycoon markers", () => {
  const content = `# Project Instructions\n\n${LEGACYTOOL_BLOCK}\n\n<!-- tycoon:delegation -->\nBody\n<!-- /tycoon:delegation -->\n`;
  const result = detectForeignManagedBlocks(content);
  assert.equal(result.length, 1);
  assert.equal(result[0].namespace, "legacytool");
  assert.ok(result[0].lines > 0, "lines must be positive when the block is present");
  assert.equal(result[0].lines, LEGACYTOOL_BLOCK.split("\n").length);
});

test("detectForeignManagedBlocks: empty content -> []", () => {
  assert.deepEqual(detectForeignManagedBlocks(""), []);
});

test("detectForeignManagedBlocks: finds multiple foreign namespaces in appearance order", () => {
  const content = `# Project Instructions\n\n${BAR_BLOCK}\n\n${FOO_BLOCK}\n`;
  const result = detectForeignManagedBlocks(content);
  assert.equal(result.length, 2);
  assert.equal(result[0].namespace, "bar", "must appear in the SAME order as in the file (bar comes first)");
  assert.equal(result[1].namespace, "foo");
});

test("detectForeignManagedBlocks: excludes the tycoon namespace", () => {
  const content =
    `# Project Instructions\n\n${LEGACYTOOL_BLOCK}\n\n` +
    "<!-- tycoon:begin -->\nShould never appear as foreign.\n<!-- tycoon:end -->\n\n" +
    `${FOO_BLOCK}\n`;
  const result = detectForeignManagedBlocks(content);
  assert.equal(result.length, 2);
  assert.ok(result.some((b) => b.namespace === "legacytool"));
  assert.ok(result.some((b) => b.namespace === "foo"));
  assert.ok(
    !result.some((b) => b.namespace.toLowerCase() === "tycoon"),
    "tycoon must never be reported as foreign"
  );
});

test("detectForeignManagedBlocks: returns [] when no managed blocks are present", () => {
  assert.deepEqual(detectForeignManagedBlocks("# Project Instructions\n\nJust plain prose.\n"), []);
});

test("detectForeignManagedBlocks: reports the correct line count per block", () => {
  const content = `# Project Instructions\n\n${FOO_BLOCK}\n\n${BAR_BLOCK}\n`;
  const result = detectForeignManagedBlocks(content);
  assert.equal(result.length, 2);
  assert.equal(result[0].namespace, "foo");
  assert.equal(result[0].lines, FOO_BLOCK.split("\n").length);
  assert.equal(result[1].namespace, "bar");
  assert.equal(result[1].lines, BAR_BLOCK.split("\n").length);
});

test("detectForeignManagedBlocks: is deterministic across repeated calls on the same content", () => {
  const content = `${BAR_BLOCK}\n\n${FOO_BLOCK}\n`;
  const first = detectForeignManagedBlocks(content);
  const second = detectForeignManagedBlocks(content);
  assert.deepEqual(first, second);
});

test("detectForeignManagedBlocks: a begin/end pair with mismatched namespaces does not match", () => {
  const content = "<!-- foo:begin -->\nBody\n<!-- bar:end -->\n";
  assert.deepEqual(detectForeignManagedBlocks(content), []);
});

// ---------------------------------------------------------------------------
// stripManagedBlock
// ---------------------------------------------------------------------------

test("stripManagedBlock: no-op when the given namespace's markers are absent", () => {
  const content = "# Project Instructions\n\n<!-- tycoon:delegation -->\nBody\n<!-- /tycoon:delegation -->\n";
  const result = stripManagedBlock(content, "legacytool");
  assert.equal(result.removed, false);
  assert.equal(result.content, content, "content must be returned byte-for-byte unchanged");
});

test("stripManagedBlock: no-op on empty content", () => {
  const result = stripManagedBlock("", "legacytool");
  assert.equal(result.removed, false);
  assert.equal(result.content, "");
});

test("stripManagedBlock removes exactly the delimited region for the given namespace, preserving surrounding content", () => {
  const content =
    `# Project Instructions\n\n${LEGACYTOOL_BLOCK}\n\n` +
    "<!-- tycoon:delegation -->\nDelegation body.\n<!-- /tycoon:delegation -->\n";
  const result = stripManagedBlock(content, "legacytool");

  assert.equal(result.removed, true);
  assert.equal(result.content.includes("legacytool:begin"), false, "namespace start marker must be gone");
  assert.equal(result.content.includes("legacytool:end"), false, "namespace end marker must be gone");
  assert.equal(result.content.includes("Routing table"), false, "block body must be gone");

  // Surrounding content is preserved.
  assert.ok(result.content.startsWith("# Project Instructions"), "heading must be preserved");
  assert.ok(result.content.includes("<!-- tycoon:delegation -->"), "tycoon delegation start marker must survive");
  assert.ok(result.content.includes("Delegation body."), "tycoon delegation body must survive");
  assert.ok(result.content.includes("<!-- /tycoon:delegation -->"), "tycoon delegation end marker must survive");
});

test("stripManagedBlock only removes the block for the GIVEN namespace, not others present in the same content", () => {
  const content = `# Project Instructions\n\n${LEGACYTOOL_BLOCK}\n\n${FOO_BLOCK}\n`;
  const result = stripManagedBlock(content, "legacytool");
  assert.equal(result.removed, true);
  assert.equal(result.content.includes("legacytool:begin"), false);
  assert.ok(result.content.includes("foo:begin"), "the untargeted foo block must survive");
  assert.ok(result.content.includes("Foo config body."), "the untargeted foo block's body must survive");
});

test("stripManagedBlock collapses the seam down to a single blank line (no double-blank artifact)", () => {
  const content =
    `# Project Instructions\n\n${LEGACYTOOL_BLOCK}\n\n` +
    "<!-- tycoon:delegation -->\nBody\n<!-- /tycoon:delegation -->\n";
  const result = stripManagedBlock(content, "legacytool");
  assert.equal(
    result.content,
    "# Project Instructions\n\n<!-- tycoon:delegation -->\nBody\n<!-- /tycoon:delegation -->\n"
  );
  assert.equal(/\n{3,}/.test(result.content), false, "must not leave a run of 3+ newlines (2+ blank lines) at the seam");
});

test("stripManagedBlock: block at the very start of the file leaves no leading blank line", () => {
  const content = `${LEGACYTOOL_BLOCK}\n\n<!-- tycoon:delegation -->\nBody\n<!-- /tycoon:delegation -->\n`;
  const result = stripManagedBlock(content, "legacytool");
  assert.ok(result.content.startsWith("<!-- tycoon:delegation -->"), "must not leave leading blank lines");
});

test("stripManagedBlock: block at the very end of the file leaves a clean trailing newline", () => {
  const content = `# Project Instructions\n\n${LEGACYTOOL_BLOCK}\n`;
  const result = stripManagedBlock(content, "legacytool");
  assert.equal(result.content, "# Project Instructions\n");
});

test("stripManagedBlock is idempotent: stripping the already-stripped content is a no-op", () => {
  const content =
    `# Project Instructions\n\n${LEGACYTOOL_BLOCK}\n\n` +
    "<!-- tycoon:delegation -->\nBody\n<!-- /tycoon:delegation -->\n";
  const once = stripManagedBlock(content, "legacytool");
  const twice = stripManagedBlock(once.content, "legacytool");
  assert.equal(twice.removed, false);
  assert.equal(twice.content, once.content);
});

test("stripManagedBlock never touches unrelated blank-line runs elsewhere in the file", () => {
  const content =
    `# Project Instructions\n\n${LEGACYTOOL_BLOCK}\n\n` +
    "Some text.\n\n\n\nMore text after an unrelated triple-blank run.\n";
  const result = stripManagedBlock(content, "legacytool");
  assert.ok(
    result.content.includes("Some text.\n\n\n\nMore text after an unrelated triple-blank run.\n"),
    "blank-line runs unrelated to the removed block must be preserved exactly"
  );
});

test("stripManagedBlock: a namespace containing a regex-special character doesn't break or over-match", () => {
  const nsBlock = "<!-- old.plugin:begin -->\nSome carried-over config.\n<!-- old.plugin:end -->";
  const content = `# Project Instructions\n\n${nsBlock}\n\n<!-- tycoon:delegation -->\nBody\n<!-- /tycoon:delegation -->\n`;

  // A literal "." in the namespace must be escaped -- confirm it does NOT
  // also match an unrelated single-character-different namespace.
  const decoy = "<!-- oldXplugin:begin -->\nDecoy.\n<!-- oldXplugin:end -->\n";
  const withDecoy = `${decoy}\n${content}`;

  const result = stripManagedBlock(withDecoy, "old.plugin");
  assert.equal(result.removed, true);
  assert.equal(result.content.includes("old.plugin:begin"), false, "the targeted namespace's block must be gone");
  assert.equal(result.content.includes("Some carried-over config."), false);
  assert.ok(result.content.includes("oldXplugin:begin"), "the decoy namespace must be untouched");
  assert.ok(result.content.includes("Decoy."), "the decoy namespace's body must survive");
});
