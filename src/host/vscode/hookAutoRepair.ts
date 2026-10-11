import * as fs from "fs";
import * as path from "path";
import { diagnose, repairSettings, hasTycoonCommandsInSettings, isTycoonCommand, type HookEnv } from "./hookDoctor";
import { TYCOON_HOOK_SLOTS } from "./hookInstall";

/** Filesystem operations the repair uses; injectable so tests can force failures. */
export type RepairFs = Pick<
  typeof fs,
  "readFileSync" | "writeFileSync" | "renameSync" | "unlinkSync" | "mkdirSync" | "existsSync"
>;

export const slotKey = (s: { event: string; matcher: string }): string => `${s.event}|${s.matcher}`;

/** Tycoon-owned marker listing the hook slots already offered to this project. */
export function slotMarkerPath(root: string): string {
  return path.join(root, ".claude", "tycoon", "hook-slots.json");
}

/** Recorded slot keys, or null when no (valid) marker exists. */
export function readSlotMarker(root: string, fsImpl: RepairFs = fs): Set<string> | null {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(slotMarkerPath(root), "utf8") as string);
    if (parsed && Array.isArray(parsed.slots)) {
      return new Set<string>(parsed.slots.filter((k: unknown): k is string => typeof k === "string"));
    }
  } catch {
    /* absent or invalid -> no marker */
  }
  return null;
}

/** Atomically record slot keys (best-effort; never throws). */
export function writeSlotMarker(root: string, keys: Iterable<string>, fsImpl: RepairFs = fs): void {
  try {
    const file = slotMarkerPath(root);
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, JSON.stringify({ slots: Array.from(new Set(keys)).sort() }, null, 2), fsImpl);
  } catch {
    /* best-effort marker */
  }
}

/** Record every slot Tycoon currently ships (install / explicit Fix add them all). */
export function recordAllHookSlots(root: string, fsImpl: RepairFs = fs): void {
  const prev = readSlotMarker(root, fsImpl) ?? new Set<string>();
  writeSlotMarker(root, [...prev, ...TYCOON_HOOK_SLOTS.map(slotKey)], fsImpl);
}

/** Write to a temp file beside the target, then rename over it. Original is intact on failure. */
export function atomicWrite(target: string, content: string, fsImpl: RepairFs = fs): void {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fsImpl.writeFileSync(tmp, content);
    fsImpl.renameSync(tmp, target);
  } catch (err) {
    try {
      fsImpl.unlinkSync(tmp);
    } catch {
      /* temp may not exist */
    }
    throw err;
  }
}

/** Safety copy in the Tycoon-owned dir (never beside the user's settings file). Best-effort, never overwrites. */
export function backupSettingsCopy(root: string, raw: string | Buffer, fsImpl: RepairFs = fs): void {
  try {
    const backupPath = path.join(root, ".claude", "tycoon", "settings.local.json.bak");
    if (fsImpl.existsSync(backupPath)) return;
    fsImpl.mkdirSync(path.dirname(backupPath), { recursive: true });
    fsImpl.writeFileSync(backupPath, raw);
  } catch {
    /* best-effort backup */
  }
}

/** Slots holding any Tycoon command (whatever its interpreter form), matched by (event, matcher). */
function wiredSlotKeys(settings: any, _currentHookCommand?: string): string[] {
  const out: string[] = [];
  for (const slot of TYCOON_HOOK_SLOTS) {
    const list = settings?.hooks?.[slot.event];
    if (!Array.isArray(list)) continue;
    const wired = list.some(
      (e: any) =>
        e && e.matcher === slot.matcher && Array.isArray(e.hooks) && e.hooks.some((h: any) => h && typeof h.command === "string" && isTycoonCommand(h.command))
    );
    if (wired) out.push(slotKey(slot));
  }
  return out;
}

/** Undo the slot additions repairSettings made for slots the user deliberately removed. */
function dropReaddedSlots(settings: any, original: any, skip: Array<{ event: string; matcher: string }>, cmd: string): void {
  for (const slot of skip) {
    const list = settings.hooks?.[slot.event];
    if (!Array.isArray(list)) continue;
    const origList = original?.hooks?.[slot.event];
    for (const e of list.slice()) {
      if (!e || e.matcher !== slot.matcher || !Array.isArray(e.hooks)) continue;
      e.hooks = e.hooks.filter((h: any) => !(h && h.command === cmd));
      const existedBefore = Array.isArray(origList) && origList.some((o: any) => o && o.matcher === slot.matcher);
      if (e.hooks.length === 0 && !existedBefore) list.splice(list.indexOf(e), 1);
    }
    if (list.length === 0 && !Array.isArray(origList)) delete settings.hooks[slot.event];
  }
}

