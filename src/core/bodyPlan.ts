/**
 * Roster character body-plan heuristic (p58-t2). Used to pick which walk
 * pose-guide reference image (biped vs quadruped — see
 * src/extension/poseGuides.ts) and which prompt paragraph (see
 * src/core/walkPoseGuidePrompts.ts) apply to a character slot whose
 * `bodyPlan` has not been explicitly set by the user.
 *
 * A user-set slot.bodyPlan always wins over this inference — see callers
 * (effective body plan = slot.bodyPlan ?? inferBodyPlan(slot.description)).
 */
export type BodyPlan = 'biped' | 'quadruped';

/** Word-boundary matched (singular or plural), case-insensitive. */
const QUADRUPED_WORDS = [
  'dog', 'dogs',
  'cat', 'cats',
  'wolf', 'wolves',
  'fox', 'foxes',
  'horse', 'horses',
  'cow', 'cows',
  'pig', 'pigs',
  'sheep',
  'deer',
  'bear', 'bears',
  'lion', 'lions',
  'tiger', 'tigers',
  'quadruped', 'quadrupeds',
  'four-legged',
];

const QUADRUPED_PATTERN = new RegExp(
  `\\b(?:${QUADRUPED_WORDS.map((word) => word.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\b`,
  'i',
);

/**
 * Infers a character's body plan from its free-text description. Defaults to
 * 'biped' whenever no quadruped keyword matches (including an empty/undefined
 * description).
 */
export function inferBodyPlan(description: string | undefined): BodyPlan {
  if (!description) return 'biped';
  return QUADRUPED_PATTERN.test(description) ? 'quadruped' : 'biped';
}
