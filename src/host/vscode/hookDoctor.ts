import * as fs from "fs";
import { TYCOON_HOOK_SLOTS, LEGACY_MATCHER_ALIASES } from "./hookInstall";
import { isElectronHostBinary } from "../../providers/codex/resolveNodeBinary";

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
  /** Platform/fs seams for interpreter staleness (default: real host). */
  env?: HookEnv;
  /** Result of running the hook's node interpreter under a minimal PATH (see hookNodeCheck.ts). */
  interpreterCheck?: { ok: boolean; interpreter: string };
  /** TYCOON_NODE_PATH value that points at an editor/Electron helper (ignored by discovery). */
  nodeOverrideRejected?: string;
  /** Clock used for staleness comparisons; defaults to Date.now(). Overridable for tests. */
  nowMs?: number;
}

/** Seams so staleness decisions do not depend on the host OS or disk. */
export interface HookEnv {
  platform?: NodeJS.Platform;
  fileExists?: (p: string) => boolean;
  /** Executable-bit probe; defaults to accessSync(X_OK), or "true" when a fileExists seam is supplied. */
  isExecutable?: (p: string) => boolean;
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
          if (!isTycoonCommand(cmd)) {
            foreign.add(cmd);
          }
        }
      }
    }
  }
  return Array.from(foreign);
}

/**
 * True for the pre-0.0.665 project-relative hook command form
 * (`node .claude/tycoon/tycoon-claude-hook.cjs`, no quotes, no absolute
 * path) — the form that silently stops firing once a session's cwd leaves
 * the project root mid-session (see panel.ts's `_buildHookCommand`). Used
 * only to give that specific case a clearer diagnostic than generic
 * staleness; `countStaleInSettings`/`repairSettings` already catch and fix
 * it regardless, via the plain `cmd !== currentHookCommand` comparison.
 */
function isRelativeHookCommand(cmd: string): boolean {
  return isTycoonCommand(cmd) && /^node\s+\.claude[\\/]tycoon[\\/]tycoon-claude-hook\.cjs\s*$/.test(cmd.trim());
}

function countRelativeInSettings(settings: any | null): number {
  let count = 0;
  const hooks = getHooksSection(settings);
  for (const event of TYCOON_EVENTS) {
    for (const entry of getEntriesForEvent(hooks, event)) {
      for (const cmd of getCommandsFromEntry(entry)) {
        if (isRelativeHookCommand(cmd)) count++;
      }
    }
  }
  return count;
}

/**
 * Minimal shell-word splitter for the hook command forms we write: double-quoted
 * (no escapes, so Windows backslashes stay literal), single-quoted (with the
 * `'\''` escape, i.e. a quote closed, an escaped quote, a quote reopened), and
 * bare words. Adjacent quoted/bare pieces concatenate into one token.
 */
function leadingTokens(cmd: string, max: number): string[] {
  const tokens: string[] = [];
  const text = cmd.trim();
  let i = 0;
  while (tokens.length < max && i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    let tok = "";
    while (i < text.length && !/\s/.test(text[i])) {
      const ch = text[i];
      if (ch === '"') {
        const end = text.indexOf('"', i + 1);
        const stop = end === -1 ? text.length : end;
        tok += text.slice(i + 1, stop);
        i = end === -1 ? text.length : end + 1;
      } else if (ch === "'") {
        const end = text.indexOf("'", i + 1);
        const stop = end === -1 ? text.length : end;
        tok += text.slice(i + 1, stop);
        i = end === -1 ? text.length : end + 1;
      } else if (ch === "\\" && text[i + 1] === "'") {
        tok += "'";
        i += 2;
      } else {
        tok += ch;
        i++;
      }
    }
    tokens.push(tok);
  }
  return tokens;
}

