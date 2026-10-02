/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as fs from "fs";
import * as path from "path";
import { mergeEnabledMcpJsonServer } from "./mcpCatalog";

interface HookCommand {
  type: "command";
  command: string;
}

/**
 * Builds the Claude Code hook command as an ABSOLUTE, quoted path:
 * `node "<root>/.claude/tycoon/tycoon-claude-hook.cjs"`.
 *
 * A project-relative command (`node .claude/tycoon/tycoon-claude-hook.cjs`,
 * used through 0.0.664) assumed Claude Code always runs hooks with
 * cwd = project root. Field evidence showed that's false: once the
 * session's cwd changes mid-session (e.g. an agent `cd`s into a subfolder),
 * Claude Code launches the hook with THAT cwd, `node` can't resolve the
 * relative script path, and the hook silently stops firing for the rest of
 * the session — no error surfaces anywhere, activity.jsonl just stops
 * growing. An absolute path removes the cwd dependency entirely, matching
 * the pattern `standalone/src/installHook.mjs` already uses
 * (`node "${hookScriptPath}"`).
 *
 * Quoting the whole path handles spaces on every platform this targets:
 * double quotes around a path work identically for `node` under POSIX
 * sh/bash AND under Windows cmd.exe (Claude Code's hook launcher on win32),
 * with no reliance on `$VAR`-style shell expansion (cmd.exe doesn't do
 * that) or on any particular shell being present. `path.join` is used
 * rather than manual string concatenation so the path separator matches
 * the host OS either way.
 *
 * `root` must be the resolved project root (NOT `process.cwd()`).
 */
export function buildAbsoluteHookCommand(root: string): string {
  const scriptPath = path.join(root, ".claude", "tycoon", "tycoon-claude-hook.cjs");
  return `node "${scriptPath}"`;
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
  { event: "PreToolUse", matcher: "mcp__.*" },
  // p15-t1: detects a provider failure (quota/unavailable/unreachable) on a
  // registered backend MCP tool result and injects the fallback-chain
  // re-dispatch instruction — see hooks/tycoon-claude-hook.cjs's PostToolUse
  // branch and src/core/fallbackChain.ts.
  { event: "PostToolUse", matcher: "mcp__.*" },
  // p99-t1: Claude Code fires PostToolUseFailure (NOT PostToolUse) for an MCP
  // result with isError:true — the primary provider-failure shape. Wired to
  // the same mcp__.* detection; mergeTycoonHooks adds it to existing installs
  // on the next panel open / repair.
  { event: "PostToolUseFailure", matcher: "mcp__.*" },
  // Runs after a Task/Agent spawn completes so the hook can surface unseen
  // plan-gate approvals/rejections back to the orchestrator (see
  // hooks/tycoon-claude-hook.cjs's PostToolUse Task/Agent branch). "Task" is
  // a deprecated alias for "Agent" — both are matched.
  { event: "PostToolUse", matcher: "Task|Agent" },
  { event: "SubagentStop", matcher: "" },
  { event: "Stop", matcher: "" },
  { event: "TaskCompleted", matcher: "" },
  { event: "TeammateIdle", matcher: "" },
  { event: "TaskCreated", matcher: "" },
];

/** True if `h` is a well-formed hook entry whose command references our own hook script. */
function isOurHookCommand(h: unknown): boolean {
  return (
    h !== null &&
    typeof h === "object" &&
    typeof (h as { command?: unknown }).command === "string" &&
    ((h as { command: string }).command).includes("tycoon-claude-hook.cjs")
  );
}

/**
 * Legacy matcher values TycoonAgents used to write for a given event, keyed
 * to the value TYCOON_HOOK_SLOTS uses today for that same event. Consumed by
 * both {@link mergeTycoonHooks} (in-place rename during install/repair) and
 * {@link migrateLegacyHookMatchers} (narrow panel-open auto-heal) so an
 * already-installed project's settings.local.json picks up a matcher
 * upgrade as a rename instead of ending up with both the stale and the
 * current matcher wired to our hook (which would double-fire the hook on
 * every matching tool call). Add an entry here whenever a TYCOON_HOOK_SLOTS
 * matcher changes for an event that previously shipped under a different
 * value.
 *
 * Current entry: PreToolUse's MCP-tool matcher was bare `"mcp__"` (substring
 * regex) through 0.0.482; Claude Code's docs recommend the anchored
 * `"mcp__.*"` form for matching all MCP tools, and field evidence showed an
 * MCP tool call producing no PreToolUse record under the bare form.
 */
