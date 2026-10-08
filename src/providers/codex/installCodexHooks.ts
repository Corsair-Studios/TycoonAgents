/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Installer for the codex hook adapter (plan p22-t3). Writes/merges TWO
// things, both marked so uninstall removes only what this installer added:
//
//   1. A top-level `notify = [...]` line in CODEX_HOME/config.toml — the
//      one entry point confirmed to actually fire (see
//      docs/codex-harness-findings.md). Codex rejects `notify` at
//      project-local scope ("Ignored unsupported project-local config
//      keys"), so this MUST go in the user-level config, never
//      <project>/.codex/config.toml.
//   2. A project-scoped .codex/hooks.json with the 12 documented hook
//      event names pointing at the same script, for forward-compatible
//      coverage the moment `[hooks.*]` starts firing on a future codex-cli
//      version (per the task brief) — hooks.json is a TycoonAgents-owned
//      file shape (codex's own config format for this is TOML, not JSON;
//      this file is inert to codex itself today, kept for the hook binary
//      and any future codex-side JSON hook manifest support).
//
// Discovery follows docs/PATH-DISCOVERY.md: CODEX_HOME env override wins
// outright; otherwise falls back to the platform default (~/.codex). Never
// silently no-ops on failure — resolveCodexHome throws with every location
// tried when nothing usable exists AND no override was given (matching
// resolveOpenCode's contract in ../opencode/discovery.ts).
//
// This module never touches .claude/settings*.json or opencode.json/
// .opencode/ — those belong to the Claude Code and OpenCode installers
// respectively (see docs/codex-harness-findings.md's isolation note and
// this task's file-ownership brief).

import * as fs from "fs";
import * as path from "path";
import { isElectronHostBinary, resolveNodeBinary } from "./resolveNodeBinary";
import { collapseBlankRunAt, detectEol, scanTomlLines, type TomlLine } from "./tomlScan";

/** The 12 hook event names codex-cli 0.153.0's own HookEventName/HookEventsToml enum accepts, per docs/codex-harness-findings.md. */
export const CODEX_HOOK_EVENTS: readonly string[] = [
  "session_start",
  "session_end",
  "user_prompt_submit",
  "pre_tool_use",
  "post_tool_use",
  "permission_request",
  "pre_compact",
  "post_compact",
  "subagent_start",
  "subagent_stop",
  "stop",
  "interrupt",
];

/** Marker delimiting the block this installer owns inside config.toml, so uninstall removes only its own lines. */
const TOML_MARKER_START = "# tycoon-codex-hook: managed notify entry (do not edit by hand)";
const TOML_MARKER_END = "# tycoon-codex-hook: end managed notify entry";

/**
 * Marker value inside hooks.json's top-level `description` field identifying
 * this installer's ownership. codex-cli 0.153.0 parses .codex/hooks.json
 * strictly and rejects any unknown top-level field (confirmed live:
 * `unknown field `_tycoonManaged`, expected `description` or `hooks` at
 * line 2 column 18` — see docs/codex-harness-findings.md's retry/update
 * section), so the top-level shape MUST be exactly `{ description?: string,
 * hooks: {...} }`. There is no room for a dedicated marker field; ownership
 * is tracked via this known description string instead.
 */
const HOOKS_JSON_MARKER_DESCRIPTION = "tycoon-codex-hook: managed by TycoonAgents (do not edit by hand)";

export interface ResolveCodexHomeEnv {
  [key: string]: string | undefined;
}

export interface ResolveCodexHomeOptions {
  env: ResolveCodexHomeEnv;
  platform?: NodeJS.Platform;
}

/**
 * Resolve CODEX_HOME per docs/PATH-DISCOVERY.md: CODEX_HOME env override
 * wins outright; otherwise the platform default (~/.codex, codex-cli's own
 * documented default). Throws an explicit error naming every location
 * tried and the override variable only when neither resolves to an
 * existing-or-creatable directory path (we don't require it to pre-exist —
 * installers are expected to create it — but we DO require a usable HOME).
 */