export type SilentRepairResult =
  | { status: "repaired"; changes: string[] }
  | { status: "skipped"; reason: string };

/** Finding ids a silent repair is allowed to act on (all settings-file issues repairSettings fixes). */
const SILENT_FIXABLE = new Set(["hooks-missing", "hooks-stale", "hooks-relative-command", "hooks-duplicate"]);

/**
 * Silent upgrade repair for `<root>/.claude/settings.local.json` only.
 *
 * Acts only when the file is valid JSON and ALREADY holds at least one
 * Tycoon hook command (opt-in stays explicit), and settings.json holds none
 * (a split install is left to the visible warning). Never touches foreign
 * hooks, settings.json, or user-level settings. Invalid or unreadable JSON is
 * never rewritten. Writes only when the repaired result differs from the
 * original, so a second run is a no-op.
 */
export function silentRepairLocalHooks(
  root: string,
  currentHookCommand: string,
  fsImpl: RepairFs = fs,
  hookEnv: HookEnv = {}
): SilentRepairResult {
  const claudeDir = path.join(root, ".claude");
  const localPath = path.join(claudeDir, "settings.local.json");
  const sharedPath = path.join(claudeDir, "settings.json");

  let raw: string;
  try {
    raw = fsImpl.readFileSync(localPath, "utf8") as string;
  } catch {
    return { status: "skipped", reason: "no settings.local.json" };
  }
  let local: any;
  try {
    local = JSON.parse(raw);
  } catch {
    return { status: "skipped", reason: "invalid JSON" };
  }
  if (local === null || typeof local !== "object" || Array.isArray(local)) {
    return { status: "skipped", reason: "not an object" };
  }

  let shared: any = null;
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(sharedPath, "utf8") as string);
    if (parsed !== null && typeof parsed === "object") shared = parsed;
  } catch {
    /* absent or invalid shared settings -> treated as no hooks there */
  }

  const findings = diagnose({
    localSettings: local,
    sharedSettings: shared,
    currentHookCommand,
    hookScriptExists: true,
    env: hookEnv,
  });
  if (findings.some((f) => f.id === "hooks-split")) {
    return { status: "skipped", reason: "hooks split across settings files" };
  }
  const marker = readSlotMarker(root, fsImpl);
  const actionable = findings.filter((f) => SILENT_FIXABLE.has(f.id));
  // Opt-in guard: a project with no Tycoon hook command is never touched.
  if (!hasTycoonCommandsInSettings(local) || actionable.length === 0) {
    if (!marker && hasTycoonCommandsInSettings(local)) writeSlotMarker(root, wiredSlotKeys(local, currentHookCommand), fsImpl);
    return { status: "skipped", reason: "nothing to repair" };
  }

  const repaired = repairSettings(local, currentHookCommand, { removeForeign: false, env: hookEnv });
  const settings = repaired.settings;
  let changes: string[] = repaired.changes;
  // A slot recorded in the marker but absent now was removed on purpose: do not re-add it.
  // Only slots introduced since the marker was written (or all, with no marker) are added.
  if (marker) {
    const wasWired = new Set(wiredSlotKeys(local, currentHookCommand));
    const skip = TYCOON_HOOK_SLOTS.filter((sl) => marker.has(slotKey(sl)) && !wasWired.has(slotKey(sl)));
    dropReaddedSlots(settings, local, skip, currentHookCommand);
    const skipped = new Set(skip.map((sl) => `Wired ${sl.event} (${sl.matcher || "any"}) hook`));
    changes = changes.filter((c) => !skipped.has(c));
  }
  if (JSON.stringify(settings) === JSON.stringify(local) || changes.length === 0) {
    if (!marker) writeSlotMarker(root, wiredSlotKeys(local, currentHookCommand), fsImpl);
    return { status: "skipped", reason: "already current" };
  }

  backupSettingsCopy(root, raw, fsImpl);
  try {
    atomicWrite(localPath, JSON.stringify(settings, null, 2), fsImpl);
  } catch {
    return { status: "skipped", reason: "write failed" };
  }
  writeSlotMarker(root, [...(marker ?? []), ...wiredSlotKeys(settings, currentHookCommand)], fsImpl);
  return { status: "repaired", changes };
}
