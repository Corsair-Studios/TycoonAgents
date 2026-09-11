/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Tests src/providers/codex/installCodexDispatcher.ts: register a
// [mcp_servers.tycoon] table in CODEX_HOME/config.toml, appended after all
// existing content (never before the first table header, unlike notify),
// idempotent re-install, foreign-table conflict handling, and
// byte-identical uninstall, per plan p23-t2's acceptance criteria.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDispatcherBlock,
  mergeDispatcherIntoConfigToml,
  removeDispatcherFromConfigToml,
  isDispatcherMarkerInConfigToml,
} from "../src/providers/codex/installCodexDispatcher";

const OPTS = {
  nodePath: "/usr/bin/node",
  serverScriptPath: "/proj/hooks/tycoon-dispatcher-mcp.cjs",
  projectDir: "/proj",
};

/** Minimal TOML table-header scanner: every line index (0-based) matching /^\s*\[/. */
function tableHeaderLineIndices(text: string): number[] {
  const lines = text.split("\n");
  const out: number[] = [];
  lines.forEach((line, i) => {
    if (/^[ \t]*\[/.test(line)) out.push(i);
  });
  return out;
}

test("merge: appends the managed block after all existing content, never before an existing table header", () => {
  const existing = `notify = ["node", "x.js"]\n\n[projects."/repo"]\ntrust_level = "trusted"\n`;
  const merged = mergeDispatcherIntoConfigToml(existing, OPTS);
  const startIdx = merged.text.indexOf("# tycoon-dispatcher: managed mcp server");
  const existingHeaderIdx = merged.text.indexOf('[projects."/repo"]');
  assert.ok(startIdx > existingHeaderIdx);
  assert.equal(merged.warnings, undefined);
});

test("merge: block is last in the file and no line between markers is outside it", () => {
  const merged = mergeDispatcherIntoConfigToml(undefined, OPTS);
  const lines = merged.text.split("\n");
  const startLine = lines.findIndex((l) => l.includes("tycoon-dispatcher: managed mcp server"));
  const endLine = lines.findIndex((l) => l.includes("tycoon-dispatcher: end managed mcp server"));
  assert.ok(startLine >= 0);
  assert.ok(endLine > startLine);

  const headerIndices = tableHeaderLineIndices(merged.text);
  const ourHeaderIdx = lines.findIndex((l) => l.trim() === "[mcp_servers.tycoon]");
  assert.ok(ourHeaderIdx > startLine && ourHeaderIdx < endLine);
  assert.ok(headerIndices.includes(ourHeaderIdx));
  assert.equal(headerIndices.length, 1); // only our table header exists in this fresh file

  const nonEmpty = lines.map((l, i) => [i, l] as const).filter(([, l]) => l.trim() !== "");
  assert.equal(nonEmpty[nonEmpty.length - 1][0], endLine); // end marker is the last non-blank line
});

test("merge: block content is Codex-parsable TOML (command/args/env)", () => {
  const merged = mergeDispatcherIntoConfigToml(undefined, OPTS);
  assert.ok(merged.text.includes('command = "/usr/bin/node"'));
  assert.ok(merged.text.includes('args = ["/proj/hooks/tycoon-dispatcher-mcp.cjs"]'));
  assert.ok(
    merged.text.includes(
      'env = { TYCOON_PROJECT_DIR = "/proj", TYCOON_CODEX_DISPATCHER_CONFIGURED = "1" }',
    ),
  );
});

test("merge: does not embed secret env names in the written block", () => {
  const merged = mergeDispatcherIntoConfigToml(undefined, OPTS);
  assert.doesNotMatch(merged.text, /CLAUDE_CLI_|OPENAI_COMPAT_/);
});

test("merge: idempotent re-install replaces the managed block in place, no duplication", () => {
  const once = mergeDispatcherIntoConfigToml(undefined, OPTS).text;
  const twice = mergeDispatcherIntoConfigToml(once, OPTS).text;
  assert.equal(twice, once);
  assert.equal(twice.split("mcp_servers.tycoon").length - 1, 1);
});

test("merge: foreign [mcp_servers.tycoon] table outside our markers is left untouched with a warning", () => {
  const existing = `[mcp_servers.tycoon]\ncommand = "custom"\nargs = []\n`;
  const merged = mergeDispatcherIntoConfigToml(existing, OPTS);
  assert.deepEqual(merged.warnings, [
    "config.toml already has a [mcp_servers.tycoon] table outside the tycoon-dispatcher managed block; left it untouched.",
  ]);
  assert.equal(merged.text, existing);
  assert.ok(!merged.text.includes("tycoon-dispatcher: managed mcp server"));
});

test("merge: does not split an existing table's body when appending", () => {
  const existing = `[projects."/repo"]\ntrust_level = "trusted"\nfoo = "bar"\n`;
  const merged = mergeDispatcherIntoConfigToml(existing, OPTS);
  assert.ok(merged.text.includes('trust_level = "trusted"\nfoo = "bar"'));
});

test("uninstall: byte-identical restore of the original content", () => {
  const original = `notify = ["node", "x.js"]\n\n[projects."/repo"]\ntrust_level = "trusted"\n`;
  const merged = mergeDispatcherIntoConfigToml(original, OPTS).text;
  const restored = removeDispatcherFromConfigToml(merged);
  assert.equal(restored, original);
});

test("uninstall: returns the same string reference when there is nothing to remove", () => {
  const text = `notify = ["node", "x.js"]\n`;
  assert.equal(removeDispatcherFromConfigToml(text), text);
});

test("uninstall: removes only the managed block, leaving a foreign table untouched", () => {
  const original = `[mcp_servers.other]\ncommand = "x"\n`;
  const merged = mergeDispatcherIntoConfigToml(original, OPTS).text;
  const restored = removeDispatcherFromConfigToml(merged);
  assert.equal(restored, original);
});

test("buildDispatcherBlock: includes start/end markers and the table header", () => {
  const block = buildDispatcherBlock(OPTS);
  assert.ok(block.startsWith("# tycoon-dispatcher: managed mcp server"));
  assert.ok(block.endsWith("# tycoon-dispatcher: end managed mcp server"));
  assert.ok(block.includes("[mcp_servers.tycoon]"));
});

test("isDispatcherMarkerInConfigToml: false, never throws, when CODEX_HOME cannot be resolved", () => {
  assert.equal(isDispatcherMarkerInConfigToml({}), false);
});