export const LEGACY_MATCHER_ALIASES: ReadonlyArray<{ event: string; from: string; to: string }> = [
  { event: "PreToolUse", from: "mcp__", to: "mcp__.*" },
];

/**
 * Renames the matcher of any entry in `list` whose matcher is `from` AND
 * whose hooks are entirely ours (per {@link isOurHookCommand}) to `to`.
 * Immutable — returns a NEW array only when something changed; returns the
 * SAME `list` reference untouched when nothing matched, so callers can
 * cheaply detect "nothing to do". An entry with a mixed or foreign hook, or
 * a different matcher, is never touched.
 */
function renamePureOursMatchers(list: HookEntry[], from: string, to: string): HookEntry[] {
  let changed = false;
  const next = list.map((e) => {
    if (
      e !== null &&
      typeof e === "object" &&
      e.matcher === from &&
      Array.isArray(e.hooks) &&
      e.hooks.length > 0 &&
      e.hooks.every((h) => isOurHookCommand(h))
    ) {
      changed = true;
      return { ...e, matcher: to };
    }
    return e;
  });
  return changed ? next : list;
}

/**
 * Narrow, pure migration for panel-open auto-heal: renames any pre-existing
 * hook entry matching a {@link LEGACY_MATCHER_ALIASES} (event, from) pair —
 * AND whose hooks are entirely ours — to that alias's `to` matcher. Unlike
 * {@link mergeTycoonHooks}, this never adds a missing slot, never collapses
 * duplicates, and never touches an entry with a different matcher, a
 * different command, or any non-ours hook mixed in, so a user's manual
 * customization is always preserved untouched.
 *
 * Returns `changed: false` (with `settings` being the SAME object reference
 * as `existing`) when there was nothing to migrate, so a caller writing
 * this back to disk can skip the write entirely on the common no-op case.
 */
export function migrateLegacyHookMatchers(
  existing: Record<string, unknown>
): { settings: Record<string, unknown>; changed: boolean } {
  const hooksSection = existing.hooks;
  if (hooksSection === null || typeof hooksSection !== "object") {
    return { settings: existing, changed: false };
  }
  const hooks = hooksSection as Record<string, unknown>;

  let changed = false;
  const nextHooks: Record<string, unknown> = { ...hooks };
  for (const alias of LEGACY_MATCHER_ALIASES) {
    const list = hooks[alias.event];
    if (!Array.isArray(list)) continue;
    const next = renamePureOursMatchers(list as HookEntry[], alias.from, alias.to);
    if (next !== list) {
      nextHooks[alias.event] = next;
      changed = true;
    }
  }

  if (!changed) {
    return { settings: existing, changed: false };
  }
  return { settings: { ...existing, hooks: nextHooks }, changed: true };
}

/** Matches the pre-0.0.665 project-relative hook command, either slash style (`node .claude/tycoon/tycoon-claude-hook.cjs` or the Windows-backslash form) — the form that silently stops firing once a session's cwd leaves the project root (see buildAbsoluteHookCommand's doc comment). */
const RELATIVE_HOOK_COMMAND_RE = /^node\s+\.claude[\\/]tycoon[\\/]tycoon-claude-hook\.cjs\s*$/;

/**
 * Auto-migration companion to {@link buildAbsoluteHookCommand}: rewrites
 * ONLY hook entries whose command is exactly the old project-relative form
 * to `absoluteHookCommand`, leaving every other entry (a different command,
 * a foreign hook, an already-absolute Tycoon command, or any unrelated
 * top-level key) byte-for-byte untouched. Idempotent — a settings object
 * with no relative commands comes back with `changed: false` and the SAME
 * object reference, so a caller can skip the write entirely.
 *
 * Deliberately narrower than {@link repairSettings}/{@link mergeTycoonHooks}
 * (which also add missing slots, dedupe, and optionally strip foreign
 * hooks): this is meant for a silent, best-effort auto-heal on activation/
 * panel-open, so it only ever does the one rewrite the incident calls for.
 */
