/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Managed relay agents: a normal agent whose routing slot names a bridged
// foreign provider becomes a relay on the Claude Code harness (src/core/
// agentRelay.ts, driven by scripts/apply-routing-profile.mjs --relay), and
// reverts exactly when the slot goes back to Anthropic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentMarkdownIsRelayManaged,
  buildRelayBody,
  convertToRelay,
  reconcileRelay,
  relayTargetFor,
  RELAY_ORIGINAL_BEGIN,
  RELAY_ORIGINAL_END,
  RELAY_SECTION_BEGIN,
  RELAY_SECTION_END,
  type RelayTarget,
} from "../src/core/agentRelay";
import { saveRoutingProfile } from "../src/core/routingHostOps";
import { setOpencodeAvailableForTests } from "../src/core/providerSelection";
import {
  healForeignWrapperModel,
  healLegacyOfficeAgentsFrontmatter,
  healSupersededAgentTitle,
  resyncAgentDisciplineSection,
  resyncAgentFrontmatterFields,
  resyncAgentRoleSection,
  REGULAR_AGENTS,
} from "../src/host/vscode/packCatalog";

const REPO_ROOT = process.cwd();

const ORIGINAL_BODY =
  "\n# Coding Specialist\n\n<!-- OfficeAgents Core Agent -->\n\n## Role\nImplements code.\n\n## Keywords (for task routing)\nimplement|code|fix\n\n## Working discipline\nDo the work.\n";

function agentFile(eol = "\n", model = "sonnet"): string {
  const fm = ["name: coding-specialist", 'description: "Implements code."', `model: ${model}`, "disallowedTools: Agent", "tycoon_pack: worker"];
  return `---${eol}${fm.join(eol)}${eol}---${eol}${ORIGINAL_BODY.replace(/\n/g, eol)}`;
}

const CODEX: RelayTarget = relayTargetFor("coding-specialist", {
  vendor: "openai",
  transport: "mcp",
  mcpServer: "codex",
  tools: ["codex", "codex-reply"],
  model: "openai/gpt-6.1-sol",
})!;

const CODEX_WRITE: RelayTarget = relayTargetFor("coding-specialist", {
  vendor: "openai",
  transport: "mcp",
  mcpServer: "codex-write",
  tools: ["codex", "codex-reply"],
  model: "openai/gpt-6.1-sol",
})!;

const GEMINI: RelayTarget = relayTargetFor("coding-specialist", {
  vendor: "google",
  transport: "mcp",
  mcpServer: "gemini",
  tools: ["ask-gemini"],
  model: "google/gemini-2.5-pro",
})!;

test("relayTargetFor only accepts a bridged non-Anthropic backend", () => {
  assert.ok(CODEX);
  assert.equal(CODEX.kind, "text-only");
  assert.equal(CODEX_WRITE.kind, "workspace");
  assert.equal(GEMINI.kind, "text-only");
  assert.equal(relayTargetFor("a", { vendor: "anthropic", transport: "claude-native", model: "anthropic/sonnet" }), null);
  assert.equal(relayTargetFor("a", { vendor: "anthropic", transport: "mcp", mcpServer: "claude-cli", tools: ["claude"], model: "anthropic/sonnet" }), null);
  assert.equal(relayTargetFor("a", { vendor: "openai", transport: "claude-native", model: "openai/gpt-6.1-sol" }), null);
  const compat = relayTargetFor("a", { vendor: "moonshot", transport: "openai-compatible", model: "moonshot/kimi-k2" });
  assert.equal(compat?.server, "openai-compatible");
  assert.equal(compat?.kind, "text-only");
});

for (const eol of ["\n", "\r\n"]) {
  test(`convert then revert gives the byte-identical original (${JSON.stringify(eol)})`, () => {
    const original = agentFile(eol);
    const relayed = convertToRelay(original, CODEX)!;
    assert.ok(agentMarkdownIsRelayManaged(relayed));
    assert.match(relayed, /^model: haiku$/m);
    assert.match(relayed, /^tycoon_relay: codex$/m);
    assert.match(relayed, /^tycoon_relay_original_model: sonnet$/m);
    assert.match(relayed, /^disallowedTools: Agent$/m);
    assert.ok(relayed.includes("## Relay (managed by TycoonAgents)"));
    assert.ok(relayed.includes("## Role instructions to forward to the provider"));
    assert.ok(relayed.includes(ORIGINAL_BODY.replace(/\n/g, eol)), "original body is kept verbatim inside the markers");
    assert.equal(reconcileRelay(relayed, null), original);
  });
}

