/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as fs from "fs";
import * as path from "path";

interface HookCommand {
  type: "command";
  command: string;
}
interface HookEntry {
  matcher: string;
  hooks: HookCommand[];
}

/** The Claude Code hook events + matchers TycoonAgents wires up. */
export const TYCOON_HOOK_SLOTS: ReadonlyArray<{ event: string; matcher: string }> = [
  { event: "UserPromptSubmit", matcher: "" },
  { event: "PreToolUse", matcher: "Task|Agent|Skill" },
  { event: "PreToolUse", matcher: "Read|Write|Edit|Grep|Glob|Bash" },
  { event: "PreToolUse", matcher: "mcp__" },
  { event: "SubagentStop", matcher: "" },
  { event: "Stop", matcher: "" },
  { event: "TaskCompleted", matcher: "" },
];

/**
 * Pure merge of TycoonAgents hook entries into an existing Claude Code settings
 * object. Adds our hook for each event/matcher in TYCOON_HOOK_SLOTS without
 * dropping unrelated hooks and without duplicating an entry whose matcher
 * already references our hook. No fs/vscode usage, so this is unit-testable.
 */
export function mergeTycoonHooks(
  existing: Record<string, unknown>,
  hookCommand: string
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...existing };
  const srcHooks = (existing.hooks as Record<string, unknown> | undefined) ?? {};
  const hooks: Record<string, HookEntry[]> = {};

  for (const event of Object.keys(srcHooks)) {
    const arr = srcHooks[event];
    hooks[event] = Array.isArray(arr) ? (arr.slice() as HookEntry[]) : [];
  }

  for (const slot of TYCOON_HOOK_SLOTS) {
    const list = hooks[slot.event] ?? (hooks[slot.event] = []);
    const matching = list.find(
      (e) => e !== null && typeof e === "object" && e.matcher === slot.matcher
    );
    const referencesOurHook =
      matching !== undefined &&
      Array.isArray(matching.hooks) &&
      matching.hooks.some(
        (h) =>
          h !== null &&
          typeof h === "object" &&
          typeof h.command === "string" &&
          h.command.includes("tycoon-claude-hook.cjs")
      );
    if (referencesOurHook) {
      continue;
    }
    list.push({
      matcher: slot.matcher,
      hooks: [{ type: "command", command: hookCommand }],
    });
  }

  result.hooks = hooks;
  return result;
}

// ---------------------------------------------------------------------------
// Leftover legacy agent-hook system cleanup
//
// Installing TycoonAgents onto a project that previously had a *different*
// hook-driven agent system installed can leave that system's hook commands
// wired into the very same Claude Code events we use (UserPromptSubmit,
// PreToolUse, SubagentStop, Stop, TaskCompleted) plus assorted state files at
// the `.claude/` root. Left in place, those foreign hooks double-fire
// alongside ours and their leftover state files can collide with/confuse our
// own activity tracking. Everything below is a *best-effort, idempotent*
// reset: safe to run on a totally clean project (no-ops throughout) and safe
// to re-run on every install.
// ---------------------------------------------------------------------------

/**
 * Basenames of hook scripts belonging to a foreign/legacy agent-hook system
 * (path-agnostic — matched by substring against the full command string, so
 * it doesn't matter how that system quoted or rooted its path). These are
 * plain data (filenames), not attributed to any named product.
 */
export const LEGACY_HOOK_BASENAMES: ReadonlyArray<string> = [
  "task-start.cjs",
  "task-stop.cjs",
  "session-stop.cjs",
  "error-detector.cjs",
  "delegation-enforcer.cjs",
  "teammate-idle.cjs",
  "task-completed.cjs",
];

/**
 * Known leftover state files a foreign/legacy agent-hook system may have left
 * at the `.claude/` root (NOT `.claude/tycoon/` — our own equivalents live
 * there and are never touched by this list). Once the foreign hook commands
 * that read/write them are stripped, these files are inert clutter.
 */
export const LEGACY_STATE_FILE_NAMES: ReadonlyArray<string> = [
  "hook-config.json",
  "agent-keywords.json",
  "agent-registry.json",
  "expression-events.json",
  "active-agent.json",
];