export function migrateRelativeHookCommand(
  existing: Record<string, unknown>,
  absoluteHookCommand: string
): { settings: Record<string, unknown>; changed: boolean } {
  const hooksSection = existing.hooks;
  if (hooksSection === null || typeof hooksSection !== "object") {
    return { settings: existing, changed: false };
  }
  const hooks = hooksSection as Record<string, unknown>;

  let changed = false;
  const nextHooks: Record<string, unknown> = { ...hooks };
  for (const event of Object.keys(hooks)) {
    const list = hooks[event];
    if (!Array.isArray(list)) continue;
    let entryChanged = false;
    const nextList = list.map((e: unknown) => {
      if (e === null || typeof e !== "object" || !Array.isArray((e as HookEntry).hooks)) return e;
      const entry = e as HookEntry;
      let hooksListChanged = false;
      const nextHooksList = entry.hooks.map((h) => {
        if (
          h !== null &&
          typeof h === "object" &&
          typeof h.command === "string" &&
          RELATIVE_HOOK_COMMAND_RE.test(h.command)
        ) {
          hooksListChanged = true;
          return { ...h, command: absoluteHookCommand };
        }
        return h;
      });
      if (!hooksListChanged) return e;
      entryChanged = true;
      return { ...entry, hooks: nextHooksList };
    });
    if (entryChanged) {
      nextHooks[event] = nextList;
      changed = true;
    }
  }

  if (!changed) {
    return { settings: existing, changed: false };
  }
  return { settings: { ...existing, hooks: nextHooks }, changed: true };
}

/**
 * Pure merge of TycoonAgents hook entries into an existing Claude Code settings
 * object. Adds our hook for each event/matcher in TYCOON_HOOK_SLOTS without
 * dropping unrelated hooks and without duplicating an entry whose matcher
 * already references our hook. No fs/vscode usage, so this is unit-testable.
 *
 * Idempotency check scans ALL entries for a given (event, matcher) — not just
 * the first — so a third-party hook entry that happens to share our matcher
 * string (e.g. many foreign hooks registering on the empty "" matcher for
 * Stop/SubagentStop/UserPromptSubmit/TaskCompleted) sitting before our own
 * entry in that event's array can no longer mask our entry and cause a
 * duplicate to be appended on every re-run.
 *
 * Also self-heals settings already bloated by that historical bug: for each
 * slot's matcher, any PRE-EXISTING entries whose hooks are entirely ours
 * (leftover duplicates) are collapsed down to at most one before the
 * idempotency check runs. An entry is only ever touched here if EVERY hook
 * inside it references our own script — an entry mixing in any third-party
 * or unrelated hook is left completely alone.
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

  // Upgrade any pre-existing pure-ours entry still wired to a legacy
  // matcher (see LEGACY_MATCHER_ALIASES) to the current matcher BEFORE the
  // per-slot loop below runs, so an install/repair lands as an in-place
  // rename instead of leaving the stale entry AND appending a duplicate
  // under the new matcher — which would double-fire the hook.
  for (const alias of LEGACY_MATCHER_ALIASES) {
    const list = hooks[alias.event];
    if (list) {
      hooks[alias.event] = renamePureOursMatchers(list, alias.from, alias.to);
    }
  }

  for (const slot of TYCOON_HOOK_SLOTS) {
    const rawList = hooks[slot.event] ?? (hooks[slot.event] = []);

    // Heal: collapse duplicate pure-ours entries for this matcher (leftovers
    // from the old idempotency bug) down to at most one.
    let keptOneOurs = false;
    const deduped: HookEntry[] = [];
    for (const e of rawList) {
      const isPureOurs =
        e !== null &&
        typeof e === "object" &&
        e.matcher === slot.matcher &&
        Array.isArray(e.hooks) &&
        e.hooks.length > 0 &&
        e.hooks.every((h) => isOurHookCommand(h));
      if (isPureOurs) {
        if (keptOneOurs) {
          continue; // drop this duplicate — it's entirely our own hook
        }
        keptOneOurs = true;
      }
      deduped.push(e);
    }
    const list = deduped;
    hooks[slot.event] = list;

    // Idempotency: does ANY entry for this matcher already reference our hook?
    const alreadyOurs = list.some(
      (e) =>
        e !== null &&
        typeof e === "object" &&
        e.matcher === slot.matcher &&
        Array.isArray(e.hooks) &&
        e.hooks.some((h) => isOurHookCommand(h))
    );
    if (alreadyOurs) {
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

/**
 * Pure merge of TycoonAgents' managed `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`
 * env var into an existing Claude Code settings object's top-level `env`
 * block. Belt-and-braces for the PreToolUse spawn guard (see
 * `hooks/tycoon-claude-hook.cjs`): even if a guard bug ever let a denied
 * spawn through, Claude Code's own harness-level nesting cap still stops it
 * from going deeper than intended. `desiredDepth` should be `"1"` for
 * flat/direct delegation (orchestrator -> worker, one hop) and `"2"` for
 * team_leads (orchestrator -> lead -> worker, two hops).
 *
 * Ownership caveat: `settings.local.json` carries no provenance marker for
 * individual env keys, so there is no reliable way to tell "the user set
 * this deliberately" apart from "we wrote it on a previous install/mode
 * switch". Rather than risk clobbering a value a user set on purpose, this
 * ONLY EVER writes when the key is entirely ABSENT — any existing value
 * (user-set or ours from an earlier install) is left completely untouched,
 * even when it no longer matches `desiredDepth` (e.g. after a later mode
 * switch). Known gap: switching flat -> team_leads on a project that
 * already has the env key set from a flat install does NOT raise the cap
 * from 1 to 2 automatically — see the call site in panel.ts.
 *
 * No fs/vscode usage, so this is unit-testable like {@link mergeTycoonHooks}.
 */