export function resolveCodexHome(options: ResolveCodexHomeOptions): { codexHome: string; tried: string[] } {
  const { env } = options;
  const tried: string[] = [];

  if (env.CODEX_HOME) {
    tried.push(env.CODEX_HOME);
    return { codexHome: env.CODEX_HOME, tried };
  }

  const home = env.HOME || env.USERPROFILE || "";
  if (home) {
    const candidate = path.join(home, ".codex");
    tried.push(candidate);
    return { codexHome: candidate, tried };
  }
  tried.push("(no HOME/USERPROFILE set)");

  throw new Error(
    `resolveCodexHome: could not determine a CODEX_HOME directory. Tried:\n` +
      tried.map((p) => `  - ${p}`).join("\n") +
      `\nSet CODEX_HOME to override discovery.`,
  );
}

/**
 * Windows-safe command array for the notify entry / hooks.json commands:
 * `[nodePath, <abs script path>]`. `nodePath` defaults to resolveNodeBinary() (never the VS Code binary)
 * (the absolute path to the currently-running node binary) rather than the
 * bare string "node", so the notify entry still fires in shells/services
 * where "node" is not on PATH (e.g. codex-cli launched from a GUI process on
 * Windows). Argv-array form is preserved — no shell quoting involved.
 * Uninstall matching is marker-based (see TOML_MARKER_START/END and
 * HOOKS_JSON_MARKER_DESCRIPTION), not command-content-based, so entries
 * written by an older version of this installer with the bare "node" form
 * are still recognized and removed correctly.
 */
export function buildHookCommand(hookScriptPath: string, nodePath: string = resolveNodeBinary()): string[] {
  return [nodePath, hookScriptPath];
}

function tomlStringArray(items: string[]): string {
  return "[" + items.map((s) => JSON.stringify(s)).join(", ") + "]";
}

/**
 * Find the index of the first line matching /^\s*\[/ (a TOML table or
 * array-of-tables header) in `text`, or -1 if there is none. Used to locate
 * the boundary of the top-level (no-table) section, since a bare key placed
 * after a table header becomes a member of that table per TOML semantics.
 */
function findFirstTableHeaderIndex(text: string): number {
  const header = scanTomlLines(text).find((l) => l.header !== undefined);
  return header ? header.start : -1;
}

interface StrippedNotify {
  text: string;
  /** True when nothing but our own marker and notify lines sat between the markers. */
  regionEmpty: boolean;
  /** True when a top-level `notify` key inside the markers was removed. */
  droppedNotify: boolean;
  /** Text of the dropped `notify` key, for inspecting the command it names. */
  notifyText: string;
  /** Offset where the region began, and the end of the end-marker line's content. */
  start: number;
  end: number;
}

/**
 * Text with the managed notify block removed. Removal is line-scoped: the two
 * marker lines and the `notify` key that opens the block (before any table
 * header inside the markers; its whole value, including a multi-line array) go; anything else another tool left between
 * the markers is kept byte-for-byte, and a `notify` key inside a table is
 * never touched. Returns undefined when there is no marker pair.
 */