const LEGACY_ACTIVITY_FILE_PATTERN = /^agent-activity-.*\.json$/;

/** True if `command` looks like it invokes a foreign/legacy agent-hook script. */
function commandReferencesLegacyHook(command: unknown): boolean {
  if (typeof command !== "string" || command.length === 0) {
    return false;
  }
  if (command.includes("tycoon-claude-hook.cjs")) {
    return false;
  }
  return LEGACY_HOOK_BASENAMES.some((name) => command.includes(name));
}

/**
 * Pure scan (no fs, no mutation): returns every hook command found under
 * TYCOON_HOOK_SLOTS' events in `settings` that looks like it belongs to a
 * foreign/legacy agent-hook system. Used both by {@link cleanupForeignHookArtifacts}
 * and by Hook Doctor to report the same signal without performing the cleanup.
 */
export function findLegacyHookCommands(
  settings: Record<string, unknown> | null | undefined
): string[] {
  const found: string[] = [];
  if (!settings || typeof settings !== "object") {
    return found;
  }
  const hooksSection = (settings as { hooks?: unknown }).hooks;
  if (!hooksSection || typeof hooksSection !== "object") {
    return found;
  }
  const events = new Set(TYCOON_HOOK_SLOTS.map((s) => s.event));
  const hooks = hooksSection as Record<string, unknown>;
  for (const event of events) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      const inner = (entry as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(inner)) {
        continue;
      }
      for (const h of inner) {
        const cmd = (h as { command?: unknown } | null)?.command;
        if (commandReferencesLegacyHook(cmd)) {
          found.push(cmd as string);
        }
      }
    }
  }
  return found;
}

