/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Relay review fixes: defaults never relay every agent, `tools:` allowlists, edited-relay backups,
// missing markers, BOM, invalid stored models, the opt-in codex-write server, and the dispatcher path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentMarkdownIsRelayManaged,
  convertToRelay,
  reconcileRelayDetailed,
  relayTargetFor,
  RELAY_ORIGINAL_BEGIN,
  type RelayTarget,
} from "../src/core/agentRelay";
import { saveRoutingProfile } from "../src/core/routingHostOps";
import { bridgeServersForRoutingProfile, profileUsesCodexWrite } from "../src/core/bridgeSetup";

const REPO_ROOT = process.cwd();
const BODY = "\n# Coding Specialist\n\n## Role\nImplements code.\n";

function agent(extra: string[] = [], model = "sonnet"): string {
  return `---\nname: coding-specialist\ndescription: "Implements code."\nmodel: ${model}\n${extra.map((l) => l + "\n").join("")}---\n${BODY}`;
}

const slot = (mcpServer: string) => ({ vendor: "openai", transport: "mcp", mcpServer, tools: ["codex", "codex-reply"], model: "openai/gpt-6.1-sol", costModelClass: "subscription" });
const target = (mcpServer: string): RelayTarget => relayTargetFor("coding-specialist", slot(mcpServer))!;