/** True only when the command's script argument (the token after the interpreter) is the Tycoon hook script. */
export function isTycoonCommand(cmd: string): boolean {
  const tokens = leadingTokens(cmd, 2);
  const script = tokens.length >= 2 ? tokens[1] : tokens[0];
  if (!script) {
    return false;
  }
  const last = script.split(/[\\/]/).pop();
  return last === TYCOON_MARKER;
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

/**
 * True when `cmd` (a Tycoon command) should be rewritten to `currentHookCommand`.
 * On macOS/Linux a stored command whose interpreter is an ABSOLUTE node that
 * exists, is executable and is not an Electron host, with the same script, is
 * never stale, even when discovery now returns a different valid node (no
 * ping-pong between two installs). Only bare `node`, or a missing, non-executable
 * or Electron interpreter, is stale. Windows: any difference is stale.
 */
export function isStaleCommand(cmd: string, currentHookCommand: string, env: HookEnv = {}): boolean {
  if (cmd === currentHookCommand) return false;
  const platform = env.platform ?? process.platform;
  if (platform === "win32") return true;
  const cur = leadingTokens(currentHookCommand, 2);
  const old = leadingTokens(cmd, 2);
  if (cur.length === 2 && old.length === 2 && cur[1] === old[1] && old[0].startsWith("/") && !isElectronHostBinary(old[0])) {
    const exists = env.fileExists ?? ((p: string) => fs.existsSync(p));
    const executable =
      env.isExecutable ??
      (env.fileExists
        ? () => true
        : (p: string) => {
            try {
              fs.accessSync(p, fs.constants.X_OK);
              return true;
            } catch {
              return false;
            }
          });
    if (exists(old[0]) && executable(old[0])) return false;
  }
  return true;
}

/**
 * Standalone re-install helper: rewrites existing Tycoon commands that are stale
 * (bare `node`, or a missing/non-executable/Electron interpreter) to
 * `currentHookCommand`, only when they run the SAME script, and never on Windows.
 * Everything else is untouched. Returns the SAME object when nothing changed.
 */
export function rewriteStaleTycoonInterpreters(
  settings: Record<string, unknown>,
  currentHookCommand: string,
  env: HookEnv = {}
): { settings: Record<string, unknown>; changed: boolean } {
  if ((env.platform ?? process.platform) === "win32") return { settings, changed: false };
  const copy: any = JSON.parse(JSON.stringify(settings));
  const curScript = leadingTokens(currentHookCommand, 2)[1];
  let changed = false;
  const hooks = getHooksSection(copy);
  for (const event of Object.keys(hooks)) {
    for (const entry of getEntriesForEvent(hooks, event)) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (!h || typeof h.command !== "string" || !isTycoonCommand(h.command)) continue;
        if (leadingTokens(h.command, 2)[1] !== curScript) continue;
        if (isStaleCommand(h.command, currentHookCommand, env)) {
          h.command = currentHookCommand;
          changed = true;
        }
      }
    }
  }
  return changed ? { settings: copy, changed } : { settings, changed };
}

function countStaleInSettings(settings: any | null, currentHookCommand: string, env: HookEnv = {}): number {
  let count = 0;
  const hooks = getHooksSection(settings);
  for (const event of TYCOON_EVENTS) {
    for (const entry of getEntriesForEvent(hooks, event)) {
      for (const cmd of getCommandsFromEntry(entry)) {
        if (isTycoonCommand(cmd) && isStaleCommand(cmd, currentHookCommand, env)) {
          count++;
        }
      }
    }
  }
  return count;
}

function hasDuplicateTycoonInSlot(settings: any | null, slot: { event: string; matcher: string }): boolean {
  const hooks = getHooksSection(settings);
  let total = 0;
  for (const entry of getEntriesForEvent(hooks, slot.event)) {
    if (entry && entry.matcher === slot.matcher) {
      total += getCommandsFromEntry(entry).filter(isTycoonCommand).length;
    }
  }
  return total > 1;
}

/** Interpreter (first token) of the first Tycoon hook command in `settings`, or undefined. */
export function firstTycoonInterpreter(settings: any | null): string | undefined {
  const hooks = getHooksSection(settings);
  for (const event of TYCOON_EVENTS) {
    for (const entry of getEntriesForEvent(hooks, event)) {
      for (const cmd of getCommandsFromEntry(entry)) {
        if (isTycoonCommand(cmd)) {
          const tokens = leadingTokens(cmd, 2);
          if (tokens.length >= 2) return tokens[0];
        }
      }
    }
  }
  return undefined;
}