function readJsonFileSafe(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (raw === "") {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface CleanupResult {
  /** Foreign/legacy hook commands stripped out of settings files. */
  strippedForeignHookCommands: string[];
  /** True if a stale `active-agent.json.lock` was found and deleted. */
  clearedStaleLock: boolean;
  /** True if `active-agent.json` was reset to an empty stack. */
  resetStack: boolean;
  /** Basenames of leftover legacy state files that were deleted. */
  deletedLeftoverFiles: string[];
  /** Human-readable change log, for surfacing in the Hook Doctor UI. */
  changes: string[];
}

const SETTINGS_FILE_NAMES: ReadonlyArray<string> = ["settings.local.json", "settings.json"];

/**
 * Idempotently strips leftover foreign/legacy agent-hook artifacts under
 * `claudeDirRoot` (the project's `.claude` directory) so a fresh TycoonAgents
 * install lands in a clean hook environment:
 *
 * 1. Removes foreign/legacy hook commands wired into OUR events in
 *    settings.local.json / settings.json (our own entries and unrelated
 *    non-agent hooks are left untouched).
 * 2. Clears a stale `active-agent.json.lock` (any age — install is a safe
 *    reset point) and, if the stack looked stuck, resets `active-agent.json`
 *    to an empty stack.
 * 3. Deletes known leftover legacy state files at the `.claude/` root (see
 *    {@link LEGACY_STATE_FILE_NAMES}) plus any `agent-activity-*.json` files.
 *
 * Every step is guarded (existsSync / try-catch) so this is a safe no-op on
 * a project that never had a foreign hook system, and safe to call on every
 * install.
 */
export function cleanupForeignHookArtifacts(claudeDirRoot: string): CleanupResult {
  const result: CleanupResult = {
    strippedForeignHookCommands: [],
    clearedStaleLock: false,
    resetStack: false,
    deletedLeftoverFiles: [],
    changes: [],
  };

  // 1. Strip foreign/legacy hook commands from our event slots.
  const tycoonEvents = new Set(TYCOON_HOOK_SLOTS.map((s) => s.event));
  for (const fileName of SETTINGS_FILE_NAMES) {
    const filePath = path.join(claudeDirRoot, fileName);
    const parsed = readJsonFileSafe(filePath);
    const hooksSection = parsed ? (parsed as { hooks?: unknown }).hooks : undefined;
    if (!parsed || !hooksSection || typeof hooksSection !== "object") {
      continue;
    }
    const hooks = hooksSection as Record<string, unknown>;
    let changed = false;

    for (const event of tycoonEvents) {
      const entries = hooks[event];
      if (!Array.isArray(entries)) {
        continue;
      }
      const nextEntries: unknown[] = [];
      for (const entry of entries) {
        const inner = (entry as { hooks?: unknown } | null)?.hooks;
        if (!Array.isArray(inner)) {
          nextEntries.push(entry);
          continue;
        }
        const keptHooks = inner.filter((h) => {
          const cmd = (h as { command?: unknown } | null)?.command;
          return !commandReferencesLegacyHook(cmd);
        });
        if (keptHooks.length === inner.length) {
          // Nothing stripped from this entry -> leave it exactly as-is.
          nextEntries.push(entry);
          continue;
        }
        changed = true;
        for (const h of inner) {
          const cmd = (h as { command?: unknown } | null)?.command;
          if (commandReferencesLegacyHook(cmd)) {
            result.strippedForeignHookCommands.push(cmd as string);
          }
        }
        if (keptHooks.length > 0) {
          // Some non-foreign hooks remain in this entry -> keep the entry, drop the foreign ones.
          nextEntries.push({ ...(entry as object), hooks: keptHooks });
        }
        // else: every hook in this entry was foreign -> drop the now-empty shell entirely.
      }
      hooks[event] = nextEntries;
    }

    if (changed) {
      try {
        fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), "utf8");
        result.changes.push(`Stripped leftover legacy hook entries from ${fileName}`);
      } catch {
        /* best-effort */
      }
    }
  }

  // 2. Stale lock + stuck stack reset (safe reset point — install always wins).
  const tycoonDir = path.join(claudeDirRoot, "tycoon");
  const lockPath = path.join(tycoonDir, "active-agent.json.lock");
  const activeAgentPath = path.join(tycoonDir, "active-agent.json");

  let hadLock = false;
  if (fs.existsSync(lockPath)) {
    try {
      fs.unlinkSync(lockPath);
      hadLock = true;
      result.clearedStaleLock = true;
      result.changes.push("Cleared a stale hook lock");
    } catch {
      /* best-effort */
    }
  }

  if (fs.existsSync(activeAgentPath)) {
    const current = readJsonFileSafe(activeAgentPath);
    const stack = current && Array.isArray(current.stack) ? (current.stack as unknown[]) : [];
    const agentId = current && typeof current.agentId === "string" ? (current.agentId as string) : "none";
    const needsReset = hadLock || stack.length > 0 || agentId !== "none";
    if (needsReset) {
      try {
        fs.writeFileSync(
          activeAgentPath,
          JSON.stringify({ version: 1, agentId: "none", timestamp: Date.now(), stack: [] }, null, 2),
          "utf8"
        );
        result.resetStack = true;
        result.changes.push("Reset the active-agent stack");
      } catch {
        /* best-effort */
      }
    }
  }

  // 3. Delete known leftover legacy state files at the `.claude/` root.
  for (const name of LEGACY_STATE_FILE_NAMES) {
    const filePath = path.join(claudeDirRoot, name);
    if (fs.existsSync(filePath)) {
      try {
        try { fs.chmodSync(filePath, 0o666); } catch { /* best-effort */ }
        fs.unlinkSync(filePath);
        result.deletedLeftoverFiles.push(name);
      } catch {
        /* best-effort */
      }
    }
  }
  try {
    if (fs.existsSync(claudeDirRoot)) {
      for (const entry of fs.readdirSync(claudeDirRoot)) {
        if (LEGACY_ACTIVITY_FILE_PATTERN.test(entry)) {
          try {
            const entryPath = path.join(claudeDirRoot, entry);
            try { fs.chmodSync(entryPath, 0o666); } catch { /* best-effort */ }
            fs.unlinkSync(entryPath);
            result.deletedLeftoverFiles.push(entry);
          } catch {
            /* best-effort */
          }
        }
      }
    }
  } catch {
    /* best-effort */
  }
  if (result.deletedLeftoverFiles.length > 0) {
    result.changes.push(`Deleted ${result.deletedLeftoverFiles.length} leftover legacy state file(s)`);
  }

  return result;
}