export function mergeManagedSubagentDepthEnv(
  existing: Record<string, unknown>,
  desiredDepth: "1" | "2"
): Record<string, unknown> {
  const srcEnv = existing.env;
  const env: Record<string, unknown> =
    srcEnv !== null && typeof srcEnv === "object" && !Array.isArray(srcEnv)
      ? (srcEnv as Record<string, unknown>)
      : {};

  if (Object.prototype.hasOwnProperty.call(env, "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH")) {
    return existing; // already set (user or a prior install) — never overwrite
  }

  return {
    ...existing,
    env: { ...env, CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: desiredDepth },
  };
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
 * The bundled hook script plus every companion runtime file an installer
 * copies alongside it into `.claude/tycoon/` (VS Code) or may find already
 * copied there by a prior VS Code install (standalone). Shared by both
 * hosts so the file list never drifts between them — see
 * `_handleInstallHooks` in panel.ts and `refreshRuntimeHookCopies` in
 * standalone/src/installHook.mjs.
 */
export const RUNTIME_HOOK_FILES: ReadonlyArray<string> = [
  "tycoon-claude-hook.cjs",
  "agentBackend.js",
  "modelAliases.js",
  "delegationEnforcement.js",
  "fallbackChain.js",
  // p99-t1: required by the hook for structured bridge-status detection; the
  // hook fails open to regex-on-error if this copy is missing.
  "bridge-result.cjs",
];

/**
 * MCP bridge scripts copied into the consumer project's `.claude/hooks/`
 * (NOT `.claude/tycoon/`, where {@link RUNTIME_HOOK_FILES} lands) so that
 * `.mcp.json` entries can reference them with a project-relative path
 * (`.claude/hooks/codex-app-server-mcp.cjs`) instead of an
 * extension-install-dependent `${EXTENSION_DIR}` token — these files also
 * need to work from a bare `codex`/OpenCode/other-editor checkout with no
 * TycoonAgents extension installed at all. See
 * docs/codex-reviewer-onboarding-friction-2026-09-18.md: the catalog and
 * `.mcp.json.example` previously launched the removed `codex mcp-server`
 * subcommand, and the working replacement bridge
 * (`codex-app-server-mcp.cjs`, which itself launches `codex app-server` via
 * `codex-mcp-launcher.cjs`'s discovery/shell logic) was never installed
 * anywhere a consumer project could reach it.
 */
export const MCP_BRIDGE_HOOK_FILES: ReadonlyArray<string> = [
  "codex-mcp-launcher.cjs",
  "codex-app-server-mcp.cjs",
  "bridge-result.cjs",
  "gemini-mcp-wrapper.cjs",
  // p99-t2: the dispatcher MCP server (catalog id "tycoon") and every module it
  // requires, so a project-relative .mcp.json entry can launch it.
  "tycoon-dispatcher-mcp.cjs",
  "dispatcherAdapters.cjs",
  "dispatcherBridgeClient.cjs",
  "dispatcherClaudeChain.cjs",
  "codexRouting.cjs",
  "codexRollout.cjs",
  "gateEvents.cjs",
  "delegationEnforcement.js",
  "fallbackChain.js",
];

/**
 * Writes `<dir>/package.json` = {"type":"commonjs"} so the CommonJS `.js`
 * modules copied into `.claude/hooks/` and `.claude/tycoon/` load as CJS even
 * when the project's own package.json says "type":"module" (otherwise Node
 * throws "exports is not defined in ES module scope"). Idempotent; an
 * existing file is only touched when it has no `type` field (type is added,
 * other fields preserved); an existing `type` or unparseable file is left alone.
 */
export function ensureCommonJsMarker(dir: string): "created" | "updated" | "unchanged" | "skipped" {
  const file = path.join(dir, "package.json");
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({ type: "commonjs" }, null, 2) + "\n", "utf8");
    return "created";
  }
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "skipped";
    if (typeof parsed.type === "string") return "unchanged";
    fs.writeFileSync(file, JSON.stringify({ ...parsed, type: "commonjs" }, null, 2) + "\n", "utf8");
    return "updated";
  } catch {
    return "skipped";
  }
}

