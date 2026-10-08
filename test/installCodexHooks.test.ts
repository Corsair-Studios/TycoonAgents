/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Tests src/providers/codex/installCodexHooks.ts: install writes/merges a
// managed notify block into CODEX_HOME/config.toml and a marked
// .codex/hooks.json in the project, leaving .claude/settings*.json and
// opencode config untouched (criterion 2), and uninstall removes only
// what install added (criterion 3), per plan p22-t3's acceptance criteria.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installCodexHooks,
  uninstallCodexHooks,
  resolveCodexHome,
  mergeNotifyIntoConfigToml,
  detectCodexNotifyState,
  removeNotifyFromConfigToml,
  buildHooksJson,
  buildHookCommand,
  CODEX_HOOK_EVENTS,
} from "../src/providers/codex/installCodexHooks";

function setupDirs(): { codexHome: string; projectDir: string } {
  const base = mkdtempSync(join(tmpdir(), "tycoon-codex-install-test-"));
  const codexHome = join(base, "home", ".codex");
  const projectDir = join(base, "project");
  mkdirSync(projectDir, { recursive: true });
  return { codexHome, projectDir };
}

test("(a) resolveCodexHome: CODEX_HOME env override wins outright; falls back to HOME/.codex otherwise", () => {
  const viaOverride = resolveCodexHome({ env: { CODEX_HOME: "/explicit/override" } });
  assert.equal(viaOverride.codexHome, "/explicit/override");

  const viaHome = resolveCodexHome({ env: { HOME: "/home/someone" } });
  assert.equal(viaHome.codexHome, join("/home/someone", ".codex"));

  assert.throws(() => resolveCodexHome({ env: {} }));
});

test("(b) installCodexHooks writes a notify block to config.toml and hooks.json with all 12 events, and never touches .claude or opencode config", () => {
  const { codexHome, projectDir } = setupDirs();
  // Simulate pre-existing sibling config the installer must leave alone.
  const claudeSettingsPath = join(projectDir, ".claude", "settings.local.json");
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  const claudeSettingsContent = JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [] }] } }, null, 2);
  writeFileSync(claudeSettingsPath, claudeSettingsContent, "utf8");
  const opencodeConfigPath = join(projectDir, "opencode.json");
  const opencodeContent = JSON.stringify({ plugin: ["./tycoon-opencode-plugin"] }, null, 2);
  writeFileSync(opencodeConfigPath, opencodeContent, "utf8");

  const hookScriptPath = join(projectDir, "hooks", "tycoon-codex-hook.cjs");

  const result = installCodexHooks({
    projectDir,
    hookScriptPath,
    env: { CODEX_HOME: codexHome },
    nodePath: "node",
  });

  assert.ok(existsSync(result.configTomlPath));
  const tomlContent = readFileSync(result.configTomlPath, "utf8");
  assert.match(tomlContent, /notify = \["node", ".*tycoon-codex-hook\.cjs"\]/);

  assert.ok(existsSync(result.hooksJsonPath));
  const hooksJson = JSON.parse(readFileSync(result.hooksJsonPath, "utf8"));
  assert.equal(hooksJson.description, "tycoon-codex-hook: managed by TycoonAgents (do not edit by hand)");
  assert.deepEqual(Object.keys(hooksJson).sort(), ["description", "hooks"]);
  for (const event of CODEX_HOOK_EVENTS) {
    assert.ok(hooksJson.hooks[event], `hooks.json missing event ${event}`);
    assert.deepEqual(hooksJson.hooks[event].command, ["node", hookScriptPath]);
  }

  // Byte-identical sibling configs (criterion 2).
  assert.equal(readFileSync(claudeSettingsPath, "utf8"), claudeSettingsContent);
  assert.equal(readFileSync(opencodeConfigPath, "utf8"), opencodeContent);
});

test("(c) installCodexHooks is idempotent: re-running replaces the managed block instead of duplicating it, preserving unrelated config.toml content", () => {
  const { codexHome, projectDir } = setupDirs();
  mkdirSync(codexHome, { recursive: true });
  const configTomlPath = join(codexHome, "config.toml");
  writeFileSync(configTomlPath, '[windows]\nsandbox = "elevated"\n', "utf8");

  const hookScriptPath = join(projectDir, "hooks", "tycoon-codex-hook.cjs");
  installCodexHooks({ projectDir, hookScriptPath, env: { CODEX_HOME: codexHome } });
  installCodexHooks({ projectDir, hookScriptPath, env: { CODEX_HOME: codexHome } });

  const content = readFileSync(configTomlPath, "utf8");
  const occurrences = content.split("notify = ").length - 1;
  assert.equal(occurrences, 1, "re-install must not duplicate the notify line");
  assert.match(content, /sandbox = "elevated"/);
});

