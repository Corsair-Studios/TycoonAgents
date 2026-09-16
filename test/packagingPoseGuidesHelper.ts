// test/packagingPoseGuidesHelper.ts
//
// Side-effect-free helper shared by test/packagingPoseGuides.check.ts. Pure
// logic only — no test(...) registration here (see the 0.0.615 incident:
// VSIX-content checks must never run as a side effect of importing a unit
// test file). Mirrors test/packagingProviderStrings.ts's pattern.

export interface PoseGuideCheckResult {
  /** true when this check ran a real comparison; false when it was skipped
   * because no pose-guide PNGs exist in the repo yet. */
  ran: boolean;
  /** Repo-relative pose-guide PNG paths present on disk. */
  reposPresent: string[];
  /** Of `reposPresent`, the ones missing from the VSIX entry set. */
  missingFromVsix: string[];
}

/**
 * Compares the pose-guide PNGs present in the repo (`repoPoseGuideFiles`,
 * e.g. from fs.readdirSync of media/pose-guides) against the VSIX entry set
 * (`vsixEntries`, e.g. from `unzip -Z1`), each PNG expected at
 * `extension/media/pose-guides/<filename>`.
 *
 * When `repoPoseGuideFiles` is empty (the user has not saved the real PNGs
 * yet, per the p58 walk-pose-guide feature), the check is a no-op with
 * `ran: false` so CI stays green until the files exist.
 */
export function checkPoseGuidesPackaged(
  repoPoseGuideFiles: string[],
  vsixEntries: string[],
): PoseGuideCheckResult {
  const pngs = repoPoseGuideFiles.filter((f) => f.toLowerCase().endsWith('.png'));
  if (pngs.length === 0) {
    return { ran: false, reposPresent: [], missingFromVsix: [] };
  }
  const entrySet = new Set(vsixEntries);
  const missingFromVsix = pngs
    .map((f) => `extension/media/pose-guides/${f}`)
    .filter((expected) => !entrySet.has(expected));
  return { ran: true, reposPresent: pngs, missingFromVsix };
}
