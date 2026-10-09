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
import { scanTomlLines, detectEol, parseTableHeader } from "../src/providers/codex/tomlScan";

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
      'env = { TYCOON_CODEX_DISPATCHER_CONFIGURED = "1" }',
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

test("merge: a table outside our markers whose args reference tycoon-dispatcher-mcp.cjs is treated as ours and rewritten", () => {
  const existing =
    'model = "x"\n\n[mcp_servers.tycoon]\ncommand = "node"\nargs = ["D:\\\\old\\\\hooks\\\\tycoon-dispatcher-mcp.cjs"]\n\n[mcp_servers.tycoon.env]\nA = "b"\n\n[windows]\nsandbox = "elevated"\n';
  const merged = mergeDispatcherIntoConfigToml(existing, OPTS);
  assert.equal(merged.warnings, undefined);
  assert.ok(!merged.text.includes("old"));
  assert.ok(!merged.text.includes("[mcp_servers.tycoon.env]"));
  assert.ok(merged.text.includes(OPTS.serverScriptPath));
  assert.ok(merged.text.includes('[windows]\nsandbox = "elevated"'));
  assert.equal(merged.text.split("[mcp_servers.tycoon]").length - 1, 1);
  const again = mergeDispatcherIntoConfigToml(merged.text, OPTS);
  assert.equal(again.text, merged.text);
});

test("merge: a foreign table that does not reference our dispatcher script is still skipped", () => {
  const existing = '[mcp_servers.tycoon]\ncommand = "node"\nargs = ["/x/other-server.js"]\n';
  const merged = mergeDispatcherIntoConfigToml(existing, OPTS);
  assert.ok(merged.warnings && merged.warnings.length === 1);
  assert.equal(merged.text, existing);
});

const REORDERED = [
  'model = "x"',
  "",
  "# tycoon-dispatcher: managed mcp server (do not edit by hand)",
  "[mcp_servers.node_repl]",
  'command = "node-repl"',
  "",
  "[mcp_servers.blender]",
  'command = "blender-mcp"',
  "",
  "[mcp_servers.tycoon]",
  'command = "node"',
  'args = ["D:\\\\old\\\\hooks\\\\tycoon-dispatcher-mcp.cjs"]',
  'env = { TYCOON_PROJECT_DIR = "D:\\\\old", TYCOON_CODEX_DISPATCHER_CONFIGURED = "1" }',
  "",
  "[mcp_servers.tycoon.tools.delegate]",
  'approval_mode = "approve"',
  "",
  "[mcp_servers.davinci_resolve]",
  'command = "resolve-mcp"',
  "# tycoon-dispatcher: end managed mcp server",
  "",
  "[windows]",
  'sandbox = "elevated"',
  "",
].join("\n");

test("block: env carries no TYCOON_PROJECT_DIR", () => {
  const block = buildDispatcherBlock(OPTS);
  assert.ok(!block.includes("TYCOON_PROJECT_DIR"));
  assert.ok(block.includes('TYCOON_CODEX_DISPATCHER_CONFIGURED = "1"'));
});

test("uninstall: other servers reordered between the markers survive; only our tables and marker lines go", () => {
  const restored = removeDispatcherFromConfigToml(REORDERED);
  for (const keep of ["[mcp_servers.node_repl]", "[mcp_servers.blender]", "[mcp_servers.davinci_resolve]", "[windows]", 'command = "resolve-mcp"']) {
    assert.ok(restored.includes(keep), keep);
  }
  assert.ok(!restored.includes("mcp_servers.tycoon"));
  assert.ok(!restored.includes("tycoon-dispatcher:"));
  assert.ok(!restored.includes("TYCOON_PROJECT_DIR"));
});

test("merge: reordered file keeps other servers and the user's approval_mode, upgrades the old block, and is stable on re-run", () => {
  const merged = mergeDispatcherIntoConfigToml(REORDERED, OPTS);
  assert.equal(merged.warnings, undefined);
  for (const keep of ["[mcp_servers.node_repl]", "[mcp_servers.blender]", "[mcp_servers.davinci_resolve]", "[windows]"]) {
    assert.ok(merged.text.includes(keep), keep);
  }
  assert.ok(merged.text.includes('[mcp_servers.tycoon.tools.delegate]\napproval_mode = "approve"'));
  assert.ok(!merged.text.includes("TYCOON_PROJECT_DIR"));
  assert.ok(!merged.text.includes("D:\\\\old"));
  assert.equal(merged.text.split("[mcp_servers.tycoon]").length - 1, 1);
  assert.ok(merged.text.includes(OPTS.serverScriptPath));
  const again = mergeDispatcherIntoConfigToml(merged.text, OPTS);
  assert.equal(again.text, merged.text);
});