function stripManagedNotifyRegion(text: string): StrippedNotify | undefined {
  const lines = scanTomlLines(text);
  const isMarker = (l: TomlLine, marker: string): boolean => !l.cont && text.slice(l.start, l.end).trim() === marker;
  const startLi = lines.findIndex((l) => isMarker(l, TOML_MARKER_START));
  if (startLi === -1) return undefined;
  let endLi = -1;
  for (let li = startLi + 1; li < lines.length; li++) {
    if (isMarker(lines[li], TOML_MARKER_END)) {
      endLi = li;
      break;
    }
  }
  if (endLi === -1) return undefined;
  const dropped = new Set<number>([startLi, endLi]);
  let droppedNotify = false;
  for (let li = startLi + 1; li < endLi; li++) {
    const l = lines[li];
    if (l.header) break;
    if (l.header || l.cont || !/^[ \t]*notify[ \t]*=/.test(text.slice(l.start, l.end))) continue;
    droppedNotify = true;
    dropped.add(li);
    while (li + 1 < endLi && lines[li + 1].cont) dropped.add(++li);
  }
  let notifyText = "";
  for (const li of dropped) {
    if (li !== startLi && li !== endLi) notifyText += text.slice(lines[li].start, lines[li].next);
  }
  let kept = "";
  for (let li = startLi; li <= endLi; li++) {
    if (!dropped.has(li)) kept += text.slice(lines[li].start, lines[li].next);
  }
  const start = lines[startLi].start;
  const end = lines[endLi].end;
  if (kept.trim() === "") {
    return { text: text.slice(0, start) + text.slice(end), regionEmpty: true, droppedNotify, notifyText, start, end };
  }
  return { text: text.slice(0, start) + kept + text.slice(lines[endLi].next), regionEmpty: false, droppedNotify, notifyText, start, end };
}

export interface MergeNotifyResult {
  text: string;
  warnings?: string[];
}

/**
 * How the user-level config.toml currently routes Codex's `notify`:
 *   installed     - our managed block holds the notify entry
 *   wrapped       - another tool owns `notify` and carries our hook inside its
 *                   `--previous-notify` argument, at the current path
 *   stale-wrapped - same, but the embedded hook path differs from the current one
 *   blocked       - another tool owns `notify` and our hook is not in it
 *   wrapper-missing - a known wrapper owns `notify` but carries no hook of
 *                   ours; install can add it (not an error)
 *   stale-installed - our managed block exists but names the wrong program
 *                   (e.g. the editor binary) or script path
 *   none          - no top-level notify at all
 * "stale-wrapped" also covers a wrapped hook whose node element is wrong.
 */
export type CodexNotifyState =
  | "installed"
  | "stale-installed"
  | "wrapped"
  | "stale-wrapped"
  | "wrapper-missing"
  | "blocked"
  | "none";

export const CODEX_NOTIFY_BLOCKED_MESSAGE =
  "Another tool owns the Codex notify setting — TycoonAgents can't see Codex turns.";
export const CODEX_NOTIFY_STALE_MESSAGE =
  "The Codex notify setting points TycoonAgents at an old hook path or the wrong program, so Codex turns may not be seen. Install again to update it.";
export const CODEX_NOTIFY_WRAPPED_UNINSTALL_MESSAGE =
  "TycoonAgents could not remove itself from the Codex notify setting that another tool owns. You can remove it by hand.";

/**
 * Path equality that ignores Windows spelling differences (slash direction,
 * case, redundant segments); other paths compare exactly.
 */
