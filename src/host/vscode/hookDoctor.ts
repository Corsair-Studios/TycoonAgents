import { TYCOON_HOOK_SLOTS, LEGACY_MATCHER_ALIASES } from "./hookInstall";

export type DoctorSeverity = "ok" | "warn" | "error";

export interface DoctorFinding {
  id: string;
  severity: DoctorSeverity;
  title: string;
  detail: string;
  fixable: boolean;
  destructive: boolean;
}

export interface DoctorInput {
  localSettings: any | null;
  sharedSettings: any | null;
  currentHookCommand: string;
  hookScriptExists: boolean;
  /**
   * Operational-health inputs (all optional). `diagnose` itself stays
   * fs-free/pure for unit testing, so the caller (panel.ts) does the actual
   * filesystem reads and passes the parsed results in here. Omitting a field
   * simply skips its corresponding check — install-time / settings-only
   * callers that don't have this data are unaffected.
   */
  legacyArtifacts?: { leftoverFiles: string[]; hookCommands: string[] };
  /** Age (ms) of `.claude/tycoon/active-agent.json.lock`, if it exists. */
  lockFileAgeMs?: number;
  /** Parsed `.claude/tycoon/active-agent.json`, or null if absent/unreadable. */
  activeAgentState?: { stack: unknown[]; agentId: string; timestampMs?: number } | null;
  /** Trailing raw lines from `.claude/tycoon/activity.jsonl` (already read by the caller). */
  activityTailLines?: string[];
  /** Clock used for staleness comparisons; defaults to Date.now(). Overridable for tests. */
  nowMs?: number;
}

const TYCOON_MARKER = "tycoon-claude-hook.cjs";

const TYCOON_EVENTS = Array.from(new Set(TYCOON_HOOK_SLOTS.map((s) => s.event)));

function getHooksSection(settings: any | null): Record<string, any[]> {
  if (!settings || typeof settings !== "object") {
    return {};
  }
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object") {
    return {};
  }
  return hooks as Record<string, any[]>;
}

function getCommandsFromEntry(entry: any): string[] {
  if (!entry || !Array.isArray(entry.hooks)) {
    return [];
  }
  return entry.hooks
    .filter((h: any) => h && typeof h.command === "string")
    .map((h: any) => h.command as string);
}

function getEntriesForEvent(hooks: Record<string, any[]>, event: string): any[] {
  const entries = hooks[event];
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries;
}

export function findForeignHooks(
  localSettings: any | null,
  sharedSettings: any | null
): string[] {
  const foreign = new Set<string>();
  for (const settings of [localSettings, sharedSettings]) {
    const hooks = getHooksSection(settings);
    for (const event of TYCOON_EVENTS) {
      for (const entry of getEntriesForEvent(hooks, event)) {
        for (const cmd of getCommandsFromEntry(entry)) {
          if (!cmd.includes(TYCOON_MARKER)) {
            foreign.add(cmd);
          }
        }
      }
    }
  }
  return Array.from(foreign);
}

function isTycoonCommand(cmd: string): boolean {
  return cmd.includes(TYCOON_MARKER);
}

function slotIsWiredIn(settings: any | null, slot: { event: string; matcher: string }, currentHookCommand: string): boolean {
  const hooks = getHooksSection(settings);
  for (const entry of getEntriesForEvent(hooks, slot.event)) {
    if (entry.matcher === slot.matcher) {
      for (const cmd of getCommandsFromEntry(entry)) {
        if (isTycoonCommand(cmd)) {
          return true;
        }
      }
    }
  }
  return false;
}

function countStaleInSettings(settings: any | null, currentHookCommand: string): number {
  let count = 0;
  const hooks = getHooksSection(settings);
  for (const event of TYCOON_EVENTS) {
    for (const entry of getEntriesForEvent(hooks, event)) {
      for (const cmd of getCommandsFromEntry(entry)) {
        if (isTycoonCommand(cmd) && cmd !== currentHookCommand) {
          count++;
        }
      }
    }
  }
  return count;
}

function hasDuplicateTycoonInSlot(settings: any | null, slot: { event: string; matcher: string }): boolean {
  const hooks = getHooksSection(settings);
  for (const entry of getEntriesForEvent(hooks, slot.event)) {
    if (entry.matcher === slot.matcher) {
      const cmds = getCommandsFromEntry(entry).filter(isTycoonCommand);
      if (cmds.length > 1) {
        return true;
      }
    }
  }
  return false;
}

function hasTycoonCommandsInSettings(settings: any | null): boolean {
  const hooks = getHooksSection(settings);
  for (const event of TYCOON_EVENTS) {
    for (const entry of getEntriesForEvent(hooks, event)) {
      for (const cmd of getCommandsFromEntry(entry)) {
        if (isTycoonCommand(cmd)) {
          return true;
        }
      }
    }
  }
  return false;
}

