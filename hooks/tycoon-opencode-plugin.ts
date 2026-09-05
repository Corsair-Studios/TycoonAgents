/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Shipped OpenCode plugin (plan p5-t2). Loads from .opencode/plugin/ as a
 * SINGLE file with no imports beyond node builtins — OpenCode auto-installs
 * @opencode-ai/plugin's types for editor support, but this file must not
 * depend on that package (or any other) at runtime, mirroring
 * hooks/tycoon-claude-hook.cjs's zero-dep posture.
 *
 * Source of truth for payload shapes and the mapping below:
 * docs/opencode-probe-findings.md. Anything not resolved there is called out
 * in this file's comments rather than guessed.
 *
 * Mirrors hooks/tycoon-claude-hook.cjs's file formats exactly:
 *   - <activityDir>/activity.jsonl: one JSON line per HookRecord-shaped event
 *   - <activityDir>/active-agent.json: { version, agentId, timestamp, stack }
 *     push/pop, same shape as the Claude hook's pushActiveAgent/pop.
 * activityDir = TYCOON_ACTIVITY_DIR env override, else <directory>/.claude/tycoon.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Delegation enforcement (plan p14-t1): pure decision functions ported from
// hooks/tycoon-claude-hook.cjs, shared via src/core/delegationEnforcement.ts
// (compiled to out/src/core/delegationEnforcement.js) so both hosts use the
// SAME algorithms. Loaded lazily/defensively — an unbuilt out/ (dev checkout
// that hasn't run `npm run compile`, or a packaged install missing it for any
// reason) must never crash the plugin; every call site below falls back to
// "allow" when this module isn't available.
//
// Depth rule for this plugin (orchestrator vs. leaf): depth is derived
// SOLELY from OpenCode's own session tree, never from the shared
// active-agent.json stack (that file is written by BOTH this plugin and
// hooks/tycoon-claude-hook.cjs, so a Claude worker pushed onto it must never
// be read as "this OpenCode session is nested"). `session.created` payloads
// (docs/opencode-probe-findings.md) carry `info.parentID` for every child
// session and `info.agent` for its agent name; this plugin tracks both in
// `sessionParent`/`sessionAgentName` as those events arrive. A `task` call
// (or any other tool call) is a LEAF call only when its OWN calling
// `sessionID` is a known OpenCode child session (has a recorded parentID);
// a root session with no recorded parent is the orchestrator regardless of
// what is on the shared stack. Entries THIS plugin pushes onto the shared
// stack (for the panel) are tagged `provider: "opencode"` and matched by
// `sessionId` — never treated as authoritative for the depth decision
// itself, and never matched against entries another provider pushed.
// ---------------------------------------------------------------------------

interface DelegationEnforcementModule {
  matchAgentFromKeywords: (
    searchText: string,
    keywordsConfig: { fallback_agent?: string; agents?: Record<string, { pattern?: string }> } | null | undefined
  ) => { agentId: string; matchedKeyword: string } | null;
  decideDirectToolCall: (
    toolName: string,
    readCountSoFar: number
  ) => { action: "allow" | "nudge" | "deny"; message?: string; nextReadCount?: number };
  decideSpawn: (ctx: {
    spawnerAgentId: string;
    spawnerAgentType: string;
    delegationMode: string;
    spawnerIsLead: boolean;
  }) => { action: "allow" | "nudge" | "deny"; message?: string };
  LEAF_WORKER_DENY_MESSAGE: string;
  startReviewGate: () => { status: string; reviewsRun: number };
  advanceReviewGate: (
    state: { status: string; reviewsRun: number },
    approved: boolean
  ) => { status: string; reviewsRun: number };
  isReviewGateTerminal: (state: { status: string; reviewsRun: number }) => boolean;
}

interface FallbackChainModule {
  isProviderFailure: (text: string | undefined | null) => boolean;
  resolveNextFallback: (input: {
    slotId: string;
    chain: { model?: string; vendor?: string }[];
    attemptsSoFar: number;
  }) => { slot: { model?: string; vendor?: string } | null; index: number; exhausted: boolean };
  buildFallbackInstruction: (input: {
    workerId: string;
    failedProvider?: string;
    failedModel?: string;
    reason: string;
    result: { slot: { model?: string; vendor?: string } | null; index: number; exhausted: boolean };
    chainLength: number;
  }) => string;
  FallbackState: new () => {
    recordFailure: (
      sessionId: string,
      slotId: string,
      chain: { model?: string; vendor?: string }[],
      failedModel?: string,
      reason?: string
    ) => { attemptsSoFar: number; chain: { model?: string; vendor?: string }[] };
    getNext: (
      sessionId: string,
      slotId: string
    ) => { slot: { model?: string; vendor?: string } | null; index: number; exhausted: boolean } | undefined;
    getRecord: (
      sessionId: string,
      slotId: string
    ) => { attemptsSoFar: number; chain: { model?: string; vendor?: string }[] } | undefined;
    endSession: (sessionId: string) => void;
  };
}

let fallbackChainModule: FallbackChainModule | null | undefined; // undefined = not attempted

function getFallbackChainModule(): FallbackChainModule | null {
  if (fallbackChainModule === undefined) {
    try {
      // Resolves to out/src/core/fallbackChain.js when compiled and copied
      // alongside this plugin (see scripts/copy-hook-runtime.mjs); absent in
      // an unbuilt dev checkout or a packaged install missing it — both fall
      // back to "no fallback wiring" (activity still logs normally).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      fallbackChainModule = require(path.join(__dirname, "fallbackChain.js")) as FallbackChainModule;
    } catch {
      fallbackChainModule = null;
      try {
        process.stderr.write(
          "[tycoon-opencode-plugin] fallbackChain.js not available next to the plugin — provider-failure fallback dispatch is disabled.\n"
        );
      } catch {
        /* never let a warning break the plugin */
      }
    }
  }
  return fallbackChainModule;
}

// Reads .opencode/tycoon-routing.generated.json (written by
// scripts/generate-opencode-config.mjs) for a given agent's resolved
// fallback chain: { agents: { <name>: { model, fallback: string[] } },
// orchestrator: { model } } — fallback entries are "provider/model" strings,
// converted here into the {model} shape resolveNextFallback expects.
function readFallbackChainForAgent(directory: string, agentId: string): { model?: string }[] {
  const generated = readJsonSafe<{ agents?: Record<string, { model?: string; fallback?: string[] }> }>(
    path.join(directory, ".opencode", "tycoon-routing.generated.json")
  );
  const entry = generated?.agents?.[agentId];
  if (!entry || !Array.isArray(entry.fallback)) return [];
  return entry.fallback.map((model) => ({ model }));
}

let delegationEnforcementModule: DelegationEnforcementModule | null | undefined; // undefined = not attempted

function getDelegationEnforcementModule(): DelegationEnforcementModule | null {
  if (delegationEnforcementModule === undefined) {
    try {
      // Resolves to out/src/core/delegationEnforcement.js when compiled and
      // copied alongside this plugin (see scripts/copy-hook-runtime.mjs);
      // absent in a dev checkout that hasn't built out/, or a packaged
      // install missing it — both fall back to "allow" everywhere below.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      delegationEnforcementModule = require(path.join(
        __dirname,
        "delegationEnforcement.js"
      )) as DelegationEnforcementModule;
    } catch {
      delegationEnforcementModule = null;
      try {
        process.stderr.write(
          "[tycoon-opencode-plugin] delegationEnforcement.js not available next to the plugin — direct-tool-call nudges, keyword routing fallback, and the leaf-spawn guard are disabled.\n"
        );
      } catch {
        /* never let a warning break the plugin */
      }
    }
  }
  return delegationEnforcementModule;
}