export function hasTycoonCommandsInSettings(settings: any | null): boolean {
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
    countStaleInSettings(input.localSettings, input.currentHookCommand, input.env) +
    countStaleInSettings(input.sharedSettings, input.currentHookCommand, input.env);
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

  if ((input.interpreterCheck && !input.interpreterCheck.ok) || input.nodeOverrideRejected) {
    const overrideHint = input.nodeOverrideRejected
      ? `TYCOON_NODE_PATH ("${input.nodeOverrideRejected}") points at an editor helper (VS Code/Cursor/Electron), not node, and is ignored. Point it at a real node binary or unset it. `
      : "";
    const failed = input.interpreterCheck && !input.interpreterCheck.ok;
    findings.push({
      id: "hooks-node-missing",
      severity: "error",
      title: "Node.js not found for hooks",
      detail:
        (failed
          ? `Claude Code could not run "${input.interpreterCheck!.interpreter}" for the hook command, so hooks fail silently and no activity is recorded. `
          : "") +
        overrideHint +
        "Set TYCOON_NODE_PATH to the full path of node, or install Node.js, then reopen the panel.",
      fixable: false,
      destructive: false,
    });
  }

  const relativeCount =
    countRelativeInSettings(input.localSettings) + countRelativeInSettings(input.sharedSettings);
  if (relativeCount > 0) {
    findings.push({
      id: "hooks-relative-command",
      severity: "warn",
      title: "Hook command is project-relative",
      detail:
        `${relativeCount} hook command(s) use the old "node .claude/tycoon/tycoon-claude-hook.cjs" form, which stops firing (silently — no error, activity just stops) as soon as the session's working directory leaves the project root, e.g. an agent cd's into a subfolder. ` +
        "Fixing rewrites it to an absolute path.",
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
  opts: { removeForeign: boolean; foreignCommands?: string[]; env?: HookEnv }
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
    // Normalise EVERY Tycoon command across ALL entries sharing this
    // (event, matcher) to the current command and keep exactly one — a
    // legacy relative entry sitting beside an absolute one lives in a
    // separate entry object, so a per-entry pass would leave both firing.
    let seenTycoon = false;
    let fixedStale = false;
    let removedDup = false;
    let firstMatching: any = null;
    for (const entry of entries.slice()) {
      if (!entry || typeof entry !== "object" || entry.matcher !== matcher || !Array.isArray(entry.hooks)) {
        continue;
      }
      if (!firstMatching) firstMatching = entry;
      const kept: any[] = [];
      let droppedHere = false;
      for (const h of entry.hooks) {
        if (h && typeof h.command === "string" && isTycoonCommand(h.command)) {
          if (seenTycoon) {
            removedDup = true;
            droppedHere = true;
            continue;
          }
          seenTycoon = true;
          if (isStaleCommand(h.command, currentHookCommand, opts.env)) {
            h.command = currentHookCommand;
            fixedStale = true;
          }
        }
        kept.push(h);
      }
      entry.hooks = kept;
      if (droppedHere && kept.length === 0) {
        entries.splice(entries.indexOf(entry), 1);
        if (firstMatching === entry) firstMatching = null;
      }
    }

    if (!seenTycoon) {
      let target = firstMatching;
      if (!target) {
        target = entries.find((e: any) => e && typeof e === "object" && e.matcher === matcher);
      }
      if (!target) {
        target = { matcher, hooks: [] };
        entries.push(target);
      }
      if (!Array.isArray(target.hooks)) target.hooks = [];
      target.hooks.push({ type: "command", command: currentHookCommand });
      changes.push(`Wired ${event} (${matcher || "any"}) hook`);
    }
    if (fixedStale) changes.push(`Fixed stale hook path in ${event}`);
    if (removedDup) changes.push(`Removed duplicate Tycoon hook in ${event}`);
  }

  // Tycoon commands under a matcher outside TYCOON_HOOK_SLOTS: detection
  // counts them stale too, so rewrite them here (no dedupe: distinct matcher).
  for (const event of TYCOON_EVENTS) {
    const list = settings.hooks[event];
    if (!Array.isArray(list)) continue;
    let fixed = false;
    for (const e of list) {
      if (!e || !Array.isArray(e.hooks)) continue;
      for (const h of e.hooks) {
        if (h && typeof h.command === "string" && isTycoonCommand(h.command) && isStaleCommand(h.command, currentHookCommand, opts.env)) {
          h.command = currentHookCommand;
          fixed = true;
        }
      }
    }
    if (fixed) changes.push(`Fixed stale hook path in ${event}`);
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
