/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Tests hooks/tycoon-codex-hook.cjs's pure functions directly (require()'d
// as a CJS module — the harness exposes them via module.exports for
// testability, same shape as its detectEntryPoint/mapNotifyPayload/
// mapHooksPayload exports), then replays the resulting HookRecord-shaped
// lines through src/core/mappingRegistry.getMapper("codex") /
// src/core/state.computeStateFromRecords, mirroring
// test/opencodeProvider.test.ts's fixture-replay pattern.
//
// Fixture 1 (real, p22-t2): test/fixtures/codex-hooks/notify-agent-turn-complete.jsonl
// — a captured `agent-turn-complete` notify payload.
// Fixture 2 (SYNTHETIC — no live hooks payload exists per
// docs/codex-harness-findings.md, hooks never fired in the p22-t2 spike):
// a hand-built stream covering all 12 documented event names from
// installCodexHooks.ts's CODEX_HOOK_EVENTS, run through the hooks entry
// point.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { computeStateFromRecords } from "../src/core/state";
import "../src/providers/claude-code";
import "../src/providers/codex";
import { getMapper, tryMapRecord } from "../src/core/mappingRegistry";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const codexHook = require("../../hooks/tycoon-codex-hook.cjs") as {
  HOOKS_EVENT_MAP: Record<string, string>;
  detectEntryPoint: (
    argvPayload: string | null,
    stdinPayload: string,
    argvEventName: string | null,
  ) => { kind: "notify" | "hooks"; eventName?: string; payload: Record<string, unknown> } | null;
  mapNotifyPayload: (
    payload: Record<string, unknown>,
    activityFile: string,
    at: number,
    env?: Record<string, string | undefined>,
  ) => unknown[];
  mapHooksPayload: (eventName: string, payload: Record<string, unknown>, at: number) => unknown[];
  hasSeenSessionStart: (activityFile: string, threadId: string) => boolean;
};

// __dirname is out/test/ at runtime (compiled output), but fixtures are
// plain data files never copied by tsc — read them from the source tree.
const FIXTURES_DIR = join(__dirname, "..", "..", "test", "fixtures", "codex-hooks");
const NONEXISTENT_ACTIVITY_FILE = join(FIXTURES_DIR, "__does-not-exist__.jsonl");

test("(a) real notify fixture: detectEntryPoint recognizes it as 'notify' and mapNotifyPayload produces a synthetic SessionStart + Stop", () => {
  const line = readFileSync(join(FIXTURES_DIR, "notify-agent-turn-complete.jsonl"), "utf8").trim();
  const outer = JSON.parse(line) as { argv: string[] };
  const notifyJson = outer.argv[0]; // the notify script's argv[2]-equivalent, per the captured fixture shape

  const detected = codexHook.detectEntryPoint(notifyJson, "", null);
  assert.ok(detected);
  assert.equal(detected!.kind, "notify");

  const payload = JSON.parse(notifyJson) as Record<string, unknown>;
  const threadId = payload["thread-id"] as string;
  assert.equal(payload.type, "agent-turn-complete");

  const records = codexHook.mapNotifyPayload(payload, NONEXISTENT_ACTIVITY_FILE, 1000) as Array<{
    event: string;
    provider: string;
    sessionId: string;
  }>;
  assert.equal(records.length, 2);
  assert.equal(records[0].event, "UserPromptSubmit");
  assert.equal(records[1].event, "Stop");
  for (const r of records) {
    assert.equal(r.provider, "codex");
    assert.equal(r.sessionId, threadId);
  }

  // Replay through the registered "codex" mapper -> NormalizedEvent[] -> state.
  const mapper = getMapper("codex");
  const events = records.flatMap((r) => mapper(r));
  const state = computeStateFromRecords(records as never[]);
  assert.ok(events.some((e) => e.type === "SessionStart"));
  assert.ok(events.some((e) => e.type === "SessionStop"));
  assert.ok(state); // computeStateFromRecords doesn't throw on codex-provider lines
});

