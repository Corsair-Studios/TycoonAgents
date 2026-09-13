#!/usr/bin/env node
/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * ---------------------------------------------------------------------------
 * Plan p23-t1: "Tycoon dispatcher MCP server" — a zero-dependency MCP stdio
 * server that lets Codex (or any MCP client) delegate a task to a
 * TycoonAgents specialist by name/keyword/fallback, the same routing
 * codexRouting.resolveCodexSpecialist already uses for Codex's native spawn
 * tool, then actually RUNS that specialist via a vendor-appropriate adapter
 * (hooks/dispatcherAdapters.cjs) — anthropic via `claude -p`, openai-
 * compatible/local/moonshot via HTTP, google/openai explicit errors, never a
 * silent model substitution (docs/codex-cross-vendor-bridge.md Option A).
 *
 * Transport/handshake: identical legacy MCP stdio flow to
 * hooks/claude-cli-mcp.cjs / hooks/openai-compatible-mcp.cjs (initialize ->
 * notifications/initialized -> tools/list -> tools/call), one JSON-RPC 2.0
 * message per line, protocolVersion echoed back.
 *
 * Tool: `delegate`
 *   input:  { specialist: string, task: string, description?: string }
 *   output: { content: [{type:"text", text}], structuredContent?: {usage},
 *             isError?: true }
 *
 * Flow per call:
 *   1. Resolve the specialist via codexRouting.resolveCodexSpecialist with
 *      dispatcherConfigured:true — explicit name (specialist field, mapped
 *      to toolInput.name) wins, else keyword match against `description`
 *      (falling back to `task` as the search text when description is
 *      absent), else keywordsConfig.fallback_agent.
 *   2. Nested-delegation denial: if env TYCOON_DISPATCH_DEPTH is already
 *      "1" (or higher) OR the calling codex thread (env
 *      TYCOON_CODEX_THREAD_ID) is present in tycoon-codex-hook.cjs's own
 *      active-agent-codex.json stack, return isError with
 *      delegationEnforcement.js's LEAF_WORKER_DENY_MESSAGE verbatim — no
 *      HookRecord write for a denial, mirroring evaluateSpawnRouting's own
 *      SpawnDenied path being reserved for actual routing denials, not this
 *      structural nesting guard. TYCOON_DISPATCH_DEPTH=1 is set on the
 *      adapter child process so IT cannot dispatch again.
 *   3. Adapter selection by the resolved specialist's vendor (parsed from
 *      .claude/agents/<id>.md via codexRouting.parseAgentVendor):
 *        anthropic                        -> claude -p json
 *        openai-compatible/local/moonshot -> OPENAI_COMPAT_BASE_URL HTTP call
 *        google                           -> gemini shim if configured, else error
 *        openai                           -> error "use Codex native agents"
 *      See hooks/dispatcherAdapters.cjs for the implementations and the
 *      TYCOON_DISPATCH_ADAPTER=stub override used by offline tests.
 *   4. activity.jsonl records (HookRecord shape, src/providers/claude-code/
 *      hookRecord.ts): a Task-shaped PreToolUse BEFORE the adapter call
 *      (tool:"Task", workerId, agentDescription, provider:"codex",
 *      sessionId: env TYCOON_CODEX_THREAD_ID or "dispatcher", parentId: that
 *      same thread id when present, vendor, costModelClass from the agent
 *      file's frontmatter) and, after, either a SubagentStop (tokens summed
 *      from the adapter's usage.input_tokens+output_tokens when reported) on
 *      success, or a ProviderError (reason:"dispatch-failed") on adapter
 *      failure — never substituting another model.
 *   5. Secrets: only env var NAMES ever appear in code, log text, or
 *      activity.jsonl records — never values.
 *
 * Path discovery (docs/PATH-DISCOVERY.md ladder) for activity.jsonl:
 *   1. TYCOON_PROJECT_DIR env var, if set.
 *   2. process.cwd().
 *   Explicit isError (both for a tools/call and thrown as a startup-time
 *   diagnostic on stderr) when neither resolves to a usable directory — this
 *   never silently drops telemetry.
 * ---------------------------------------------------------------------------
 */

"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const crypto = require("crypto");

const codexRouting = require("./codexRouting.cjs");
const codexRollout = require("./codexRollout.cjs");
const { LEAF_WORKER_DENY_MESSAGE } = require("./delegationEnforcement.js");
const dispatcherAdapters = require("./dispatcherAdapters.cjs");
const gateEvents = require("./gateEvents.cjs");

// Plan p29-t3: cursor file name this harness uses to track its own read
// position in <tycoonDir>/gate-events.jsonl, distinct from the Claude hook's
// "gate-events.cursor" and OpenCode's "gate-events.opencode.cursor" so none
// of the three harnesses consume another's events.
const CODEX_GATE_CURSOR_FILE = "gate-events.codex.cursor";

const SERVER_NAME = "tycoon-dispatcher-mcp";
const SERVER_VERSION = "1.0.0";

const DELEGATE_TOOL = {
  name: "delegate",
  description:
    "Delegate one task to a TycoonAgents specialist, resolved by name/keyword/fallback the same way Codex's native spawn routing works, then run it via a vendor-appropriate adapter (claude CLI for Anthropic specialists, HTTP for OpenAI-compatible/local/Moonshot ones). Nested delegation (a dispatched specialist trying to dispatch again) is refused.",
  inputSchema: {
    type: "object",
    properties: {
      specialist: { type: "string", description: "Explicit specialist/agent id to route to (e.g. \"coding-specialist\"). Wins over keyword matching when it names a known agent." },
      task: { type: "string", description: "The task text to send to the resolved specialist." },
      description: { type: "string", description: "Optional short description used for keyword routing when `specialist` doesn't name a known agent. Falls back to `task` when omitted." },
    },
    required: ["task"],
  },
};

function writeMessage(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function respond(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}
function respondError(id, code, message) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}
function isErrorResult(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

/** Path discovery for activity.jsonl — override-first, explicit failure on total failure. */
function resolveActivityFile() {
  const override = process.env.TYCOON_PROJECT_DIR;
  const projectDir = override && override.trim() ? override.trim() : process.cwd();
  if (!projectDir) {
    throw new Error("tycoon-dispatcher-mcp: could not resolve a project directory — set TYCOON_PROJECT_DIR.");
  }
  const tycoonDir = path.join(projectDir, ".claude", "tycoon");
  try {
    fs.mkdirSync(tycoonDir, { recursive: true });
  } catch {
    /* fail-open: appendRecord below no-ops if the dir truly can't be created */
  }
  return path.join(tycoonDir, "activity.jsonl");
}

function appendRecord(activityFile, record) {
  try {
    fs.appendFileSync(activityFile, JSON.stringify(record) + "\n", "utf8");
  } catch {
    /* never crash a dispatch over a telemetry write failure */
  }
}

function resolveActiveStackFile(projectDir) {
  return path.join(projectDir, ".claude", "tycoon", "active-agent-codex.json");
}

const CODEX_STACK_MAX_AGE_MS = 30 * 60 * 1000;

function readActiveStack(stackFile) {
  try {
    const raw = fs.readFileSync(stackFile, "utf8");
    const parsed = JSON.parse(raw);
    const stack = Array.isArray(parsed.stack) ? parsed.stack : [];
    const now = Date.now();
    return stack.filter((e) => typeof e.at !== "number" || now - e.at <= CODEX_STACK_MAX_AGE_MS);
  } catch {
    return [];
  }
}

/** True when nested delegation must be denied: TYCOON_DISPATCH_DEPTH>=1, or the calling
 * codex thread is itself a bound worker per tycoon-codex-hook.cjs's stack file. */
function isNestedDelegation(projectDir) {
  const depth = Number(process.env.TYCOON_DISPATCH_DEPTH || "0");
  if (Number.isFinite(depth) && depth >= 1) return true;
  const threadId = process.env.TYCOON_CODEX_THREAD_ID;
  if (!threadId) return false;
  const stack = readActiveStack(resolveActiveStackFile(projectDir));
  return stack.some((e) => e.threadId === threadId);
}

let cachedKeywordsConfig;
let cachedKeywordsError = false;
function loadKeywordsConfigFailOpen(projectDir) {
  if (cachedKeywordsConfig || cachedKeywordsError) return cachedKeywordsConfig;
  try {
    cachedKeywordsConfig = codexRouting.loadAgentKeywords(projectDir);
  } catch {
    cachedKeywordsError = true;
  }
  return cachedKeywordsConfig;
}

let cachedVendorMap;
function loadVendorMapFailOpen(agentsDir) {
  if (!cachedVendorMap) {
    try {
      cachedVendorMap = codexRouting.buildVendorMap(agentsDir);
    } catch {
      cachedVendorMap = new Map();
    }
  }
  return cachedVendorMap;
}

// p25-t3: fallback-on-provider-failure for adapter-run specialists. Mirrors
// the fail-open module loaders already used by the other hook wiring
// (getFallbackChainModule in hooks/tycoon-claude-hook.cjs /
// hooks/tycoon-opencode-plugin.ts) — fallbackChain.js lives next to this
// file (copied by scripts/copy-hook-runtime.mjs); its absence just means
// "no fallback, single attempt" rather than a crash.
let fallbackChainModule;
function getFallbackChainModule() {
  if (fallbackChainModule === undefined) {
    try {
      fallbackChainModule = require("./fallbackChain.js");
    } catch {
      fallbackChainModule = null;
    }
  }
  return fallbackChainModule;
}

/** Cap on chained fallback attempts per delegate call — mirrors
 * MAX_FALLBACK_DEPTH in src/core/routingProfile.ts (routing.json's own
 * `fallback` arrays are validated against that same limit, so this just
 * bounds a defaultFallback-only chain the same way). */
const MAX_FALLBACK_DEPTH = 3;

/** Reads .claude/tycoon/routing.resolved.json — the per-agent-over-defaults
 * MERGED output that scripts/apply-routing-profile.mjs writes from
 * src/core/routingProfile.ts's resolveAgentSlot/mergeSlots (defaults.fallback
 * is inherited only when the agent has no fallback of its own AND its vendor
 * matches the defaults' vendor). This is the exact same file and same field
 * path (`agents[id].fallback`, top-level `defaultFallback`) that
 * hooks/tycoon-claude-hook.cjs reads for its own fallback-chain resolution
 * (see readJsonSafe(path.join(tycoonDir, "routing.resolved.json")) there) —
 * reusing it keeps the dispatcher and the Claude hook in agreement instead
 * of re-deriving the merge here. Falls back to a raw parse of the SOURCE
 * routing.json (today's pre-fix behavior, unmerged) with one stderr warning
 * when routing.resolved.json is missing or unreadable — e.g. no routing
 * profile has been applied yet. */
function readRoutingChainForSpecialist(projectDir, specialistId) {
  const resolvedPath = path.join(projectDir, ".claude", "tycoon", "routing.resolved.json");
  try {
    const raw = fs.readFileSync(resolvedPath, "utf8");
    const parsed = JSON.parse(raw);
    const chainRaw =
      (parsed && parsed.agents && parsed.agents[specialistId] && parsed.agents[specialistId].fallback) || [];
    const agentEntry = parsed && parsed.agents && parsed.agents[specialistId];
    return {
      chain: Array.isArray(chainRaw) ? chainRaw : [],
      defaultFallback: parsed && parsed.defaultFallback,
      useDefaultFallback: agentEntry && agentEntry.useDefaultFallback === false ? false : true,
    };
  } catch {
    // routing.resolved.json absent/unreadable: fall back to the unmerged
    // source file, matching the pre-fix behavior, with a visible warning
    // since this path no longer applies per-agent/defaults vendor merging.
    try {
      process.stderr.write(
        "tycoon-dispatcher-mcp: routing.resolved.json unavailable, falling back to unmerged routing.json " +
          "(no defaults inheritance applied) for specialist " + String(specialistId) + "\n"
      );
      const raw = fs.readFileSync(path.join(projectDir, ".claude", "tycoon", "routing.json"), "utf8");
      const parsed = JSON.parse(raw);
      const chainRaw =
        (parsed && parsed.agents && parsed.agents[specialistId] && parsed.agents[specialistId].fallback) || [];
      const agentEntry = parsed && parsed.agents && parsed.agents[specialistId];
      return {
        chain: Array.isArray(chainRaw) ? chainRaw : [],
        defaultFallback: parsed && parsed.defaultFallback,
        useDefaultFallback: agentEntry && agentEntry.useDefaultFallback === false ? false : true,
      };
    } catch {
      return { chain: [], defaultFallback: undefined, useDefaultFallback: true };
    }
  }
}

/** True when an adapter failure should trigger fallback dispatch to the next
 * chain entry, rather than surfacing the error directly. Reuses
 * fallbackChain.js's isProviderFailure pattern list (usage limit, 401/429,
 * rate limit, RESOURCE_EXHAUSTED, ECONNREFUSED, etc.) and additionally
 * treats this dispatcher's own missing-endpoint-env message
 * (dispatcherAdapters.cjs's missingVendorEnvMessage output, e.g.
 * "OPENAI_COMPAT_BASE_URL is not set in the Codex process environment or
 * the TycoonAgents local env store.") as a failure — a missing endpoint is
 * exactly the kind of condition a fallback chain exists to route around. */
function isDispatchFailure(fallbackChain, errorText) {
  if (fallbackChain && fallbackChain.isProviderFailure(errorText)) return true;
  return /not set in the Codex process environment or the TycoonAgents local env store\./.test(
    String(errorText || "")
  );
}

async function handleDelegateTool(args) {
  const task = args && typeof args.task === "string" ? args.task : undefined;
  if (!task) return isErrorResult("Missing required argument: task");

  const override = process.env.TYCOON_PROJECT_DIR;
  const projectDir = override && override.trim() ? override.trim() : process.cwd();
  const agentsDir = path.join(projectDir, ".claude", "agents");

  let activityFile;
  try {
    activityFile = resolveActivityFile();
  } catch (err) {
    return isErrorResult(err && err.message ? err.message : String(err));
  }

  // Nested-delegation denial — structural, no HookRecord write.
  if (isNestedDelegation(projectDir)) {
    return isErrorResult(LEAF_WORKER_DENY_MESSAGE);
  }

  const keywordsConfig = loadKeywordsConfigFailOpen(projectDir);
  const knownAgentIds = codexRouting.listKnownAgentIds(agentsDir);
  const vendorMap = loadVendorMapFailOpen(agentsDir);

  const toolInput = {
    name: typeof args.specialist === "string" ? args.specialist : undefined,
    description: typeof args.description === "string" && args.description ? args.description : task,
    prompt: task,
  };

  const routing = codexRouting.resolveCodexSpecialist({
    toolInput,
    activeAgentStack: [],
    keywordsConfig,
    knownAgentIds,
    vendorOf: (id) => vendorMap.get(id),
    dispatcherConfigured: true,
  });

  if (routing.denied) {
    if (routing.providerError) {
      appendRecord(activityFile, { ...routing.providerError, sessionId: process.env.TYCOON_CODEX_THREAD_ID || "dispatcher", at: Date.now() });
    }
    return isErrorResult(routing.message || `delegate: routing denied (${routing.reason || "no-match"})`);
  }

  const workerId = routing.workerId;
  const info = vendorMap.get(workerId) || {};
  const vendor = info.vendor;
  const model = info.model;
  const costModelClass = costModelClassFromAgentFile(path.join(agentsDir, `${workerId}.md`), vendor);

  // Plan p23-t9: Codex's MCP server env never carries TYCOON_CODEX_THREAD_ID
  // (Codex doesn't set it for its own MCP-hosted tools), so a call made via
  // this dispatcher would otherwise always record under sessionId
  // "dispatcher" — invisible under the live Codex session in the panel.
  // Resolve the calling thread by scanning CODEX_HOME/sessions for the
  // newest user-originated rollout whose cwd matches this project, falling
  // back to "dispatcher" (with one stderr warning) when nothing matches.
  let threadId = process.env.TYCOON_CODEX_THREAD_ID;
  if (!threadId) {
    let found = null;
    try {
      found = codexRollout.findNewestUserThreadForCwd(projectDir, process.env);
    } catch {
      found = null;
    }
    if (found) {
      threadId = found;
    } else {
      threadId = "dispatcher";
      try {
        process.stderr.write(
          `[tycoon-dispatcher-mcp] could not resolve a live Codex parent thread for cwd "${projectDir}" (no matching rollout under CODEX_HOME/sessions); recording sessionId "dispatcher".\n`,
        );
      } catch { /* never let a stderr write break a dispatch */ }
    }
  }
  // Per-call spawn id — parity with hooks/tycoon-claude-hook.cjs's
  // generateSpawnId. This dispatcher call is synchronous end-to-end (await
  // adapterFn, then write the matching SubagentStop below), so one id per
  // call is always exact — no cross-call binding is needed as it is on the
  // Claude Code hook.
  const spawnId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `spawn-${Date.now()}`;

  const preRecord = {
    event: "PreToolUse",
    provider: "codex",
    tool: "Task",
    workerId,
    agentDescription: toolInput.description,
    sessionId: threadId,
    vendor,
    model,
    spawnId,
    at: Date.now(),
  };
  if (costModelClass) preRecord.costModelClass = costModelClass;
  if (threadId !== "dispatcher") preRecord.parentId = threadId;
  appendRecord(activityFile, preRecord);

  // p25-t3: fallback loop. Attempt 0 always runs on the originally resolved
  // (vendor, model); on a provider-failure error it advances to the next
  // entry in the specialist's routing.json `fallback` chain (or the
  // top-level `defaultFallback` when the specialist has none), up to
  // MAX_FALLBACK_DEPTH — never selecting a model outside that chain. Each
  // fallback attempt gets its own Task-shaped PreToolUse
  // (fallbackOf:workerId, fallbackDepth) before the adapter call, mirroring
  // the PreToolUse already written above for attempt 0.
  const fallbackChainModule = getFallbackChainModule();
  const { chain: fallbackChainEntries, defaultFallback, useDefaultFallback } = readRoutingChainForSpecialist(projectDir, workerId);

  let currentVendor = vendor;
  let currentModel = model;
  let fallbackDepth = 0;
  let fallbackIsDefault = false;

  for (;;) {
    const { fn: adapterFn } = dispatcherAdapters.resolveAdapter(currentVendor);

    // Set depth marker for the child adapter process — it must not dispatch again.
    const prevDepth = process.env.TYCOON_DISPATCH_DEPTH;
    process.env.TYCOON_DISPATCH_DEPTH = "1";
    let result;
    try {
      result = await adapterFn(task, { vendor: currentVendor, model: currentModel, workerId });
    } finally {
      if (prevDepth === undefined) delete process.env.TYCOON_DISPATCH_DEPTH;
      else process.env.TYCOON_DISPATCH_DEPTH = prevDepth;
    }

    if (!result.error) {
      const tokens =
        result.usage && (typeof result.usage.input_tokens === "number" || typeof result.usage.output_tokens === "number")
          ? (result.usage.input_tokens || 0) + (result.usage.output_tokens || 0)
          : undefined;
      const stopRecord = { event: "SubagentStop", provider: "codex", workerId, sessionId: threadId, spawnId, at: Date.now() };
      if (fallbackDepth > 0) {
        stopRecord.fallbackOf = workerId;
        stopRecord.fallbackDepth = fallbackDepth;
        stopRecord.fallbackIsDefault = fallbackIsDefault;
      }
      if (typeof tokens === "number") stopRecord.tokens = tokens;
      // p-savings-eligibility: tokens above are real vendor-reported counts
      // (result.usage.input_tokens/output_tokens from the adapter's own API
      // response — claude -p json for anthropic, the chat-completions
      // response body for openai-compatible/moonshot/local) whenever
      // present; there is no estimate/synthesized fallback in this file, so
      // usageReported is simply whether that number was available at all.
      stopRecord.usageReported = typeof tokens === "number";
      appendRecord(activityFile, stopRecord);

      // Plan p29-t3: prefix any unseen plan-gate events onto the delegate
      // result text, mirroring the Claude hook's additionalContext surfacing
      // so the Codex orchestrator (which never sees Claude Code hooks) still
      // learns about gate approvals/rejections — via the one channel it does
      // have, a tool result. Best-effort/fail-open: a read failure yields no
      // events rather than breaking the delegate call.
      let resultText = result.text || "";
      try {
        const tycoonDir = path.join(projectDir, ".claude", "tycoon");
        const unseenGateEvents = gateEvents.readUnseenGateEvents(tycoonDir, CODEX_GATE_CURSOR_FILE);
        const gateLines = gateEvents.formatGateEventLines(unseenGateEvents);
        if (gateLines) resultText = gateLines + "\n\n" + resultText;
      } catch { /* fail open: never let gate-event surfacing break a dispatch */ }

      const out = { content: [{ type: "text", text: resultText }] };
      if (result.usage) out.structuredContent = { usage: result.usage };
      return out;
    }

    const errorRecord = {
      event: "ProviderError",
      provider: "codex",
      reason: "dispatch-failed",
      workerId,
      model: currentModel,
      vendor: currentVendor,
      message: result.error,
      sessionId: threadId,
      at: Date.now(),
    };
    if (fallbackDepth > 0) {
      errorRecord.fallbackOf = workerId;
      errorRecord.fallbackDepth = fallbackDepth;
      errorRecord.fallbackIsDefault = fallbackIsDefault;
    }
    appendRecord(activityFile, errorRecord);

    if (!isDispatchFailure(fallbackChainModule, result.error) || fallbackDepth >= MAX_FALLBACK_DEPTH) {
      return isErrorResult(`delegate: ${workerId} failed: ${result.error}`);
    }

    if (!fallbackChainModule) {
      return isErrorResult(`delegate: ${workerId} failed: ${result.error}`);
    }

    const next = fallbackChainModule.resolveNextFallback({
      slotId: workerId,
      chain: fallbackChainEntries,
      attemptsSoFar: fallbackDepth,
      defaultFallback,
      useDefaultFallback,
      failingSlot: { vendor: currentVendor, model: currentModel },
    });
    if (next.exhausted || !next.slot) {
      return isErrorResult(`delegate: ${workerId} failed: ${result.error}`);
    }

    fallbackDepth += 1;
    fallbackIsDefault = next.isDefault === true;
    currentVendor = next.slot.vendor || currentVendor;
    currentModel = next.slot.model || currentModel;

    const fbPreRecord = {
      event: "PreToolUse",
      provider: "codex",
      tool: "Task",
      workerId,
      agentDescription: toolInput.description,
      sessionId: threadId,
      vendor: currentVendor,
      model: currentModel,
      fallbackOf: workerId,
      fallbackDepth,
      fallbackIsDefault,
      spawnId,
      at: Date.now(),
    };
    if (next.slot.costModelClass) fbPreRecord.costModelClass = next.slot.costModelClass;
    if (threadId !== "dispatcher") fbPreRecord.parentId = threadId;
    appendRecord(activityFile, fbPreRecord);
  }
}

/** vendor -> HookRecord.costModelClass fallback for agents with no `backend:` block
 * (anthropic subscription-backed here since this bridge uses the user's own claude CLI login). */
function vendorCostModelClass(vendor) {
  const v = String(vendor || "").toLowerCase();
  if (v === "anthropic") return "subscription";
  if (v === "local") return "local";
  if (v === "openai-compatible" || v === "moonshot" || v === "google" || v === "openai") return "metered";
  return undefined;
}

/**
 * Plan p23-t9: derives costModelClass for a resolved specialist from its
 * agent file's `backend.costModelClass` (agentBackend.ts's own rule:
 * src/core/agentBackend.ts parseAgentBackend — an explicit backend block's
 * costModelClass always wins) so a locally-hosted specialist like
 * kimi-reviewer (backend.costModelClass: local) is never misreported as
 * "metered" from a vendor-only guess. Falls back to vendorCostModelClass
 * when the agent file has no backend block, or no backend.costModelClass
 * line, or can't be read/parsed — fail-open, never throws.
 */
function costModelClassFromAgentFile(agentFilePath, vendor) {
  try {
    const raw = fs.readFileSync(agentFilePath, "utf8");
    const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const backendBlockMatch = fmMatch[1].match(/^backend:\s*\n((?:[ \t]+.+\n?)+)/m);
      if (backendBlockMatch) {
        const cmcMatch = backendBlockMatch[1].match(/^\s*costModelClass:\s*(.+)$/m);
        if (cmcMatch) {
          const value = cmcMatch[1].trim();
          if (value === "metered" || value === "subscription" || value === "local") return value;
        }
      }
    }
  } catch {
    /* fail-open: fall through to the vendor-based guess below */
  }
  return vendorCostModelClass(vendor);
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    const clientProtocolVersion = params && typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";
    respond(id, {
      protocolVersion: clientProtocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }

  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    respond(id, { tools: [DELEGATE_TOOL] });
    return;
  }

  if (method === "tools/call") {
    const toolName = params && params.name;
    const args = (params && params.arguments) || {};
    if (toolName !== "delegate") {
      respond(id, { isError: true, content: [{ type: "text", text: `Unknown tool: ${toolName}` }] });
      return;
    }
    try {
      const result = await handleDelegateTool(args);
      respond(id, result);
    } catch (err) {
      respond(id, { isError: true, content: [{ type: "text", text: `Unexpected error: ${err && err.message ? err.message : String(err)}` }] });
    }
    return;
  }

  if (id !== undefined) {
    respondError(id, -32601, `Method not found: ${method}`);
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      try {
        process.stderr.write(`[tycoon-dispatcher-mcp] ignoring malformed JSON-RPC line: ${err && err.message ? err.message : String(err)}\n`);
      } catch { /* never let a stderr write break the server */ }
      return;
    }
    handleRequest(msg).catch(() => { /* handleRequest itself never rejects; defensive only */ });
  });
  rl.on("close", () => process.exit(0));
}

module.exports = {
  resolveActivityFile,
  resolveActiveStackFile,
  isNestedDelegation,
  handleDelegateTool,
  vendorCostModelClass,
  costModelClassFromAgentFile,
  DELEGATE_TOOL,
};

if (require.main === module) {
  main();
}