export function samePath(a: string, b: string): boolean {
  const winLike = (p: string): boolean => /^[a-zA-Z]:[\\/]/.test(p);
  if (process.platform === "win32" || winLike(a) || winLike(b)) {
    const norm = (p: string): string => path.win32.normalize(p.replace(/\//g, "\\")).toLowerCase();
    return norm(a) === norm(b);
  }
  return a === b;
}

/** Wrapper programs we know how to extend with `--previous-notify` (basename, no extension). */
function isKnownNotifyWrapper(command: string): boolean {
  return /^codex-computer-use$/i.test((command.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, ""));
}

const HOOK_SCRIPT_BASENAME = "tycoon-codex-hook.cjs";

interface TomlArrayElement {
  start: number;
  end: number;
  value: string;
}

/**
 * Scan a TOML array of single-line strings whose `[` is at `openIdx`. Returns
 * undefined for anything it cannot decode exactly (multi-line strings, non-
 * string elements), so callers treat the entry as opaque.
 */
function scanTomlStringArray(text: string, openIdx: number): TomlArrayElement[] | undefined {
  const elements: TomlArrayElement[] = [];
  let i = openIdx + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "]") return elements;
    if (ch === "," || ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
    } else if (ch === "#") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === '"') {
      if (text.startsWith('"""', i)) return undefined;
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\n") return undefined;
        j += text[j] === "\\" ? 2 : 1;
      }
      if (j >= text.length) return undefined;
      let value: unknown;
      try {
        value = JSON.parse(text.slice(i, j + 1));
      } catch {
        return undefined;
      }
      if (typeof value !== "string") return undefined;
      elements.push({ start: i, end: j + 1, value });
      i = j + 1;
    } else if (ch === "'") {
      if (text.startsWith("'''", i)) return undefined;
      const j = text.indexOf("'", i + 1);
      if (j === -1 || text.slice(i, j).includes("\n")) return undefined;
      elements.push({ start: i, end: j + 1, value: text.slice(i + 1, j) });
      i = j + 1;
    } else {
      return undefined;
    }
  }
  return undefined;
}

interface EmbeddedHook {
  /** Offsets of the `--previous-notify` string element in the scanned text. */
  start: number;
  end: number;
  argv: string[];
  scriptPath: string;
  /** Range covering the `--previous-notify` flag, its value and the separator that joins them to the rest. */
  pairStart: number;
  pairEnd: number;
}

interface NotifyWrapper {
  elements: TomlArrayElement[];
  embedded?: EmbeddedHook;
}

