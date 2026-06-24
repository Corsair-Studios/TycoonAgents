/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

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
