// TycoonAgents standalone — activity records -> MetricsWorldState -> SSE.
//
// Wires activityWatcher.mjs (raw activity.jsonl tailing) through
// sharedLogic.mjs (the compiled src/core/state.js / mapHookRecord.js reused
// in place, NOT forked) into the same webview message shape
// src/host/vscode/panel.ts posts for MSG.STATE. See panel.ts's two real
// postMessage call sites (constructor's runtime.onChange subscription, and
// the MSG.READY handler): both post
//   { type: MSG.STATE, state: this._applyTimeAdjustments(runtimeState) }
// where _applyTimeAdjustments (absent persisted time-adjustments.json, the
// common case) reduces to _withModeStats, which just attaches
// `modeStats: computeDelegationModeStats(state.agentMetrics)` to the state
// object. MSG.STATE's wire value is the literal string "state"
// (src/host/vscode/messages.ts) — mirrored here as MSG_STATE since
// messages.ts itself (zod + ProjectPlanSchema) is out of this task's
// verified-vscode-free bridge surface; only the wire STRING is duplicated,
// not any logic.
//
// KNOWN GAP: persisted `.claude/tycoon/time-adjustments.json` per-agent
// activeMs corrections (panel.ts's _applyTimeAdjustments) are NOT replicated
// here — only the common no-adjustments-file path (_withModeStats) is. A
// project with saved time adjustments will see slightly different activeMs
// in the standalone view than in the VS Code panel until a later task adds
// that file read too.
//
// Node built-ins only — standalone/package.json ships zero dependencies.

import { createActivityWatcher } from './activityWatcher.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {
  computeStateFromRecords,
  computeDelegationModeStats,
  loadAgentRoster,
  rosterSeedEvents,
  stampRosterModels,
} from './sharedLogic.mjs';

// Mirrors MSG.STATE ("state") from src/host/vscode/messages.ts — see module
// header. Wire-string duplication only; the VALUE must stay byte-identical
// to that file's MSG.STATE, since media/main.js matches it by hand.
const MSG_STATE = 'state';

/**
 * @param {object} opts
 * @param {string} opts.projectRoot absolute path to the target project (the
 *   dir containing `.claude/tycoon/`), passed straight through to
 *   createActivityWatcher.
 * @param {(eventName: string, data: object) => void} opts.broadcast typically
 *   standalone/src/server.mjs's exported `broadcast` — called with
 *   eventName "message" (the SSE event name the host page's EventSource
 *   listener re-dispatches as a window 'message' event; see server.mjs's
 *   buildHostHtml() connectEvents()) and the exact `{ type: MSG.STATE, state
 *   }` payload shape media/main.js's `window.addEventListener("message", ...)`
 *   listener expects from a real VS Code webview.postMessage() state push.
 * @returns {{ close: () => void, getStateMessage: () => { type: string, state: object } }}
 */
export function createStateFeed({ projectRoot, broadcast }) {
  if (typeof projectRoot !== 'string' || projectRoot === '') {
    throw new Error('[tycoonagents-standalone] createStateFeed: projectRoot is required');
  }
  if (typeof broadcast !== 'function') {
    throw new Error('[tycoonagents-standalone] createStateFeed: broadcast(eventName, data) function is required');
  }

  // In-memory accumulator of every HookRecord seen so far (backlog + live),
  // in order — computeStateFromRecords is a whole-file replay (same
  // contract as panel.ts's _readActivityRecords + computeStateFromRecords),
  // not an incremental reducer feed, so re-running it over the full
  // accumulated list on every batch is the correct (and, per the task brief,
  // preferred-for-correctness) approach rather than an incremental diff.
  /** @type {object[]} */
  let records = [];

  // Last computed `state` payload (the value that goes on the `state` key of
  // the { type, state } message), kept so a newly-connecting SSE client can
  // be caught up immediately via getStateMessage() instead of waiting for
  // the next activity.jsonl write — mirrors the VS Code panel's boot-time
  // MSG.READY handler, which posts runtime.getState() synchronously on
  // connect.
  let currentState = null;

  // Roster cache keyed on the agents dir mtime + each .md file's mtime/size, so
  // recompute() stats files but only re-reads them when something changed.
  let rosterSig = null;
  let rosterCache = [];
  function loadRosterCached(agentsDir) {
    let sig = 'missing';
    try {
      const parts = [String(fs.statSync(agentsDir).mtimeMs)];
      for (const f of fs.readdirSync(agentsDir).filter((n) => n.endsWith('.md')).sort()) {
        const st = fs.statSync(path.join(agentsDir, f));
        parts.push(`${f}:${st.mtimeMs}:${st.size}`);
      }
      sig = parts.join('|');
    } catch {
      /* missing/unreadable dir => empty roster */
    }
    if (sig !== rosterSig) {
      rosterCache = sig === 'missing' ? [] : loadAgentRoster(agentsDir);
      rosterSig = sig;
    }
    return rosterCache;
  }

  function recompute() {
    // Same roster seeding + model stamping the VS Code host does (extension.ts
    // WorkerRegistered/RosterSeeded, panel.ts _stampRosterModels) so rows carry
    // roster display names and the orchestrator's roster model.
    const agentsDir = path.join(projectRoot, '.claude', 'agents');
    const roster = loadRosterCached(agentsDir);
    const seed = roster.length > 0 ? rosterSeedEvents(roster, Date.now()) : [];
    const raw = computeStateFromRecords(records, undefined, seed);
    const state = stampRosterModels(raw, roster);
    currentState =
      state !== null && typeof state === 'object' && Array.isArray(state.agentMetrics)
        ? { ...state, modeStats: computeDelegationModeStats(state.agentMetrics) }
        : state;
    return currentState;
  }

  function postState() {
    recompute();
    broadcast('message', { type: MSG_STATE, state: currentState });
  }

  const watcher = createActivityWatcher(projectRoot, {
    // Whole-file replay on start, same as panel.ts's boot-time read — a
    // standalone server started against a project with existing activity
    // must show that history immediately, not just events from server-start
    // onward (see activityWatcher.mjs's replayExisting doc comment).
    replayExisting: true,
    onRecords(batch) {
      records = records.concat(batch);
      postState();
    },
    onError(err) {
      console.error('[tycoonagents-standalone] stateFeed:', (err && err.message) || err);
    },
  });

  // Seed currentState immediately (even with zero records, e.g. a brand new
  // project with no activity.jsonl yet) so getStateMessage() never returns
  // `state: null` to a client connecting before the first batch — an empty
  // MetricsWorldState (sessionActive: false, no agents) renders the correct
  // "no agents yet" board, same as VS Code's fresh-install boot state.
  recompute();

  return {
    /**
     * Current state message, in the exact { type, state } shape a
     * server -> browser push carries. For a late-connecting SSE client so
     * it sees real state immediately rather than a blank board (see
     * server.mjs's /events handler, which calls this via
     * registerInitialMessageProvider).
     */
    getStateMessage() {
      return { type: MSG_STATE, state: currentState };
    },
    /** Current computed state (null before the first compute). */
    getState() {
      return currentState;
    },
    close() {
      watcher.close();
    },
  };
}
