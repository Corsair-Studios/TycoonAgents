import * as fs from "fs";
import * as path from "path";

/** Grace period after a hooks change before an absent hook event counts as "waiting". */
export const HOOK_WAIT_GRACE_MS = 10_000;

/** Subset of fs the marker helpers use; injectable for tests. */
export type HookWaitFs = Pick<typeof fs, "readFileSync" | "writeFileSync" | "renameSync" | "mkdirSync" | "statSync" | "openSync" | "readSync" | "closeSync">;

/** Tycoon-owned marker: when TycoonAgents last installed/repaired/rewrote this project's hooks. */
export function hooksChangedPath(root: string): string {
  return path.join(root, ".claude", "tycoon", "hooks-changed.json");
}

/** Epoch ms of the last Tycoon hook write for this project, or null when never recorded. */
export function readHooksChangedAt(root: string, fsImpl: HookWaitFs = fs): number | null {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(hooksChangedPath(root), "utf8") as string);
    const at = parsed?.changedAt;
    return typeof at === "number" && Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/** Record "hooks changed now" (best-effort, atomic; never throws). Returns the stamped time. */
export function recordHooksChanged(root: string, now: number = Date.now(), fsImpl: HookWaitFs = fs): number {
  try {
    const file = hooksChangedPath(root);
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fsImpl.writeFileSync(tmp, JSON.stringify({ changedAt: now }));
    fsImpl.renameSync(tmp, file);
  } catch {
    /* best-effort marker */
  }
  return now;
}

/** Tycoon-owned marker: the latest hook event the panel has ingested. Never touched by metrics reset or log rotation. */
export function lastHookEventPath(root: string): string {
  return path.join(root, ".claude", "tycoon", "hook-last-event.json");
}

/** Epoch ms of the last hook event the panel has seen (persisted), or null when none seen yet. */
export function readLastHookEventAt(root: string, fsImpl: HookWaitFs = fs): number | null {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(lastHookEventPath(root), "utf8") as string);
    const at = parsed?.lastEventAt;
    return typeof at === "number" && Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/** Persist a seen-event time; monotonic (never moves backwards). Best-effort, never throws. */
export function recordHookEventSeen(root: string, at: number, fsImpl: HookWaitFs = fs): void {
  try {
    const prev = readLastHookEventAt(root, fsImpl);
    if (prev !== null && prev >= at) return;
    const file = lastHookEventPath(root);
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fsImpl.writeFileSync(tmp, JSON.stringify({ lastEventAt: at }));
    fsImpl.renameSync(tmp, file);
  } catch {
    /* best-effort marker */
  }
}

/** Incremental read position in activity.jsonl; undefined before the first scan. */
export interface HookEventScanState {
  offset: number | undefined;
}

const FIRST_SCAN_TAIL_BYTES = 64 * 1024;

/**
 * Ingest newly appended hook events from activity.jsonl and persist the
 * latest event time (the record's own `at` in ms, else ingest time). A
 * truncated/rewritten file (metrics reset, rotation) only rewinds the read
 * offset; it never changes the persisted marker.
 */
export function scanHookEvents(
  root: string,
  state: HookEventScanState,
  now: number = Date.now(),
  fsImpl: HookWaitFs = fs
): void {
  try {
    const file = path.join(root, ".claude", "tycoon", "activity.jsonl");
    const size = fsImpl.statSync(file).size;
    let from = state.offset;
    if (from === undefined) from = Math.max(0, size - FIRST_SCAN_TAIL_BYTES);
    else if (size < from) from = 0;
    if (size <= from) {
      state.offset = size;
      return;
    }
    const buf = Buffer.alloc(size - from);
    const fd = fsImpl.openSync(file, "r");
    try {
      fsImpl.readSync(fd, buf, 0, buf.length, from);
    } finally {
      fsImpl.closeSync(fd);
    }
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) {
      state.offset = from;
      return;
    }
    state.offset = from + lastNl + 1;
    let max: number | null = null;
    for (const line of buf.subarray(0, lastNl).toString("utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t);
        if (rec === null || typeof rec !== "object") continue;
        const at = typeof rec.at === "number" && Number.isFinite(rec.at) ? rec.at : now;
        if (max === null || at > max) max = at;
      } catch {
        /* skip malformed line */
      }
    }
    if (max !== null) recordHookEventSeen(root, max, fsImpl);
  } catch {
    /* activity.jsonl missing/unreadable -> nothing to ingest */
  }
}

/**
 * True when hooks are installed, were changed at least `graceMs` ago, and no
 * hook event has arrived since. Self-clearing: the first event after the
 * change makes it false. Never true without a recorded change.
 */
export function isWaitingForFirstHookEvent(args: {
  installed: boolean;
  changedAt: number | null;
  lastEventAt: number | null;
  now: number;
  graceMs?: number;
}): boolean {
  const { installed, changedAt, lastEventAt, now, graceMs = HOOK_WAIT_GRACE_MS } = args;
  if (!installed || changedAt === null) return false;
  if (lastEventAt !== null && lastEventAt >= changedAt) return false;
  return now - changedAt >= graceMs;
}

/** globalState key holding the extension version that last ran against `root`. */
export function lastRunVersionKey(root: string): string {
  return `tycoonagents.lastRunVersion:${root}`;
}

/**
 * Version-change detector: returns true (and stores the new version) when the
 * stored version for this project differs from `current`. A missing stored
 * value only records the version and returns false. Memento-shaped so tests can pass a Map-backed stub.
 */
export function noteRunVersion(
  store: { get<T>(key: string): T | undefined; update(key: string, value: unknown): PromiseLike<void> | void },
  root: string,
  current: string | null
): boolean {
  if (current === null) return false;
  const key = lastRunVersionKey(root);
  const prev = store.get<string>(key);
  if (prev === current) return false;
  void store.update(key, current);
  // First sighting only records the version; just a real difference is a change.
  return prev !== undefined;
}