export function diagnose(input: DoctorInput): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  if (!input.hookScriptExists) {
    findings.push({
      id: "hook-script-missing",
      severity: "error",
      title: "Hook script missing",
      detail:
        "The tycoon-claude-hook.cjs script file was not found in .claude/tycoon/. Re-install hooks to restore it.",
      fixable: false,
      destructive: false,
    });
  }

  const missingSlots = TYCOON_HOOK_SLOTS.filter(
    (slot) =>
      !slotIsWiredIn(input.localSettings, slot, input.currentHookCommand) &&
      !slotIsWiredIn(input.sharedSettings, slot, input.currentHookCommand)
  );
  if (missingSlots.length > 0) {
    findings.push({
      id: "hooks-missing",
      severity: "error",
      title: "Hook slots not wired",
      detail: `${missingSlots.length} of ${TYCOON_HOOK_SLOTS.length} hook slots are not wired.`,
      fixable: true,
      destructive: false,
    });
  }

  const staleCount =
    countStaleInSettings(input.localSettings, input.currentHookCommand) +
    countStaleInSettings(input.sharedSettings, input.currentHookCommand);
  if (staleCount > 0) {
    findings.push({
      id: "hooks-stale",
      severity: "warn",
      title: "Stale hook paths",
      detail: `${staleCount} hook command(s) point to an outdated path.`,
      fixable: true,
      destructive: false,
    });
  }

  const hasDuplicate = TYCOON_HOOK_SLOTS.some(
    (slot) =>
      hasDuplicateTycoonInSlot(input.localSettings, slot) ||
      hasDuplicateTycoonInSlot(input.sharedSettings, slot)
  );
  if (hasDuplicate) {
    findings.push({
      id: "hooks-duplicate",
      severity: "warn",
      title: "Duplicate hook entries",
      detail: "One or more hook slots contain duplicate Tycoon commands.",
      fixable: true,
      destructive: false,
    });
  }

  const inLocal = hasTycoonCommandsInSettings(input.localSettings);
  const inShared = hasTycoonCommandsInSettings(input.sharedSettings);
  if (inLocal && inShared) {
    findings.push({
      id: "hooks-split",
      severity: "warn",
      title: "Hooks split across settings files",
      detail:
        "Tycoon hook commands were found in both settings.local.json and settings.json, which causes double execution. Keep hooks only in settings.local.json.",
      fixable: false,
      destructive: false,
    });
  }

  const foreignCmds = findForeignHooks(input.localSettings, input.sharedSettings);
  if (foreignCmds.length > 0) {
    const list = foreignCmds.map((c) => `  ${c}`).join("\n");
    findings.push({
      id: "hooks-foreign",
      severity: "warn",
      title: "Foreign hook commands detected",
      detail: `The following hook commands in Tycoon event-slots are not from this extension:\n${list}`,
      fixable: true,
      destructive: true,
    });
  }

  // ---------------------------------------------------------------------
  // Operational health: installed/wired correctly is not the same as
  // actually working. A leftover foreign hook system, a stale lock, or a
  // stuck active-agent stack can freeze activity tracking even though every
  // check above passes. These only fire when the caller supplied the
  // corresponding data (see DoctorInput) — a settings-only diagnose() call
  // (e.g. from install-time code that hasn't read the runtime state files)
  // simply skips them.
  // ---------------------------------------------------------------------

  const legacyLeftoverFiles = input.legacyArtifacts?.leftoverFiles ?? [];
  const legacyHookCommands = input.legacyArtifacts?.hookCommands ?? [];
  if (legacyLeftoverFiles.length > 0 || legacyHookCommands.length > 0) {
    findings.push({
      id: "legacy-artifacts",
      severity: "error",
      title: "Leftover agent-hook artifacts detected",
      detail:
        "Leftover files from a previously-installed agent system were found — they can corrupt activity tracking.",
      fixable: true,
      destructive: false,
    });
  }

  const STALE_LOCK_MS = 30_000;
  if (typeof input.lockFileAgeMs === "number" && input.lockFileAgeMs > STALE_LOCK_MS) {
    findings.push({
      id: "hooks-lock-stale",
      severity: "error",
      title: "Stale hook lock",
      detail: "A stale hook lock is blocking activity updates.",
      fixable: true,
      destructive: false,
    });
  }

  if (input.activeAgentState) {
    const { stack, agentId, timestampMs } = input.activeAgentState;
    const now = typeof input.nowMs === "number" ? input.nowMs : Date.now();
    const STUCK_STACK_MS = 10 * 60 * 1000;
    const hasActivity = (Array.isArray(stack) && stack.length > 0) || (agentId !== undefined && agentId !== "none");
    const isStale = typeof timestampMs === "number" && now - timestampMs > STUCK_STACK_MS;
    if (hasActivity && isStale) {
      findings.push({
        id: "hooks-stack-stuck",
        severity: "error",
        title: "Agent activity looks stuck",
        detail: "Agent activity looks stuck (the active-agent stack has not drained).",
        fixable: true,
        destructive: false,
      });
    }
  }

  if (Array.isArray(input.activityTailLines) && input.activityTailLines.length > 0) {
    const parsesOk = (line: string): boolean => {
      try {
        const parsed = JSON.parse(line);
        return !!parsed && typeof parsed === "object" && typeof parsed.event === "string";
      } catch {
        return false;
      }
    };
    const anyMalformed = input.activityTailLines.some((line) => line.trim() !== "" && !parsesOk(line));
    if (anyMalformed) {
      findings.push({
        id: "activity-malformed",
        severity: "warn",
        title: "Malformed activity records",
        detail: "Recent activity records are malformed.",
        fixable: false,
        destructive: false,
      });
    }
  }

  if (findings.length === 0) {
    findings.push({
      id: "hooks-healthy",
      severity: "ok",
      title: "Hooks are healthy",
      detail: `All ${TYCOON_HOOK_SLOTS.length} hook slots are correctly wired.`,
      fixable: false,
      destructive: false,
    });
  }

  return findings;
}