/** Outcome of syncing one runtime file — see {@link syncRuntimeFile}. */
export type RuntimeFileSyncStatus = "created" | "refreshed" | "unchanged";

/**
 * Compares `srcPath` (the bundled/source-of-truth file) against `destPath`
 * (the live copy in a project's `.claude/tycoon/`) by content, byte-for-byte
 * — never by mtime or a "registered" flag, per the 2026-09-06 bug where a
 * stale runtime copy survived an install because only hook REGISTRATION was
 * checked, never the copy's content.
 *
 * - `destPath` missing: creates it (parent dir included) — `"created"`.
 * - `destPath` present and byte-identical to `srcPath`: leaves it
 *   completely untouched (no write, mtime unchanged) — `"unchanged"`.
 * - `destPath` present and different: overwrites it — `"refreshed"`.
 *
 * `destPath` is always one of our own runtime files (see
 * {@link RUNTIME_HOOK_FILES}), never a user-authored file, so overwriting on
 * a content mismatch is always safe.
 */
export function syncRuntimeFile(srcPath: string, destPath: string): RuntimeFileSyncStatus {
  const srcBuf = fs.readFileSync(srcPath);
  let destBuf: Buffer | undefined;
  try {
    destBuf = fs.readFileSync(destPath);
  } catch {
    destBuf = undefined;
  }
  if (destBuf === undefined) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
    return "created";
  }
  if (srcBuf.equals(destBuf)) {
    return "unchanged";
  }
  fs.copyFileSync(srcPath, destPath);
  return "refreshed";
}

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
 * Idempotently adds `id` to `settings.local.json`'s `enabledMcpjsonServers`
 * array so Claude Code auto-approves a project `.mcp.json` server instead of
 * leaving it "Pending approval" (which times out non-interactive sessions).
 * Called right after a pack/MCP install writes an entry into `.mcp.json`
 * (see panel.ts `_handleInstallMcp` and the pack-install `pack.mcp` branch).
 *
 * - Creates `settings.local.json` if it doesn't exist yet.
 * - Uses the pure, unit-tested `mergeEnabledMcpJsonServer` (mcpCatalog.ts) so
 *   existing `env`/`hooks`/`permissions`/other keys are preserved untouched
 *   and the id is never duplicated across repeated calls.
 * - If the file exists but isn't valid JSON (or isn't a JSON object), this
 *   logs and skips rather than clobbering an unparseable file.
 *
 * Returns true if the file was written (created or changed), false if
 * skipped (already present, or unparseable existing file).
 */
export function enableMcpJsonServerInSettings(claudeDirRoot: string, id: string): boolean {
  const filePath = path.join(claudeDirRoot, "settings.local.json");
  let existing: Record<string, unknown> | null = {};
  if (fs.existsSync(filePath)) {
    existing = readJsonFileSafe(filePath);
    if (existing === null) {
      console.error(
        `[TycoonAgents] Skipping enabledMcpjsonServers merge: ${filePath} is not valid JSON.`
      );
      return false;
    }
  }

  const list = existing.enabledMcpjsonServers;
  if (Array.isArray(list) && list.includes(id)) {
    return false;
  }

  const merged = mergeEnabledMcpJsonServer(existing, id);
  try {
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error(`[TycoonAgents] Failed writing ${filePath}: ${String(e)}`);
    return false;
  }
}

