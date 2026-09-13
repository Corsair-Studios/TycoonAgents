/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for three attribution defects diagnosed by two independent Codex
// cross-vendor reviews of hooks/tycoon-claude-hook.cjs (see
// .wip/codex-verdict-8dfff87.md), reproduced live as swapped SubagentStop
// reports between two concurrent general-purpose/sonnet workers:
//
//   1. resolveNonSpawnAgent's instanceId bind (~line 641) must be atomic —
//      read, prune, decide, and write-back inside ONE held lock. Previously
//      the lock was released between read (readAndPruneActiveStack) and
//      write (writeActiveStack), so two racing first-sightings could both
//      bind to the same unbound entry, permanently mis-binding a UUID.
//   2. popMatchedAgent (~line 413) must accept an instanceId and pop the
//      exact matching entry ahead of transcript-keyword/subagentType/LIFO
//      heuristics. The SubagentStop call site (~line 875) never passed one
//      at all, so two same-type concurrent workers were indistinguishable
//      at Stop time — this is the actual swapped-reports regression.
//   3. Orphan-entry TTL (readAndPruneActiveStack, ~line 566) must key off a
//      `lastSeen` field refreshed on every resolved call, falling back to
//      `timestamp` only when lastSeen is absent — so a long-running worker
//      that is still actively making tool calls is never evicted mid-turn.
//
// Driven the same way as test/tycoonClaudeHookSpawn.test.ts and
// test/tycoonClaudeHookAgentOverride.test.ts: spawn the hook as a child
// process, pipe a JSON hook payload on stdin, and inspect the
// activity.jsonl / active-agent.json it writes under a scratch
// CLAUDE_PROJECT_DIR. Time is controlled by writing explicit
// timestamp/lastSeen values into a fixture active-agent.json, never by
// waiting on real clocks.
//
// This file owns ONLY test/ — it does not and must not edit
// hooks/tycoon-claude-hook.cjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK_PATH = join(process.cwd(), "hooks", "tycoon-claude-hook.cjs");

interface ActivityRecord {
  event: string;
  workerId?: string;
  instanceId?: string;
  tool?: string;
  at?: number;
  [key: string]: unknown;
}

interface StackEntry {
  agentId: string;
  model?: string;
  timestamp: number;
  subagentType?: string;
  parentId?: string;
  instanceId?: string;
  lastSeen?: number;
  [key: string]: unknown;
}

interface ActiveAgentFile {
  version: number;
  agentId: string;
  timestamp: number;
  stack: StackEntry[];
}

function runHook(projectRoot: string, payload: Record<string, unknown>): void {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
  });
  assert.equal(result.status, 0, `hook exited non-zero: ${result.stderr}`);
}

function activeAgentPath(projectRoot: string): string {
  return join(projectRoot, ".claude", "tycoon", "active-agent.json");
}

function activityPath(projectRoot: string): string {
  return join(projectRoot, ".claude", "tycoon", "activity.jsonl");
}

function readActiveAgent(projectRoot: string): ActiveAgentFile {
  return JSON.parse(readFileSync(activeAgentPath(projectRoot), "utf8")) as ActiveAgentFile;
}

function readActivity(projectRoot: string): ActivityRecord[] {
  const raw = readFileSync(activityPath(projectRoot), "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ActivityRecord);
}

function setupProject(): string {
  const root = mkdtempSync(join(tmpdir(), "tycoon-hook-attribution-test-"));
  const agentsDir = join(root, ".claude", "agents");
  const tycoonDir = join(root, ".claude", "tycoon");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(tycoonDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "coding-specialist.md"),
    "---\ndescription: Implements code.\nmodel: sonnet\n---\nBody.\n",
    "utf8",
  );
  writeFileSync(
    join(agentsDir, "search-retrieval.md"),
    "---\ndescription: Search and retrieval.\nmodel: haiku\n---\nBody.\n",
    "utf8",
  );
  return root;
}

