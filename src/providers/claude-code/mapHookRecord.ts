/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
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
 * NOTE (v1 simplification): worker identity uses the hook payload's session id;
 * precise parent<->sub-agent correlation is a later refinement.
 */
export function mapHookRecord(record: HookRecord): NormalizedEvent[] {
  const raw = record.workerId ?? "orchestrator";
  const workerId = UUID_RE.test(raw) ? "orchestrator" : raw;
  switch (record.event) {
    case "UserPromptSubmit":
      return [{ type: "SessionStart", at: record.at }];
    case "Stop":
      return [
        {
          type: "SessionStop",
          at: record.at,
          ...(record.tokens !== undefined ? { tokens: record.tokens } : {}),
          ...(record.model !== undefined ? { model: record.model } : {}),
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
        },
      ];
    case "PreToolUse": {
      if (!record.tool) return [];
      if (record.tool === "Task" || record.tool === "Agent") {
        // Spawn credit always goes to orchestrator (v1 simplification).
        return [
          {
            type: "WorkerSpawned",
            at: record.at,
            workerId,
            role: record.tool,
            ...(record.model !== undefined ? { model: record.model } : {}),
            ...(record.agentDescription !== undefined ? { description: record.agentDescription } : {}),
          },
          { type: "TaskCompleted", at: record.at, workerId: "orchestrator" },
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
          },
        ];
      }
      return [{ type: "WorkerActivity", at: record.at, workerId, kind: toolToActivityKind(record.tool), detail: record.tool }];
    }
    default:
      return [];
  }
}