test("revert restores a missing model line and an agent without a trailing newline", () => {
  const original = "---\nname: x\ndescription: d\n---\nNo trailing newline";
  const relayed = convertToRelay(original, CODEX)!;
  assert.match(relayed, /^model: haiku$/m);
  assert.equal(reconcileRelay(relayed, null), original);
});

test("vendor switch regenerates only the relay section", () => {
  const original = agentFile();
  const codexRelay = convertToRelay(original, CODEX)!;
  const geminiRelay = reconcileRelay(codexRelay, { target: GEMINI });
  assert.notEqual(geminiRelay, codexRelay);
  assert.match(geminiRelay, /^tycoon_relay: gemini$/m);
  assert.match(geminiRelay, /^tycoon_relay_original_model: sonnet$/m);
  assert.match(geminiRelay, /^model: haiku$/m);
  const strip = (t: string) => t.slice(t.indexOf(RELAY_SECTION_END) + RELAY_SECTION_END.length);
  assert.equal(strip(geminiRelay), strip(codexRelay), "everything after the relay section is untouched");
  assert.equal(geminiRelay.slice(geminiRelay.indexOf(RELAY_ORIGINAL_BEGIN)), codexRelay.slice(codexRelay.indexOf(RELAY_ORIGINAL_BEGIN)));
  assert.ok(geminiRelay.includes("mcp__gemini__ask-gemini"));
  assert.ok(!geminiRelay.includes("mcp__codex__codex"));
  // Regenerating with the same target is a no-op, and the original still reverts exactly.
  assert.equal(reconcileRelay(geminiRelay, { target: GEMINI }), geminiRelay);
  assert.equal(reconcileRelay(geminiRelay, null), original);
});

test("a hand-written relay agent is never converted", () => {
  const bridge = "---\nname: codex-reviewer\nmodel: haiku\n---\n<!-- wrapper-class: relay - forwards -->\n\n## Role\nReviews.\n";
  assert.equal(reconcileRelay(bridge, { target: CODEX }), bridge);
  assert.equal(reconcileRelay(agentFile(), { target: CODEX, skipConversion: true }), agentFile());
});

test("heals and resyncs do not touch a relay file", () => {
  const relayed = convertToRelay(agentFile(), CODEX)!;
  const agent = REGULAR_AGENTS.find((a) => a.id === "coding-specialist")!;
  assert.equal(resyncAgentFrontmatterFields(relayed, agent), null);
  assert.equal(resyncAgentRoleSection(relayed, "A brand new role line."), null);
  assert.equal(resyncAgentDisciplineSection(relayed), relayed);
  assert.equal(healLegacyOfficeAgentsFrontmatter(relayed, "coding-specialist", "d"), null);
  assert.equal(healSupersededAgentTitle(relayed, { id: "coding-specialist", name: "Coding Specialist" }), null);
  assert.equal(healForeignWrapperModel(relayed.replace("model: haiku", "model: openai/gpt-6.1-sol"), "sonnet"), null);
});

