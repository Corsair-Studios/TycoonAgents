// TycoonAgents standalone — activity file watcher.
//
// Watches a target project's `.claude/tycoon/activity.jsonl` (append-only,
// one JSON record per line — written by hooks/tycoon-claude-hook.cjs, see
// its fs.appendFileSync(activityFile, JSON.stringify(record) + "\n") call
// sites) and `.claude/tycoon/active-agent.json` (the spawn/pop stack, see
// pushActiveAgent()/popMatchedAgent() in that same hook script — shape
// { version: 1, agentId, timestamp, stack: [...] }), and surfaces parsed
// records/state to the rest of the standalone host via callbacks.
//
// Record shapes match src/providers/claude-code/hookRecord.ts's HookRecord
// exactly (this module does not invent its own shape) — p2-t2 is expected to
// run each emitted record through mapHookRecord() (or an equivalent) the
// same way the VS Code host does. active-agent.json's `.lock` sibling file
// (see acquireLock()/releaseLock() in the hook) is never read here — it is
// a mutex, not data.
//
// WATCH MECHANISM: poll-primary, fs.watch-assisted. The sole source of
// correctness is a periodic poll (default 250ms) that stats/reads the two
// files directly; an `fs.watch(tycoonDir, ...)` directory watcher (armed
// opportunistically, re-armed every tick until it succeeds) is layered on
// top purely to trigger an out-of-cycle poll sooner. This split exists
// because fs.watch is documented as platform-dependent and is known to be
// flaky for append-only file growth and for a watched path that doesn't
// exist yet (throws ENOENT) — exactly this module's two hard requirements
// (tail appends, and pick up files created after the watcher starts, AC3).
// Polling directly against fs.statSync/fs.readSync sidesteps all of that at
// the cost of up to one poll interval of latency, which is an acceptable
// trade for a live-metrics view. No third-party deps — Node builtins only.
//
// Node built-ins only — standalone/package.json ships zero dependencies.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_POLL_MS = 250;

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// Codes seen from Windows' atomic tmp-then-rename write pattern (see
// hooks/tycoon-claude-hook.cjs's atomicWriteSync) while the writer (the hook,
// or the VS Code host) briefly holds/replaces the file: EPERM/EBUSY when the
// rename target is momentarily locked, EACCES on some Windows/AV
// combinations, ENOENT mid-rename (old name gone, new name not yet visible).
// All of these are expected to clear within a handful of milliseconds and
// must never be treated as a real failure.
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOENT']);

function isTransientFsError(err) {
  return !!err && TRANSIENT_FS_CODES.has(err.code);
}

// Backing buffer for the synchronous sleep in readWithRetrySync — allocated
// once at module scope and reused across calls rather than per-call.
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(_sleepBuf, 0, 0, ms);
}

/**
 * Retry a synchronous fs read a few times with a short backoff when it
 * throws a transient error (see TRANSIENT_FS_CODES) — Windows' atomic
 * tmp-then-rename write pattern briefly makes the destination path
 * unreadable while the writer holds/replaces it. A non-transient error (bad
 * permissions that aren't going to clear, etc.) is thrown immediately on
 * first failure so callers still see real problems promptly.
 *
 * Backoff uses Atomics.wait on a shared buffer for a true blocking sleep
 * (not a CPU spin). Default attempts=4 with backoff [5, 10, 20]ms bounds
 * worst-case blocking at 35ms per call, off a 250ms poll tick.
 * @param {() => T} fn
 * @param {{ attempts?: number, delayMs?: number | number[] }} [opts]
 * @returns {T}
 */
function readWithRetrySync(fn, opts = {}) {
  const attempts = opts.attempts ?? 4;
  const backoff = opts.delayMs ?? [5, 10, 20];
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientFsError(err)) throw err;
      if (i < attempts - 1) {
        const delay = Array.isArray(backoff) ? (backoff[i] ?? backoff[backoff.length - 1]) : backoff;
        sleepSync(delay);
      }
    }
  }
  throw lastErr;
}

/**
 * @param {string} projectRoot absolute path to the target project (the dir
 *   containing `.claude/tycoon/`, i.e. what the hook calls CLAUDE_PROJECT_DIR).
 * @param {object} [opts]
 * @param {(records: object[]) => void} [opts.onRecords] called with a
 *   non-empty, in-order batch of parsed activity.jsonl records whenever new
 *   complete lines are observed. Never called with an empty array.
 * @param {(state: object | null) => void} [opts.onActiveAgent] called with
 *   the parsed active-agent.json content whenever it changes (push/pop/any
 *   rewrite), or `null` if the file is missing/removed. Not called on a
 *   redundant read (byte-identical content).
 * @param {(err: Error) => void} [opts.onError] called for a recoverable
 *   problem (malformed line, transient read failure). Never thrown.
 * @param {number} [opts.pollIntervalMs]
 * @param {boolean} [opts.replayExisting] when `true`, the existing content of
 *   activity.jsonl at prime-time is parsed and emitted (in order, via
 *   onRecords, as a single batch when non-empty) BEFORE live tailing begins,
 *   instead of the default behavior of silently advancing past it. Consumers
 *   that need a full-file replay (e.g. rebuilding MetricsWorldState via
 *   computeStateFromRecords, which is whole-file like the VS Code panel's
 *   boot-time read) should opt in with `true`. Default `false` preserves the
 *   original "backlog is not new events" behavior for callers that only care
 *   about live activity from watcher-start onward. Malformed lines in the
 *   replayed backlog go through onError exactly like a live-tailed malformed
 *   line; a trailing partial line (no final newline) is carried into the live
 *   tail buffer, never parsed early, same as the live path.
 * @returns {{ close: () => void }}
 */