// Plan p22-t10: rollout-enriched notify attribution for Codex sub-agents.
// Fixtures are the four real (redacted) rollout session_meta first-lines
// captured from a live run (parent + 3 native search-retrieval sub-agent
// threads, nicknames Hegel/Confucius/Jason), laid out under
// test/fixtures/codex-hooks/sessions/2026/09/08/ so CODEX_HOME can be
// pointed at test/fixtures/codex-hooks/ directly.
const ROLLOUT_CODEX_HOME = FIXTURES_DIR;
const PARENT_THREAD_ID = "01a08436-0127-7e42-9ddd-3fa757a819ed";
const CHILD_THREAD_ID = "01a08437-3da8-78e3-93c8-4a12d9bdd11d"; // Hegel / search_retrieval_1

test("(c) notify for a child (subagent) thread with a matching rollout fixture: WorkerSpawned+WorkerStopped-shaped records, workerId/parentId/provider codex", () => {
  // mapNotifyPayload resolves workerId via codexRouting.listKnownAgentIds(<CLAUDE_PROJECT_DIR>/.claude/agents),
  // which without an override falls back to the real repo's .claude/agents —
  // itself gitignored (.gitignore:45) and absent on a clean clone/CI
  // checkout, so the agent_path "/root/search_retrieval_1" match against the
  // roster silently misses and resolveWorkerId falls through to the literal
  // "codex-agent" default. Point CLAUDE_PROJECT_DIR at an isolated fixture
  // project containing only the one roster file this case needs.
  const fixtureProjectDir = fsMod.mkdtempSync(join(os.tmpdir(), "codex-hook-roster-test-"));
  fsMod.mkdirSync(join(fixtureProjectDir, ".claude", "agents"), { recursive: true });
  fsMod.writeFileSync(join(fixtureProjectDir, ".claude", "agents", "search-retrieval.md"), "---\nmodel: haiku\n---\n# Search Retrieval\n");
  const prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = fixtureProjectDir;
  const prevHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = ROLLOUT_CODEX_HOME;
  try {
    const payload = { type: "agent-turn-complete", "thread-id": CHILD_THREAD_ID };
    const records = codexHook.mapNotifyPayload(payload, NONEXISTENT_ACTIVITY_FILE, 5000) as Array<{
      event: string;
      provider: string;
      sessionId: string;
      tool?: string;
      workerId?: string;
      parentId?: string;
    }>;
    assert.equal(records.length, 2);
    assert.equal(records[0].event, "PreToolUse");
    assert.equal(records[0].tool, "Task");
    assert.equal(records[0].workerId, "search-retrieval"); // agent_path "/root/search_retrieval_1" -> roster id
    assert.equal(records[0].parentId, PARENT_THREAD_ID);
    assert.equal(records[1].event, "SubagentStop");
    assert.equal(records[1].workerId, "search-retrieval");
    for (const r of records) {
      assert.equal(r.provider, "codex");
      assert.equal(r.sessionId, CHILD_THREAD_ID);
    }

    const mapper = getMapper("codex");
    const events = records.flatMap((r) => mapper(r));
    assert.ok(events.some((e) => e.type === "WorkerSpawned"));
    const state = computeStateFromRecords(records as never[]);
    assert.ok(state);
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
    if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
    fsMod.rmSync(fixtureProjectDir, { recursive: true, force: true });
  }
});

test("(d) notify for the parent (user) thread with a matching rollout fixture: behaviour unchanged (synthetic UserPromptSubmit + Stop)", () => {
  const prevHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = ROLLOUT_CODEX_HOME;
  try {
    const payload = { type: "agent-turn-complete", "thread-id": PARENT_THREAD_ID };
    const records = codexHook.mapNotifyPayload(payload, NONEXISTENT_ACTIVITY_FILE, 6000) as Array<{
      event: string;
      provider: string;
      sessionId: string;
    }>;
    assert.equal(records.length, 2);
    assert.equal(records[0].event, "UserPromptSubmit");
    assert.equal(records[1].event, "Stop");
    for (const r of records) {
      assert.equal(r.provider, "codex");
      assert.equal(r.sessionId, PARENT_THREAD_ID);
    }
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
  }
});