test("the codex relay passes the slot model and never sandbox or approval overrides", () => {
  const body = buildRelayBody(CODEX);
  assert.ok(body.includes("mcp__codex__codex"));
  assert.ok(body.includes('`model`: `"gpt-6.1-sol"`'), "bare slot model id");
  assert.ok(body.includes("`cwd`"));
  assert.ok(body.includes("mcp__tycoon__delegate"));
  assert.ok(body.includes('specialist: "coding-specialist"'));
  assert.match(body, /Do NOT pass `sandbox`, `approval-policy`/);
  assert.doesNotMatch(body, /sandbox: "|approval-policy: "|sandbox_mode|approval_policy|danger-full-access|workspace-write/);
  assert.match(body, /Do not modify any files/);
  assert.match(body, /unified diff/);
  assert.match(body, /which file and hunk failed/);
  const writeBody = buildRelayBody(CODEX_WRITE);
  assert.ok(writeBody.includes("mcp__codex-write__codex"));
  assert.match(writeBody, /Do NOT pass `sandbox`, `approval-policy`/);
  assert.match(writeBody, /never retry with a wider sandbox or looser approval/);
  assert.doesNotMatch(writeBody, /sandbox: "|approval-policy: "|workspace-write|danger-full-access/);
  assert.match(body, /provider-unavailable/);
  assert.match(body, /under 250 words/);
});

test("the text-only relay keeps Edit and applies the proposed edits itself", () => {
  const body = buildRelayBody(GEMINI);
  assert.match(body, /apply them yourself with Edit and Write exactly as proposed/);
  assert.match(body, /no extra reasoning/);
  assert.match(body, /`model`: `"gemini-2.5-pro"`/);
  const relayed = convertToRelay(agentFile(), GEMINI)!;
  assert.doesNotMatch(relayed, /^disallowedTools:.*\b(Edit|Write|Read)\b/m, "Read, Edit and Write stay available");
  assert.match(buildRelayBody(CODEX), /apply them yourself/, "propose mode keeps Edit");
  assert.doesNotMatch(buildRelayBody(CODEX_WRITE), /apply them yourself/);
});

function tmpProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-relay-save-"));
  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  return root;
}

function save(root: string, agents: Record<string, unknown>, harness = "claude-code") {
  return saveRoutingProfile({ root, profile: { version: 1, agents }, scriptsDir: REPO_ROOT, effectiveHarness: harness });
}

const CODEX_SLOT = { vendor: "openai", transport: "mcp", mcpServer: "codex", tools: ["codex", "codex-reply"], model: "openai/gpt-6.1-sol", costModelClass: "subscription" };

test("Save on Claude Code relays the agent and a later Anthropic Save restores its body and model", () => {
  const root = tmpProject();
  const file = path.join(root, ".claude", "agents", "coding-specialist.md");
  const original = agentFile();
  fs.writeFileSync(file, original, "utf8");

  const r1 = save(root, { "coding-specialist": CODEX_SLOT });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const relayed = fs.readFileSync(file, "utf8");
  assert.ok(agentMarkdownIsRelayManaged(relayed));
  assert.match(relayed, /^model: haiku$/m);
  assert.match(relayed, /^backend:$/m);
  assert.match(relayed, /^ {2}vendor: openai$/m);
  assert.ok(relayed.includes(ORIGINAL_BODY));
  // Idempotent.
  assert.equal(save(root, { "coding-specialist": CODEX_SLOT }).ok, true);
  assert.equal(fs.readFileSync(file, "utf8"), relayed);

  // Vendor switch regenerates the relay section only.
  const r2 = save(root, { "coding-specialist": { vendor: "google", transport: "mcp", mcpServer: "gemini", tools: ["ask-gemini"], model: "google/gemini-2.5-pro", costModelClass: "metered" } });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const switched = fs.readFileSync(file, "utf8");
  assert.match(switched, /^tycoon_relay: gemini$/m);
  assert.ok(switched.includes("mcp__gemini__ask-gemini"));
  assert.ok(switched.slice(switched.indexOf(RELAY_ORIGINAL_BEGIN)) === relayed.slice(relayed.indexOf(RELAY_ORIGINAL_BEGIN)));

  // Back to Anthropic: body and model restored exactly.
  const r3 = save(root, { "coding-specialist": { vendor: "anthropic", transport: "claude-native", model: "anthropic/sonnet", costModelClass: "subscription" } });
  assert.equal(r3.ok, true, JSON.stringify(r3));
  const restored = fs.readFileSync(file, "utf8");
  assert.ok(!agentMarkdownIsRelayManaged(restored));
  assert.ok(!restored.includes("tycoon:relay"));
  assert.match(restored, /^model: sonnet$/m);
  assert.ok(restored.endsWith(ORIGINAL_BODY), "body restored byte-identical");
});

