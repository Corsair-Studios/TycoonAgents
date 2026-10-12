import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

/** The two harnesses whose hooks tag a person's own prompt into activity.jsonl. */
export type MismatchHarness = "claude-code" | "codex";

/** Subset of fs the scanner uses; injectable for tests. */
export type MismatchFs = Pick<typeof fs, "statSync" | "openSync" | "readSync" | "closeSync">;

/** Incremental scan state. `pending` is the unanswered mismatching prompt, if any. */
export interface HarnessMismatchState {
  offset: number | undefined;
  /** Selected harness the state was built for; a switch resets it. */
  selected: string | undefined;
  pending: { from: MismatchHarness; at: number; sessionId: string } | null;
  /** Fingerprint (birthtime + first-line hash) of the file `offset` refers to; a change means rotation. */
  fingerprint: string | undefined;
  /** Dismissed mismatching session/thread ids (bounded, newest last). */
  dismissed: string[];
}

export function newHarnessMismatchState(): HarnessMismatchState {
  return { offset: undefined, selected: undefined, pending: null, fingerprint: undefined, dismissed: [] };
}

export const MAX_DISMISSED_SESSIONS = 50;

const MAX_READ_BYTES = 1024 * 1024;

/** Provider tag of an activity record (untagged legacy records are Claude Code, like the providers' own filter). */
export function recordProvider(rec: unknown): string {
  const p = rec && typeof rec === "object" ? (rec as { provider?: unknown }).provider : undefined;
  return typeof p === "string" && p !== "" ? p : "claude-code";
}

/** Stable dismissal key for a mismatching session/thread (provider-scoped; per-provider fallback when the record has no id). */
export function mismatchSessionId(provider: string, sessionId: unknown): string {
  return `${provider}:${typeof sessionId === "string" && sessionId !== "" ? sessionId : "unknown"}`;
}

/** Birthtime + hash of the first complete line; undefined until a full line exists. */
function fileFingerprint(file: string, birthtimeMs: number, fsImpl: MismatchFs): string | undefined {
  const buf = Buffer.alloc(4096);
  const fd = fsImpl.openSync(file, "r");
  let n = 0;
  try {
    n = fsImpl.readSync(fd, buf, 0, buf.length, 0);
  } finally {
    fsImpl.closeSync(fd);
  }
  const nl = buf.subarray(0, n).indexOf(0x0a);
  if (nl === -1) return undefined;
  const h = crypto.createHash("sha1").update(buf.subarray(0, nl)).digest("hex");
  return `${birthtimeMs > 0 ? Math.floor(birthtimeMs) : 0}:${h}`;
}

/**
 * Apply one activity record. A top-level prompt (`userPrompt:true`, written only by
 * a person's own prompt, never by tool/subagent events or bridge children) from the
 * OTHER of claude-code/codex sets `pending`; any record from the selected harness clears it.
 */
export function applyMismatchRecord(state: HarnessMismatchState, selected: string, rec: unknown, now: number): void {
  if (rec === null || typeof rec !== "object") return;
  const provider = recordProvider(rec);
  if (provider === selected) {
    state.pending = null;
    return;
  }
  const r = rec as { userPrompt?: unknown; at?: unknown; sessionId?: unknown };
  if (r.userPrompt === true && (provider === "claude-code" || provider === "codex") && (selected === "claude-code" || selected === "codex")) {
    const sessionId = mismatchSessionId(provider, r.sessionId);
    if (state.dismissed.includes(sessionId)) return;
    // Both records of one Codex turn (UserPromptSubmit + Stop) share a thread id; keep the first `at` so the payload key is stable mid-turn.
    if (state.pending && state.pending.from === provider && state.pending.sessionId === sessionId) return;
    state.pending = { from: provider, at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : now, sessionId };
  }
}

/**
 * Ingest lines appended to activity.jsonl since the last call. The first call only
 * records the end of the file (history never raises the hint). A different `selected`
 * harness clears pending. Best-effort; never throws.
 */