/** Parse the top-level `notify = [...]` string array, and our hook inside its `--previous-notify`, if any. */
function parseNotifyWrapper(topLevel: string): NotifyWrapper | undefined {
  const m = /^[ \t]*notify[ \t]*=[ \t]*\[/m.exec(topLevel);
  if (!m) return undefined;
  const elements = scanTomlStringArray(topLevel, m.index + m[0].length - 1);
  if (!elements) return undefined;
  for (let k = 0; k + 1 < elements.length; k++) {
    if (elements[k].value !== "--previous-notify") continue;
    const el = elements[k + 1];
    let parsed: unknown;
    try {
      parsed = JSON.parse(el.value);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) continue;
    const scriptPath = (parsed as string[]).find((x) => scriptBasename(x) === HOOK_SCRIPT_BASENAME);
    if (scriptPath === undefined) continue;
    let pairStart = elements[k].start;
    let pairEnd = el.end;
    if (k > 0) pairStart = elements[k - 1].end;
    else if (k + 2 < elements.length) pairEnd = elements[k + 2].start;
    return { elements, embedded: { start: el.start, end: el.end, argv: parsed as string[], scriptPath, pairStart, pairEnd } };
  }
  return { elements };
}

function scriptBasename(p: string): string {
  return p.split(/[\\/]/).pop() ?? "";
}

/** Our hook embedded in the top-level foreign notify's `--previous-notify` argv, if present. */
function findEmbeddedHook(topLevel: string): EmbeddedHook | undefined {
  return parseNotifyWrapper(topLevel)?.embedded;
}

/**
 * Classify config.toml's notify routing. With `hookScriptPath`, an embedded
 * hook whose script path differs is reported as stale-wrapped (the node path
 * is not compared; install rewrites it anyway).
 */
export function detectCodexNotifyState(text: string, hookScriptPath?: string, nodePath?: string): CodexNotifyState {
  const wrongNode = (node: string | undefined): boolean =>
    node !== undefined && (isElectronHostBinary(node) || (nodePath !== undefined && !samePath(node, nodePath)));
  const stripped = stripManagedNotifyRegion(text);
  if (stripped?.droppedNotify) {
    const open = stripped.notifyText.indexOf("[");
    const elements = open === -1 ? undefined : scanTomlStringArray(stripped.notifyText, open);
    const stale =
      elements !== undefined &&
      (wrongNode(elements[0]?.value) ||
        (hookScriptPath !== undefined && elements.length > 1 && !samePath(elements[1].value, hookScriptPath)));
    return stale ? "stale-installed" : "installed";
  }
  const rest = stripped ? stripped.text : text;
  const headerIdx = findFirstTableHeaderIndex(rest);
  const topLevel = headerIdx === -1 ? rest : rest.slice(0, headerIdx);
  if (!/^[ \t]*notify[ \t]*=/m.test(topLevel)) return "none";
  const wrapper = parseNotifyWrapper(topLevel);
  const embedded = wrapper?.embedded;
  if (!embedded) {
    const canExtend =
      wrapper !== undefined &&
      wrapper.elements.length > 0 &&
      isKnownNotifyWrapper(wrapper.elements[0].value) &&
      !wrapper.elements.some((e) => e.value === "--previous-notify");
    return canExtend ? "wrapper-missing" : "blocked";
  }
  const staleScript = hookScriptPath !== undefined && !samePath(embedded.scriptPath, hookScriptPath);
  return staleScript || wrongNode(embedded.argv[0]) ? "stale-wrapped" : "wrapped";
}

/**
 * Merge the managed notify block into an existing config.toml's text
 * content (or create fresh content if `existing` is undefined). Replaces a
 * prior managed block wholesale (idempotent re-install) rather than
 * duplicating it; leaves everything outside the marker pair untouched. The
 * block is always inserted in the top-level section — before the first
 * table/array-of-tables header line — because TOML makes a bare key after a
 * table header a member of that table, which is why codex silently ignored
 * a `notify` appended at end-of-file after `[projects.'...']`. If a
 * top-level `notify =` line already exists outside the managed block, it is
 * left alone and a warning is returned instead of overriding it.
 */
export function mergeNotifyIntoConfigToml(
  existing: string | undefined,
  hookScriptPath: string,
  nodePath?: string,
): MergeNotifyResult {
  const command = buildHookCommand(hookScriptPath, nodePath);
  const text = existing ?? "";
  const eol = detectEol(text);
  const block = [TOML_MARKER_START, `notify = ${tomlStringArray(command)}`, TOML_MARKER_END].join(eol);

  // Text with the existing managed block (if any) removed, so we can check
  // for a foreign top-level `notify =` and re-derive the header boundary
  // cleanly regardless of where the old block currently sits.
  const stripped = stripManagedNotifyRegion(text);
  const hasManagedBlock = stripped !== undefined;
  let withoutManaged = stripped ? stripped.text : text;
  if (stripped?.regionEmpty) {
    // A block that sat at the very top leaves blank lines behind; drop them so re-install is stable.
    withoutManaged =
      stripped.start === 0
        ? withoutManaged.replace(/^(?:\r?\n)+/, "")
        : collapseBlankRunAt(withoutManaged, stripped.start, eol);
  }

  const headerIdx = findFirstTableHeaderIndex(withoutManaged);
  const topLevelSection = headerIdx === -1 ? withoutManaged : withoutManaged.slice(0, headerIdx);
  const foreignNotify = /^[ \t]*notify[ \t]*=/m.test(topLevelSection);

  const warnings: string[] = [];
  if (foreignNotify) {
    // Another tool may have moved our notify into its own wrapper's
    // --previous-notify argv. Refresh only that embedded argv; the wrapper's
    // other bytes stay as they were, and no managed notify is added (Codex
    // allows one notify).
    const embedded = findEmbeddedHook(topLevelSection);
    if (embedded) {
      const same = embedded.argv.length === command.length && embedded.argv.every((v, k) => v === command[k]);
      const rewritten = same
        ? withoutManaged
        : withoutManaged.slice(0, embedded.start) +
          JSON.stringify(JSON.stringify(command)) +
          withoutManaged.slice(embedded.end);
      return { text: rewritten };
    }
    const wrapper = parseNotifyWrapper(topLevelSection);
    if (
      wrapper &&
      wrapper.elements.length > 0 &&
      isKnownNotifyWrapper(wrapper.elements[0].value) &&
      !wrapper.elements.some((e) => e.value === "--previous-notify")
    ) {
      // A known wrapper that forwards to a previous notify command: add ours
      // as that previous command, encoded the way wrappers already do.
      const last = wrapper.elements[wrapper.elements.length - 1];
      const pair = `, "--previous-notify", ${JSON.stringify(JSON.stringify(command))}`;
      return { text: withoutManaged.slice(0, last.end) + pair + withoutManaged.slice(last.end) };
    }
    warnings.push(
      "config.toml already has a top-level `notify =` entry outside the tycoon-codex-hook managed block; left it untouched.",
    );
    // Leave the file exactly as-is apart from removing our own stale block
    // (if any), so we never sit alongside a duplicate managed entry.
    return { text: withoutManaged, warnings };
  }

  if (headerIdx === -1) {
    // No table headers at all: append at the end of the (already
    // managed-block-free) top-level-only file.
    const t = withoutManaged;
    const separator = t.length > 0 && !t.endsWith("\n") ? eol : "";
    const blank = t.length > 0 ? eol : "";
    return { text: `${t}${separator}${blank}${block}${eol}`, warnings: warnings.length ? warnings : undefined };
  }

  // Insert the block just before the first table header, preserving
  // everything before and after byte-for-byte.
  const before = withoutManaged.slice(0, headerIdx);
  const after = withoutManaged.slice(headerIdx);
  const beforeTrimmed = before.trim() === "" ? "" : before.replace(/(?:\r?\n)*$/, eol);
  const blank = beforeTrimmed.length > 0 ? eol : "";
  return { text: `${beforeTrimmed}${blank}${block}${eol}${eol}${after}`, warnings: warnings.length ? warnings : undefined };
}

/** Remove exactly the managed notify block (and nothing else) from config.toml text. Returns the SAME string reference when there was nothing to remove. */
export function removeNotifyFromConfigToml(existing: string): string {
  const stripped = stripManagedNotifyRegion(existing);
  if (!stripped) return existing;
  if (!stripped.regionEmpty) return stripped.text;
  const eol = detectEol(existing);
  const before = existing.slice(0, stripped.start).replace(/(?:\r?\n)+$/, eol);
  const after = existing.slice(stripped.end).replace(/^(?:\r?\n)+/, eol);
  const combined = before + after;
  // If the block sat at the very start of the file, `before` was empty and
  // `after` began with a blank separator line — strip that leading blank
  // line so removal restores the original bytes exactly.
  return before === "" ? combined.replace(/^\r?\n/, "") : combined;
}

/**
 * Remove our hook from another tool's notify wrapper: only the
 * `"--previous-notify", "<our argv>"` pair goes, every other element and byte
 * stays. Returns the same string when no wrapper carries our hook.
 */
export function removeWrappedHookFromConfigToml(text: string): string {
  const headerIdx = findFirstTableHeaderIndex(text);
  const topLevel = headerIdx === -1 ? text : text.slice(0, headerIdx);
  const embedded = findEmbeddedHook(topLevel);
  if (!embedded) return text;
  return text.slice(0, embedded.pairStart) + text.slice(embedded.pairEnd);
}

/**
 * Exactly the two top-level keys codex-cli 0.153.0's own hooks.json parser
 * accepts (see HOOKS_JSON_MARKER_DESCRIPTION doc comment above) — any other
 * top-level key causes codex to refuse to parse the whole file.
 */
export interface CodexHooksJson {
  description?: string;
  hooks: Record<string, { command: string[] }>;
}

/** Build the .codex/hooks.json content wiring all 12 documented events to hookScriptPath. */
export function buildHooksJson(hookScriptPath: string, nodePath?: string): CodexHooksJson {
  const hooks: Record<string, { command: string[] }> = {};
  for (const event of CODEX_HOOK_EVENTS) {
    hooks[event] = { command: buildHookCommand(hookScriptPath, nodePath) };
  }
  return { description: HOOKS_JSON_MARKER_DESCRIPTION, hooks };
}

export interface InstallCodexHooksOptions {
  /** Project directory whose .codex/hooks.json is written. */
  projectDir: string;
  /** Absolute path to hooks/tycoon-codex-hook.cjs. */
  hookScriptPath: string;
  env: ResolveCodexHomeEnv;
  platform?: NodeJS.Platform;
  /** Absolute node executable path written into the command array. Defaults to process.execPath. */
  nodePath?: string;
}

export interface InstallCodexHooksResult {
  configTomlPath: string;
  hooksJsonPath: string;
  warnings?: string[];
}

/**
 * Merge our owned event entries into an existing hooks.json's parsed
 * content. If the existing file has a non-empty `hooks` object AND either a
 * foreign (non-empty, non-ours) `description` or no `description` at all,
 * we do NOT overwrite that description — we merge only our own event keys
 * into `hooks` and return a warning instead of setting/replacing it. When
 * the file is absent, empty, or already carries our own description, we set
 * description freely.
 */
function mergeHooksJson(
  existing: unknown,
  hookScriptPath: string,
  nodePath?: string,
): { json: CodexHooksJson; warnings?: string[] } {
  const built = buildHooksJson(hookScriptPath, nodePath);
  const warnings: string[] = [];

  const isObject = existing !== null && typeof existing === "object" && !Array.isArray(existing);
  const existingHooks: Record<string, unknown> =
    isObject && typeof (existing as Record<string, unknown>).hooks === "object" && (existing as Record<string, unknown>).hooks !== null
      ? ((existing as Record<string, unknown>).hooks as Record<string, unknown>)
      : {};
  const existingDescription =
    isObject && typeof (existing as Record<string, unknown>).description === "string"
      ? ((existing as Record<string, unknown>).description as string)
      : undefined;
  const hasForeignHooks = Object.keys(existingHooks).some((k) => !CODEX_HOOK_EVENTS.includes(k));
  const hasAnyExistingHooks = Object.keys(existingHooks).length > 0;

  const mergedHooks: Record<string, { command: string[] }> = { ...(existingHooks as Record<string, { command: string[] }>), ...built.hooks };

  let description: string | undefined;
  if (existingDescription === HOOKS_JSON_MARKER_DESCRIPTION || existingDescription === undefined) {
    if (existingDescription === undefined && hasAnyExistingHooks) {
      warnings.push(
        "hooks.json already has non-empty hooks with no description of its own; leaving description unset and merging only our own event keys.",
      );
    } else {
      description = HOOKS_JSON_MARKER_DESCRIPTION;
    }
  } else {
    warnings.push(
      `hooks.json already has a foreign description ("${existingDescription}"); left it untouched and merged only our own event keys into hooks.`,
    );
    description = existingDescription;
  }

  if (hasForeignHooks) {
    warnings.push("hooks.json has foreign hook event keys we don't own; left them untouched.");
  }

  const json: CodexHooksJson = description !== undefined ? { description, hooks: mergedHooks } : { hooks: mergedHooks };
  return { json, warnings: warnings.length ? warnings : undefined };
}

/**
 * Installs both artifacts. Idempotent: re-running replaces this
 * installer's own managed block/marker without disturbing any other
 * content a user (or another tool) has in config.toml, and without ever
 * touching .claude/settings*.json or an opencode config.
 */
export function installCodexHooks(options: InstallCodexHooksOptions): InstallCodexHooksResult {
  const { codexHome } = resolveCodexHome({ env: options.env, platform: options.platform });
  fs.mkdirSync(codexHome, { recursive: true });
  const configTomlPath = path.join(codexHome, "config.toml");
  const existing = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, "utf8") : undefined;
  const merged = mergeNotifyIntoConfigToml(existing, options.hookScriptPath, options.nodePath);
  fs.writeFileSync(configTomlPath, merged.text, "utf8");

  const dotCodexDir = path.join(options.projectDir, ".codex");
  fs.mkdirSync(dotCodexDir, { recursive: true });
  const hooksJsonPath = path.join(dotCodexDir, "hooks.json");
  let existingHooksJsonParsed: unknown;
  if (fs.existsSync(hooksJsonPath)) {
    try {
      existingHooksJsonParsed = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8"));
    } catch {
      existingHooksJsonParsed = undefined;
    }
  }
  const hooksJsonMerge = mergeHooksJson(existingHooksJsonParsed, options.hookScriptPath, options.nodePath);
  fs.writeFileSync(hooksJsonPath, JSON.stringify(hooksJsonMerge.json, null, 2) + "\n", "utf8");

  const warnings = [...(merged.warnings ?? []), ...(hooksJsonMerge.warnings ?? [])];
  return { configTomlPath, hooksJsonPath, ...(warnings.length ? { warnings } : {}) };
}