function project(content: string, id = "coding-specialist"): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-relay-review-"));
  const file = path.join(root, ".claude", "agents", `${id}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return { root, file };
}

function save(root: string, profile: Record<string, unknown>) {
  return saveRoutingProfile({ root, profile: { version: 1, ...profile }, scriptsDir: REPO_ROOT, effectiveHarness: "claude-code" });
}

const ANTHROPIC = { vendor: "anthropic", transport: "claude-native", model: "anthropic/sonnet", costModelClass: "subscription" };

test("a foreign defaults slot does not relay any agent", () => {
  const { root, file } = project(agent());
  const original = fs.readFileSync(file, "utf8");
  const r = save(root, { defaults: slot("codex"), agents: {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!agentMarkdownIsRelayManaged(fs.readFileSync(file, "utf8")));
  assert.match(fs.readFileSync(file, "utf8"), /^model: sonnet$/m);
  // An agent entry that carries no vendor of its own (the vendor comes from defaults) stays native too.
  assert.equal(save(root, { defaults: slot("codex"), agents: { "coding-specialist": { model: "openai/gpt-6.1-sol" } } }).ok, true);
  assert.ok(!agentMarkdownIsRelayManaged(fs.readFileSync(file, "utf8")));
  assert.ok(fs.readFileSync(file, "utf8").endsWith(original.slice(original.indexOf("\n---\n") + 5)));
});

test("a relayed agent reverts when its vendor now comes only from defaults", () => {
  const { root, file } = project(agent());
  assert.equal(save(root, { agents: { "coding-specialist": slot("codex") } }).ok, true);
  assert.ok(agentMarkdownIsRelayManaged(fs.readFileSync(file, "utf8")));
  assert.equal(save(root, { defaults: slot("codex"), agents: { "coding-specialist": { model: "openai/gpt-6.1-sol" } } }).ok, true);
  assert.ok(!agentMarkdownIsRelayManaged(fs.readFileSync(file, "utf8")));
});

test("a tools allowlist gains the relay's tools and is restored exactly", () => {
  const original = agent(["tools: Read, Grep"]);
  const propose = convertToRelay(original, target("codex"))!;
  const toolsLine = /^tools: (.*)$/m.exec(propose)![1];
  for (const t of ["Read", "Grep", "mcp__codex__codex", "mcp__tycoon__delegate", "Edit", "Write"]) assert.ok(toolsLine.includes(t), `${t} in ${toolsLine}`);
  assert.match(propose, /^tycoon_relay_original_tools: Read, Grep$/m);
  assert.equal(reconcileRelayDetailed(propose, null).content, original);

  const write = convertToRelay(agent(["tools: [Read]"]), target("codex-write"))!;
  const writeTools = /^tools: (.*)$/m.exec(write)![1];
  assert.ok(writeTools.includes("mcp__codex-write__codex"));
  assert.ok(!writeTools.includes("Edit"), "workspace mode does not add Edit");
  assert.equal(reconcileRelayDetailed(write, null).content, agent(["tools: [Read]"]));

  // A vendor switch recomputes the widened line from the stored original.
  const switched = reconcileRelayDetailed(propose, { target: relayTargetFor("coding-specialist", { vendor: "google", transport: "mcp", mcpServer: "gemini", tools: ["ask-gemini"], model: "google/gemini-2.5-pro" })! }).content;
  assert.match(/^tools: (.*)$/m.exec(switched)![1], /mcp__gemini__ask-gemini/);
  assert.ok(!/^tools: (.*)$/m.exec(switched)![1].includes("mcp__codex__codex"));
  assert.equal(reconcileRelayDetailed(switched, null).content, original);
});

test("an edited relay is backed up before it is restored, with a notice", () => {
  const original = agent();
  const relayed = convertToRelay(original, target("codex"))!;
  const at = relayed.indexOf("<!-- tycoon:relay-original:begin -->");
  const edited = relayed.slice(0, at) + relayed.slice(at).replace("# Coding Specialist", "# Coding Specialist (my edit outside the markers)");
  const withHeading = edited.replace("## Original instructions (kept for revert, not forwarded)", "## Role instructions to forward to the provider (changed)");
  const r = reconcileRelayDetailed(withHeading, null, { agentId: "coding-specialist" });
  assert.equal(r.content, original.replace("# Coding Specialist", "# Coding Specialist (my edit outside the markers)"));
  assert.equal(r.backup, withHeading);
  assert.match(r.notices.join("\n"), /coding-specialist\.md\.relay-backup/);
  // An untouched relay needs no backup.
  assert.equal(reconcileRelayDetailed(relayed, null).backup, undefined);
});

test("Save writes <id>.md.relay-backup for an edited relay and reports it in the result", () => {
  const { root, file } = project(agent());
  assert.equal(save(root, { agents: { "coding-specialist": slot("codex") } }).ok, true);
  const relayed = fs.readFileSync(file, "utf8");
  const edited = relayed.replace("Do not do the task yourself", "Please do the task yourself");
  assert.notEqual(edited, relayed);
  fs.writeFileSync(file, edited, "utf8");
  const r = save(root, { agents: { "coding-specialist": ANTHROPIC } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!agentMarkdownIsRelayManaged(fs.readFileSync(file, "utf8")));
  assert.equal(fs.readFileSync(`${file}.relay-backup`, "utf8"), edited);
  assert.ok((r.relayNotices ?? []).some((n) => n.includes("coding-specialist.md.relay-backup")), JSON.stringify(r.relayNotices));
});

test("missing markers are reported in the save result and the file is not silently stuck", () => {
  const { root, file } = project(agent());
  assert.equal(save(root, { agents: { "coding-specialist": slot("codex") } }).ok, true);
  const broken = fs.readFileSync(file, "utf8").split(RELAY_ORIGINAL_BEGIN).join("");
  fs.writeFileSync(file, broken, "utf8");
  const r = save(root, { agents: { "coding-specialist": ANTHROPIC } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fs.readFileSync(file, "utf8").includes("tycoon_relay"), true, "left as it is, never half-restored");
  assert.ok((r.relayNotices ?? []).some((n) => /markers are missing/.test(n) && n.includes("coding-specialist")), JSON.stringify(r.relayNotices));
});

test("a BOM is stripped for conversion and restored on revert", () => {
  const original = "﻿" + agent();
  const relayed = convertToRelay(original, target("codex"))!;
  assert.ok(relayed.startsWith("﻿---"));
  assert.ok(agentMarkdownIsRelayManaged(relayed));
  assert.equal(reconcileRelayDetailed(relayed, null).content, original);
  const { root, file } = project(original);
  assert.equal(save(root, { agents: { "coding-specialist": slot("codex") } }).ok, true);
  const onDisk = fs.readFileSync(file, "utf8");
  assert.ok(onDisk.startsWith("﻿---") && agentMarkdownIsRelayManaged(onDisk));
  assert.equal(save(root, { agents: { "coding-specialist": ANTHROPIC } }).ok, true);
  const back = fs.readFileSync(file, "utf8");
  assert.ok(back.startsWith("﻿---"));
  assert.ok(back.endsWith(BODY));
});

test("a stored original model that is not a Claude model falls back to the catalog default", () => {
  const relayed = convertToRelay(agent([], "openai/gpt-6.1-sol"), target("codex"))!;
  const r = reconcileRelayDetailed(relayed, null, { agentId: "coding-specialist", fallbackModel: "sonnet" });
  assert.match(r.content, /^model: sonnet$/m);
  assert.match(r.notices.join("\n"), /openai\/gpt-6\.1-sol/);
  // A valid pinned Claude id and an alias are restored as they were.
  assert.match(reconcileRelayDetailed(convertToRelay(agent([], "claude-opus-4-7"), target("codex"))!, null).content, /^model: claude-opus-4-7$/m);
  assert.match(reconcileRelayDetailed(convertToRelay(agent([], "opus[1m]"), target("codex"))!, null).content, /^model: opus\[1m\]$/m);
  // Through Save: the catalog default for coding-specialist.
  const { root, file } = project(agent());
  assert.equal(save(root, { agents: { "coding-specialist": slot("codex") } }).ok, true);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^tycoon_relay_original_model: .*$/m, "tycoon_relay_original_model: gpt-bogus"), "utf8");
  assert.equal(save(root, { agents: { "coding-specialist": ANTHROPIC } }).ok, true);
  assert.match(fs.readFileSync(file, "utf8"), /^model: sonnet$/m);
});

test("codex-write is registered only when ticked and the unused check sees it go away", () => {
  const readOnly = { agents: { "coding-specialist": slot("codex") } };
  const write = { agents: { "coding-specialist": slot("codex-write") } };
  assert.deepEqual(bridgeServersForRoutingProfile(readOnly, null), ["codex"]);
  assert.deepEqual(bridgeServersForRoutingProfile(write, null), ["codex-write"]);
  assert.deepEqual(bridgeServersForRoutingProfile(write, write), [], "an unchanged slot registers nothing");
  assert.deepEqual(bridgeServersForRoutingProfile(readOnly, write), ["codex"], "unticking switches back to the read-only server");
  assert.equal(profileUsesCodexWrite(write), true);
  assert.equal(profileUsesCodexWrite(readOnly), false);
  assert.equal(profileUsesCodexWrite({ agents: {} }), false);
  const catalog = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "media", "mcp", "catalog.json"), "utf8")) as Array<{ id: string; hidden?: boolean; config: { args: string[] } }>;
  const ro = catalog.find((c) => c.id === "codex")!;
  const rw = catalog.find((c) => c.id === "codex-write")!;
  assert.equal(rw.hidden, true);
  assert.ok(ro.config.args.includes('sandbox_mode="read-only"'), "the read-only entry is unchanged");
  assert.ok(rw.config.args.includes('sandbox_mode="workspace-write"'));
  assert.ok(rw.config.args.includes('approval_policy="never"'));
  assert.deepEqual(rw.config.args.filter((a) => !a.startsWith("sandbox_mode")), ro.config.args.filter((a) => !a.startsWith("sandbox_mode")));
});

test("Save relays to codex-write when ticked and the stage shows its MCP call and the dispatcher call in the provider color", () => {
  const { root, file } = project(agent());
  assert.equal(save(root, { agents: { "coding-specialist": slot("codex-write") } }).ok, true);
  const relayed = fs.readFileSync(file, "utf8");
  assert.match(relayed, /^tycoon_relay: codex-write$/m);
  assert.ok(relayed.includes("mcp__codex-write__codex"));
  assert.match(relayed, /the provider makes any file changes itself|The provider makes any file changes itself/);

  const hookDir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-relay-hook2-"));
  const hookPath = path.join(hookDir, "tycoon-claude-hook.cjs");
  fs.copyFileSync(path.join(REPO_ROOT, "hooks", "tycoon-claude-hook.cjs"), hookPath);
  for (const f of ["agentBackend.js", "modelAliases.js"]) fs.copyFileSync(path.join(REPO_ROOT, "out", "src", "core", f), path.join(hookDir, f));
  const run = (tool: string, input: Record<string, unknown>) => {
    const res = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, session_id: "s-" + tool }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(res.status, 0, res.stderr);
  };
  run("mcp__codex-write__codex", { model: "gpt-6.1-sol", prompt: "x" });
  run("mcp__tycoon__delegate", { specialist: "coding-specialist", task: "x" });
  const records = fs.readFileSync(path.join(root, ".claude", "tycoon", "activity.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const direct = records.find((r) => r.tool === "mcp__codex-write__codex");
  assert.equal(direct.vendor, "openai");
  assert.equal(direct.model, "gpt-6.1-sol");
  const viaDispatcher = records.find((r) => r.tool === "mcp__tycoon__delegate");
  assert.equal(viaDispatcher.vendor, "openai", "the dispatcher call carries the specialist's provider");
  assert.equal(viaDispatcher.model, "openai/gpt-6.1-sol");
  assert.equal(viaDispatcher.costModelClass, "subscription");
});