export function scanHarnessMismatch(
  root: string,
  selected: string,
  state: HarnessMismatchState,
  now: number = Date.now(),
  fsImpl: MismatchFs = fs
): void {
  try {
    if (state.selected !== selected) {
      state.selected = selected;
      state.pending = null;
    }
    const file = path.join(root, ".claude", "tycoon", "activity.jsonl");
    let st: { size: number; birthtimeMs: number };
    try {
      st = fsImpl.statSync(file);
    } catch {
      // Absent: whatever appears later is new content, not history (also covers delete + recreate).
      state.offset = 0;
      state.fingerprint = undefined;
      return;
    }
    const size = st.size;
    const fp = fileFingerprint(file, st.birthtimeMs, fsImpl);
    if (state.offset === undefined) {
      state.offset = size;
      state.fingerprint = fp;
      return;
    }
    let rotated = false;
    if (fp !== undefined) {
      if (state.fingerprint !== undefined && state.fingerprint !== fp) rotated = true;
      state.fingerprint = fp;
    }
    let from = state.offset;
    if (size < from || rotated) from = 0;
    if (size <= from) {
      state.offset = size;
      return;
    }
    const len = Math.min(size - from, MAX_READ_BYTES);
    const buf = Buffer.alloc(len);
    const fd = fsImpl.openSync(file, "r");
    try {
      fsImpl.readSync(fd, buf, 0, len, from);
    } finally {
      fsImpl.closeSync(fd);
    }
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) {
      state.offset = from;
      return;
    }
    state.offset = from + lastNl + 1;
    for (const line of buf.subarray(0, lastNl).toString("utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        applyMismatchRecord(state, selected, JSON.parse(t), now);
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* activity.jsonl missing/unreadable -> nothing to ingest */
  }
}

/** workspaceState key for the per-project "Don't show again" choice. */
export function mismatchSuppressKey(root: string): string {
  return `tycoonagents.harnessMismatchHintOff:${root}`;
}

/** Memento-shaped store (workspaceState). */
export interface MismatchStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

export function isMismatchSuppressed(store: MismatchStore | undefined, root: string): boolean {
  try {
    return !!store && store.get<boolean>(mismatchSuppressKey(root)) === true;
  } catch {
    return false;
  }
}

export function suppressMismatch(store: MismatchStore | undefined, root: string): void {
  try {
    if (store) void store.update(mismatchSuppressKey(root), true);
  } catch {
    /* best-effort */
  }
}

export function dismissedKey(root: string): string {
  return `tycoonagents.harnessMismatchDismissed:${root}`;
}

/** Load persisted dismissed session ids into the scan state. Never throws. */
export function loadDismissedMismatch(state: HarnessMismatchState, store: MismatchStore | undefined, root: string): void {
  try {
    const v = store ? store.get<unknown>(dismissedKey(root)) : undefined;
    if (Array.isArray(v)) {
      for (const id of v) if (typeof id === "string" && !state.dismissed.includes(id)) state.dismissed.push(id);
      state.dismissed = state.dismissed.slice(-MAX_DISMISSED_SESSIONS);
    }
  } catch {
    /* best-effort */
  }
}

/** Dismiss the pending hint for its whole session/thread: further prompts in it never re-raise. */
export function dismissMismatch(state: HarnessMismatchState, store: MismatchStore | undefined, root: string): void {
  const p = state.pending;
  if (!p) return;
  if (!state.dismissed.includes(p.sessionId)) state.dismissed.push(p.sessionId);
  state.dismissed = state.dismissed.slice(-MAX_DISMISSED_SESSIONS);
  state.pending = null;
  try {
    if (store) void store.update(dismissedKey(root), state.dismissed.slice());
  } catch {
    /* best-effort */
  }
}

/** Payload for the host -> webview message; active=false clears the hint. */
export interface HarnessMismatchPayload {
  active: boolean;
  from: MismatchHarness | null;
  selected: string;
  promptAt: number | null;
}

export function mismatchPayload(state: HarnessMismatchState, selected: string, suppressed: boolean): HarnessMismatchPayload {
  const p = !suppressed ? state.pending : null;
  return { active: !!p, from: p ? p.from : null, selected, promptAt: p ? p.at : null };
}