export function createActivityWatcher(projectRoot, opts = {}) {
  const onRecords = typeof opts.onRecords === 'function' ? opts.onRecords : () => {};
  const onActiveAgent = typeof opts.onActiveAgent === 'function' ? opts.onActiveAgent : () => {};
  const onError =
    typeof opts.onError === 'function'
      ? opts.onError
      : (err) => console.error('[tycoonagents-standalone] activityWatcher:', err.message || err);
  const pollIntervalMs = opts.pollIntervalMs || DEFAULT_POLL_MS;
  const replayExisting = opts.replayExisting === true;

  const tycoonDir = path.join(projectRoot, '.claude', 'tycoon');
  const activityPath = path.join(tycoonDir, 'activity.jsonl');
  const activeAgentPath = path.join(tycoonDir, 'active-agent.json');

  // Byte offset already consumed from activity.jsonl, and any trailing
  // partial line (no newline yet — the hook is mid-write) carried forward
  // to the next poll so it is never parsed half-formed.
  let activityOffset = 0;
  let activityBuffer = '';

  // Last raw active-agent.json text surfaced, so an unchanged file (most
  // polls) is a no-op rather than a redundant callback.
  let lastActiveAgentRaw;
  let sawActiveAgentFile = false;

  let closed = false;

  // Rate-limits onError so a run of transient EPERM/EBUSY/ENOENT retries
  // (which can recur every poll tick while a writer is mid-rename under
  // load) doesn't spam the log — one line per source per window, not one per
  // tick. Keyed by source so activity.jsonl and active-agent.json failures
  // are tracked independently.
  const ERROR_LOG_WINDOW_MS = 5000;
  const lastErrorLoggedAt = new Map();
  function reportError(source, err) {
    const now = Date.now();
    const last = lastErrorLoggedAt.get(source) ?? 0;
    if (now - last < ERROR_LOG_WINDOW_MS) return;
    lastErrorLoggedAt.set(source, now);
    onError(err);
  }

  function pollActivity() {
    const stat = safeStat(activityPath);
    if (!stat) {
      // Not present yet (or removed) — reset so a later create is tailed
      // from the start rather than assumed to be a truncation.
      if (activityOffset !== 0 || activityBuffer !== '') {
        activityOffset = 0;
        activityBuffer = '';
      }
      return;
    }

    if (stat.size < activityOffset) {
      // Truncated or rotated out from under us — restart from 0. Anything
      // already in the (now-stale) buffer is discarded; it belonged to
      // content that no longer exists at these offsets.
      activityOffset = 0;
      activityBuffer = '';
    }

    if (stat.size === activityOffset) return; // nothing new

    let buf;
    try {
      buf = readWithRetrySync(() => {
        const length = stat.size - activityOffset;
        const b = Buffer.alloc(length);
        // Open, read, and close within each attempt so a failed attempt
        // never leaks an fd across retries.
        const fd = fs.openSync(activityPath, 'r');
        try {
          fs.readSync(fd, b, 0, length, activityOffset);
        } finally {
          try {
            fs.closeSync(fd);
          } catch {
            /* ignore */
          }
        }
        return b;
      });
      activityOffset = stat.size;
    } catch (err) {
      // File vanished/locked between stat and read, and stayed that way
      // through the retries above (see readWithRetrySync) — leave offset
      // as-is and retry next tick. Never propagates past pollAll's own
      // try/catch, and the watcher/timer are untouched either way.
      reportError('activity.jsonl', err);
      return;
    }

    activityBuffer += buf.toString('utf8');

    // Split into complete lines; the final element is either '' (buffer
    // ended exactly on a newline) or a partial line still being written —
    // either way it goes back into activityBuffer, never parsed early.
    const parts = activityBuffer.split('\n');
    activityBuffer = parts.pop() ?? '';

    const records = [];
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(stripBom(trimmed)));
      } catch (err) {
        onError(new Error(`activity.jsonl: skipped malformed line (${err.message})`));
      }
    }
    if (records.length > 0) onRecords(records);
  }

  function pollActiveAgent() {
    const stat = safeStat(activeAgentPath);
    if (!stat) {
      if (sawActiveAgentFile) {
        sawActiveAgentFile = false;
        lastActiveAgentRaw = undefined;
        onActiveAgent(null);
      }
      return;
    }

    let raw;
    try {
      raw = readWithRetrySync(() => fs.readFileSync(activeAgentPath, 'utf8'));
    } catch (err) {
      // Transient (EPERM/EBUSY/EACCES/ENOENT — see TRANSIENT_FS_CODES) reads
      // survived the retries above and still failed: the writer (the hook's
      // atomicWriteSync, or the VS Code host) is mid tmp-then-rename on
      // Windows. Keep surfacing the LAST known state rather than clearing
      // it — never call onActiveAgent(null) here — and log at most once per
      // ERROR_LOG_WINDOW_MS instead of every poll tick. The watcher keeps
      // polling; next tick retries the read from scratch.
      reportError('active-agent.json', err);
      return;
    }
    if (raw === lastActiveAgentRaw) return; // unchanged since last surfaced

    let parsed;
    try {
      parsed = JSON.parse(stripBom(raw));
    } catch {
      // The hook writes this file via an atomic tmp-then-rename (see
      // atomicWriteSync in hooks/tycoon-claude-hook.cjs), so a torn read
      // should be rare/transient — wait for the next poll rather than
      // surfacing broken state or throwing.
      return;
    }

    lastActiveAgentRaw = raw;
    sawActiveAgentFile = true;
    onActiveAgent(parsed);
  }

  function pollAll() {
    if (closed) return;
    try {
      pollActivity();
    } catch (err) {
      onError(err);
    }
    try {
      pollActiveAgent();
    } catch (err) {
      onError(err);
    }
  }

  // Prime: existing activity.jsonl content on startup is backlog. By default
  // (replayExisting === false) it is not a burst of "new" events — the
  // offset silently advances to end-of-file, preserving this module's
  // original tail-only behavior. With replayExisting === true, the backlog
  // IS parsed and handed to onRecords (in order, as one batch) before live
  // tailing begins — mirrors the VS Code panel's whole-file boot-time read
  // (_readActivityRecords), which callers like stateFeed.mjs need since
  // computeStateFromRecords is a whole-file replay, not an incremental feed.
  // Either way, active-agent.json's CURRENT state (if any) IS surfaced once
  // immediately so a freshly-connected browser tab sees who's active right
  // away, same as the VS Code panel's boot-time read.
  (function prime() {
    const stat = safeStat(activityPath);
    if (stat) {
      if (replayExisting) {
        let raw = '';
        try {
          raw = fs.readFileSync(activityPath, 'utf8');
        } catch (err) {
          onError(err);
          raw = '';
        }
        // Same split as pollActivity: the final element is either '' (file
        // ends exactly on a newline) or a still-being-written partial line —
        // either way it is carried into activityBuffer, never parsed early.
        const parts = raw.split('\n');
        const trailingPartial = parts.pop() ?? '';
        activityBuffer = trailingPartial;
        // Byte offset (not JS string length) so a later poll's fs.readSync
        // (which operates on byte positions) resumes exactly where the
        // trailing partial line began.
        activityOffset = Buffer.byteLength(raw, 'utf8') - Buffer.byteLength(trailingPartial, 'utf8');

        const records = [];
        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            records.push(JSON.parse(stripBom(trimmed)));
          } catch (err) {
            onError(new Error(`activity.jsonl: skipped malformed line (${err.message})`));
          }
        }
        if (records.length > 0) onRecords(records);
      } else {
        activityOffset = stat.size;
      }
    }
    pollActiveAgent();
  })();

  // fs.watch fast-path (best-effort, never the sole source of correctness —
  // see module header). Watching the DIRECTORY (not the individual files)
  // means it also catches the files being CREATED after the watcher starts
  // (AC3), and survives armDirWatch() being called before .claude/tycoon
  // exists (it just fails silently and is retried every poll tick).
  let dirWatcher;
  function armDirWatch() {
    if (closed || dirWatcher) return;
    try {
      dirWatcher = fs.watch(tycoonDir, () => pollAll());
      dirWatcher.on('error', () => {
        try {
          dirWatcher.close();
        } catch {
          /* ignore */
        }
        dirWatcher = undefined;
      });
    } catch {
      // tycoonDir does not exist yet, or fs.watch is unsupported for this
      // path on this platform — the interval below retries arming it and
      // is itself sufficient for correctness in the meantime.
    }
  }
  armDirWatch();

  const interval = setInterval(() => {
    if (!dirWatcher) armDirWatch();
    pollAll();
  }, pollIntervalMs);
  // Don't hold the process open on this timer alone (matters for a future
  // CLI/test harness that wants to exit cleanly without explicitly closing
  // every watcher).
  if (typeof interval.unref === 'function') interval.unref();

  return {
    close() {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      if (dirWatcher) {
        try {
          dirWatcher.close();
        } catch {
          /* ignore */
        }
        dirWatcher = undefined;
      }
    },
  };
}
