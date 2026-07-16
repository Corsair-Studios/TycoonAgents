/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectForeignManagedBlocks,
  detectLegacyOfficeAgentsBlock,
  stripLegacyOfficeAgentsBlock,
} from "../src/host/vscode/legacyDoctrine";

const LEGACY_BLOCK =
  "<!-- officeagents:begin — managed by OfficeAgents; do not edit between markers -->\n" +
  "## OfficeAgents routing table\n" +
  "\n" +
  "| kind | agent |\n" +
  "| --- | --- |\n" +
  "| search | search-retrieval |\n" +
  "<!-- officeagents:end -->";

// ---------------------------------------------------------------------------
// detectLegacyOfficeAgentsBlock
// ---------------------------------------------------------------------------

test("detectLegacyOfficeAgentsBlock: absent markers -> present:false, lineCount:0", () => {
  const result = detectLegacyOfficeAgentsBlock("# Project Instructions\n\nNo legacy block here.\n");
  assert.deepEqual(result, { present: false, lineCount: 0 });
});

test("detectLegacyOfficeAgentsBlock: present markers -> present:true with a positive lineCount", () => {
  const content = `# Project Instructions\n\n${LEGACY_BLOCK}\n\n<!-- tycoon:delegation -->\nBody\n<!-- /tycoon:delegation -->\n`;
  const result = detectLegacyOfficeAgentsBlock(content);
  assert.equal(result.present, true);
  assert.ok(result.lineCount > 0, "lineCount must be positive when the block is present");
  assert.equal(result.lineCount, LEGACY_BLOCK.split("\n").length);
});

test("detectLegacyOfficeAgentsBlock: empty content -> present:false", () => {
  assert.deepEqual(detectLegacyOfficeAgentsBlock(""), { present: false, lineCount: 0 });
});

// ---------------------------------------------------------------------------
// stripLegacyOfficeAgentsBlock
// ---------------------------------------------------------------------------

test("stripLegacyOfficeAgentsBlock: no-op when markers are absent", () => {
  const content = "# Project Instructions\n\n<!-- tycoon:delegation -->\nBody\n<!-- /tycoon:delegation -->\n";
  const result = stripLegacyOfficeAgentsBlock(content);
  assert.equal(result.removed, false);
  assert.equal(result.content, content, "content must be returned byte-for-byte unchanged");
});

test("stripLegacyOfficeAgentsBlock: no-op on empty content", () => {
  const result = stripLegacyOfficeAgentsBlock("");
  assert.equal(result.removed, false);
  assert.equal(result.content, "");
});

test("stripLegacyOfficeAgentsBlock removes exactly the delimited region, preserving surrounding content", () => {
  const content =
    `# Project Instructions\n\n${LEGACY_BLOCK}\n\n` +
    "<!-- tycoon:delegation -->\nDelegation body.\n<!-- /tycoon:delegation -->\n";
  const result = stripLegacyOfficeAgentsBlock(content);

  assert.equal(result.removed, true);
  assert.equal(result.content.includes("officeagents:begin"), false, "legacy start marker must be gone");
  assert.equal(result.content.includes("officeagents:end"), false, "legacy end marker must be gone");
  assert.equal(result.content.includes("OfficeAgents routing table"), false, "legacy body must be gone");

  // Surrounding content is preserved.
  assert.ok(result.content.startsWith("# Project Instructions"), "heading must be preserved");
  assert.ok(result.content.includes("<!-- tycoon:delegation -->"), "tycoon delegation start marker must survive");
  assert.ok(result.content.includes("Delegation body."), "tycoon delegation body must survive");
  assert.ok(result.content.includes("<!-- /tycoon:delegation -->"), "tycoon delegation end marker must survive");
});

test("stripLegacyOfficeAgentsBlock collapses the seam down to a single blank line (no double-blank artifact)", () => {
  const content =
    `# Project Instructions\n\n${LEGACY_BLOCK}\n\n` +
    "<!-- tycoon:delegation -->\nBody\n<!-- /tycoon:delegation -->\n";
  const result = stripLegacyOfficeAgentsBlock(content);
  assert.equal(
    result.content,
    "# Project Instructions\n\n<!-- tycoon:delegation -->\nBody\n<!-- /tycoon:delegation -->\n"
  );
  assert.equal(/\n{3,}/.test(result.content), false, "must not leave a run of 3+ newlines (2+ blank lines) at the seam");
});

