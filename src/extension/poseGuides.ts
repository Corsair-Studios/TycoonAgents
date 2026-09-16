import * as fs from "fs";
import * as path from "path";

export type BodyPlan = "biped" | "quadruped";

/**
 * Relative (from the extension root) paths to the walk pose-guide PNGs.
 * See media/pose-guides/README.md for what each guide shows.
 */
export const POSE_GUIDE_FILES: Record<BodyPlan, string> = {
  biped: path.join("media", "pose-guides", "humanoid-walk-reference.png"),
  quadruped: path.join("media", "pose-guides", "quadruped-walk-reference.png"),
};

const cache = new Map<BodyPlan, string>();

/**
 * Loads the walk pose-guide PNG for the given body plan as a data URL,
 * cached per process. Resolves relative to the given extension root
 * (e.g. context.extensionUri.fsPath, or the standalone equivalent) — no
 * absolute paths and no __dirname tricks that break when bundled.
 *
 * Returns null (and logs a single console.info line) when the file is
 * missing on disk, since the PNGs are provided by the user separately and
 * may not be present.
 */
export function loadWalkPoseGuide(extensionRoot: string, bodyPlan: BodyPlan): string | null {
  const cached = cache.get(bodyPlan);
  if (cached !== undefined) {
    return cached;
  }

  const relativePath = POSE_GUIDE_FILES[bodyPlan];
  const absolutePath = path.join(extensionRoot, relativePath);

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    console.info(`[poseGuides] walk pose-guide not found for "${bodyPlan}" at ${relativePath}`);
    return null;
  }

  const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
  cache.set(bodyPlan, dataUrl);
  return dataUrl;
}
