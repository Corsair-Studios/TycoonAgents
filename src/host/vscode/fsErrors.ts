/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * Classify a filesystem copy/mkdir failure and, when it looks like a
 * Windows long-path problem, append remedy text naming the actual policy to
 * flip and the path length involved — instead of letting it surface as a
 * bare, unexplained OS error.
 *
 * THE BUG THIS FIXES: on Windows, a destination path deeper than ~260
 * characters commonly does NOT raise `ENAMETOOLONG` — it raises `ENOENT`
 * ("no such file or directory"), because the Win32 API layer truncates/
 * rejects the path before the filesystem ever sees it. That masks a fixable
 * "your path is too long" precondition as a confusing "the destination
 * doesn't exist", which it very much does further up the tree. Every
 * staging/copy catch site in this codebase (`_stageBridgeTo`,
 * `_stageSkillTree`, `_installProjectPlanSkill`) routes through this one
 * classifier so the remedy text — and the detection heuristic — can't drift
 * between call sites.
 *
 * Detection: an explicit `ENAMETOOLONG`, OR an `ENOENT` whose destination
 * absolute path exceeds 250 characters (a conservative margin under
 * Windows' ~260-character MAX_PATH, since the OS-reported failure can be a
 * few characters shorter than the full path once a filename/extension is
 * appended by the caller). A short-path `ENOENT` (destination directory
 * simply doesn't exist yet, unrelated to length) is left as a plain error —
 * only a destination whose OWN length crosses the threshold is flagged, so
 * this never mislabels an ordinary "missing parent directory" failure.
 */
export function describeFsError(err: unknown, destPath: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null | undefined)?.code;

  const isExplicitLongPath = code === "ENAMETOOLONG";
  const isMaskedLongPath = code === "ENOENT" && destPath.length > 250;
  if (!isExplicitLongPath && !isMaskedLongPath) return raw;

  const maskedNote = isMaskedLongPath && !isExplicitLongPath
    ? " Windows commonly reports a too-long destination path as ENOENT (\"not found\") rather than ENAMETOOLONG, which is why this looks like a missing-file error."
    : "";

  return (
    `${raw} -- LONG PATH: destination is ${destPath.length} characters long ` +
    `("${destPath}"), at or beyond Windows' ~260-character path limit.${maskedNote} ` +
    "Fix: enable Windows long-path support (set LongPathsEnabled=1 under " +
    "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\FileSystem, or the " +
    "'Enable Win32 long paths' Group Policy setting, then restart), or move the " +
    "project to a shorter path."
  );
}