// ---------------------------------------------------------------------------
// Types (kept local — no cross-package import at runtime; shapes mirror
// src/providers/claude-code/hookRecord.ts's HookRecord as closely as an
// OpenCode-sourced record can).
// ---------------------------------------------------------------------------

type OpenCodeHookEventName =
  | "UserPromptSubmit"
  | "PreToolUse"
  | "SubagentStop"
  | "Stop"
  | "PluginError"
  | "SpawnDenied"
  | "ReviewGate"
  | "FallbackTriggered";

interface OpenCodeHookRecord {
  event: OpenCodeHookEventName;
  provider: "opencode";
  at: number;
  tool?: string;
  workerId?: string;
  tokens?: number;
  cacheReadTokens?: number;
  model?: string;
  vendor?: string;
  costModelClass?: "metered" | "subscription" | "local";
  agentDescription?: string;
  parentId?: string;
  sessionId?: string;
  error?: string;
  /** SpawnDenied/ReviewGate-only fields. */
  routingMethod?: string;
  matchedKeyword?: string;
  reviewGateStatus?: string;
  message?: string;
  /** FallbackTriggered-only fields. */
  failedModel?: string;
  nextModel?: string;
  slotId?: string;
  reason?: string;
  /** p15-t2: set on a Task PreToolUse/SubagentStop pair only when this dispatch is a fallback re-dispatch. */
  fallbackOf?: string;
  fallbackDepth?: number;
}

interface ActiveAgentEntry {
  agentId: string;
  timestamp: number;
  model?: string;
  subagentType?: string;
  parentId?: string;
  sessionId?: string;
  /** p15-t2: remembered from the spawning Task call so the matching SubagentStop can carry the same tag. */
  fallbackOf?: string;
  fallbackDepth?: number;
  /** Tags an entry THIS plugin pushed, so depth/attribution logic never
   *  matches an entry another provider (e.g. hooks/tycoon-claude-hook.cjs)
   *  pushed onto the same shared stack file. */
  provider?: "opencode";
}

interface ActiveAgentFile {
  version: 1;
  agentId: string;
  timestamp: number;
  stack: ActiveAgentEntry[];
}

// Minimal shape of the SDK client used here — kept structural (no import of
// @opencode-ai/sdk) so the plugin has zero runtime dependencies.
interface OpenCodeClientLike {
  session: {
    messages: (opts: { path: { id: string } }) => Promise<{
      data?: Array<{ info?: Record<string, unknown> }>;
    }>;
  };
}

export interface PluginDeps {
  directory: string;
  client?: OpenCodeClientLike;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_STRING_BYTES = 8 * 1024; // 8 KB, per brief

// OpenCode tool name -> the Claude-style tool name TycoonAgents' mapper
// understands (see the PreToolUse "other tools" row in the findings' mapping
// table). mcp__<server>__<tool> names are left untouched so backend routing
// (buildMcpBackendRouting-equivalent below) still applies.
const TOOL_NAME_MAP: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  write: "Write",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  webfetch: "WebFetch",
};

function mapToolName(rawTool: string): string {
  if (TOOL_NAME_MAP[rawTool]) return TOOL_NAME_MAP[rawTool];
  return rawTool;
}

// ---------------------------------------------------------------------------
// String truncation (mirrors standalone/spike/opencode-probe-plugin.ts's
// truncateDeep, scoped to top-level string fields on a flat record here since
// HookRecord-shaped lines are flat).
// ---------------------------------------------------------------------------

function truncateString(value: string): string {
  if (value.length > MAX_STRING_BYTES) {
    const truncatedCount = value.length - MAX_STRING_BYTES;
    return value.slice(0, MAX_STRING_BYTES) + `…[truncated ${truncatedCount} chars]`;
  }
  return value;
}

function truncateRecordStrings<T extends object>(record: T): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record) as Array<keyof T & string>) {
    const v = (record as Record<string, unknown>)[key];
    out[key] = typeof v === "string" ? truncateString(v) : v;
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// File I/O helpers — deliberately simple (single-process plugin, no
// multi-process lock contention like the Claude hook's short-lived CLI
// invocations), but still defensive against a missing dir or malformed JSON.
// ---------------------------------------------------------------------------

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(stripBom(fs.readFileSync(filePath, "utf8"))) as T;
  } catch {
    return null;
  }
}

function atomicWriteSync(filePath: string, data: string): void {
  const tmp = filePath + ".tmp";
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, data, "utf8");
    if (process.platform === "win32") {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        /* ignore */
      }
    }
    fs.renameSync(tmp, filePath);
  } catch {
    try {
      fs.writeFileSync(filePath, data, "utf8");
    } catch {
      /* best-effort: never let a state write crash the plugin */
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function resolveActivityDir(directory: string): string {
  const override = process.env.TYCOON_ACTIVITY_DIR;
  if (override && override.trim() !== "") return override;
  return path.join(directory, ".claude", "tycoon");
}

let loggedFetchUsageError = false;

// ---------------------------------------------------------------------------
// Agent backend routing (mirrors hooks/tycoon-claude-hook.cjs's
// buildMcpBackendRouting/lookupMcpBackend, reusing the SAME compiled module
// via require(path.join(__dirname,'agentBackend.js')) with a legacy
// fallback). Only used to resolve vendor/model/costModelClass for a `task`
// spawn (from the agent's own .claude/agents/<subagent_type>.md when it
// exists) and for mcp__<server>__<tool> routing.
// ---------------------------------------------------------------------------

interface AgentBackendModule {
  readAgentFrontmatter: (mdText: string) => Record<string, unknown>;
  parseAgentBackend: (frontmatter: Record<string, unknown>) => {
    vendor: string;
    transport: string;
    mcpServer?: string;
    tools?: string[];
    model: string;
    costModelClass: "metered" | "subscription" | "local";
  };
}

let agentBackendModule: AgentBackendModule | null | undefined; // undefined = not attempted

function getAgentBackendModule(): AgentBackendModule | null {
  if (agentBackendModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      agentBackendModule = require(path.join(__dirname, "agentBackend.js")) as AgentBackendModule;
    } catch {
      agentBackendModule = null;
      try {
        process.stderr.write(
          "[tycoon-opencode-plugin] agentBackend.js not available next to the plugin — mcp backend routing and per-agent model/vendor resolution disabled.\n"
        );
      } catch {
        /* never let a warning break the plugin */
      }
    }
  }
  return agentBackendModule;
}

function readAgentBackendFromFile(
  agentsDir: string,
  agentId: string
): { vendor?: string; model?: string; costModelClass?: "metered" | "subscription" | "local" } {
  const mod = getAgentBackendModule();
  if (!mod) return {};
  try {
    const mdPath = path.join(agentsDir, agentId + ".md");
    if (!fs.existsSync(mdPath)) return {};
    const text = fs.readFileSync(mdPath, "utf8");
    const frontmatter = mod.readAgentFrontmatter(text);
    const backend = mod.parseAgentBackend(frontmatter);
    return { vendor: backend.vendor, model: backend.model, costModelClass: backend.costModelClass };
  } catch {
    return {};
  }
}

interface McpRouting {
  exact: Map<string, { vendor?: string; model?: string; costModelClass?: "metered" | "subscription" | "local" }>;
  prefixes: Array<{ prefix: string; entry: { vendor?: string; model?: string; costModelClass?: "metered" | "subscription" | "local" } }>;
}

function buildMcpBackendRouting(agentsDir: string): McpRouting | null {
  const mod = getAgentBackendModule();
  if (!mod) return null;
  const exact: McpRouting["exact"] = new Map();
  const prefixes: McpRouting["prefixes"] = [];
  let files: string[];
  try {
    files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return { exact, prefixes };
  }
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(agentsDir, file), "utf8");
    } catch {
      continue;
    }
    let backend: ReturnType<AgentBackendModule["parseAgentBackend"]>;
    try {
      const frontmatter = mod.readAgentFrontmatter(text);
      backend = mod.parseAgentBackend(frontmatter);
    } catch {
      continue;
    }
    if (!backend || (backend.transport !== "mcp" && backend.transport !== "openai-compatible")) continue;
    if (!backend.mcpServer) continue;
    const entry = { vendor: backend.vendor, model: backend.model, costModelClass: backend.costModelClass };
    const serverPrefix = "mcp__" + backend.mcpServer + "__";
    if (Array.isArray(backend.tools) && backend.tools.length > 0) {
      for (const tool of backend.tools) exact.set(serverPrefix + tool, entry);
    } else {
      prefixes.push({ prefix: serverPrefix, entry });
    }
  }
  return { exact, prefixes };
}