export function repairSettings(
  localSettings: any | null,
  currentHookCommand: string,
  opts: { removeForeign: boolean; foreignCommands?: string[] }
): { settings: any; changes: string[] } {
  const settings: any = JSON.parse(JSON.stringify(localSettings ?? {}));
  const changes: string[] = [];

  if (!settings.hooks || typeof settings.hooks !== "object") {
    settings.hooks = {};
  }

  // Upgrade any pre-existing pure-ours entry still wired to a legacy
  // matcher (e.g. the old bare "mcp__" PreToolUse matcher) to the current
  // matcher BEFORE the slot loop below runs. Without this, the slot loop
  // would find no entry matching the new matcher and push a brand-new one,
  // leaving the stale matcher's entry (and its tycoon hook command) in
  // place too — wiring our hook twice for the same event.
  for (const alias of LEGACY_MATCHER_ALIASES) {
    const list = settings.hooks[alias.event];
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (
        e &&
        typeof e === "object" &&
        e.matcher === alias.from &&
        Array.isArray(e.hooks) &&
        e.hooks.length > 0 &&
        e.hooks.every((h: any) => h && typeof h.command === "string" && isTycoonCommand(h.command))
      ) {
        e.matcher = alias.to;
        changes.push(`Upgraded ${alias.event} matcher "${alias.from}" -> "${alias.to}"`);
      }
    }
  }

  for (const slot of TYCOON_HOOK_SLOTS) {
    const { event, matcher } = slot;

    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
    }

    const entries: any[] = settings.hooks[event];
    let entry = entries.find((e: any) => e.matcher === matcher);

    if (!entry) {
      entry = { matcher, hooks: [] };
      entries.push(entry);
    }

    if (!Array.isArray(entry.hooks)) {
      entry.hooks = [];
    }

    const hasTycoon = entry.hooks.some(
      (h: any) => h && typeof h.command === "string" && isTycoonCommand(h.command)
    );

    if (!hasTycoon) {
      entry.hooks.push({ type: "command", command: currentHookCommand });
      changes.push(`Wired ${event} (${matcher || "any"}) hook`);
    } else {
      let fixedStale = false;
      for (const h of entry.hooks) {
        if (h && typeof h.command === "string" && isTycoonCommand(h.command) && h.command !== currentHookCommand) {
          h.command = currentHookCommand;
          fixedStale = true;
        }
      }
      if (fixedStale) {
        changes.push(`Fixed stale hook path in ${event}`);
      }

      const before = entry.hooks.length;
      let foundFirst = false;
      entry.hooks = entry.hooks.filter((h: any) => {
        if (h && typeof h.command === "string" && h.command === currentHookCommand) {
          if (!foundFirst) {
            foundFirst = true;
            return true;
          }
          return false;
        }
        return true;
      });
      if (entry.hooks.length < before) {
        changes.push(`Removed duplicate Tycoon hook in ${event}`);
      }
    }
  }

  if (opts.removeForeign && Array.isArray(opts.foreignCommands) && opts.foreignCommands.length > 0) {
    const foreignSet = new Set(opts.foreignCommands);
    let removedCount = 0;

    for (const event of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[event])) {
        continue;
      }
      settings.hooks[event] = settings.hooks[event]
        .map((entry: any) => {
          if (!entry || !Array.isArray(entry.hooks)) {
            return entry;
          }
          const before = entry.hooks.length;
          entry.hooks = entry.hooks.filter(
            (h: any) => !(h && typeof h.command === "string" && foreignSet.has(h.command))
          );
          removedCount += before - entry.hooks.length;
          return entry;
        })
        .filter((entry: any) => entry && Array.isArray(entry.hooks) && entry.hooks.length > 0);
    }

    if (removedCount > 0) {
      changes.push(`Removed ${removedCount} foreign hook(s)`);
    }
  }

  return { settings, changes };
}