test("merge: upgrades an old end-of-file block that still has TYCOON_PROJECT_DIR", () => {
  const old =
    'model = "x"\n\n# tycoon-dispatcher: managed mcp server (do not edit by hand)\n[mcp_servers.tycoon]\ncommand = "/usr/bin/node"\nargs = ["/proj/hooks/tycoon-dispatcher-mcp.cjs"]\nenv = { TYCOON_PROJECT_DIR = "/proj", TYCOON_CODEX_DISPATCHER_CONFIGURED = "1" }\n# tycoon-dispatcher: end managed mcp server\n';
  const merged = mergeDispatcherIntoConfigToml(old, OPTS);
  assert.ok(!merged.text.includes("TYCOON_PROJECT_DIR"));
  assert.equal(merged.text.split("tycoon-dispatcher: managed").length - 1, 1);
});

const S = "# tycoon-dispatcher: managed mcp server (do not edit by hand)";
const E = "# tycoon-dispatcher: end managed mcp server";
const ML_TABLE = '[mcp_servers.node_repl]\ncommand = """\n[mcp_servers.tycoon]\nfoo\n"""\nnotes = [\n[1],\n]\n';

test("uninstall: multi-line strings and arrays holding header-like lines are not mistaken for headers", () => {
  const text = `model = "x"\n\n${S}\n[mcp_servers.tycoon]\ncommand = "n"\nargs = ["a"]\n${ML_TABLE}${E}\n`;
  assert.equal(removeDispatcherFromConfigToml(text), `model = "x"\n\n${ML_TABLE}`);
});

test("merge: multi-line string content survives byte-for-byte and re-run is stable", () => {
  const text = `model = "x"\n\n${S}\n[mcp_servers.tycoon]\ncommand = "n"\nargs = ["a"]\n${ML_TABLE}${E}\n`;
  const merged = mergeDispatcherIntoConfigToml(text, OPTS);
  assert.ok(merged.text.includes(ML_TABLE));
  assert.equal(merged.text.split("\n[mcp_servers.tycoon]\n").length - 1, 2); // one inside the string, one managed
  assert.equal(merged.text.split(S).length - 1, 1);
  assert.equal(mergeDispatcherIntoConfigToml(merged.text, OPTS).text, merged.text);
});

test("uninstall: a [mcp_servers.tycoon] line inside a foreign multi-line string is kept", () => {
  const text = `${S}\n[mcp_servers.foo]\ns = """\n[mcp_servers.tycoon]\nkeepme\n"""\n[mcp_servers.tycoon]\ncommand = "n"\n${E}\n`;
  assert.equal(removeDispatcherFromConfigToml(text), '[mcp_servers.foo]\ns = """\n[mcp_servers.tycoon]\nkeepme\n"""\n');
});

test("uninstall: nested arrays inside our own table are dropped with it", () => {
  const text = `${S}\n[mcp_servers.tycoon]  # c\nargs = [\n  ["x"],\n]\n[mcp_servers.tycoon.env]\nA = "b"\n${E}\n`;
  assert.equal(removeDispatcherFromConfigToml(text), "");
});

test("uninstall: spaced and quoted header forms are ours; lookalike names are not", () => {
  const text = `${S}\n[ mcp_servers . tycoon ]\nc = 1\n["mcp_servers"."tycoon"]\nd = 1\n[mcp_servers.tycoon_x]\ne = 1\n[mcp_servers.tycoonfoo]\n[mcp_servers."tycoon"]\nz = 1\n[[mcp_servers.tycoon]]\n${E}\n`;
  assert.equal(removeDispatcherFromConfigToml(text), "[mcp_servers.tycoon_x]\ne = 1\n[mcp_servers.tycoonfoo]\n");
});

test("CRLF: uninstall keeps every line ending intact", () => {
  const text = `a = 1\r\n\r\n${S}\r\n[mcp_servers.tycoon]\r\ncommand="n"\r\n[mcp_servers.tycoon.tools.x]\r\napproval_mode="approve"\r\n[mcp_servers.blender]\r\ncommand="b"\r\n${E}\r\n`;
  assert.equal(removeDispatcherFromConfigToml(text), 'a = 1\r\n\r\n[mcp_servers.blender]\r\ncommand="b"\r\n');
});