test("(e) missing rollout / CODEX_HOME: falls back to today's default mapping, never throws", () => {
  // Isolated env whose CODEX_HOME points at a directory with no matching rollout for this thread id.
  const { env } = makeIsolatedEnv({ CODEX_HOME: join(FIXTURES_DIR, "__no-such-codex-home__") });
  const payload = { type: "agent-turn-complete", "thread-id": "unknown-thread-xyz" };
  let records: Array<{ event: string; provider: string; sessionId: string }> = [];
  assert.doesNotThrow(() => {
    records = codexHook.mapNotifyPayload(payload, NONEXISTENT_ACTIVITY_FILE, 7000, env) as typeof records;
  });
  assert.equal(records.length, 2);
  assert.equal(records[0].event, "UserPromptSubmit");
  assert.equal(records[1].event, "Stop");
});

test("(f) two notifies for the same child thread produce exactly one Task-shaped spawn record", () => {
  // Isolated env whose CODEX_HOME points at the real rollout fixtures dir (not the machine's real home).
  const { env } = makeIsolatedEnv({ CODEX_HOME: ROLLOUT_CODEX_HOME });
  const activityFile = join(FIXTURES_DIR, `__scratch-activity-${Date.now()}.jsonl`);
  try {
    const payload = { type: "agent-turn-complete", "thread-id": CHILD_THREAD_ID };

    const turn1 = codexHook.mapNotifyPayload(payload, activityFile, 8000, env) as Array<{
      event: string;
      provider: string;
      sessionId: string;
      tool?: string;
    }>;
    for (const r of turn1) require("node:fs").appendFileSync(activityFile, JSON.stringify(r) + "\n");

    const turn2 = codexHook.mapNotifyPayload(payload, activityFile, 9000, env) as Array<{
      event: string;
      provider: string;
      sessionId: string;
      tool?: string;
    }>;

    const allSpawns = [...turn1, ...turn2].filter((r) => r.event === "PreToolUse" && r.tool === "Task");
    assert.equal(allSpawns.length, 1);

    // Second turn still reflects activity + a Stop, just not a re-spawn.
    assert.equal(turn2.length, 2);
    assert.equal(turn2[0].event, "PreToolUse");
    assert.notEqual(turn2[0].tool, "Task");
    assert.equal(turn2[1].event, "SubagentStop");
  } finally {
    try {
      require("node:fs").unlinkSync(activityFile);
    } catch {
      /* best-effort cleanup */
    }
  }
});

test("(b) SYNTHETIC hooks-entry stream covering all 12 documented event names maps through mapHooksPayload/getMapper('codex') with correlation by thread-id", () => {
  const threadId = "synthetic-thread-01";
  const receiverThreadId = "synthetic-sub-01";
  let at = 2000;

  const rawRecords: unknown[] = [];
  for (const eventName of Object.keys(codexHook.HOOKS_EVENT_MAP)) {
    const payload: Record<string, unknown> =
      eventName === "subagent_start"
        ? { "thread-id": threadId, receiver_thread_id: receiverThreadId, agent_role: "coding-specialist" }
        : eventName === "subagent_stop"
          ? { "thread-id": threadId, receiver_thread_id: receiverThreadId }
          : eventName === "pre_tool_use" || eventName === "post_tool_use"
            ? { "thread-id": threadId, tool_name: "Read" }
            : { "thread-id": threadId };
    const detected = codexHook.detectEntryPoint(null, JSON.stringify(payload), eventName);
    assert.ok(detected, `detectEntryPoint should recognize synthetic event ${eventName}`);
    assert.equal(detected!.kind, "hooks");
    const records = codexHook.mapHooksPayload(eventName, payload, at++);
    rawRecords.push(...records);
  }

  // 12 event names -> HOOKS_EVENT_MAP maps 8 to a Claude-hook analogue
  // (session_start/user_prompt_submit -> UserPromptSubmit,
  // pre_tool_use/post_tool_use/subagent_start -> PreToolUse,
  // subagent_stop -> SubagentStop, stop/session_end -> Stop) and passes 4
  // through verbatim with no analogue (permission_request/pre_compact/
  // post_compact/interrupt) — every one still produces exactly one record.
  assert.equal(rawRecords.length, 12);

  const mapper = getMapper("codex");
  const events = rawRecords.flatMap((r) => mapper(r));

  // WorkerSpawned from the synthetic subagent_start (mapped to PreToolUse
  // tool:"Task"), TaskCompleted+WorkerStopped from subagent_stop
  // (SubagentStop), SessionStart from session_start/user_prompt_submit,
  // SessionStop from stop/session_end. permission_request/pre_compact/
  // post_compact/interrupt/post_tool_use/pre_tool_use(non-Task) map to []
  // or WorkerActivity per mapHookRecord's default PreToolUse branch.
  assert.ok(events.some((e) => e.type === "WorkerSpawned" && (e as { workerId: string }).workerId === receiverThreadId));
  assert.ok(events.some((e) => e.type === "WorkerStopped" && (e as { workerId: string }).workerId === receiverThreadId));
  assert.ok(events.some((e) => e.type === "SessionStart"));
  assert.ok(events.some((e) => e.type === "SessionStop"));
  for (const e of events) {
    if ("sessionId" in e) assert.equal((e as { sessionId?: string }).sessionId, threadId);
  }
});