test("stripLegacyOfficeAgentsBlock: block at the very start of the file leaves no leading blank line", () => {
  const content = `${LEGACY_BLOCK}\n\n<!-- tycoon:delegation -->\nBody\n<!-- /tycoon:delegation -->\n`;
  const result = stripLegacyOfficeAgentsBlock(content);
  assert.ok(result.content.startsWith("<!-- tycoon:delegation -->"), "must not leave leading blank lines");
});

test("stripLegacyOfficeAgentsBlock: block at the very end of the file leaves a clean trailing newline", () => {
  const content = `# Project Instructions\n\n${LEGACY_BLOCK}\n`;
  const result = stripLegacyOfficeAgentsBlock(content);
  assert.equal(result.content, "# Project Instructions\n");
});

test("stripLegacyOfficeAgentsBlock is idempotent: stripping the already-stripped content is a no-op", () => {
  const content =
    `# Project Instructions\n\n${LEGACY_BLOCK}\n\n` +
    "<!-- tycoon:delegation -->\nBody\n<!-- /tycoon:delegation -->\n";
  const once = stripLegacyOfficeAgentsBlock(content);
  const twice = stripLegacyOfficeAgentsBlock(once.content);
  assert.equal(twice.removed, false);
  assert.equal(twice.content, once.content);
});

test("stripLegacyOfficeAgentsBlock never touches unrelated blank-line runs elsewhere in the file", () => {
  const content =
    `# Project Instructions\n\n${LEGACY_BLOCK}\n\n` +
    "Some text.\n\n\n\nMore text after an unrelated triple-blank run.\n";
  const result = stripLegacyOfficeAgentsBlock(content);
  assert.ok(
    result.content.includes("Some text.\n\n\n\nMore text after an unrelated triple-blank run.\n"),
    "blank-line runs unrelated to the removed block must be preserved exactly"
  );
});

// ---------------------------------------------------------------------------
// detectForeignManagedBlocks
// ---------------------------------------------------------------------------

const FOO_BLOCK = "<!-- foo:begin — managed by Foo -->\nFoo config body.\n<!-- foo:end -->";
const BAR_BLOCK = "<!-- bar:begin -->\nBar line one.\nBar line two.\nBar line three.\n<!-- bar:end -->";

test("detectForeignManagedBlocks: finds multiple foreign namespaces in appearance order", () => {
  const content = `# Project Instructions\n\n${BAR_BLOCK}\n\n${FOO_BLOCK}\n`;
  const result = detectForeignManagedBlocks(content);
  assert.equal(result.length, 2);
  assert.equal(result[0].namespace, "bar", "must appear in the SAME order as in the file (bar comes first)");
  assert.equal(result[1].namespace, "foo");
});

test("detectForeignManagedBlocks: excludes tycoon and officeagents namespaces", () => {
  const content =
    `# Project Instructions\n\n${LEGACY_BLOCK}\n\n` +
    "<!-- tycoon:begin -->\nShould never appear as foreign.\n<!-- tycoon:end -->\n\n" +
    `${FOO_BLOCK}\n`;
  const result = detectForeignManagedBlocks(content);
  assert.equal(result.length, 1);
  assert.equal(result[0].namespace, "foo");
  assert.ok(
    !result.some((b) => b.namespace.toLowerCase() === "tycoon" || b.namespace.toLowerCase() === "officeagents"),
    "tycoon/officeagents must never be reported as foreign"
  );
});

test("detectForeignManagedBlocks: returns [] when no managed blocks are present", () => {
  assert.deepEqual(detectForeignManagedBlocks("# Project Instructions\n\nJust plain prose.\n"), []);
});

test("detectForeignManagedBlocks: returns [] on empty content", () => {
  assert.deepEqual(detectForeignManagedBlocks(""), []);
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