test("(d) uninstallCodexHooks removes only the managed notify block and the marked hooks.json, leaving unrelated content intact", () => {
  const { codexHome, projectDir } = setupDirs();
  mkdirSync(codexHome, { recursive: true });
  const configTomlPath = join(codexHome, "config.toml");
  writeFileSync(configTomlPath, '[windows]\nsandbox = "elevated"\n', "utf8");

  const hookScriptPath = join(projectDir, "hooks", "tycoon-codex-hook.cjs");
  installCodexHooks({ projectDir, hookScriptPath, env: { CODEX_HOME: codexHome } });

  uninstallCodexHooks({ projectDir, env: { CODEX_HOME: codexHome } });

  const remainingToml = readFileSync(configTomlPath, "utf8");
  assert.ok(!remainingToml.includes("notify ="));
  assert.match(remainingToml, /sandbox = "elevated"/);

  const hooksJsonPath = join(projectDir, ".codex", "hooks.json");
  assert.equal(existsSync(hooksJsonPath), false);
});

test("(e) uninstallCodexHooks never deletes a foreign/unmarked .codex/hooks.json whose keys we don't own", () => {
  const { codexHome, projectDir } = setupDirs();
  const dotCodexDir = join(projectDir, ".codex");
  mkdirSync(dotCodexDir, { recursive: true });
  const hooksJsonPath = join(dotCodexDir, "hooks.json");
  const foreignContent = JSON.stringify({ hooks: { some_other_tool_event: { command: ["echo", "not ours"] } } }, null, 2);
  writeFileSync(hooksJsonPath, foreignContent, "utf8");

  uninstallCodexHooks({ projectDir, env: { CODEX_HOME: codexHome } });

  assert.equal(existsSync(hooksJsonPath), true);
  assert.equal(readFileSync(hooksJsonPath, "utf8"), foreignContent);
});

test("(e2) uninstallCodexHooks strips only our owned event keys from a foreign hooks.json that happens to reuse one of our event names, leaving the rest intact", () => {
  const { codexHome, projectDir } = setupDirs();
  const dotCodexDir = join(projectDir, ".codex");
  mkdirSync(dotCodexDir, { recursive: true });
  const hooksJsonPath = join(dotCodexDir, "hooks.json");
  const foreignContent = JSON.stringify(
    { hooks: { stop: { command: ["echo", "not ours"] }, some_other_tool_event: { command: ["echo", "keep"] } } },
    null,
    2,
  );
  writeFileSync(hooksJsonPath, foreignContent, "utf8");

  uninstallCodexHooks({ projectDir, env: { CODEX_HOME: codexHome } });

  assert.equal(existsSync(hooksJsonPath), true);
  const remaining = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
  assert.equal(remaining.hooks.stop, undefined);
  assert.deepEqual(remaining.hooks.some_other_tool_event.command, ["echo", "keep"]);
});

test("(e3) installCodexHooks merging: existing hooks.json with a foreign description and non-owned event key is preserved, only our event keys are merged in, and a warning is returned", () => {
  const { codexHome, projectDir } = setupDirs();
  const dotCodexDir = join(projectDir, ".codex");
  mkdirSync(dotCodexDir, { recursive: true });
  const hooksJsonPath = join(dotCodexDir, "hooks.json");
  writeFileSync(
    hooksJsonPath,
    JSON.stringify(
      { description: "some other tool's config", hooks: { some_other_tool_event: { command: ["echo", "keep"] } } },
      null,
      2,
    ),
    "utf8",
  );

  const hookScriptPath = join(projectDir, "hooks", "tycoon-codex-hook.cjs");
  const result = installCodexHooks({ projectDir, hookScriptPath, env: { CODEX_HOME: codexHome }, nodePath: "node" });

  assert.ok(result.warnings && result.warnings.length > 0);
  const written = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
  assert.equal(written.description, "some other tool's config");
  assert.deepEqual(written.hooks.some_other_tool_event.command, ["echo", "keep"]);
  for (const event of CODEX_HOOK_EVENTS) {
    assert.deepEqual(written.hooks[event].command, ["node", hookScriptPath]);
  }
});