test("Unticking the provider (slot removed) and clearing the profile both restore the agent", () => {
  const root = tmpProject();
  const file = path.join(root, ".claude", "agents", "coding-specialist.md");
  const original = agentFile();
  fs.writeFileSync(file, original, "utf8");
  assert.equal(save(root, { "coding-specialist": CODEX_SLOT }).ok, true);
  assert.ok(agentMarkdownIsRelayManaged(fs.readFileSync(file, "utf8")));
  assert.equal(save(root, {}).ok, true);
  assert.equal(fs.readFileSync(file, "utf8"), original, "an empty profile unapplies the relay and the managed backend block");
});

test("codex and opencode harnesses keep the dispatcher behaviour and never relay", () => {
  setOpencodeAvailableForTests(true);
  try {
    for (const harness of ["codex", "opencode"]) {
      const root = tmpProject();
      const file = path.join(root, ".claude", "agents", "coding-specialist.md");
      fs.writeFileSync(file, agentFile(), "utf8");
      save(root, { "coding-specialist": CODEX_SLOT }, harness);
      assert.ok(!agentMarkdownIsRelayManaged(fs.readFileSync(file, "utf8")), harness);
    }
  } finally {
    setOpencodeAvailableForTests(undefined);
  }
});

test("a hand-written bridge agent keeps its body when its slot is saved", () => {
  const root = tmpProject();
  const file = path.join(root, ".claude", "agents", "codex-reviewer.md");
  const text = "---\nname: codex-reviewer\nmodel: haiku\nbackend:\n  vendor: openai\n  transport: mcp\n  mcpServer: codex\n  tools: [codex, codex-reply]\n  model: openai/gpt-6.1-sol\n  costModelClass: subscription\n---\n<!-- wrapper-class: relay - forwards -->\n\n## Role\nReviews.\n";
  fs.writeFileSync(file, text, "utf8");
  assert.equal(save(root, { "codex-reviewer": CODEX_SLOT }).ok, true);
  const after = fs.readFileSync(file, "utf8");
  assert.ok(!agentMarkdownIsRelayManaged(after));
  assert.ok(after.endsWith("<!-- wrapper-class: relay - forwards -->\n\n## Role\nReviews.\n"));
});

test("the hook shows a relay's codex MCP call with the provider vendor and model (light blue)", () => {
  const root = tmpProject();
  const file = path.join(root, ".claude", "agents", "coding-specialist.md");
  fs.writeFileSync(file, agentFile(), "utf8");
  assert.equal(save(root, { "coding-specialist": CODEX_SLOT }).ok, true);
  const hookDir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-relay-hook-"));
  const hookPath = path.join(hookDir, "tycoon-claude-hook.cjs");
  fs.copyFileSync(path.join(REPO_ROOT, "hooks", "tycoon-claude-hook.cjs"), hookPath);
  for (const f of ["agentBackend.js", "modelAliases.js"]) fs.copyFileSync(path.join(REPO_ROOT, "out", "src", "core", f), path.join(hookDir, f));
  const run = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "mcp__codex__codex", tool_input: { model: "gpt-6.1-sol", prompt: "x" }, session_id: "relay-session" }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(run.status, 0, run.stderr);
  const lines = fs.readFileSync(path.join(root, ".claude", "tycoon", "activity.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const rec = lines.find((r) => r.event === "PreToolUse" && r.tool === "mcp__codex__codex");
  assert.ok(rec);
  assert.equal(rec.vendor, "openai");
  assert.equal(rec.model, "gpt-6.1-sol");
  assert.equal(rec.costModelClass, "subscription");
});

test("section markers exist exactly once in a relay file", () => {
  const relayed = convertToRelay(agentFile(), CODEX)!;
  for (const m of [RELAY_SECTION_BEGIN, RELAY_SECTION_END, RELAY_ORIGINAL_BEGIN, RELAY_ORIGINAL_END]) {
    assert.equal(relayed.split(m).length - 1, 1, m);
  }
});