// Seed active-agent.json directly with a specific stack, bypassing the Task
// spawn path entirely — this is what lets us pin exact timestamp/lastSeen
// values and multi-entry stack shapes deterministically instead of racing
// real spawns.
function seedStack(projectRoot: string, stack: StackEntry[]): void {
  const file: ActiveAgentFile = {
    version: 1,
    agentId: stack.length > 0 ? stack[stack.length - 1].agentId : "none",
    timestamp: Date.now(),
    stack,
  };
  writeFileSync(activeAgentPath(projectRoot), JSON.stringify(file, null, 2), "utf8");
}

function preToolUseWithAgentId(tool: string, agentId: string, sessionId = "attr-session"): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: {},
    agent_id: agentId,
    session_id: sessionId,
  };
}

function subagentStopWithAgentId(subagentType: string, agentId: string, sessionId = "attr-session"): Record<string, unknown> {
  return {
    hook_event_name: "SubagentStop",
    tool_input: { subagent_type: subagentType },
    agent_id: agentId,
    session_id: sessionId,
  };
}

// ---------------------------------------------------------------------------
// Contract 1: atomic instanceId bind (resolveNonSpawnAgent)
// ---------------------------------------------------------------------------

test("Contract 1: a tool call carrying agent_id binds to the correct entry, and a second call with the same agent_id resolves to that SAME entry even with an unbound sibling above it", () => {
  const root = setupProject();
  try {
    // Two siblings on the stack: bottom = worker-a (unbound), top = worker-b
    // (unbound). worker-a's first call must bind to worker-a, not to
    // stack-top worker-b — and its second call must resolve to the SAME
    // entry it bound on the first call, not re-derive from stack position.
    seedStack(root, [
      { agentId: "coding-specialist", model: "sonnet", timestamp: Date.now(), subagentType: "coding-specialist" },
      { agentId: "search-retrieval", model: "haiku", timestamp: Date.now(), subagentType: "search-retrieval" },
    ]);

    // Bind worker-a's instance by first exhausting the ambiguous-unbound
    // case for worker-b's sibling: bind search-retrieval's instance first so
    // only ONE unbound entry (coding-specialist) remains when worker-a calls.
    runHook(root, preToolUseWithAgentId("Read", "uuid-b"));
    let stack = readActiveAgent(root).stack;
    const boundToB = stack.find((e) => e.instanceId === "uuid-b");
    assert.ok(boundToB, "uuid-b must be bound to some entry");

    // Now the only unbound entry left is coding-specialist -> worker-a's
    // first call must bind unambiguously to it.
    runHook(root, preToolUseWithAgentId("Edit", "uuid-a"));
    stack = readActiveAgent(root).stack;
    const entryA = stack.find((e) => e.agentId === "coding-specialist");
    assert.equal(entryA?.instanceId, "uuid-a", "coding-specialist must be bound to uuid-a");

    // Second call from the SAME instance (uuid-a) must resolve to the SAME
    // entry (coding-specialist) by exact instanceId match, not stack-top.
    runHook(root, preToolUseWithAgentId("Bash", "uuid-a"));
    const records = readActivity(root);
    const calls = records.filter((r) => r.event === "PreToolUse" && (r.tool === "Edit" || r.tool === "Bash"));
    assert.equal(calls.length, 2);
    for (const rec of calls) {
      assert.equal(rec.workerId, "coding-specialist", `call for uuid-a must resolve to coding-specialist, got ${rec.workerId}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Contract 1: two calls with DIFFERENT agent_ids against two unbound siblings must bind to two DIFFERENT entries, never both to the same one", () => {
  const root = setupProject();
  try {
    seedStack(root, [
      { agentId: "coding-specialist", model: "sonnet", timestamp: Date.now(), subagentType: "coding-specialist" },
      { agentId: "search-retrieval", model: "haiku", timestamp: Date.now(), subagentType: "search-retrieval" },
    ]);

    // First call from instance uuid-1: with two unbound siblings this is the
    // genuinely ambiguous case (falls back to stack-top per the documented
    // case 3), so it binds to whichever entry is on top.
    runHook(root, preToolUseWithAgentId("Read", "uuid-1"));
    let stack = readActiveAgent(root).stack;
    const boundTo1 = stack.find((e) => e.instanceId === "uuid-1");
    assert.ok(boundTo1, "uuid-1 must be bound to some entry after its first call");

    // Second call from a DIFFERENT instance uuid-2: exactly one unbound
    // entry remains now, so it must bind unambiguously to THAT entry, not
    // the one uuid-1 already claimed.
    runHook(root, preToolUseWithAgentId("Read", "uuid-2"));
    stack = readActiveAgent(root).stack;
    const boundTo2 = stack.find((e) => e.instanceId === "uuid-2");
    assert.ok(boundTo2, "uuid-2 must be bound to some entry after its first call");

    assert.notEqual(
      boundTo1!.agentId + "|" + (boundTo1 === boundTo2 ? "same" : "diff"),
      boundTo1!.agentId + "|same",
      "sanity: comparing entry identity, not agentId string",
    );
    assert.notStrictEqual(boundTo1, boundTo2, "uuid-1 and uuid-2 must be bound to two DIFFERENT stack entries");

    const records = readActivity(root);
    const call1 = records.find((r) => r.event === "PreToolUse" && r.at !== undefined && r.instanceId === undefined);
    // workerId attribution: the two calls' recorded workerId must differ,
    // proving they resolved to different entries (not both to stack-top).
    const preToolUseRecords = records.filter((r) => r.event === "PreToolUse");
    assert.equal(preToolUseRecords.length, 2);
    assert.notEqual(
      preToolUseRecords[0].workerId,
      preToolUseRecords[1].workerId,
      "the two differently-instanced calls must attribute to two different workerIds",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Contract 1: a call with NO agent_id still resolves via legacy stack-top and does not throw", () => {
  const root = setupProject();
  try {
    seedStack(root, [
      { agentId: "coding-specialist", model: "sonnet", timestamp: Date.now(), subagentType: "coding-specialist" },
    ]);
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: {},
        session_id: "attr-session",
        // no agent_id field at all
      }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(result.status, 0, `hook must not throw/crash on missing agent_id: ${result.stderr}`);
    const records = readActivity(root);
    const rec = records.find((r) => r.event === "PreToolUse" && r.tool === "Read");
    assert.ok(rec, "expected a PreToolUse record");
    assert.equal(rec!.workerId, "coding-specialist", "must resolve via legacy stack-top when no agent_id is present");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Contract 2: SubagentStop pops by instanceId
// ---------------------------------------------------------------------------

test("Contract 2 (SWAPPED-REPORTS REGRESSION): two same-subagentType same-model concurrent entries — SubagentStop carrying the BOTTOM entry's agent_id pops the BOTTOM entry, leaving the top one on the stack", () => {
  const root = setupProject();
  try {
    // Both entries share subagentType AND model — the exact condition under
    // which the old transcript-keyword/subagentType/LIFO heuristics in
    // popMatchedAgent cannot tell them apart and popped the wrong one.
    seedStack(root, [
      {
        agentId: "coding-specialist",
        model: "sonnet",
        timestamp: Date.now() - 5000,
        subagentType: "general-purpose",
        instanceId: "uuid-bottom",
      },
      {
        agentId: "coding-specialist",
        model: "sonnet",
        timestamp: Date.now(),
        subagentType: "general-purpose",
        instanceId: "uuid-top",
      },
    ]);

    runHook(root, subagentStopWithAgentId("general-purpose", "uuid-bottom"));

    const stack = readActiveAgent(root).stack;
    assert.equal(stack.length, 1, "exactly one entry must remain on the stack");
    assert.equal(stack[0].instanceId, "uuid-top", "the TOP entry (uuid-top) must remain — the bottom entry was popped by exact instanceId match");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Contract 2: the resulting SubagentStop record in activity.jsonl carries the matched instanceId and the correct workerId", () => {
  const root = setupProject();
  try {
    seedStack(root, [
      {
        agentId: "search-retrieval",
        model: "haiku",
        timestamp: Date.now() - 5000,
        subagentType: "general-purpose",
        instanceId: "uuid-bottom",
      },
      {
        agentId: "coding-specialist",
        model: "sonnet",
        timestamp: Date.now(),
        subagentType: "general-purpose",
        instanceId: "uuid-top",
      },
    ]);

    runHook(root, subagentStopWithAgentId("general-purpose", "uuid-bottom"));

    const records = readActivity(root);
    const stop = records.find((r) => r.event === "SubagentStop");
    assert.ok(stop, "expected a SubagentStop record");
    assert.equal(stop!.workerId, "search-retrieval", "must attribute to the bottom entry's agentId (search-retrieval), not the top (coding-specialist)");
    assert.equal(stop!.instanceId, "uuid-bottom", "SubagentStop record must carry the matched instanceId for auditability");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Contract 2: with no agent_id on the SubagentStop payload, and neither same-subagentType candidate bound to an instanceId, the fallback now prefers the OLDEST (FIFO), not stack-top (LIFO)", () => {
  const root = setupProject();
  try {
    seedStack(root, [
      { agentId: "search-retrieval", model: "haiku", timestamp: Date.now() - 5000, subagentType: "coding-specialist" },
      { agentId: "coding-specialist", model: "sonnet", timestamp: Date.now(), subagentType: "coding-specialist" },
    ]);

    // No agent_id field at all, and neither candidate has ever bound an
    // instanceId. This is the exact ambiguous case the concurrent-same-type
    // SubagentStop fix addresses: when two same-subagentType entries are
    // both still unbound, LIFO (stack-top) tie-break used to pop whichever
    // spawned MOST RECENTLY regardless of which one is actually stopping —
    // the direct cause of a same-type spawn's SubagentStop removing the
    // WRONG spawn's spawnId. The fix breaks the tie FIFO (oldest first)
    // instead, matching natural stop order for two spawns that both
    // started before either bound an instanceId.
    runHook(root, { hook_event_name: "SubagentStop", tool_input: { subagent_type: "coding-specialist" }, session_id: "attr-session" });

    const records = readActivity(root);
    const stop = records.find((r) => r.event === "SubagentStop");
    assert.ok(stop, "expected a SubagentStop record");
    assert.equal(stop!.workerId, "search-retrieval", "unbound same-subagentType fallback must now pop the OLDEST (FIFO) entry");

    const stack = readActiveAgent(root).stack;
    assert.equal(stack.length, 1, "one entry must remain");
    assert.equal(stack[0].agentId, "coding-specialist");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Contract 3: TTL keys off lastSeen, falling back to timestamp
// ---------------------------------------------------------------------------

const ORPHAN_ENTRY_TTL_MS = 30 * 60 * 1000; // must match hooks/tycoon-claude-hook.cjs

test("Contract 3: an entry with an OLD timestamp but a RECENT lastSeen is NOT evicted", () => {
  const root = setupProject();
  try {
    const now = Date.now();
    seedStack(root, [
      {
        agentId: "coding-specialist",
        model: "sonnet",
        timestamp: now - (ORPHAN_ENTRY_TTL_MS + 10 * 60 * 1000), // 40 min old by timestamp
        lastSeen: now - 1000, // active 1 second ago
        subagentType: "coding-specialist",
        instanceId: "uuid-live",
      },
    ]);

    // Trigger readAndPruneActiveStack via any non-spawn tool call.
    runHook(root, preToolUseWithAgentId("Read", "uuid-live"));

    const stack = readActiveAgent(root).stack;
    assert.equal(stack.length, 1, "the actively-working entry must NOT be evicted despite its old timestamp");
    assert.equal(stack[0].instanceId, "uuid-live");

    const records = readActivity(root);
    const eviction = records.find((r) => r.event === "AgentEvicted");
    assert.equal(eviction, undefined, "no AgentEvicted record must be written for a live entry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Contract 3: an entry with both old timestamp and old lastSeen IS evicted, and an AgentEvicted record is written", () => {
  const root = setupProject();
  try {
    const now = Date.now();
    seedStack(root, [
      {
        agentId: "coding-specialist",
        model: "sonnet",
        timestamp: now - (ORPHAN_ENTRY_TTL_MS + 10 * 60 * 1000),
        lastSeen: now - (ORPHAN_ENTRY_TTL_MS + 5 * 60 * 1000), // also stale
        subagentType: "coding-specialist",
        instanceId: "uuid-stale",
      },
    ]);

    runHook(root, preToolUseWithAgentId("Read", "some-other-uuid"));

    const stack = readActiveAgent(root).stack;
    assert.equal(stack.length, 0, "the stale entry must be evicted");

    const records = readActivity(root);
    const eviction = records.find((r) => r.event === "AgentEvicted");
    assert.ok(eviction, "expected an AgentEvicted record");
    assert.equal(eviction!.workerId, "coding-specialist");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Contract 3: an entry with an old timestamp and NO lastSeen falls back to timestamp and is evicted (backward compatibility)", () => {
  const root = setupProject();
  try {
    const now = Date.now();
    seedStack(root, [
      {
        agentId: "coding-specialist",
        model: "sonnet",
        timestamp: now - (ORPHAN_ENTRY_TTL_MS + 5 * 60 * 1000),
        // no lastSeen field at all — entries written before this change.
        subagentType: "coding-specialist",
        instanceId: "uuid-pre-change",
      },
    ]);

    runHook(root, preToolUseWithAgentId("Read", "some-other-uuid"));

    const stack = readActiveAgent(root).stack;
    assert.equal(stack.length, 0, "an entry with no lastSeen must fall back to its (stale) timestamp and be evicted");

    const records = readActivity(root);
    const eviction = records.find((r) => r.event === "AgentEvicted");
    assert.ok(eviction, "expected an AgentEvicted record");
    assert.equal(eviction!.workerId, "coding-specialist");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression: UserPromptSubmit must not wipe a live in-flight spawn entry
// ---------------------------------------------------------------------------
// 2026-09-06 ready-test run: 11 of 12 rapid-fire Task spawns had their
// SubagentStop attributed to workerId "orchestrator" with no model. Root
// cause was UserPromptSubmit calling clearActiveStack() unconditionally --
// firing between a spawn's push and its own SubagentStop pop (a real
// pattern when the harness issues a fresh prompt per rapid-fire step) wiped
// the entry before it could be popped. Fixed by having UserPromptSubmit call
// readAndPruneActiveStack (TTL-based) instead, so fresh live entries survive
// and only genuinely abandoned (TTL-expired) entries are evicted.
test("Regression: an active-agent stack entry survives a UserPromptSubmit that arrives before its SubagentStop", () => {
  const root = setupProject();
  try {
    seedStack(root, [
      { agentId: "coding-specialist", model: "sonnet", timestamp: Date.now(), subagentType: "coding-specialist" },
    ]);

    // A fresh prompt submitted while the spawn above is still in flight --
    // this must NOT clear the live entry.
    runHook(root, { hook_event_name: "UserPromptSubmit", prompt: "next step", session_id: "attr-session" });

    const stackAfterPrompt = readActiveAgent(root).stack;
    assert.equal(stackAfterPrompt.length, 1, "a live entry must survive an intervening UserPromptSubmit");
    assert.equal(stackAfterPrompt[0].agentId, "coding-specialist");

    // The subagent's own stop must now attribute to it correctly, not fall
    // back to "orchestrator".
    runHook(root, subagentStopWithAgentId("coding-specialist", ""));

    const records = readActivity(root);
    const stop = records.filter((r) => r.event === "SubagentStop").pop();
    assert.ok(stop, "expected a SubagentStop record");
    assert.equal(stop!.workerId, "coding-specialist");
    assert.equal(stop!.model, "sonnet");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