export interface CleanupForeignHookArtifactsOptions {
  /**
   * Whether step 1 may strip foreign/legacy hook COMMANDS out of
   * settings.local.json/settings.json (and write those files). Defaults to
   * `true` so every existing caller (Install Hooks, and any other call site
   * that doesn't pass this option) keeps today's behavior — only one
   * harness can validly track a project. Callers that need to honor a
   * user-facing "remove foreign hooks?" choice (e.g. Hook Doctor's Apply
   * Fix) must pass `false` explicitly to skip settings mutation entirely
   * when the user opted out. Step 3 (deleting orphaned
   * `agent-activity-*.json` spool files) always runs regardless of this
   * flag — that cleanup is safe either way and isn't a "remove hooks"
   * choice.
   */
  removeForeignCommands?: boolean;
}

/**
 * Idempotently strips leftover foreign/legacy agent-hook artifacts under
 * `claudeDirRoot` (the project's `.claude` directory) so a fresh TycoonAgents
 * install lands in a clean hook environment:
 *
 * 1. Removes foreign/legacy hook commands wired into OUR events in
 *    settings.local.json / settings.json (our own entries and unrelated
 *    non-agent hooks are left untouched) — gated on
 *    `options.removeForeignCommands` (default `true`); when explicitly
 *    `false`, this step does not touch settings at all (no read-driven
 *    write), so `strippedForeignHookCommands` stays empty and neither
 *    settings file is written.
 * 2. Clears a stale `active-agent.json.lock` (any age — install is a safe
 *    reset point) and, if the stack looked stuck, resets `active-agent.json`
 *    to an empty stack.
 * 3. Deletes known leftover legacy state files at the `.claude/` root (see
 *    {@link LEGACY_STATE_FILE_NAMES}) plus any `agent-activity-*.json` files.
 *    Always runs, independent of `removeForeignCommands`.
 *
 * Every step is guarded (existsSync / try-catch) so this is a safe no-op on
 * a project that never had a foreign hook system, and safe to call on every
 * install.
 */
export function cleanupForeignHookArtifacts(
  claudeDirRoot: string,
  options: CleanupForeignHookArtifactsOptions = {}
): CleanupResult {
  const removeForeignCommands = options.removeForeignCommands !== false;
  const result: CleanupResult = {
    strippedForeignHookCommands: [],
    clearedStaleLock: false,
    resetStack: false,
    deletedLeftoverFiles: [],
    changes: [],
  };

  // 1. Strip foreign/legacy hook commands from our event slots — skipped
  // entirely (no read, no write) when the caller explicitly opted out.
  const tycoonEvents = new Set(TYCOON_HOOK_SLOTS.map((s) => s.event));
  for (const fileName of removeForeignCommands ? SETTINGS_FILE_NAMES : []) {
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

/**
 * Heal for projects installed by an older version: refreshes stale copies of
 * files from RUNTIME_HOOK_FILES (`.claude/tycoon/`) and MCP_BRIDGE_HOOK_FILES
 * (`.claude/hooks/`) that ALREADY exist, and ensures the CommonJS marker in
 * each dir holding them. Never adds files, never throws. Warns (leaves the
 * file) when a user package.json there pins "type":"module".
 */
export function healInstalledHookCopies(
  projectRoot: string,
  resolveSrc: (fileName: string) => string | undefined,
  warn: (message: string) => void = () => undefined,
): string[] {
  const refreshed: string[] = [];
  const groups: Array<[string, ReadonlyArray<string>]> = [
    [path.join(projectRoot, ".claude", "tycoon"), RUNTIME_HOOK_FILES],
    [path.join(projectRoot, ".claude", "hooks"), MCP_BRIDGE_HOOK_FILES],
  ];
  for (const [dir, files] of groups) {
    try {
      let any = false;
      for (const fileName of files) {
        const dest = path.join(dir, fileName);
        if (!fs.existsSync(dest)) continue;
        any = true;
        const src = resolveSrc(fileName);
        if (src && fs.existsSync(src) && syncRuntimeFile(src, dest) === "refreshed") refreshed.push(path.join(dir, fileName));
      }
      if (!any) continue;
      ensureCommonJsMarker(dir);
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8").replace(/^\uFEFF/, ""));
        if (parsed && parsed.type === "module") {
          warn(`TycoonAgents: ${dir}${path.sep}package.json sets "type":"module"; the CommonJS hook files there will fail to load. Change it to "commonjs" or remove it.`);
        }
      } catch { /* unreadable: nothing to warn about */ }
    } catch (err) {
      warn(`TycoonAgents: hook copy heal failed in ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return refreshed;
}
