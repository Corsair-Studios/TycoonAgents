/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import type { NormalizedEvent, ActivityKind } from "../../core/events";
import type { HookRecord } from "./hookRecord";

const SPAWN_TOOLS = new Set<string>(["Task", "Agent", "Skill"]);

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
 * Pure: translate one HookRecord into a normalized event (or null if unmapped).
 * NOTE (v1 simplification): worker identity uses the hook payload's session id;
 * precise parent<->sub-agent correlation is a later refinement.
 */
export function mapHookRecord(record: HookRecord): NormalizedEvent | null {
  const workerId = record.workerId ?? "orchestrator";
  switch (record.event) {
    case "UserPromptSubmit":
      return { type: "SessionStart", at: record.at };
    case "Stop":
      return { type: "SessionStop", at: record.at };
    case "SubagentStop":
      return {
        type: "WorkerStopped",
        at: record.at,
        workerId,
        ...(record.tokens !== undefined ? { tokens: record.tokens } : {}),
      };
    case "PreToolUse": {
      if (!record.tool) return null;
      if (SPAWN_TOOLS.has(record.tool)) {
        return { type: "WorkerSpawned", at: record.at, workerId, role: record.tool };
      }
      return { type: "WorkerActivity", at: record.at, workerId, kind: toolToActivityKind(record.tool), detail: record.tool };
    }
    default:
      return null;
  }
}