function lookupMcpBackend(
  routing: McpRouting | null,
  toolName: string
): { vendor?: string; model?: string; costModelClass?: "metered" | "subscription" | "local" } | undefined {
  if (!routing) return undefined;
  const hit = routing.exact.get(toolName);
  if (hit) return hit;
  for (const { prefix, entry } of routing.prefixes) {
    if (toolName.indexOf(prefix) === 0) return entry;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Active-agent stack — push/pop, mirroring hooks/tycoon-claude-hook.cjs's
// pushActiveAgent/popMatchedAgent file format exactly ({version, agentId,
// timestamp, stack}). No lock file here: OpenCode plugin hooks run
// in-process and sequentially per event, unlike the Claude hook's
// short-lived, potentially-concurrent CLI invocations.
// ---------------------------------------------------------------------------

function readActiveAgentFile(activeAgentFile: string): ActiveAgentFile {
  const existing = readJsonSafe<ActiveAgentFile>(activeAgentFile);
  if (existing && Array.isArray(existing.stack)) return existing;
  return { version: 1, agentId: "none", timestamp: 0, stack: [] };
}

function pushActiveAgent(activeAgentFile: string, entry: ActiveAgentEntry): void {
  const existing = readActiveAgentFile(activeAgentFile);
  const stack = existing.stack.slice();
  stack.push(entry);
  atomicWriteSync(
    activeAgentFile,
    JSON.stringify({ version: 1, agentId: entry.agentId, timestamp: entry.timestamp, stack }, null, 2)
  );
}

// Pop by workerId+sessionId match (highest priority — exact), falling back to
// LIFO, matching the Claude hook's fallback-to-LIFO posture when no better
// discriminator matches.
function popActiveAgent(
  activeAgentFile: string,
  opts: { workerId?: string; sessionId?: string }
): ActiveAgentEntry | null {
  const existing = readActiveAgentFile(activeAgentFile);
  const stack = existing.stack.slice();
  if (stack.length === 0) return null;

  let removedIdx = -1;
  if (opts.sessionId) {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].sessionId === opts.sessionId) {
        removedIdx = i;
        break;
      }
    }
  }
  if (removedIdx < 0 && opts.workerId) {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].agentId === opts.workerId) {
        removedIdx = i;
        break;
      }
    }
  }

  const popped = removedIdx >= 0 ? stack.splice(removedIdx, 1)[0] : stack.pop() ?? null;
  const topAgentId = stack.length > 0 ? stack[stack.length - 1].agentId : "none";
  atomicWriteSync(
    activeAgentFile,
    JSON.stringify({ version: 1, agentId: topAgentId, timestamp: Date.now(), stack }, null, 2)
  );
  return popped;
}

function peekActiveAgent(activeAgentFile: string): ActiveAgentEntry | null {
  const existing = readActiveAgentFile(activeAgentFile);
  return existing.stack.length > 0 ? existing.stack[existing.stack.length - 1] : null;
}

// ---------------------------------------------------------------------------
// activity.jsonl append + PluginError guard
// ---------------------------------------------------------------------------

function appendActivity(activityFile: string, record: OpenCodeHookRecord): void {
  try {
    fs.mkdirSync(path.dirname(activityFile), { recursive: true });
    fs.appendFileSync(activityFile, JSON.stringify(truncateRecordStrings(record)) + "\n", "utf8");
  } catch {
    /* best-effort: a broken activity log must never crash the plugin */
  }
}

function writePluginError(activityFile: string, now: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  appendActivity(activityFile, {
    event: "PluginError",
    provider: "opencode",
    at: now,
    error: truncateString(message),
  });
}

// ---------------------------------------------------------------------------
// Token fetch (SubagentStop): client.session.messages, summed over assistant
// messages. Per the findings, this SDK round-trip is the reliable source
// (the inline message.updated tokens field is an UNRESOLVED fast-path, not
// used here). On failure: omit tokens (never fabricate), log to stderr once.
// ---------------------------------------------------------------------------

async function fetchSessionTokens(
  client: OpenCodeClientLike | undefined,
  sessionId: string
): Promise<{ tokens?: number; cacheReadTokens?: number }> {
  if (!client) return {};
  try {
    const res = await client.session.messages({ path: { id: sessionId } });
    const messages = res?.data ?? [];
    let total = 0;
    let cacheRead = 0;
    for (const m of messages) {
      const info = m?.info as
        | { role?: string; tokens?: { input?: number; output?: number; cache?: { read?: number } } }
        | undefined;
      if (!info || info.role !== "assistant") continue;
      const t = info.tokens;
      if (!t) continue;
      total += Number(t.input ?? 0) + Number(t.output ?? 0);
      cacheRead += Number(t.cache?.read ?? 0);
    }
    return {
      tokens: total > 0 ? total : undefined,
      cacheReadTokens: cacheRead > 0 ? cacheRead : undefined,
    };
  } catch (err) {
    if (!loggedFetchUsageError) {
      loggedFetchUsageError = true;
      try {
        process.stderr.write(
          "[tycoon-opencode-plugin] client.session.messages failed — SubagentStop tokens omitted: " +
            (err instanceof Error ? err.message : String(err)) +
            "\n"
        );
      } catch {
        /* ignore */
      }
    }
    return {};
  }
}

// ---------------------------------------------------------------------------
// Prompt-submit dedupe (session.created with no parentID fires once per
// session; a root-session user message.updated could also fire for the same
// turn — dedupe within 1s per sessionId per findings section (d)).
// ---------------------------------------------------------------------------

