/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import type { NormalizedEvent, ActivityKind } from "../../core/events";
import type { HookRecord } from "./hookRecord";
import { DEFAULT_PROVIDER_ID } from "../../core/mappingRegistry";

const SPAWN_TOOLS = new Set<string>(["Task", "Agent", "Skill"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toolToActivityKind(tool: string): ActivityKind {
  if (tool.startsWith("mcp__")) return "wire";
  switch (tool) {
    case "Read":
    case "Grep":
    case "Glob":
      return "survey";
    case "Write":
      return "haul";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "build";
    case "Bash":
    case "PowerShell":
      return "shell";
    default:
      return "build";
  }
}

/**
 * Pure: translate one HookRecord into zero or more normalized events.
 * Returns [] if unmapped.
 * NOTE (v1 simplification): worker identity uses the hook payload's session id.
 * Parent<->sub-agent correlation (parentId/tier, Team Lead Mode Phase 3) is
 * carried through from the hook's active-agent-stack inference below — it is
 * approximate, not a ground-truth trace, per docs/plan/team-lead-mode.md.
 * delegationMode (Team Lead Mode Phase 4: measurement) is passed through
 * verbatim on WorkerSpawned/SessionStop when the hook record carries it.
 */
export function mapHookRecord(record: HookRecord): NormalizedEvent[] {
  // The current hook (hooks/tycoon-claude-hook.cjs) only ever writes the
  // literal string "orchestrator" or a real named agent id as workerId, and
  // omits it entirely to mean "orchestrator" (fallback below). A UUID-format
  // workerId is therefore always a legacy/malformed record from an old hook
  // version; skip it rather than folding it into "orchestrator", which would
  // over-credit the orchestrator's directEdits/directSearches/delegations
  // counts (see panel.ts's Delegation Health panel).
  if (record.workerId !== undefined && UUID_RE.test(record.workerId)) return [];
  const workerId = record.workerId ?? "orchestrator";
  // (p22-t1) provider/sessionId identity, stamped onto every event this
  // record produces below (via the `.map` at the end of this function).
  // `provider` mirrors mappingRegistry.resolveProviderId's own fallback
  // (DEFAULT_PROVIDER_ID = "claude-code") so a legacy record with no
  // `provider` field is tagged identically to how the registry already
  // dispatches it. `sessionId` defaults to "" (documented choice: an empty
  // string, never "unknown", so callers can treat presence/absence with a
  // simple truthiness check) when the record carries none — legacy hook
  // versions predating HookRecord.sessionId.
  const providerId = record.provider ?? DEFAULT_PROVIDER_ID;
  const sessionId = record.sessionId ?? "";
  const events = mapHookRecordUntagged(record, workerId);
  return events.map((e) => ({ ...e, provider: providerId, sessionId }));
}

function mapHookRecordUntagged(record: HookRecord, workerId: string): NormalizedEvent[] {
  switch (record.event) {
    case "UserPromptSubmit":
      return [{ type: "SessionStart", at: record.at }];
    case "Stop":
      return [
        {
          type: "SessionStop",
          at: record.at,
          ...(record.tokens !== undefined ? { tokens: record.tokens } : {}),
          ...(record.cacheReadTokens !== undefined ? { cacheReadTokens: record.cacheReadTokens } : {}),
          ...(record.model !== undefined ? { model: record.model } : {}),
          ...(record.delegationMode !== undefined ? { delegationMode: record.delegationMode } : {}),
        },
      ];
    case "ProviderError": {
      // p22-t5 fix round: codex's vendor gate (hooks/codexRouting.cjs's
      // resolveCodexSpecialist) writes {event:"ProviderError", reason:
      // "specialist-unavailable", workerId, model, vendor} to activity.jsonl
      // when a resolved specialist cannot run under the current provider —
      // never substituted for another model. message prefers an explicit
      // record.message, else is derived from reason/workerId/model so the
      // panel always has something readable even from a minimal record.
      const message =
        record.message ??
        (record.reason
          ? `${record.reason}${record.workerId ? `: ${record.workerId}` : ""}${record.model ? ` (${record.model})` : ""}`
          : "provider error");
      return [
        {
          type: "ProviderError",
          at: record.at,
          message,
          ...(record.workerId !== undefined ? { workerId: record.workerId } : {}),
        },
      ];
    }
    case "StopFailure": {
      // A turn killed by an API error (usage/rate limit, overloaded, billing,
      // model_not_found...). A subagent killed this way fires no SubagentStop,
      // so release its live spawn (WorkerStopped, NO TaskCompleted: it did not
      // finish) and then flag the error. ORDER MATTERS: WorkerStopped sets idle,
      // ProviderError afterwards leaves the worker in "error". The main session
      // (workerId "orchestrator") only gets the ProviderError.
      const message =
        record.message ??
        `${workerId} hit a provider error${record.reason ? ` (${record.reason})` : ""}`;
      const stopped: NormalizedEvent[] =
        workerId === "orchestrator"
          ? []
          : [
              {
                type: "WorkerStopped",
                at: record.at,
                workerId,
                ...(record.spawnId !== undefined ? { spawnId: record.spawnId } : {}),
              },
            ];
      const limit: NormalizedEvent[] =
        workerId === "orchestrator" && record.reason
          ? [
              {
                type: "OrchestratorLimit",
                at: record.at,
                kind: record.reason,
                // Short, capped; the hook never puts secrets in message/resetHint.
                message: message.slice(0, 200),
                ...(record.resetHint !== undefined ? { resetHint: record.resetHint.slice(0, 80) } : {}),
                ...(record.resetAt !== undefined ? { resetAt: record.resetAt } : {}),
              },
            ]
          : [];
      return [...stopped, { type: "ProviderError", at: record.at, message, workerId }, ...limit];
    }
    case "CodexSandboxUnavailable":
      return [{ type: "CodexSandboxUnavailable", at: record.at }];
    case "SubagentStop":
      // ORDER MATTERS: TaskCompleted first so task count increments before the
      // worker goes idle; WorkerStopped last so the idle timer is finalized.
      return [
        { type: "TaskCompleted", at: record.at, workerId },
        {
          type: "WorkerStopped",
          at: record.at,
          workerId,
          ...(record.tokens !== undefined ? { tokens: record.tokens } : {}),
          ...(record.cacheReadTokens !== undefined ? { cacheReadTokens: record.cacheReadTokens } : {}),
          ...(record.report !== undefined ? { report: record.report } : {}),
          ...(record.reportChars !== undefined ? { reportChars: record.reportChars } : {}),
          ...(record.usageReported !== undefined ? { usageReported: record.usageReported } : {}),
          ...(record.ok !== undefined ? { ok: record.ok } : {}),
          ...(record.spawnId !== undefined ? { spawnId: record.spawnId } : {}),
        },
      ];
    case "PreToolUse": {
      if (!record.tool) return [];
      if (record.tool === "Task" || record.tool === "Agent") {
        // A delegation spawns the worker and credits the orchestrator with a
        // DELEGATION, not a completed task. The orchestrator's `delegations`
        // counter is incremented by the WorkerSpawned reducer; emitting a
        // TaskCompleted for the orchestrator here would double-count the unit
        // (once at spawn for the orchestrator, once at the worker's
        // SubagentStop) and wrongly credit the orchestrator with completing
        // work it delegated away. The worker earns its TaskCompleted when it
        // actually finishes (SubagentStop).
        return [
          {
            type: "WorkerSpawned",
            at: record.at,
            workerId,
            role: record.tool,
            ...(record.model !== undefined ? { model: record.model } : {}),
            ...(record.agentDescription !== undefined ? { description: record.agentDescription } : {}),
            ...(typeof record.description === "string" && record.description.trim() !== ""
              ? { currentDescription: record.description }
              : {}),
            ...(record.parentId !== undefined ? { parentId: record.parentId } : {}),
            ...(record.tier !== undefined ? { tier: record.tier } : {}),
            ...(record.delegationMode !== undefined ? { delegationMode: record.delegationMode } : {}),
            ...(record.vendor !== undefined ? { vendor: record.vendor } : {}),
            ...(record.costModelClass !== undefined ? { costModelClass: record.costModelClass } : {}),
            ...(record.fallbackOf !== undefined ? { fallbackOf: record.fallbackOf } : {}),
            ...(record.fallbackDepth !== undefined ? { fallbackDepth: record.fallbackDepth } : {}),
            ...(record.fallbackIsDefault !== undefined ? { fallbackIsDefault: record.fallbackIsDefault } : {}),
            ...(record.fallbackModel !== undefined ? { fallbackModel: record.fallbackModel } : {}),
            ...(record.spawnId !== undefined ? { spawnId: record.spawnId } : {}),
            ...(record.roleInferred !== undefined ? { roleInferred: record.roleInferred } : {}),
          },
        ];
      }
      if (record.tool === "Skill") {
        // Skill spawns emit WorkerSpawned only — no TaskCompleted.
        return [
          {
            type: "WorkerSpawned",
            at: record.at,
            workerId,
            role: record.tool,
            ...(record.model !== undefined ? { model: record.model } : {}),
            ...(record.agentDescription !== undefined ? { description: record.agentDescription } : {}),
            ...(record.delegationMode !== undefined ? { delegationMode: record.delegationMode } : {}),
          },
        ];
      }
      return [
        {
          type: "WorkerActivity",
          at: record.at,
          workerId,
          kind: toolToActivityKind(record.tool),
          detail: record.tool,
          ...(record.model !== undefined ? { model: record.model } : {}),
          ...(record.vendor !== undefined ? { vendor: record.vendor } : {}),
          ...(record.costModelClass !== undefined ? { costModelClass: record.costModelClass } : {}),
        },
      ];
    }
    default:
      return [];
  }
}
