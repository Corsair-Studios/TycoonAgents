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

    let fd;
    let buf;
    try {
      fd = fs.openSync(activityPath, 'r');
      const length = stat.size - activityOffset;
      buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, activityOffset);
      activityOffset = stat.size;
    } catch (err) {
      // File vanished/locked between stat and read — leave offset as-is and
      // retry next tick.
      onError(err);
      return;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
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
      raw = fs.readFileSync(activeAgentPath, 'utf8');
    } catch (err) {
      onError(err);
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