function makeSubmitDedupe() {
  const lastSubmitAt = new Map<string, number>();
  return (sessionId: string, now: number): boolean => {
    const prev = lastSubmitAt.get(sessionId);
    lastSubmitAt.set(sessionId, now);
    if (prev !== undefined && now - prev < 1000) return true; // duplicate, skip
    return false;
  };
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export function createPlugin(deps: PluginDeps) {
  const { directory, client } = deps;
  const now = deps.now ?? (() => Date.now());

  const activityDir = resolveActivityDir(directory);
  const activityFile = path.join(activityDir, "activity.jsonl");
  const activeAgentFile = path.join(activityDir, "active-agent.json");
  const agentsDir = path.join(directory, ".claude", "agents");
  const tycoonDir = path.join(directory, ".claude", "tycoon");

  // (2) Keyword-based agent routing: same config file, same matching
  // algorithm (via delegationEnforcementModule) as
  // hooks/tycoon-claude-hook.cjs's matchAgentFromKeywords. Read once per
  // plugin instantiation — same lifetime assumption pushActiveAgent/etc.
  // already make about agentsDir being effectively static for the session.
  const keywordsConfig = readJsonSafe<{
    fallback_agent?: string;
    agents?: Record<string, { pattern?: string }>;
  }>(path.join(tycoonDir, "agent-keywords.json"));
  const delegationEnforcement = getDelegationEnforcementModule();
  const fallbackChain = getFallbackChainModule();
  const fallbackState = fallbackChain ? new fallbackChain.FallbackState() : null;

  // (1) Orchestrator direct-tool-call nudge: per-turn Read counter, reset on
  // each new root-session UserPromptSubmit (see recordUserPromptSubmit
  // below), mirroring the Claude hook's orchestrator-turn-reads.json but
  // kept in-memory here — this plugin is a single long-lived process per
  // OpenCode session, unlike the hook's short-lived per-event CLI process.
  let orchestratorTurnReads = 0;

  // (3) Single review-gate pass equivalent: BEST-EFFORT. OpenCode's probed
  // event surface (docs/opencode-probe-findings.md) carries no signal that
  // distinguishes "a review agent's SubagentStop" from any other worker's —
  // there is no observed event marking "review requested" or "review
  // verdict". This tracks review-gate state per parent session using the
  // SAME state machine as the doctrine (src/core/delegationEnforcement.ts's
  // startReviewGate/advanceReviewGate: one review, one fix-and-recheck
  // round, then stop cycling) keyed by which worker last stopped: a
  // non-"uefn-auditor" specialist finishing arms "awaiting_review"; the next
  // "uefn-auditor" SubagentStop for the same parent session advances the
  // gate. This is a heuristic wired to the SAME SubagentStop signal already
  // used for attribution, not a new OpenCode capability, and could
  // misattribute review pairing if an unrelated worker is spawned
  // interleaved with the review — acceptable for a best-effort v1.
  const reviewGateByParentSession = new Map<string, { status: string; reviewsRun: number }>();
  // Defensive size cap: entries are normally evicted promptly (see
  // handleSessionIdle's delete on root-session Stop, above), but a session
  // that never fires session.idle (crashed process, killed terminal, a host
  // that doesn't emit it) would otherwise leak forever in this long-lived
  // plugin process. Map iteration order is insertion order, so dropping from
  // the front evicts the oldest entries first (approximate LRU).
  const REVIEW_GATE_MAX_ENTRIES = 64;
  function setReviewGate(parentSessionId: string, state: { status: string; reviewsRun: number }): void {
    reviewGateByParentSession.set(parentSessionId, state);
    while (reviewGateByParentSession.size > REVIEW_GATE_MAX_ENTRIES) {
      const oldestKey = reviewGateByParentSession.keys().next().value;
      if (oldestKey === undefined) break;
      reviewGateByParentSession.delete(oldestKey);
    }
  }

  // ---------------------------------------------------------------------------
  // Enforcement mechanisms confirmed live against OpenCode 1.18.27 (plan
  // p15-t0; see docs/opencode-probe-findings.md "Enforcement mechanisms"):
  //
  //   (1) Throwing inside tool.execute.before ABORTS the tool call and the
  //       thrown error's message is surfaced to the model as the tool's
  //       error output (observed verbatim in a real `opencode run`). Used
  //       below to make the leaf-worker spawn guard an ACTUAL block, not a
  //       log-only record.
  //   (2) experimental.chat.system.transform's `output.system` array is
  //       appended to the live system prompt for the NEXT model turn in
  //       that session (observed: the model echoed injected text back).
  //       Used below to deliver the orchestrator direct-tool-call nudge
  //       INTO the model's context instead of only into the activity log.
  //
  // permission.ask was probed and did NOT fire in a real non-interactive
  // `opencode run` (only the informational `event: "permission.asked"` bus
  // event fired) — it is NOT wired here. See the findings doc.
  //
  // BlockingToolCallError is thrown ONLY for a deliberate, doctrine-driven
  // block (spawn-guard deny) and is rethrown as-is by the toolExecuteBefore
  // wrapper below; every other error from handleToolExecuteBefore is caught
  // and logged (fail open), matching every other hook in this plugin.
  // ---------------------------------------------------------------------------
  class BlockingToolCallError extends Error {}

  // Per-session queue of doctrine nudge strings waiting to be delivered into
  // the model's system prompt on its NEXT turn (chat.system.transform runs
  // once per model call, so a nudge produced by a tool call earlier in the
  // same turn is delivered on the following turn — there is no earlier hook
  // this plugin can use to inject mid-turn). Drained (not peeked) on read so
  // a nudge is delivered exactly once.
  const pendingNudgesBySession = new Map<string, string[]>();
  const PENDING_NUDGE_MAX_SESSIONS = 64;
  function queueNudge(sessionId: string | undefined, message: string): void {
    if (!sessionId) return;
    const existing = pendingNudgesBySession.get(sessionId) ?? [];
    existing.push(message);
    pendingNudgesBySession.set(sessionId, existing);
    while (pendingNudgesBySession.size > PENDING_NUDGE_MAX_SESSIONS) {
      const oldestKey = pendingNudgesBySession.keys().next().value;
      if (oldestKey === undefined) break;
      pendingNudgesBySession.delete(oldestKey);
    }
  }
  function drainNudges(sessionId: string | undefined): string[] {
    if (!sessionId) return [];
    const queued = pendingNudgesBySession.get(sessionId);
    if (!queued || queued.length === 0) return [];
    pendingNudgesBySession.delete(sessionId);
    return queued;
  }

  const isDuplicateSubmit = makeSubmitDedupe();
  // sessionID -> true once its first user message.updated has fired, so a
  // later user message.updated in the SAME root session (a later turn) still
  // maps to UserPromptSubmit rather than being suppressed forever — only the
  // 1s window above dedupes session.created vs. the first message.updated
  // for the SAME turn.
  const seenRootSessions = new Set<string>();
  // Track parentID per sessionID so session.idle can tell Stop from
  // SubagentStop without re-deriving it (OpenCode's session.idle payload
  // carries only sessionID — see findings section (d)/(a)). This is also
  // the SAME map the leaf-depth decision below reads: a sessionID present
  // here with a truthy value is a real OpenCode child session.
  const sessionParent = new Map<string, string | undefined>();
  // OpenCode's own agent name for each session (session.created's
  // info.agent), used to stamp the real OpenCode worker name on spawn
  // decisions/records instead of anything read off the shared stack.
  const sessionAgentName = new Map<string, string>();
  // Both maps are long-lived-process state (see the review-gate/pending-nudge
  // maps above for the same concern): evicted promptly on session.idle
  // (evictSessionTree, below), plus this size cap as a backstop for a
  // session that never idles (crashed process, killed terminal, a host that
  // doesn't emit session.idle). Map iteration order is insertion order, so
  // dropping from the front evicts the oldest entries first (approximate LRU).
  const SESSION_MAP_MAX_ENTRIES = 256;
  function capSessionMaps(): void {
    while (sessionParent.size > SESSION_MAP_MAX_ENTRIES) {
      const oldestKey = sessionParent.keys().next().value;
      if (oldestKey === undefined) break;
      sessionParent.delete(oldestKey);
      sessionAgentName.delete(oldestKey);
    }
    while (sessionAgentName.size > SESSION_MAP_MAX_ENTRIES) {
      const oldestKey = sessionAgentName.keys().next().value;
      if (oldestKey === undefined) break;
      sessionAgentName.delete(oldestKey);
    }
  }
  // Evicts a session (and any tracked children of it) from both maps —
  // called on session.idle so a finished session's tracking doesn't
  // accumulate for the life of this long-lived plugin process.
  function evictSessionTree(sessionId: string): void {
    sessionParent.delete(sessionId);
    sessionAgentName.delete(sessionId);
    for (const [childId, parentId] of sessionParent) {
      if (parentId === sessionId) {
        sessionParent.delete(childId);
        sessionAgentName.delete(childId);
      }
    }
  }

  // Depth rule (see module-level comment above): a call is a leaf call only
  // when its OWN calling session is a known OpenCode child session. Fails
  // open to "not a leaf" (orchestrator) when the session isn't tracked yet
  // (e.g. plugin process started mid-session) — never misclassifies a root
  // session as nested just because something else is on the shared stack.
  function isOpenCodeChildSession(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    return Boolean(sessionParent.get(sessionId));
  }

  const mcpRouting = buildMcpBackendRouting(agentsDir);

  function recordUserPromptSubmit(sessionId: string) {
    if (isDuplicateSubmit(sessionId, now())) return;
    // New turn: reset the orchestrator's direct-read counter, mirroring the
    // Claude hook's resetOrchestratorTurnReads on UserPromptSubmit.
    orchestratorTurnReads = 0;
    appendActivity(activityFile, {
      event: "UserPromptSubmit",
      provider: "opencode",
      at: now(),
      sessionId,
    });
  }

  function handleSessionCreated(properties: Record<string, unknown> | undefined) {
    const info = properties?.["info"] as { id?: string; parentID?: string; agent?: string } | undefined;
    const sessionId = info?.id;
    if (!sessionId) return;
    sessionParent.set(sessionId, info?.parentID);
    if (typeof info?.agent === "string") sessionAgentName.set(sessionId, info.agent);
    capSessionMaps();
    if (!info?.parentID) {
      recordUserPromptSubmit(sessionId);
    }
  }

  function handleMessageUpdated(properties: Record<string, unknown> | undefined) {
    const info = properties?.["info"] as { role?: string; sessionID?: string } | undefined;
    const sessionId = info?.sessionID ?? (properties?.["sessionID"] as string | undefined);
    if (!info || info.role !== "user" || !sessionId) return;
    const parentId = sessionParent.get(sessionId);
    if (parentId) return; // only root-session user messages map to UserPromptSubmit
    if (seenRootSessions.has(sessionId)) return; // dedupe: session.created already fired this turn's submit
    seenRootSessions.add(sessionId);
    recordUserPromptSubmit(sessionId);
  }

  function handleSessionIdle(properties: Record<string, unknown> | undefined) {
    const sessionId =
      (properties?.["sessionID"] as string | undefined) ??
      ((properties?.["info"] as { id?: string } | undefined)?.id);
    if (!sessionId) return;
    const parentId = sessionParent.get(sessionId);
    // Evict this session (and any tracked children of it) regardless of
    // whether it's root or a subagent session — a finished session's
    // tracking must not accumulate for the life of this long-lived process.
    evictSessionTree(sessionId);
    if (parentId) {
      // SubagentStop for a subagent session going idle without a matching
      // tool.execute.after (defensive path — the primary SubagentStop path
      // is tool.execute.after for tool 'task', below).
      return;
    }
    appendActivity(activityFile, {
      event: "Stop",
      provider: "opencode",
      at: now(),
      sessionId,
    });
    // The root session is ending — its review-gate entry (if any) is no
    // longer needed, so evict it now rather than waiting for the size cap
    // below to reclaim it (see reviewGateByParentSession's declaration).
    reviewGateByParentSession.delete(sessionId);
    // p15-t1: same eviction for tracked fallback failures — a session that
    // never fails should never accumulate fallback state, and one that does
    // fail shouldn't leak it past session end.
    fallbackState?.endSession(sessionId);
  }

  async function handleToolExecuteBefore(input: {
    tool?: string;
    sessionID?: string;
    callID?: string;
    args?: Record<string, unknown>;
  }) {
    const rawTool = input?.tool ?? "";
    const sessionId = input?.sessionID;
    const args = input?.args ?? {};

    if (rawTool === "task") {
      // -----------------------------------------------------------------
      // (4) Leaf-worker spawn guard — equivalent of tycoon-claude-hook.cjs's
      // PreToolUse isSpawn guard. Depth is derived from the active-agent
      // stack (see the module-level comment above): a non-empty stack means
      // this `task` call originated from (or on behalf of) a worker, not
      // the root orchestrator session.
      //
      // ACTUAL BLOCK (plan p15-t0): throwing a BlockingToolCallError below
      // aborts this `task` call and surfaces decision.message to the model
      // as the tool's error output — confirmed live against OpenCode
      // 1.18.27 in a real `opencode run` (see
      // docs/opencode-probe-findings.md "Enforcement mechanisms"). This is
      // now equivalent in effect to the Claude hook's stdout
      // permissionDecision:"deny", not merely a logged record.
      // -----------------------------------------------------------------
      // Depth comes ONLY from OpenCode's own session tree (see module-level
      // comment): the CALLING session (this `task` call's own sessionID)
      // must itself be a known OpenCode child session to count as a leaf.
      // The shared active-agent.json stack is never consulted here, so an
      // entry another provider (e.g. Claude Code) pushed can never cause a
      // root OpenCode session to be misread as nested.
      const isLeafCaller = isOpenCodeChildSession(sessionId);
      const spawnerAgentId = isLeafCaller ? sessionAgentName.get(sessionId!) || "unknown-opencode-worker" : "";
      if (delegationEnforcement && spawnerAgentId) {
        // team_leads tier is not modeled in this plugin (OPEN ISSUE — see
        // report): every spawner is treated as a non-lead leaf, matching
        // the Claude hook's default ("flat" delegation mode) posture.
        const decision = delegationEnforcement.decideSpawn({
          spawnerAgentId,
          spawnerAgentType: spawnerAgentId,
          delegationMode: "flat",
          spawnerIsLead: false,
        });
        if (decision.action === "deny") {
          appendActivity(activityFile, {
            event: "SpawnDenied",
            provider: "opencode",
            at: now(),
            tool: "Task",
            workerId: spawnerAgentId,
            sessionId,
            message: decision.message,
          });
          // GO mechanism (1): throwing here actually aborts the `task` call
          // and surfaces decision.message to the model as the tool's error
          // output (confirmed live — see docs/opencode-probe-findings.md).
          // Rethrown verbatim by the toolExecuteBefore wrapper below.
          throw new BlockingToolCallError(decision.message ?? delegationEnforcement.LEAF_WORKER_DENY_MESSAGE);
        }
      }

      let workerId = typeof args["subagent_type"] === "string" ? (args["subagent_type"] as string) : undefined;
      let routingMethod = workerId ? "explicit" : "fallback";
      let matchedKeyword: string | undefined;
      // (2) Keyword-based fallback routing, mirroring the Claude hook's
      // Priority 2 (matchAgentFromKeywords over description+prompt) for the
      // case where OpenCode's own `task` call carries no explicit
      // subagent_type (or one that doesn't resolve to a known agent file).
      if (delegationEnforcement && keywordsConfig) {
        const needsKeywordFallback =
          !workerId || (agentsDir && !fs.existsSync(path.join(agentsDir, workerId + ".md")));
        if (needsKeywordFallback) {
          const description = typeof args["description"] === "string" ? (args["description"] as string) : "";
          const prompt = typeof args["prompt"] === "string" ? (args["prompt"] as string).slice(0, 500) : "";
          const match = delegationEnforcement.matchAgentFromKeywords(
            `${description} ${prompt}`.toLowerCase(),
            keywordsConfig
          );
          if (match) {
            workerId = match.agentId;
            matchedKeyword = match.matchedKeyword;
            routingMethod = "keyword";
          } else if (!workerId) {
            workerId = keywordsConfig.fallback_agent || "primary-agent";
            routingMethod = "fallback";
          }
        }
      }

      const agentDescription = typeof args["description"] === "string" ? (args["description"] as string) : undefined;
      const backend = workerId ? readAgentBackendFromFile(agentsDir, workerId) : {};

      // p15-t1: on a re-dispatch of a slot that previously failed in this
      // session, rewrite the model to the next fallback chain entry. Setting
      // input.args.model here is BEST-EFFORT — docs/opencode-probe-findings.md
      // never confirmed args mutation from a hook is observed by OpenCode's
      // own tool execution; the instruction text queued via queueNudge (in
      // handleToolExecuteAfter below) is the mechanism actually relied on to
      // get the orchestrator to re-dispatch on the right model.
      let fallbackOf: string | undefined;
      let fallbackDepth: number | undefined;
      let fallbackModel: string | undefined;
      let fallbackVendor: string | undefined;
      if (fallbackState && workerId && sessionId) {
        const next = fallbackState.getNext(sessionId, workerId);
        if (next && !next.exhausted && next.slot?.model) {
          args["model"] = next.slot.model;
          input.args = args;
          // p15-t2: tag this dispatch as a fallback re-dispatch — the record
          // (and the matching SubagentStop, via the active-agent stack entry
          // below) must carry the ORIGINAL slot id, the 1-based chain
          // position, and the fallback model's own vendor/model, not the
          // originally assigned primary's.
          fallbackOf = workerId;
          fallbackDepth = next.index + 1;
          fallbackModel = next.slot.model;
          const slashIdx = fallbackModel.indexOf("/");
          fallbackVendor = slashIdx > 0 ? fallbackModel.slice(0, slashIdx) : undefined;
        }
      }

      const parentEntry = sessionId ? undefined : peekActiveAgent(activeAgentFile) ?? undefined;
      const parentId = parentEntry?.agentId && parentEntry.agentId !== "none" ? parentEntry.agentId : undefined;

      if (workerId) {
        pushActiveAgent(activeAgentFile, {
          agentId: workerId,
          timestamp: now(),
          subagentType: workerId,
          parentId,
          sessionId,
          fallbackOf,
          fallbackDepth,
          provider: "opencode",
        });
      }

      const record: OpenCodeHookRecord = {
        event: "PreToolUse",
        provider: "opencode",
        at: now(),
        tool: "Task",
        workerId,
        agentDescription,
        sessionId,
        parentId: sessionId, // parent SESSION id per findings (payload[0].sessionID = parent)
        routingMethod,
        matchedKeyword,
      };
      if (fallbackOf !== undefined) {
        // Fallback dispatch: model/vendor come from the chain entry that
        // actually runs, not the assigned primary. costModelClass is not
        // tracked per fallback-chain entry anywhere upstream (routing
        // generator only records "provider/model" strings), so the agent's
        // own declared costModelClass is kept as the best-effort value.
        record.fallbackOf = fallbackOf;
        record.fallbackDepth = fallbackDepth;
        if (fallbackVendor) record.vendor = fallbackVendor;
        if (fallbackModel) record.model = fallbackModel;
        if (backend.costModelClass) record.costModelClass = backend.costModelClass;
      } else {
        if (backend.vendor) record.vendor = backend.vendor;
        if (backend.model) record.model = backend.model;
        if (backend.costModelClass) record.costModelClass = backend.costModelClass;
      }
      appendActivity(activityFile, record);
      return;
    }

    // Attribution likewise comes from OpenCode's own session tree, not the
    // shared stack — see the module-level depth-rule comment.
    const workerId = isOpenCodeChildSession(sessionId)
      ? sessionAgentName.get(sessionId!) || "unknown-opencode-worker"
      : "orchestrator";
    const mappedTool = mapToolName(rawTool);
    const record: OpenCodeHookRecord = {
      event: "PreToolUse",
      provider: "opencode",
      at: now(),
      tool: mappedTool,
      workerId,
      sessionId,
    };
    const mcpBackend = lookupMcpBackend(mcpRouting, mappedTool);
    if (mcpBackend) {
      if (mcpBackend.vendor) record.vendor = mcpBackend.vendor;
      if (mcpBackend.model) record.model = mcpBackend.model;
      if (mcpBackend.costModelClass) record.costModelClass = mcpBackend.costModelClass;
    }

    // (1) Orchestrator direct-tool-call compliance nudge — equivalent of
    // tycoon-claude-hook.cjs's computeComplianceNudge. Only ever computed
    // for the orchestrator (empty active-agent stack); a spawned worker is
    // a leaf and is SUPPOSED to call these tools directly, so it is never
    // nagged, matching the Claude hook's own guard.
    if (delegationEnforcement && workerId === "orchestrator") {
      const decision = delegationEnforcement.decideDirectToolCall(mappedTool, orchestratorTurnReads);
      if (decision.nextReadCount !== undefined) orchestratorTurnReads = decision.nextReadCount;
      if (decision.action === "nudge" && decision.message) {
        record.message = decision.message;
        // GO mechanism (2): queue this nudge for delivery into the model's
        // own system prompt on its next turn via chat.system.transform
        // (confirmed live — see docs/opencode-probe-findings.md). Previously
        // this nudge only ever reached the activity log, never the model.
        queueNudge(sessionId, decision.message);
      }
    }

    appendActivity(activityFile, record);
  }

  // p15-t1 attempt 5: shared fallback-trigger logic, extracted so it can be
  // driven from either observable failure surface — a successful-but-failed
  // task's rendered output text (handleToolExecuteAfter, below), or the
  // bus `message.part.updated` event carrying a tool part in state
  // "error" (handled in dispatchEvent), which is the path that actually
  // fires for a real provider/connection failure (confirmed live —
  // docs/opencode-probe-findings.md "Remote VM smoke, attempt 5":
  // tool.execute.after never fires in that case at all).
  async function maybeTriggerFallback(
    workerId: string,
    rootSessionId: string | undefined,
    model: string | undefined,
    errorText: string
  ): Promise<void> {
    if (!fallbackChain || !fallbackState || workerId === "unknown" || !rootSessionId) return;
    if (!fallbackChain.isProviderFailure(errorText)) return;
    const chain = readFallbackChainForAgent(directory, workerId);
    const failureRecord = fallbackState.recordFailure(rootSessionId, workerId, chain, model, errorText.slice(0, 300));
    const result = fallbackChain.resolveNextFallback({
      slotId: workerId,
      chain,
      attemptsSoFar: failureRecord.attemptsSoFar - 1,
    });
    const instruction = fallbackChain.buildFallbackInstruction({
      workerId,
      failedProvider: model?.split("/")[0],
      failedModel: model?.split("/").slice(1).join("/") || model,
      reason: errorText.slice(0, 300) || "provider failure detected",
      result,
      chainLength: chain.length,
    });
    const nextModel = result.slot?.model;
    appendActivity(activityFile, {
      event: "FallbackTriggered",
      provider: "opencode",
      at: now(),
      workerId,
      slotId: workerId,
      sessionId: rootSessionId,
      failedModel: model,
      nextModel,
      reason: errorText.slice(0, 300),
      message: instruction,
    });
    queueNudge(rootSessionId, instruction);
  }

  // p15-t1 attempt 5: this is the path that ACTUALLY fires for a real
  // provider/connection failure. Live payload (docs/opencode-probe-findings.md
  // "Remote VM smoke, attempt 5"):
  //   event.type === "message.part.updated", properties.part = {
  //     type: "tool", tool: "task", callID, sessionID: <root>,
  //     state: { status: "error",
  //       error: "Subagent failed (task_id: ses_...): Cannot connect to
  //               API: Unable to connect. Is the computer able to access
  //               the url?",
  //       metadata: { parentSessionId, sessionId: <child>, model: {...} },
  //       input: { description, prompt, subagent_type } } }
  // and, moments earlier, a plain session.error event on the CHILD session
  // with error.name "APIError" and error.data.message the same text — but
  // that event carries no subagent_type/workerId, so the tool part above
  // (which has both the error text AND state.metadata/input) is the
  // reliable signal. tool.execute.after never fires at all in this case.
  async function handleTaskToolErrorPart(properties: Record<string, unknown> | undefined): Promise<void> {
    const part = properties?.["part"] as
      | {
          type?: string;
          tool?: string;
          sessionID?: string;
          state?: {
            status?: string;
            error?: string;
            input?: Record<string, unknown>;
            metadata?: { parentSessionId?: string; sessionId?: string; model?: { providerID?: string; modelID?: string } };
          };
        }
      | undefined;
    if (!part || part.type !== "tool" || part.tool !== "task") return;
    const state = part.state;
    if (!state || state.status !== "error") return;
    const errorText = typeof state.error === "string" ? state.error : "";
    if (!errorText) return;

    const metadata = state.metadata ?? {};
    const childSessionId = metadata.sessionId;
    const rootSessionId = metadata.parentSessionId ?? part.sessionID;
    const model =
      metadata.model?.providerID && metadata.model?.modelID
        ? `${metadata.model.providerID}/${metadata.model.modelID}`
        : undefined;

    // Resolve workerId the same way handleToolExecuteAfter does: prefer the
    // explicit subagent_type from the tool call's own input, fall back to
    // the active-agent stack entry pushed for this child session.
    const poppedEntry = childSessionId ? popActiveAgent(activeAgentFile, { sessionId: childSessionId }) : null;
    const workerId =
      (typeof state.input?.["subagent_type"] === "string" ? (state.input["subagent_type"] as string) : undefined) ??
      poppedEntry?.agentId ??
      "unknown";

    // tool.execute.after never fires for this failure (confirmed live), so
    // this is also the only place a SubagentStop gets recorded for it —
    // without it the active-agent stack entry above would still be popped
    // but no activity line would ever note the subagent's end.
    const record: OpenCodeHookRecord = {
      event: "SubagentStop",
      provider: "opencode",
      at: now(),
      workerId,
      sessionId: rootSessionId,
    };
    if (model) record.model = model;
    if (poppedEntry?.fallbackOf !== undefined) {
      record.fallbackOf = poppedEntry.fallbackOf;
      record.fallbackDepth = poppedEntry.fallbackDepth;
    }
    appendActivity(activityFile, record);

    await maybeTriggerFallback(workerId, rootSessionId, model, errorText);
  }

  async function handleToolExecuteAfter(
    input: { tool?: string; sessionID?: string; callID?: string; args?: Record<string, unknown> },
    output: { title?: string; metadata?: Record<string, unknown>; output?: string }
  ) {
    if (input?.tool !== "task") return;

    const metadata = (output?.metadata ?? {}) as {
      parentSessionId?: string;
      sessionId?: string;
      model?: { providerID?: string; modelID?: string };
    };
    const childSessionId = metadata.sessionId;
    // Pop the stack entry once (popActiveAgent mutates the file) and reuse
    // its fields for both workerId resolution and the fallbackOf/fallbackDepth
    // tag (p15-t2) — a second pop call would find nothing and silently lose them.
    const poppedEntry = childSessionId ? popActiveAgent(activeAgentFile, { sessionId: childSessionId }) : null;
    const workerId =
      (typeof input.args?.["subagent_type"] === "string" ? (input.args["subagent_type"] as string) : undefined) ??
      poppedEntry?.agentId ??
      "unknown";

    const model =
      metadata.model?.providerID && metadata.model?.modelID
        ? `${metadata.model.providerID}/${metadata.model.modelID}`
        : undefined;

    const { tokens, cacheReadTokens } = childSessionId
      ? await fetchSessionTokens(client, childSessionId)
      : {};

    const record: OpenCodeHookRecord = {
      event: "SubagentStop",
      provider: "opencode",
      at: now(),
      workerId,
      sessionId: metadata.parentSessionId ?? input.sessionID,
    };
    if (model) record.model = model;
    if (tokens !== undefined) record.tokens = tokens;
    if (cacheReadTokens !== undefined) record.cacheReadTokens = cacheReadTokens;
    if (poppedEntry?.fallbackOf !== undefined) {
      record.fallbackOf = poppedEntry.fallbackOf;
      record.fallbackDepth = poppedEntry.fallbackDepth;
    }
    appendActivity(activityFile, record);

    // p15-t1: provider-failure fallback. A task's rendered <task> output
    // string is the only observable result surface for a SUCCESSFUL `task`
    // tool call (docs/opencode-probe-findings.md (a) — no typed
    // success/error field), so a provider failure that still produced
    // output text is detected the same way the review-gate heuristic above
    // reads text out of that string. NOTE (attempt 5): for an actual
    // provider/connection failure, OpenCode never calls tool.execute.after
    // at all — see maybeTriggerFallback's other call site in the
    // message.part.updated dispatch handler below, which is the path that
    // actually fires for that case.
    const rootSessionId = metadata.parentSessionId ?? input.sessionID;
    const outputText = typeof output?.output === "string" ? output.output : "";
    await maybeTriggerFallback(workerId, rootSessionId, model, outputText);

    // (3) Single review-gate pass equivalent — BEST-EFFORT (see the
    // reviewGateByParentSession comment in createPlugin above for why this
    // is heuristic rather than driven by a dedicated OpenCode signal). Keyed
    // by the PARENT session (the orchestrator's session), since that is the
    // stable id shared by every specialist spawned from the same turn.
    const parentSessionId = metadata.parentSessionId ?? input.sessionID;
    if (delegationEnforcement && parentSessionId && workerId !== "unknown") {
      if (workerId === "uefn-auditor") {
        const gate = reviewGateByParentSession.get(parentSessionId);
        if (gate && !delegationEnforcement.isReviewGateTerminal(gate)) {
          // No structured approve/reject signal is observable from a task
          // tool's plain-text `output` (see docs/opencode-probe-findings.md
          // (a) — output is a rendered <task> string, not typed). Treat the
          // review as requesting changes only when its report text contains
          // an explicit rejection marker; otherwise treat it as approved —
          // matching the doctrine's "single pass" intent (progress, don't
          // stall) even though the verdict signal itself is best-effort.
          const outputText = typeof output?.output === "string" ? output.output : "";
          const approved = !/\b(changes requested|not approved|requires? (a )?fix)\b/i.test(outputText);
          const next = delegationEnforcement.advanceReviewGate(gate, approved);
          setReviewGate(parentSessionId, next);
          appendActivity(activityFile, {
            event: "ReviewGate",
            provider: "opencode",
            at: now(),
            sessionId: parentSessionId,
            reviewGateStatus: next.status,
          });
        }
      } else {
        // A non-review specialist finished: arm "awaiting_review" for this
        // parent session if no gate is active yet (a gate already in
        // progress, e.g. mid fix-and-recheck round, is left alone).
        const existing = reviewGateByParentSession.get(parentSessionId);
        if (!existing || delegationEnforcement.isReviewGateTerminal(existing)) {
          setReviewGate(parentSessionId, delegationEnforcement.startReviewGate());
        }
      }
    }
  }

  return {
    // Event dispatcher, exported so tests can call it directly without going
    // through OpenCode's actual plugin registration shape.
    dispatchEvent: async (evt: { type: string; properties?: Record<string, unknown> }) => {
      try {
        const type = evt?.type ?? "";
        const properties = evt?.properties;
        if (type === "session.created") {
          handleSessionCreated(properties);
        } else if (type === "message.updated") {
          handleMessageUpdated(properties);
        } else if (type === "session.idle") {
          handleSessionIdle(properties);
        } else if (type === "message.part.updated") {
          await handleTaskToolErrorPart(properties);
        }
      } catch (err) {
        writePluginError(activityFile, now(), err);
      }
    },
    toolExecuteBefore: async (input: {
      tool?: string;
      sessionID?: string;
      callID?: string;
      args?: Record<string, unknown>;
    }) => {
      try {
        await handleToolExecuteBefore(input);
      } catch (err) {
        // A BlockingToolCallError is a DELIBERATE doctrine block (spawn-guard
        // deny) — rethrow it so OpenCode aborts the tool call and surfaces
        // its message to the model (confirmed live behavior). Every other
        // error is unexpected plugin failure and must fail open, exactly
        // like every other hook in this file.
        if (err instanceof BlockingToolCallError) throw err;
        writePluginError(activityFile, now(), err);
      }
    },
    toolExecuteAfter: async (
      input: { tool?: string; sessionID?: string; callID?: string; args?: Record<string, unknown> },
      output: { title?: string; metadata?: Record<string, unknown>; output?: string }
    ) => {
      try {
        await handleToolExecuteAfter(input, output);
      } catch (err) {
        writePluginError(activityFile, now(), err);
      }
    },
    // GO mechanism (2): deliver any queued orchestrator nudges into the
    // model's own system prompt for its next turn. Never throws — an absent
    // or malformed `output.system` (older OpenCode, or a host that changes
    // the shape) is a no-op, not a crash, matching the fail-open posture of
    // every other hook here.
    chatSystemTransform: async (
      input: { sessionID?: string },
      output: { system?: string[] }
    ) => {
      try {
        const nudges = drainNudges(input?.sessionID);
        if (nudges.length === 0) return;
        if (!Array.isArray(output?.system)) return;
        for (const message of nudges) {
          output.system.push(`[TycoonAgents delegation nudge] ${message}`);
        }
      } catch (err) {
        writePluginError(activityFile, now(), err);
      }
    },
    // Exposed for tests / debugging.
    _paths: { activityFile, activeAgentFile, activityDir },
    // Exposed for tests only: sizes of the session-tree tracking maps, to
    // assert they shrink on session.idle rather than leaking for the life
    // of this long-lived plugin process.
    _debugSessionMapSizes: () => ({ sessionParent: sessionParent.size, sessionAgentName: sessionAgentName.size }),
  };
}

// ---------------------------------------------------------------------------
// OpenCode plugin entrypoint. Structural shape matches @opencode-ai/plugin's
// Plugin type (ctx: {client, project, worktree, directory, ...}) => Hooks,
// without importing that package. The `event` hook is the ONE hook OpenCode
// actually delivers session.*/message.* bus events through (confirmed by the
// probe spike); tool.execute.before/after are separate top-level hooks.
// ---------------------------------------------------------------------------

const TycoonOpenCodePlugin = async (ctx: { client?: OpenCodeClientLike; directory?: string }) => {
  const directory = typeof ctx?.directory === "string" ? ctx.directory : process.cwd();
  const plugin = createPlugin({ directory, client: ctx?.client });

  return {
    event: async (input: { event: { type: string; properties?: Record<string, unknown> } }) => {
      await plugin.dispatchEvent(input?.event ?? { type: "" });
    },
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> }
    ) => {
      // Deliberately NOT wrapped in try/catch here: a BlockingToolCallError
      // thrown out of plugin.toolExecuteBefore (spawn-guard deny) MUST
      // propagate to OpenCode so it aborts the tool call — that propagation
      // is the actual enforcement mechanism (see docs/opencode-probe-findings.md
      // "Enforcement mechanisms"). plugin.toolExecuteBefore itself already
      // catches and logs every non-blocking error, so nothing else can
      // reach here.
      await plugin.toolExecuteBefore({ ...input, args: output?.args });
    },
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string; args: Record<string, unknown> },
      output: { title: string; metadata: Record<string, unknown>; output: string }
    ) => {
      await plugin.toolExecuteAfter(input, output);
    },
    // GO mechanism (2) — absent on older OpenCode builds; OpenCode simply
    // never calls a hook key it doesn't support, so no version guard is
    // needed here (fail open by omission).
    "experimental.chat.system.transform": async (
      input: { sessionID?: string; model?: unknown },
      output: { system: string[] }
    ) => {
      await plugin.chatSystemTransform(input, output);
    },
  };
};

export default TycoonOpenCodePlugin;
