/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Parallel subagents must keep their own identity (feedback ticket #37): the first
 * sighting of an agent_id binds to the unbound stack entry whose agentId matches the
 * payload's agent_type, instead of guessing stack order. Without agent_type the old
 * guess is unchanged.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToRelay, relayTargetFor } from "../src/core/agentRelay";

const HOOK_PATH = join(process.cwd(), "hooks", "tycoon-claude-hook.cjs");
const SESSION = "parallel-session";

interface Entry { agentId: string; instanceId?: string; [k: string]: unknown }

const ORIGINAL = "---\nname: artist\ndescription: \"Makes art.\"\nmodel: sonnet\n---\n\n# Artist\n\n## Role\nArt.\n";
const WRITE_TARGET = relayTargetFor("artist", { vendor: "openai", transport: "mcp", mcpServer: "codex-write", tools: ["codex"], model: "openai/gpt-6.1-sol" })!;

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "tycoon-parallel-bind-"));
  const agents = join(root, ".claude", "agents");
  mkdirSync(agents, { recursive: true });
  mkdirSync(join(root, ".claude", "tycoon"), { recursive: true });
  writeFileSync(join(agents, "artist.md"), convertToRelay(ORIGINAL, WRITE_TARGET)!);
  for (const id of ["coding-specialist", "ux-ui-designer"]) {
    writeFileSync(join(agents, `${id}.md`), `---\nname: ${id}\ndescription: x\nmodel: sonnet\n---\nBody.\n`);
  }
  return root;
}

function seed(root: string, ids: string[]): void {
  const stack = ids.map((agentId) => ({ agentId, model: "sonnet", timestamp: Date.now(), subagentType: agentId }));
  writeFileSync(
    join(root, ".claude", "tycoon", "active-agent.json"),
    JSON.stringify({ version: 1, agentId: ids[ids.length - 1], timestamp: Date.now(), stack }),
  );
}

function run(root: string, payload: Record<string, unknown>): string {
  const r = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ session_id: SESSION, ...payload }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(r.status, 0, `hook exited non-zero: ${r.stderr}`);
  return r.stdout;
}

const pre = (tool: string, id: string, type?: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: tool,
  tool_input: { file_path: "x.txt" },
  agent_id: id,
  ...(type ? { agent_type: type } : {}),
});

function denied(out: string): boolean {
  return out.trim() !== "" && (JSON.parse(out) as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision === "deny";
}

function stackOf(root: string): Entry[] {
  return (JSON.parse(readFileSync(join(root, ".claude", "tycoon", "active-agent.json"), "utf8")) as { stack: Entry[] }).stack;
}

function calls(root: string): Array<{ tool?: string; workerId?: string; event?: string }> {
  const f = join(root, ".claude", "tycoon", "activity.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("three parallel spawns: each agent_id binds to its own agent regardless of first-sighting order", () => {
  const root = setup();
  try {
    seed(root, ["artist", "coding-specialist", "ux-ui-designer"]);
    run(root, pre("Read", "id-code", "coding-specialist"));
    run(root, pre("Read", "id-ux", "ux-ui-designer"));
    run(root, pre("Read", "id-art", "artist"));
    const by = Object.fromEntries(stackOf(root).map((e) => [e.agentId, e.instanceId]));
    assert.deepEqual(by, { artist: "id-art", "coding-specialist": "id-code", "ux-ui-designer": "id-ux" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coding-specialist Edit and Bash are allowed while the artist's Edit is still denied", () => {
  const root = setup();
  try {
    seed(root, ["artist", "coding-specialist", "ux-ui-designer"]);
    assert.equal(denied(run(root, pre("Edit", "id-code", "coding-specialist"))), false);
    assert.equal(denied(run(root, pre("Bash", "id-code", "coding-specialist"))), false);
    assert.equal(denied(run(root, pre("Edit", "id-ux", "ux-ui-designer"))), false);
    assert.equal(denied(run(root, pre("Edit", "id-art", "artist"))), true);
    assert.equal(denied(run(root, pre("Bash", "id-art", "artist"))), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the artist's mcp__codex-write call is attributed to the artist", () => {
  const root = setup();
  try {
    seed(root, ["artist", "coding-specialist", "ux-ui-designer"]);
    run(root, pre("Read", "id-code", "coding-specialist"));
    run(root, pre("mcp__codex-write__codex", "id-art", "artist"));
    const rec = calls(root).find((r) => r.event === "PreToolUse" && r.tool === "mcp__codex-write__codex");
    assert.ok(rec);
    assert.equal(rec!.workerId, "artist");
    const code = calls(root).find((r) => r.event === "PreToolUse" && r.tool === "Read");
    assert.equal(code!.workerId, "coding-specialist");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without agent_type the old binding is unchanged: ambiguous first sighting binds the stack-top unbound entry", () => {
  const root = setup();
  try {
    seed(root, ["artist", "coding-specialist", "ux-ui-designer"]);
    run(root, pre("Read", "id-code"));
    const by = Object.fromEntries(stackOf(root).map((e) => [e.agentId, e.instanceId]));
    assert.equal(by["ux-ui-designer"], "id-code");
    assert.equal(by["artist"], undefined);
    assert.equal(by["coding-specialist"], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unmatched agent_type falls back to the old stack-top guess", () => {
  const root = setup();
  try {
    seed(root, ["artist", "coding-specialist", "ux-ui-designer"]);
    run(root, pre("Read", "id-x", "general-purpose"));
    assert.equal(stackOf(root).find((e) => e.agentId === "ux-ui-designer")!.instanceId, "id-x");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent_type general-purpose on an artist stack entry: relay deny and the no-provider-call warning still apply", () => {
  const root = setup();
  try {
    seed(root, ["artist"]);
    assert.equal(denied(run(root, pre("Edit", "id-art", "general-purpose"))), true);
    assert.equal(denied(run(root, pre("Bash", "id-art", "general-purpose"))), true);
    run(root, { hook_event_name: "SubagentStop", agent_id: "id-art", agent_type: "general-purpose" });
    const rec = calls(root).find((r) => (r as { kind?: string }).kind === "relay_no_provider_call");
    assert.ok(rec, "relay_no_provider_call must be recorded");
    assert.equal(rec!.workerId, "artist");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent_type coding-specialist wins over a stack entry bound to artist (its file exists)", () => {
  const root = setup();
  try {
    seed(root, ["artist"]);
    assert.equal(denied(run(root, pre("Edit", "id-code", "coding-specialist"))), false);
    assert.equal(denied(run(root, pre("Bash", "id-code", "coding-specialist"))), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent_type Explore binds to a search-retrieval stack entry", () => {
  const root = setup();
  try {
    seed(root, ["search-retrieval", "coding-specialist", "ux-ui-designer"]);
    run(root, pre("Read", "id-ex", "Explore"));
    assert.equal(stackOf(root).find((e) => e.agentId === "search-retrieval")!.instanceId, "id-ex");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