test("(c) hasSeenSessionStart: false on a fresh/missing activity file, true once a matching UserPromptSubmit record is present", () => {
  assert.equal(codexHook.hasSeenSessionStart(NONEXISTENT_ACTIVITY_FILE, "thread-x"), false);
  assert.equal(codexHook.hasSeenSessionStart(NONEXISTENT_ACTIVITY_FILE, ""), true); // no thread id to correlate on -> skip synthesis
});

test("(d) detectEntryPoint returns null for unrecognized payloads (fail-open, never throws)", () => {
  assert.equal(codexHook.detectEntryPoint(null, "not json", null), null);
  assert.equal(codexHook.detectEntryPoint(null, JSON.stringify({ foo: "bar" }), null), null);
  assert.equal(codexHook.detectEntryPoint(null, "", null), null);
});

// (e)-(g): plan p22-t5 routing-policy wiring. codexHookExtra pulls in the
// spawn-routing exports added alongside the existing ones above.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const codexHookExtra = require("../../hooks/tycoon-codex-hook.cjs") as {
  isSpawnLikeTool: (eventName: string, payload: Record<string, unknown>) => boolean;
  evaluateSpawnRouting: (
    eventName: string,
    payload: Record<string, unknown>,
    activityFile: string,
    env?: Record<string, string | undefined>,
  ) => { decision: "allow" | "deny"; denyOutput?: { hookSpecificOutput: { permissionDecisionReason: string } }; workerId?: string };
  isDispatcherConfigured: (env?: Record<string, string | undefined>) => boolean;
  resolveActiveStackFile: () => string;
  readActiveStack: (stackFile: string) => Array<{ threadId: string; agentId: string; at?: number }>;
  writeActiveStack: (stackFile: string, stack: unknown[]) => void;
  CODEX_STACK_MAX_AGE_MS: number;
};

// Isolated env for every evaluateSpawnRouting/isDispatcherConfigured call in
// this suite: a fresh temp CODEX_HOME (and HOME/USERPROFILE fallback) so no
// test ever depends on, or is broken by, the real machine's
// ~/.codex/config.toml. TYCOON_CODEX_DISPATCHER_CONFIGURED is explicitly
// absent unless a case sets it, and a fresh dir means no marker is present.
function makeIsolatedEnv(overrides: Record<string, string | undefined> = {}) {
  const tmpHome = fsMod.mkdtempSync(join(os.tmpdir(), "codex-home-test-"));
  const codexHome = join(tmpHome, ".codex");
  fsMod.mkdirSync(codexHome, { recursive: true });
  return {
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      TYCOON_CODEX_DISPATCHER_CONFIGURED: undefined,
      ...overrides,
    },
    codexHome,
    tmpHome,
  };
}

const os = require("node:os") as typeof import("node:os");
const fsMod = require("node:fs") as typeof import("node:fs");