export interface UninstallCodexHooksOptions {
  projectDir: string;
  env: ResolveCodexHomeEnv;
  platform?: NodeJS.Platform;
}

/**
 * Removes only what installCodexHooks added: the managed notify block from
 * config.toml (leaving the rest of the file untouched), and .codex/hooks.json
 * ONLY if it carries our HOOKS_JSON_MARKER (never deletes a hooks.json a
 * user or another tool authored without that marker).
 */
export function uninstallCodexHooks(options: UninstallCodexHooksOptions): { warnings?: string[] } {
  const warnings: string[] = [];
  const { codexHome } = resolveCodexHome({ env: options.env, platform: options.platform });
  const configTomlPath = path.join(codexHome, "config.toml");
  if (fs.existsSync(configTomlPath)) {
    const existing = fs.readFileSync(configTomlPath, "utf8");
    const stripped = removeWrappedHookFromConfigToml(removeNotifyFromConfigToml(existing));
    if (stripped !== existing) fs.writeFileSync(configTomlPath, stripped, "utf8");
    const state = detectCodexNotifyState(stripped);
    if (state === "wrapped" || state === "stale-wrapped") warnings.push(CODEX_NOTIFY_WRAPPED_UNINSTALL_MESSAGE);
  }

  const hooksJsonPath = path.join(options.projectDir, ".codex", "hooks.json");
  if (fs.existsSync(hooksJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const hooks: Record<string, unknown> =
          typeof parsed.hooks === "object" && parsed.hooks !== null ? parsed.hooks : {};
        const remainingHooks: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(hooks)) {
          if (!CODEX_HOOK_EVENTS.includes(key)) remainingHooks[key] = value;
        }
        const isOurDescription = parsed.description === HOOKS_JSON_MARKER_DESCRIPTION;
        const noForeignHooksLeft = Object.keys(remainingHooks).length === 0;

        if (isOurDescription && noForeignHooksLeft) {
          fs.unlinkSync(hooksJsonPath);
        } else if (Object.keys(remainingHooks).length !== Object.keys(hooks).length) {
          // We removed at least one of our own event keys but foreign keys
          // (or a foreign description) remain — rewrite the file with only
          // our keys stripped, leaving everything else byte-identical.
          const rewritten: Record<string, unknown> = { ...parsed, hooks: remainingHooks };
          fs.writeFileSync(hooksJsonPath, JSON.stringify(rewritten, null, 2) + "\n", "utf8");
        }
        // else: none of our event keys were present — leave the file untouched.
      }
    } catch {
      // Unparseable/foreign file — never delete something we can't confirm is ours.
    }
  }
  return warnings.length ? { warnings } : {};
}
