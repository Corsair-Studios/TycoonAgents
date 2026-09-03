/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import type { NormalizedEvent, ActivityKind } from "../../core/events";
import type { HookRecord } from "./hookRecord";

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
            ...(record.parentId !== undefined ? { parentId: record.parentId } : {}),
            ...(record.tier !== undefined ? { tier: record.tier } : {}),
            ...(record.delegationMode !== undefined ? { delegationMode: record.delegationMode } : {}),
            ...(record.vendor !== undefined ? { vendor: record.vendor } : {}),
            ...(record.costModelClass !== undefined ? { costModelClass: record.costModelClass } : {}),
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