function withTempProjectDir(fn: (projectDir: string, activityFile: string) => void) {
  const dir = fsMod.mkdtempSync(join(os.tmpdir(), "codex-routing-test-"));
  const prevRoot = process.env.CLAUDE_PROJECT_DIR;
  const prevKeywords = process.env.TYCOON_AGENT_KEYWORDS_PATH;
  process.env.CLAUDE_PROJECT_DIR = dir;
  delete process.env.TYCOON_AGENT_KEYWORDS_PATH;
  try {
    fsMod.mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    fsMod.mkdirSync(join(dir, ".claude", "tycoon"), { recursive: true });
    fsMod.writeFileSync(
      join(dir, ".claude", "agents", "coding-specialist.md"),
      "---\nmodel: sonnet\n---\n# Coding Specialist\n",
    );
    fsMod.writeFileSync(
      join(dir, ".claude", "agents", "codex-reviewer.md"),
      "---\nmodel: openai/gpt-6-astra\nbackend:\n  vendor: openai\n  model: openai/gpt-6-astra\n---\n# Codex Reviewer\n",
    );
    fsMod.writeFileSync(
      join(dir, ".claude", "tycoon", "agent-keywords.json"),
      JSON.stringify({
        fallback_agent: "codex-reviewer",
        agents: {
          "coding-specialist": { pattern: "implement|code|fix|bug" },
          "codex-reviewer": { pattern: "codex|review" },
        },
      }),
    );
    const activityFile = join(dir, ".claude", "tycoon", "activity.jsonl");
    fn(dir, activityFile);
  } finally {
    if (prevRoot === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevRoot;
    if (prevKeywords === undefined) delete process.env.TYCOON_AGENT_KEYWORDS_PATH;
    else process.env.TYCOON_AGENT_KEYWORDS_PATH = prevKeywords;
    fsMod.rmSync(dir, { recursive: true, force: true });
  }
}

test("(e) evaluateSpawnRouting denies a non-OpenAI specialist and writes a ProviderError record", () => {
  withTempProjectDir((_dir, activityFile) => {
    const payload = { "thread-id": "t1", tool_name: "spawn_agent", tool_input: { name: "coding-specialist" } };
    assert.equal(codexHookExtra.isSpawnLikeTool("pre_tool_use", payload), true);
    const { env } = makeIsolatedEnv();
    const result = codexHookExtra.evaluateSpawnRouting("pre_tool_use", payload, activityFile, env);
    assert.equal(result.decision, "deny");
    assert.ok(/cannot run under Codex/i.test(result.denyOutput!.hookSpecificOutput.permissionDecisionReason));
    const lines = fsMod.readFileSync(activityFile, "utf8").trim().split("\n");
    const providerErrors = lines.map((l) => JSON.parse(l)).filter((r) => r.event === "ProviderError");
    assert.equal(providerErrors.length, 1);
    assert.equal(providerErrors[0].provider, "codex");
    assert.equal(providerErrors[0].reason, "specialist-unavailable");
    assert.equal(providerErrors[0].workerId, "coding-specialist");
  });
});

test("(e2) the ProviderError line evaluateSpawnRouting writes maps through tryMapRecord to a ProviderError NormalizedEvent", () => {
  withTempProjectDir((_dir, activityFile) => {
    const payload = { "thread-id": "t1-provider-error", tool_name: "spawn_agent", tool_input: { name: "coding-specialist" } };
    const { env } = makeIsolatedEnv();
    const result = codexHookExtra.evaluateSpawnRouting("pre_tool_use", payload, activityFile, env);
    assert.equal(result.decision, "deny");

    const lines = fsMod.readFileSync(activityFile, "utf8").trim().split("\n");
    const providerErrorLine = lines.map((l) => JSON.parse(l)).find((r) => r.event === "ProviderError");
    assert.ok(providerErrorLine);

    const events = tryMapRecord(providerErrorLine);
    assert.ok(events);
    const providerErrorEvent = events!.find((e) => e.type === "ProviderError") as
      | { type: "ProviderError"; workerId?: string; provider?: string; sessionId?: string; message: string }
      | undefined;
    assert.ok(providerErrorEvent);
    assert.equal(providerErrorEvent!.provider, "codex");
    assert.equal(providerErrorEvent!.workerId, "coding-specialist");
    assert.equal(providerErrorEvent!.sessionId, "t1-provider-error");
    assert.ok(/specialist-unavailable/.test(providerErrorEvent!.message));
  });
});

test("(f) evaluateSpawnRouting allows an OpenAI specialist through", () => {
  withTempProjectDir((_dir, activityFile) => {
    const payload = { "thread-id": "t2", tool_name: "spawn_agent", tool_input: { name: "codex-reviewer" } };
    const { env } = makeIsolatedEnv();
    const result = codexHookExtra.evaluateSpawnRouting("pre_tool_use", payload, activityFile, env);
    assert.equal(result.decision, "allow");
    assert.equal(result.workerId, "codex-reviewer");
  });
});

test("(g) evaluateSpawnRouting denies nested delegation: a spawn from a thread already on the active stack", () => {
  withTempProjectDir((dir, activityFile) => {
    // First spawn creates worker thread "sub-1" and pushes it onto the stack.
    const { env } = makeIsolatedEnv();
    const first = codexHookExtra.evaluateSpawnRouting(
      "subagent_start",
      { "thread-id": "orchestrator-thread", receiver_thread_id: "sub-1", agent_role: "codex-reviewer" },
      activityFile,
      env,
    );
    assert.equal(first.decision, "allow");

    // A subsequent spawn attempt FROM sub-1 (now a bound worker) must be denied.
    const nested = codexHookExtra.evaluateSpawnRouting(
      "pre_tool_use",
      { "thread-id": "sub-1", tool_name: "spawn_agent", tool_input: { name: "codex-reviewer" } },
      activityFile,
      env,
    );
    assert.equal(nested.decision, "deny");
    assert.ok(/leaf worker/i.test(nested.denyOutput!.hookSpecificOutput.permissionDecisionReason));
    void dir;
  });
});

test("(g2) isDispatcherConfigured reads only the injected CODEX_HOME's config.toml, never the real machine home", () => {
  // Marker present in an isolated CODEX_HOME/config.toml -> configured, regardless of the real ~/.codex.
  const withMarker = makeIsolatedEnv();
  fsMod.writeFileSync(
    join(withMarker.codexHome, "config.toml"),
    "# some real-looking codex config\n[mcp_servers.tycoon-dispatcher]\n# tycoon-dispatcher: managed mcp server (do not edit by hand)\ncommand = \"node\"\n",
  );
  assert.equal(codexHookExtra.isDispatcherConfigured(withMarker.env), true);
  fsMod.rmSync(withMarker.tmpHome, { recursive: true, force: true });

  // Marker absent from an isolated CODEX_HOME/config.toml -> not configured.
  const withoutMarker = makeIsolatedEnv();
  fsMod.writeFileSync(withoutMarker.codexHome + "/config.toml", "# no dispatcher configured here\n");
  assert.equal(codexHookExtra.isDispatcherConfigured(withoutMarker.env), false);
  fsMod.rmSync(withoutMarker.tmpHome, { recursive: true, force: true });
});

test("(h) readActiveStack prunes entries older than CODEX_STACK_MAX_AGE_MS and keeps fresh ones", () => {
  withTempProjectDir((dir) => {
    void dir;
    const stackFile = codexHookExtra.resolveActiveStackFile();
    const now = Date.now();
    codexHookExtra.writeActiveStack(stackFile, [
      { threadId: "stale-1", agentId: "coding-specialist", at: now - codexHookExtra.CODEX_STACK_MAX_AGE_MS - 1000 },
      { threadId: "fresh-1", agentId: "codex-reviewer", at: now - 1000 },
      { threadId: "legacy-no-at", agentId: "codex-reviewer" }, // pre-fix entries with no `at` are kept, not evicted
    ]);
    const pruned = codexHookExtra.readActiveStack(stackFile);
    const threadIds = pruned.map((e) => e.threadId);
    assert.ok(!threadIds.includes("stale-1"));
    assert.ok(threadIds.includes("fresh-1"));
    assert.ok(threadIds.includes("legacy-no-at"));
  });
});
