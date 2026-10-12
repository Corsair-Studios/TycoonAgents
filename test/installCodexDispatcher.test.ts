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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDispatcherBlock,
  mergeDispatcherIntoConfigToml,
  removeDispatcherFromConfigToml,
  isDispatcherMarkerInConfigToml,
  dispatcherEnvVarNames,
  unionEnvVarNames,
  readManagedEnvVars,
  installCodexDispatcher,
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
  assert.doesNotMatch(merged.text, /(CLAUDE_CLI_|OPENAI_COMPAT_|_API_KEY)[A-Z_]*\s*=/);
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

function forwardedNames(text: string): string[] {
  const m = /^env_vars = (\[.*\])$/m.exec(text);
  assert.ok(m, "env_vars line missing");
  return JSON.parse(m[1]);
}

function projectWithRouting(routing: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "tycoon-envvars-"));
  mkdirSync(join(dir, ".claude", "tycoon"), { recursive: true });
  writeFileSync(join(dir, ".claude", "tycoon", "routing.json"), JSON.stringify(routing), "utf8");
  return dir;
}

test("block: env_vars lists vendor key and URL names, names only", () => {
  const block = buildDispatcherBlock(OPTS);
  const names = forwardedNames(block);
  for (const n of ["MISTRAL_API_KEY", "XAI_API_KEY", "MOONSHOT_API_KEY", "GEMINI_API_KEY", "OPENAI_COMPAT_BASE_URL", "GEMINI_MCP_BACKEND", "CLAUDE_CLI_BIN", "TYCOON_NODE_PATH", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME"]) {
    assert.ok(names.includes(n), n);
  }
  assert.deepEqual(names, [...names].sort());
  assert.ok(block.includes('env = { TYCOON_CODEX_DISPATCHER_CONFIGURED = "1" }'));
  assert.ok(!/MISTRAL_API_KEY\s*=/.test(block));
});

test("dispatcherEnvVarNames: custom endpoint names from routing.json are included, denied names are not", () => {
  const dir = projectWithRouting({
    version: 1,
    agents: {
      a: { vendor: "custom", endpointEnv: "OLLAMA_BASE_URL", credentialEnv: "OLLAMA_API_KEY" },
      b: {
        vendor: "custom",
        endpointEnv: "bad-name",
        credentialEnv: "GITHUB_TOKEN",
        fallback: [{ vendor: "custom", endpointEnv: "GROQ_BASE_URL", credentialEnv: "AWS_SECRET_KEY" }],
      },
    },
  });
  try {
    const names = dispatcherEnvVarNames(dir, { env: { OLLAMA_BASE_URL: "http://localhost:11434/v1", GROQ_BASE_URL: "https://api.groq.com/openai/v1" }, hasStored: () => false });
    assert.ok(names.includes("OLLAMA_BASE_URL") && names.includes("OLLAMA_API_KEY"));
    assert.ok(names.includes("GROQ_BASE_URL"));
    assert.ok(!names.includes("GITHUB_TOKEN") && !names.includes("AWS_SECRET_KEY") && !names.includes("bad-name"));
    assert.ok(!dispatcherEnvVarNames().includes("OLLAMA_API_KEY"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectCodexDispatcherState: a block without env_vars, or missing a custom name, is stale", () => {
  const script = "/proj/hooks/tycoon-dispatcher-mcp.cjs";
  const exists = (): boolean => true;
  const current = buildDispatcherBlock(OPTS);
  assert.equal(detectCodexDispatcherState(current, script, exists), "installed");
  const old = current.split("\n").filter((l) => !l.startsWith("env_vars")).join("\n");
  assert.equal(detectCodexDispatcherState(old, script, exists), "stale");
  assert.equal(detectCodexDispatcherState(current, script, exists, [...dispatcherEnvVarNames(), "OLLAMA_BASE_URL"]), "stale");
});

test("merge: an old block without env_vars is rewritten with env_vars, once", () => {
  const old =
    'a = 1\n\n# tycoon-dispatcher: managed mcp server (do not edit by hand)\n[mcp_servers.tycoon]\ncommand = "/usr/bin/node"\nargs = ["/proj/hooks/tycoon-dispatcher-mcp.cjs"]\nenv = { TYCOON_CODEX_DISPATCHER_CONFIGURED = "1" }\n# tycoon-dispatcher: end managed mcp server\n';
  const merged = mergeDispatcherIntoConfigToml(old, OPTS);
  assert.ok(forwardedNames(merged.text).includes("MISTRAL_API_KEY"));
  assert.equal(merged.text.split("env_vars").length - 1, 1);
  assert.equal(mergeDispatcherIntoConfigToml(merged.text, OPTS).text, merged.text);
});

test("dispatcherEnvVarNames: OPENAI_API_KEY is never forwarded", () => {
  assert.ok(!dispatcherEnvVarNames().includes("OPENAI_API_KEY"));
});

test("dispatcherEnvVarNames: a repo-only or unpaired credential name is not forwarded", () => {
  const dir = projectWithRouting({
    version: 1,
    agents: {
      a: { vendor: "custom", endpointEnv: "OLLAMA_BASE_URL", credentialEnv: "TAVILY_API_KEY" },
      b: { vendor: "custom", credentialEnv: "SOLO_API_KEY" },
    },
  });
  try {
    // Endpoint not user-set: nothing from the project is forwarded.
    const none = dispatcherEnvVarNames(dir, { env: {}, hasStored: () => false });
    assert.ok(!none.includes("TAVILY_API_KEY") && !none.includes("OLLAMA_BASE_URL") && !none.includes("SOLO_API_KEY"));
    // Endpoint user-set: the paired credential follows, the unpaired one still does not.
    const paired = dispatcherEnvVarNames(dir, { env: { OLLAMA_BASE_URL: "http://localhost:1/v1" }, hasStored: () => false });
    assert.ok(paired.includes("OLLAMA_BASE_URL") && paired.includes("TAVILY_API_KEY"));
    assert.ok(!paired.includes("SOLO_API_KEY"));
    // User-set through the per-user store counts too.
    const stored = dispatcherEnvVarNames(dir, { env: {}, hasStored: (n) => n === "OLLAMA_BASE_URL" });
    assert.ok(stored.includes("OLLAMA_BASE_URL"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatcherEnvVarNames: an endpoint name declared in the project's .mcp.json is not forwarded", () => {
  const dir = projectWithRouting({
    version: 1,
    agents: { a: { vendor: "custom", endpointEnv: "OLLAMA_BASE_URL", credentialEnv: "OLLAMA_API_KEY" } },
  });
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { x: { command: "x", env: { OLLAMA_BASE_URL: "http://evil" } } } }), "utf8");
  try {
    const names = dispatcherEnvVarNames(dir, { env: { OLLAMA_BASE_URL: "http://localhost:1/v1" }, hasStored: () => true });
    assert.ok(!names.includes("OLLAMA_BASE_URL") && !names.includes("OLLAMA_API_KEY"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install: env_vars is the union across projects, so two windows do not rewrite each other", () => {
  const home = mkdtempSync(join(tmpdir(), "tycoon-codexhome-"));
  const mk = (endpoint: string, key: string): string =>
    projectWithRouting({ version: 1, agents: { a: { vendor: "custom", endpointEnv: endpoint, credentialEnv: key } } });
  const projA = mk("AAA_BASE_URL", "AAA_API_KEY");
  const projB = mk("BBB_BASE_URL", "BBB_API_KEY");
  const env = { CODEX_HOME: home, AAA_BASE_URL: "http://localhost:1/v1", BBB_BASE_URL: "http://localhost:2/v1" };
  const script = "/proj/hooks/tycoon-dispatcher-mcp.cjs";
  try {
    const result = installCodexDispatcher({ projectDir: projA, env, serverScriptPath: script, nodePath: "node" });
    installCodexDispatcher({ projectDir: projB, env, serverScriptPath: script, nodePath: "node" });
    const text = readFileSync(result.configTomlPath, "utf8");
    const written = readManagedEnvVars(text);
    for (const n of ["AAA_BASE_URL", "AAA_API_KEY", "BBB_BASE_URL", "BBB_API_KEY"]) assert.ok(written.includes(n), n);
    // Each project's expectation is a subset of what is written: neither sees it as stale.
    for (const dir of [projA, projB]) {
      assert.equal(detectCodexDispatcherState(text, script, () => true, dispatcherEnvVarNames(dir, { env, hasStored: () => false })), "installed");
    }
    installCodexDispatcher({ projectDir: projA, env, serverScriptPath: script, nodePath: "node" });
    assert.equal(readFileSync(result.configTomlPath, "utf8"), text);
  } finally {
    for (const d of [home, projA, projB]) rmSync(d, { recursive: true, force: true });
  }
});

test("unionEnvVarNames: capped at 200, base names kept, newly expected custom names win", () => {
  const old = Array.from({ length: 300 }, (_, i) => `OLD${i}_BASE_URL`);
  const merged = unionEnvVarNames(old, ["NEW_BASE_URL"]);
  assert.ok(merged.length <= 200);
  assert.ok(merged.includes("NEW_BASE_URL") && merged.includes("MISTRAL_API_KEY"));
});

test("installCodexDispatcher keeps an existing newer extension script path even when env_vars differ", () => {
  const base = mkdtempSync(join(tmpdir(), "disp-newer-"));
  const mk = (v: string) => {
    const d = join(base, "extensions", `tycoonagents.tycoonagents-${v}`, "hooks");
    mkdirSync(d, { recursive: true });
    const f = join(d, "tycoon-dispatcher-mcp.cjs");
    writeFileSync(f, "//\n");
    return f;
  };
  const newer = mk("0.0.711");
  const older = mk("0.0.710");
  const codexHome = join(base, "codex");
  mkdirSync(codexHome);
  const env = { CODEX_HOME: codexHome };
  installCodexDispatcher({ projectDir: base, env, platform: process.platform, serverScriptPath: newer, nodePath: "/usr/bin/node" });
  installCodexDispatcher({ projectDir: base, env, platform: process.platform, serverScriptPath: older, nodePath: "/usr/bin/node" });
  const toml = readFileSync(join(codexHome, "config.toml"), "utf8");
  assert.ok(toml.includes(JSON.stringify(newer)), "newer path kept");
  assert.ok(!toml.includes("0.0.710"));
  rmSync(base, { recursive: true, force: true });
});

test("writeFileAtomic leaves no temp file behind when the rename fails", async () => {
  const { writeFileAtomic } = await import("../src/providers/codex/tomlScan");
  const { readdirSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "atomic-"));
  const target = join(dir, "config.toml");
  mkdirSync(target); // rename onto a directory fails
  assert.throws(() => writeFileAtomic(target, "x"));
  assert.deepEqual(readdirSync(dir), ["config.toml"]);
  const ok = join(dir, "ok.toml");
  writeFileAtomic(ok, "hello");
  assert.equal(readFileSync(ok, "utf8"), "hello");
  rmSync(dir, { recursive: true, force: true });
});
