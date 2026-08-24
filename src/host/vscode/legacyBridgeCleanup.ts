/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * Cleanup for orphaned Power Tools staging left behind by upgraded
 * TycoonAgents installs.
 *
 * TycoonAgents used to bundle Trashbyrd's UEFN Power Tools at
 * `<extensionDir>/media/uefn-bridge` and stage its files into a user's UEFN
 * project (`<projectRoot>/Content/Python`) and into every Fortnite engine
 * `Content/Python` directory found by `_findFortnitePythonDirs()`. Power
 * Tools is now a standalone repo installed on demand (see
 * `powerToolsInstall.ts`); `media/uefn-bridge` no longer ships in this repo.
 * Users who upgrade are left with stale staged copies this module can find
 * and remove.
 *
 * There is no manifest of what got staged — the bundled source directory
 * that would have listed it is gone. So this cleanup is deliberately
 * self-limiting (see `scanForLegacyBridgeStaging`):
 *
 *   1. A directory is even considered "ours" only if it contains
 *      `bridge_version.py` — the one unambiguous marker `_stageBridgeTo`
 *      always writes last, after every sibling file copies cleanly (see
 *      panel.ts's `_stageBridgeTo`). No stamp, no touch.
 *   2. Within a marked directory, a file is only a deletion candidate if a
 *      file of the SAME BASENAME exists in the currently-resolved Power
 *      Tools install's directory (`resolvePowerToolsDir(...).dir` — the
 *      same directory `_stageBridgeTo` copies FROM). This makes deletion
 *      impossible to over-reach: we can never remove a file Power Tools
 *      itself doesn't ship, so a user's own unrelated file sitting next to
 *      our stamp is never touched.
 *
 * `bridge_version.py` itself, `bridge_sync_status.json` (if present), and
 * any `__pycache__` directory inside a marked directory are always removed
 * alongside the intersection-matched files — see `scanForLegacyBridgeStaging`.
 *
 * Scan (pure preview) and apply (the actual deletions) are kept as separate
 * exports so a caller can show the user exactly what will be removed before
 * anything happens — matching the confirm-then-act pattern
 * `cleanupForeignHookArtifacts` / `_handleApplyDoctorFix` already use for
 * foreign hook cleanup (see hookInstall.ts).
 */

import * as fs from "fs";
import * as path from "path";
import { describeFsError } from "./fsErrors";

const STAMP_NAME = "bridge_version.py";
const SYNC_STATUS_NAME = "bridge_sync_status.json";
const PYCACHE_NAME = "__pycache__";

/** One directory's worth of files this cleanup would remove, plus why. */
export interface LegacyBridgeDirPreview {
  /** Absolute path to the candidate directory (e.g. a `Content/Python`). */
  dir: string;
  /** Absolute paths of every file that would be deleted from `dir`. */
  files: string[];
  /** True if `dir` contains a `__pycache__` subdirectory that would also be removed. */
  hasPycache: boolean;
  /** Human-readable reason this directory was included (or why it was skipped, when `files` is empty and `skipped` is set). */
  reason: string;
  /** Set when this candidate was looked at but skipped entirely (not marked as ours, or unreadable). `files` is always empty in this case. */
  skipped?: string;
}

export interface LegacyBridgeCleanupPreview {
  /** Per-candidate-directory results, in the order the candidates were given. */
  directories: LegacyBridgeDirPreview[];
  /** Total file count across every non-skipped directory (does not count `__pycache__` contents individually). */
  totalFiles: number;
}

/**
 * List every regular file directly inside `dir` (no recursion), or `[]` if
 * `dir` can't be read. Never throws.
 */
function listFilesSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => {
      try {
        return fs.statSync(path.join(dir, name)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * Scan `candidateDirs` (the project's `Content/Python` plus every engine
 * `Content/Python` from `_findFortnitePythonDirs()`) and build a PREVIEW of
 * what a legacy-bridge cleanup would delete. Performs no writes.
 *
 * `powerToolsPythonDir` is the currently-resolved Power Tools source
 * directory (`resolvePowerToolsDir(...).dir`) — the same directory
 * `_stageBridgeTo` copies FROM. Pass `null` when Power Tools isn't
 * resolvable; every candidate is then reported as skipped (with a reason
 * naming why) rather than guessing a file list, since without a live
 * Power Tools copy there is nothing safe to intersect against.
 *
 * A directory is skipped (zero files, `skipped` reason set) when: it
 * doesn't exist or can't be read, it has no `bridge_version.py` stamp (not
 * proven to be ours), or `powerToolsPythonDir` is `null`/unreadable.
 */
export function scanForLegacyBridgeStaging(
  candidateDirs: readonly string[],
  powerToolsPythonDir: string | null
): LegacyBridgeCleanupPreview {
  const directories: LegacyBridgeDirPreview[] = [];
  let totalFiles = 0;

  // De-dupe candidates (project dir and an engine dir could coincide on a
  // dev machine) while preserving first-seen order.
  const seen = new Set<string>();
  const dedupedCandidates: string[] = [];
  for (const dir of candidateDirs) {
    if (!dir) continue;
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedCandidates.push(dir);
  }

  if (powerToolsPythonDir === null) {
    for (const dir of dedupedCandidates) {
      directories.push({
        dir,
        files: [],
        hasPycache: false,
        reason: "Power Tools is not installed — nothing to compare against, so cleanup was skipped for this directory.",
        skipped: "power-tools-not-resolved",
      });
    }
    return { directories, totalFiles: 0 };
  }

  const shippedNames = new Set(listFilesSafe(powerToolsPythonDir));

  for (const dir of dedupedCandidates) {
    let exists: boolean;
    try {
      exists = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) {
      directories.push({
        dir,
        files: [],
        hasPycache: false,
        reason: "Directory does not exist.",
        skipped: "missing",
      });
      continue;
    }

    const stampPath = path.join(dir, STAMP_NAME);
    let hasStamp: boolean;
    try {
      hasStamp = fs.existsSync(stampPath) && fs.statSync(stampPath).isFile();
    } catch {
      hasStamp = false;
    }
    if (!hasStamp) {
      directories.push({
        dir,
        files: [],
        hasPycache: false,
        reason: `No ${STAMP_NAME} found — not confirmed as a TycoonAgents-staged directory, so it was left alone.`,
        skipped: "no-stamp",
      });
      continue;
    }

    const localNames = listFilesSafe(dir);
    const matched = localNames.filter((name) => name !== STAMP_NAME && shippedNames.has(name));
    const files = matched.map((name) => path.join(dir, name));

    // Always include the stamp itself and the sync-status file if present.
    files.push(stampPath);
    const syncStatusPath = path.join(dir, SYNC_STATUS_NAME);
    try {
      if (fs.existsSync(syncStatusPath) && fs.statSync(syncStatusPath).isFile()) {
        files.push(syncStatusPath);
      }
    } catch {
      /* ignore — not present or unreadable, nothing to remove */
    }

    let hasPycache = false;
    try {
      const pycacheDir = path.join(dir, PYCACHE_NAME);
      hasPycache = fs.existsSync(pycacheDir) && fs.statSync(pycacheDir).isDirectory();
    } catch {
      hasPycache = false;
    }

    directories.push({
      dir,
      files,
      hasPycache,
      reason:
        `Confirmed TycoonAgents staging (${STAMP_NAME} present); ${matched.length} file(s) match the current ` +
        `Power Tools install's file set and would be removed along with the version stamp` +
        (hasPycache ? " and __pycache__." : "."),
    });
    totalFiles += files.length;
  }

  return { directories, totalFiles };
}

export interface LegacyBridgeCleanupResult {
  /** Absolute file paths successfully deleted. */
  deletedFiles: string[];
  /** Absolute paths of `__pycache__` directories successfully removed. */
  deletedPycacheDirs: string[];
  /** Absolute paths of candidate directories that ended up empty and were removed. */
  removedEmptyDirs: string[];
  /** `{ path, error }` for anything that failed to delete — apply continues past individual failures. */
  failures: Array<{ path: string; error: string }>;
}

/**
 * Perform the deletions described by a PREVIEW previously returned from
 * `scanForLegacyBridgeStaging`. Deletes each listed file, then the
 * directory's `__pycache__` if `hasPycache` was true, then removes the
 * containing directory itself ONLY if it is completely empty afterward —
 * a non-empty `Content/Python` (e.g. a user's own scripts alongside ours)
 * is never removed.
 *
 * Every deletion is independently try/caught: one failure is recorded in
 * `failures` and does not stop the rest from being attempted. Skipped
 * directories (from the preview) are not touched at all.
 */
export function applyLegacyBridgeCleanup(preview: LegacyBridgeCleanupPreview): LegacyBridgeCleanupResult {
  const deletedFiles: string[] = [];
  const deletedPycacheDirs: string[] = [];
  const removedEmptyDirs: string[] = [];
  const failures: Array<{ path: string; error: string }> = [];

  for (const dirPreview of preview.directories) {
    if (dirPreview.skipped) continue;

    for (const filePath of dirPreview.files) {
      try {
        fs.unlinkSync(filePath);
        deletedFiles.push(filePath);
      } catch (e) {
        failures.push({ path: filePath, error: describeFsError(e, filePath) });
      }
    }

    if (dirPreview.hasPycache) {
      const pycacheDir = path.join(dirPreview.dir, PYCACHE_NAME);
      try {
        fs.rmSync(pycacheDir, { recursive: true, force: true });
        deletedPycacheDirs.push(pycacheDir);
      } catch (e) {
        failures.push({ path: pycacheDir, error: describeFsError(e, pycacheDir) });
      }
    }

    try {
      const remaining = fs.readdirSync(dirPreview.dir);
      if (remaining.length === 0) {
        fs.rmdirSync(dirPreview.dir);
        removedEmptyDirs.push(dirPreview.dir);
      }
    } catch {
      /* directory not empty, already gone, or unreadable — never force-remove a non-empty dir */
    }
  }

  return { deletedFiles, deletedPycacheDirs, removedEmptyDirs, failures };
}