test("(n) buildHookCommand defaults nodePath to process.execPath (absolute node binary), not the bare string 'node'", () => {
  const cmd = buildHookCommand("/abs/hook.cjs");
  assert.deepEqual(cmd, [process.execPath, "/abs/hook.cjs"]);
  assert.notEqual(cmd[0], "node");
});

test("(o) installCodexHooks defaults nodePath to process.execPath end to end when no override is given", () => {
  const { codexHome, projectDir } = setupDirs();
  const hookScriptPath = join(projectDir, "hooks", "tycoon-codex-hook.cjs");
  const result = installCodexHooks({ projectDir, hookScriptPath, env: { CODEX_HOME: codexHome } });
  const tomlContent = readFileSync(result.configTomlPath, "utf8");
  assert.ok(tomlContent.includes(JSON.stringify(process.execPath)), "notify entry should carry the absolute node executable path");
  const hooksJson = JSON.parse(readFileSync(result.hooksJsonPath, "utf8"));
  assert.deepEqual(hooksJson.hooks.stop.command, [process.execPath, hookScriptPath]);
});

/**
 * Minimal TOML basic-string decoder for `notify = ["...", "..."]` lines,
 * handling exactly the escapes JSON.stringify (used by tomlStringArray) can
 * produce for a Windows path: `\\` and `\"`. Not a general TOML parser.
 */