test("CRLF: merge writes the block with CRLF, keeps approvals, no mixed endings, stable on re-run", () => {
  const text = `a = 1\r\n\r\n${S}\r\n[mcp_servers.tycoon]\r\ncommand="n"\r\n[mcp_servers.tycoon.tools.x]\r\napproval_mode="approve"\r\n[mcp_servers.blender]\r\ncommand="b"\r\n${E}\r\n`;
  const merged = mergeDispatcherIntoConfigToml(text, OPTS).text;
  assert.ok(!/(^|[^\r])\n/.test(merged), "lone LF found");
  assert.ok(merged.includes('[mcp_servers.tycoon.tools.x]\r\napproval_mode="approve"\r\n'));
  assert.ok(merged.includes('[mcp_servers.blender]\r\ncommand="b"\r\n'));
  assert.equal(mergeDispatcherIntoConfigToml(merged, OPTS).text, merged);
  const fresh = mergeDispatcherIntoConfigToml("a = 1\r\n", OPTS).text;
  assert.ok(!/(^|[^\r])\n/.test(fresh), "lone LF in fresh CRLF merge");
});

test("uninstall: reversed or single markers leave the file unchanged", () => {
  const reversed = `${E}\n[mcp_servers.tycoon]\nc = 1\n${S}\n`;
  assert.equal(removeDispatcherFromConfigToml(reversed), reversed);
  const single = `a = 1\n${S}\n[mcp_servers.tycoon]\nc = 1\n`;
  assert.equal(removeDispatcherFromConfigToml(single), single);
});

test("tomlScan: headers, continuation lines and EOL", () => {
  const text = 'a = """\n[x]\n"""\nb = [\n["y"],\n]\n[ t . "u" ]  # c\n[[arr.t]]\nc = 1\r\n';
  const lines = scanTomlLines(text);
  assert.deepEqual(
    lines.map((l) => l.header?.name ?? null),
    [null, null, null, null, null, null, "t.u", "arr.t", null],
  );
  assert.deepEqual(
    lines.map((l) => l.cont),
    [false, true, true, false, true, true, false, false, false],
  );
  assert.equal(lines[7].header?.array, true);
  assert.equal(text.slice(lines[8].start, lines[8].end), "c = 1");
  assert.equal(detectEol(text), "\r\n");
  assert.equal(detectEol("a\nb\n"), "\n");
  assert.equal(parseTableHeader("[1, 2]"), undefined);
});

import { detectCodexDispatcherState } from "../src/providers/codex/installCodexDispatcher";

test("detectCodexDispatcherState: none without a managed block; stale for a missing or other-version script; installed otherwise", () => {
  const ext = (v: string) => `C:/ext/tycoonagents.tycoonagents-${v}/hooks/tycoon-dispatcher-mcp.cjs`;
  const block = (script: string) => buildDispatcherBlock({ nodePath: "C:/node.exe", serverScriptPath: script }) + "\n";
  const all = () => true;
  assert.equal(detectCodexDispatcherState('model = "x"\n', ext("0.0.710"), all), "none");
  assert.equal(detectCodexDispatcherState(block(ext("0.0.710")), ext("0.0.710"), all), "installed");
  assert.equal(detectCodexDispatcherState(block(ext("0.0.710")), ext("0.0.710"), () => false), "stale");
  assert.equal(detectCodexDispatcherState(block(ext("0.0.709")), ext("0.0.710"), all), "stale", "other version folder");
  assert.equal(detectCodexDispatcherState(block(ext("0.0.709")), ext("0.0.710"), () => false), "stale", "missing file");
  assert.equal(detectCodexDispatcherState(block("D:/repo/hooks/tycoon-dispatcher-mcp.cjs"), ext("0.0.710"), all), "installed", "existing non-versioned path is left alone");
});

test("detectCodexDispatcherState: an existing NEWER extension version path is left alone; an older one is stale", () => {
  const ext = (v: string) => `C:/ext/tycoonagents.tycoonagents-${v}/hooks/tycoon-dispatcher-mcp.cjs`;
  const block = (script: string) => buildDispatcherBlock({ nodePath: "C:/node.exe", serverScriptPath: script }) + "\n";
  assert.equal(detectCodexDispatcherState(block(ext("0.0.711")), ext("0.0.710"), () => true), "installed");
  assert.equal(detectCodexDispatcherState(block(ext("0.0.711")), ext("0.0.710"), () => false), "stale", "newer but missing");
  assert.equal(detectCodexDispatcherState(block(ext("0.0.9")), ext("0.0.10"), () => true), "stale", "numeric compare, older");
  assert.equal(detectCodexDispatcherState(block(ext("0.0.100")), ext("0.0.99"), () => true), "installed", "numeric compare, newer");
});