function decodeNotifyArgv(tomlText: string): string[] {
  const m = /^notify = \[(.*)\]$/m.exec(tomlText);
  assert.ok(m, "expected a notify = [...] line");
  const inner = m![1];
  const strRe = /"((?:\\.|[^"\\])*)"/g;
  const out: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = strRe.exec(inner))) {
    out.push(sm[1].replace(/\\\\/g, "\\").replace(/\\"/g, '"'));
  }
  return out;
}

test("(r) mergeNotifyIntoConfigToml round-trips a Windows-style node path with backslashes and a space", () => {
  const hookScriptPath = "D:\\hook.cjs";
  const nodePath = "C:\\Program Files\\nodejs\\node.exe";
  const merged = mergeNotifyIntoConfigToml(undefined, hookScriptPath, nodePath);
  const decoded = decodeNotifyArgv(merged.text);
  assert.deepEqual(decoded, [nodePath, hookScriptPath]);
});

test("(p) uninstallCodexHooks still matches and removes a notify block written with the old bare 'node' form", () => {
  const { codexHome, projectDir } = setupDirs();
  mkdirSync(codexHome, { recursive: true });
  const configTomlPath = join(codexHome, "config.toml");
  const hookScriptPath = join(projectDir, "hooks", "tycoon-codex-hook.cjs");
  const oldStyle = mergeNotifyIntoConfigToml(undefined, hookScriptPath, "node");
  writeFileSync(configTomlPath, oldStyle.text, "utf8");

  uninstallCodexHooks({ projectDir, env: { CODEX_HOME: codexHome } });

  const remaining = readFileSync(configTomlPath, "utf8");
  assert.equal(remaining.includes("notify ="), false);
});

test("(f) mergeNotifyIntoConfigToml / removeNotifyFromConfigToml round-trip on undefined (fresh file) input", () => {
  const merged = mergeNotifyIntoConfigToml(undefined, "/abs/path/hook.cjs", "node");
  assert.match(merged.text, /notify = \["node", "\/abs\/path\/hook\.cjs"\]/);
  assert.equal(merged.warnings, undefined);
  const removed = removeNotifyFromConfigToml(merged.text);
  assert.equal(removed.includes("notify ="), false);
});

test("(h) mergeNotifyIntoConfigToml inserts the managed block before the first table header, not at end-of-file", () => {
  const original =
    '[windows]\nsandbox = "elevated"\n\n' + "[projects.'d:\\\\acode\\\\tycoonagents']\ntrust_level = \"trusted\"\n";
  const merged = mergeNotifyIntoConfigToml(original, "D:\\hook.cjs");
  assert.equal(merged.warnings, undefined);

  const lines = merged.text.split("\n");
  const notifyLineIdx = lines.findIndex((l) => l.startsWith("notify ="));
  const firstHeaderIdx = lines.findIndex((l) => /^\s*\[/.test(l));
  assert.ok(notifyLineIdx !== -1, "notify line must exist");
  assert.ok(firstHeaderIdx !== -1, "a table header must exist");
  assert.ok(
    notifyLineIdx < firstHeaderIdx,
    `notify (line ${notifyLineIdx}) must come before the first table header (line ${firstHeaderIdx})`,
  );

  // Original tables and their content are preserved byte-for-byte in order.
  assert.match(merged.text, /\[windows\]\nsandbox = "elevated"/);
  assert.match(merged.text, /\[projects\.'d:\\\\acode\\\\tycoonagents'\]\ntrust_level = "trusted"/);
});

test("(i) mergeNotifyIntoConfigToml is idempotent when tables are present: re-merge replaces the block in place, still before the first header", () => {
  const original = "[windows]\nsandbox = \"elevated\"\n";
  const first = mergeNotifyIntoConfigToml(original, "D:\\hook.cjs");
  const second = mergeNotifyIntoConfigToml(first.text, "D:\\hook.cjs");

  const occurrences = second.text.split("notify = ").length - 1;
  assert.equal(occurrences, 1, "re-merge must not duplicate the notify line");
  const lines = second.text.split("\n");
  const notifyLineIdx = lines.findIndex((l) => l.startsWith("notify ="));
  const firstHeaderIdx = lines.findIndex((l) => /^\s*\[/.test(l));
  assert.ok(notifyLineIdx < firstHeaderIdx);
  assert.match(second.text, /sandbox = "elevated"/);
});

test("(j) removeNotifyFromConfigToml removes an old-style end-of-file managed block and restores original bytes", () => {
  const original = '[windows]\nsandbox = "elevated"\n';
  const oldStyleAppended =
    original.trimEnd() +
    "\n\n# tycoon-codex-hook: managed notify entry (do not edit by hand)\n" +
    'notify = ["node", "D:\\\\hook.cjs"]\n' +
    "# tycoon-codex-hook: end managed notify entry\n";
  const removed = removeNotifyFromConfigToml(oldStyleAppended);
  assert.equal(removed.includes("notify ="), false);
  assert.match(removed, /sandbox = "elevated"/);
});

test("(k) removeNotifyFromConfigToml removes the new top-level-placed managed block and restores original bytes", () => {
  const original = '[windows]\nsandbox = "elevated"\n';
  const merged = mergeNotifyIntoConfigToml(original, "D:\\hook.cjs");
  const removed = removeNotifyFromConfigToml(merged.text);
  assert.equal(removed, original);
});

test("(l) mergeNotifyIntoConfigToml leaves a pre-existing foreign top-level notify untouched and reports a conflict warning", () => {
  const original = 'notify = ["echo", "foreign"]\n\n[windows]\nsandbox = "elevated"\n';
  const merged = mergeNotifyIntoConfigToml(original, "D:\\hook.cjs");
  assert.ok(merged.warnings && merged.warnings.length > 0, "expected a warning for the foreign notify conflict");
  assert.match(merged.text, /notify = \["echo", "foreign"\]/);
  assert.equal(merged.text.includes("tycoon-codex-hook"), false);
  assert.match(merged.text, /sandbox = "elevated"/);
});

test("(m) mergeNotifyIntoConfigToml handles empty/undefined existing config", () => {
  const fromUndefined = mergeNotifyIntoConfigToml(undefined, "/abs/hook.cjs", "node");
  assert.match(fromUndefined.text, /notify = \["node", "\/abs\/hook\.cjs"\]/);

  const fromEmpty = mergeNotifyIntoConfigToml("", "/abs/hook.cjs", "node");
  assert.match(fromEmpty.text, /notify = \["node", "\/abs\/hook\.cjs"\]/);
});

test("(g) buildHooksJson covers exactly the 12 documented event names", () => {
  const built = buildHooksJson("/abs/hook.cjs");
  assert.equal(Object.keys(built.hooks).length, 12);
  assert.deepEqual(Object.keys(built.hooks).sort(), [...CODEX_HOOK_EVENTS].sort());
});

test("(q) the written hooks.json's top-level keys are exactly `description` and `hooks` — codex-cli 0.153.0 rejects any other top-level field", () => {
  const { codexHome, projectDir } = setupDirs();
  const hookScriptPath = join(projectDir, "hooks", "tycoon-codex-hook.cjs");
  const result = installCodexHooks({ projectDir, hookScriptPath, env: { CODEX_HOME: codexHome } });
  const written = JSON.parse(readFileSync(result.hooksJsonPath, "utf8"));
  assert.deepEqual(Object.keys(written).sort(), ["description", "hooks"]);
});

// Computer-use style wrapper: another tool moved our notify into its own
// notify argv, passing ours as a JSON-encoded --previous-notify argument.
function wrapperNotify(embeddedArgv: string[]): string {
  const previous = JSON.stringify(JSON.stringify(embeddedArgv));
  return `notify = [ "C:\\\\tools\\\\codex-computer-use.exe", "turn-ended", "--previous-notify", ${previous} ]`;
}
const WRAPPER_MARKERS =
  "# tycoon-codex-hook: managed notify entry (do not edit by hand)\n# tycoon-codex-hook: end managed notify entry";
const CURRENT_HOOK = "C:\\ext\\hooks\\tycoon-codex-hook.cjs";

test("(w1) wrapped notify with the current hook path is kept as-is (empty markers removed) and reports wrapped", () => {
  const body = `${WRAPPER_MARKERS}\n${wrapperNotify(["node", CURRENT_HOOK])}\n\n[windows]\nsandbox = "elevated"\n`;
  const merged = mergeNotifyIntoConfigToml(body, CURRENT_HOOK, "node");
  assert.equal(merged.warnings, undefined);
  assert.ok(!merged.text.includes("tycoon-codex-hook: managed"));
  assert.ok(merged.text.includes(wrapperNotify(["node", CURRENT_HOOK])));
  assert.equal(detectCodexNotifyState(merged.text, CURRENT_HOOK), "wrapped");
  assert.equal((merged.text.match(/^notify\s*=/gm) ?? []).length, 1);
});

test("(w2) wrapped notify with a stale hook path is rewritten inside --previous-notify only, and is idempotent", () => {
  const stale = "D:\\ACode\\TycoonAgents\\hooks\\tycoon-codex-hook.cjs";
  const original = `${WRAPPER_MARKERS}\n${wrapperNotify(["node", stale])}\n\n[windows]\nsandbox = "elevated"\n`;
  assert.equal(detectCodexNotifyState(original, CURRENT_HOOK), "stale-wrapped");
  const first = mergeNotifyIntoConfigToml(original, CURRENT_HOOK, "node");
  assert.ok(first.text.includes(wrapperNotify(["node", CURRENT_HOOK])));
  assert.ok(!first.text.includes("ACode"));
  assert.ok(first.text.includes('[windows]\nsandbox = "elevated"'));
  assert.equal(detectCodexNotifyState(first.text, CURRENT_HOOK), "wrapped");
  const second = mergeNotifyIntoConfigToml(first.text, CURRENT_HOOK, "node");
  assert.equal(second.text, first.text);
});

test("(w3) the literal computer-use wrapper string keeps its other elements and yields valid TOML escaping", () => {
  const exact = String.raw`notify = [ "C:\\Users\\x\\codex-computer-use.exe", "turn-ended", "--previous-notify", "[\"node\",\"D:\\\\ACode\\\\TycoonAgents\\\\hooks\\\\tycoon-codex-hook.cjs\"]" ]` + "\n";
  assert.equal(detectCodexNotifyState(exact, CURRENT_HOOK), "stale-wrapped");
  const merged = mergeNotifyIntoConfigToml(exact, CURRENT_HOOK, "node");
  const head = String.raw`notify = [ "C:\\Users\\x\\codex-computer-use.exe", "turn-ended", "--previous-notify", `;
  assert.ok(merged.text.startsWith(head));
  assert.ok(merged.text.endsWith(" ]\n"));
  const encoded = merged.text.slice(head.length, merged.text.length - " ]\n".length);
  assert.deepEqual(JSON.parse(JSON.parse(encoded)), ["node", CURRENT_HOOK]);
});

test("(w4) foreign notify without our hook is blocked: skipped with a warning, file unchanged", () => {
  const original = 'notify = [ "other.exe", "--previous-notify", "[\\"node\\",\\"/x/other-hook.cjs\\"]" ]\n';
  assert.equal(detectCodexNotifyState(original, CURRENT_HOOK), "blocked");
  const merged = mergeNotifyIntoConfigToml(original, CURRENT_HOOK, "node");
  assert.ok(merged.warnings && merged.warnings.length > 0);
  assert.equal(merged.text, original);
});

test("(w5) detectCodexNotifyState reports installed for our block and none for no notify", () => {
  const fresh = mergeNotifyIntoConfigToml(undefined, CURRENT_HOOK, "node").text;
  assert.equal(detectCodexNotifyState(fresh, CURRENT_HOOK), "installed");
  assert.equal(detectCodexNotifyState('model = "x"\n', CURRENT_HOOK), "none");
});

test("(w6) uninstallCodexHooks leaves a wrapper untouched and returns a plain-words warning", () => {
  const { codexHome, projectDir } = setupDirs();
  mkdirSync(codexHome, { recursive: true });
  const configPath = join(codexHome, "config.toml");
  const original = `${wrapperNotify(["node", CURRENT_HOOK])}\n`;
  writeFileSync(configPath, original, "utf8");
  const result = uninstallCodexHooks({ projectDir, env: { CODEX_HOME: codexHome } });
  assert.equal(readFileSync(configPath, "utf8"), original);
  assert.ok(result.warnings && /another tool/i.test(result.warnings[0]));
  rmSync(join(codexHome, ".."), { recursive: true, force: true });
});

test("(w7) other tables stranded between the notify markers survive merge and removal", () => {
  const reordered = [
    "# tycoon-codex-hook: managed notify entry (do not edit by hand)",
    "[mcp_servers.blender]",
    'command = "blender-mcp"',
    "# tycoon-codex-hook: end managed notify entry",
    "",
  ].join("\n");
  const removed = removeNotifyFromConfigToml(reordered);
  assert.ok(removed.includes('[mcp_servers.blender]\ncommand = "blender-mcp"'));
  assert.ok(!removed.includes("tycoon-codex-hook:"));
  const merged = mergeNotifyIntoConfigToml(reordered, CURRENT_HOOK, "node");
  assert.ok(merged.text.includes('[mcp_servers.blender]\ncommand = "blender-mcp"'));
  assert.equal(merged.text.split("tycoon-codex-hook: managed").length - 1, 1);
  assert.equal(mergeNotifyIntoConfigToml(merged.text, CURRENT_HOOK, "node").text, merged.text);
});

const NS = "# tycoon-codex-hook: managed notify entry (do not edit by hand)";
const NE = "# tycoon-codex-hook: end managed notify entry";

test("(w8) notify keys inside tables between the markers are never touched", () => {
  const text = `${NS}\nnotify = ["n"]\n[foo]\nnotify = "keep"\n${NE}\n`;
  assert.equal(removeNotifyFromConfigToml(text), '[foo]\nnotify = "keep"\n');
});

test("(w9) a multi-line notify array inside the markers is removed whole; sibling keys survive", () => {
  const text = `${NS}\nnotify = [\n"node",\n"x"\n]\nmodel = "gpt"\n${NE}\n[a]\nb = 1\n`;
  assert.equal(removeNotifyFromConfigToml(text), 'model = "gpt"\n[a]\nb = 1\n');
  const merged = mergeNotifyIntoConfigToml(text, CURRENT_HOOK, "node");
  assert.ok(merged.text.includes('model = "gpt"\n'));
  assert.ok(!merged.text.includes('"x"'));
  assert.equal(merged.text.split(NS).length - 1, 1);
  assert.equal(mergeNotifyIntoConfigToml(merged.text, CURRENT_HOOK, "node").text, merged.text);
});

test("(w10) CRLF: notify removal and merge keep line endings consistent", () => {
  const text = `a = 1\r\n${NS}\r\nnotify = ["n"]\r\n${NE}\r\n[t]\r\n`;
  assert.equal(removeNotifyFromConfigToml(text), "a = 1\r\n\r\n[t]\r\n");
  const merged = mergeNotifyIntoConfigToml("a = 1\r\n[t]\r\nx = 1\r\n", CURRENT_HOOK, "node").text;
  assert.ok(!/(^|[^\r])\n/.test(merged), "lone LF found");
});

test("(w11) header-like lines inside a multi-line value do not end the top-level section", () => {
  const text = 'long = [\n["a"],\n]\nnotify = ["other.exe"]\n[t]\nx = 1\n';
  assert.equal(detectCodexNotifyState(text, CURRENT_HOOK), "blocked");
  const merged = mergeNotifyIntoConfigToml(text, CURRENT_HOOK, "node");
  assert.equal(merged.text, text);
});
