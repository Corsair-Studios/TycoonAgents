import type { ThemeManifest } from '../shared/types';
import { THEME_EXPRESSION_COUNT } from './themePlan';

// ============================================================================
// THEME INTEGRITY HEALTH CHECK
// Pure data validation — no API calls. Flags roster<->frames mismatches, the
// bug class that caused the "Roadblock" placeholder (manifest listed 4 rivals
// but frames.json had only 3 rival_* keys). Also covers the fixed-key FX/UI
// families (projectile/poof/crate/expression/achievement) that are not
// roster-driven but can still silently lose their frames when a board
// partially fails to generate.
// ============================================================================

export type ThemeIntegrityIssueKind = 'missing_frames' | 'orphan_frames' | 'empty_frames';

export interface ThemeIntegrityIssue {
  severity: 'error' | 'warning';
  kind: ThemeIntegrityIssueKind;
  entity: string;
  key: string;
  message: string;
}

// Roster arrays that are keyed 1:1 into frames.json via a fixed prefix.
const ROSTER_FRAME_PREFIXES = ['character_', 'rival_', 'object_', 'decor_'] as const;

// Every prefixed frame-key family whose expected membership can be derived
// reliably, used both to label issues and to drive orphan detection below.
// expression_/achievement_ are fixed sets (not roster arrays) but their
// expected keys ARE derivable — expression_ from the hardcoded
// THEME_EXPRESSION_COUNT pipeline constant, achievement_ from manifest.badges
// — so, unlike before, they are no longer excluded from orphan detection.
const FRAME_ENTITY_BY_PREFIX: Record<string, string> = {
  character_: 'Agent',
  rival_: 'Rival',
  object_: 'Buildable object',
  decor_: 'Decor object',
  expression_: 'Expression',
  achievement_: 'Badge icon',
};

// The authoritative frames key for a roster entry lives in its asset field
// ("frames.json#<key>") — the exact string the webview resolves to render.
// Returns the substring after '#', or null when there is no usable key.
function frameKeyFromAsset(asset?: string): string | null {
  if (typeof asset !== 'string') return null;
  const hash = asset.indexOf('#');
  if (hash < 0) return null;
  const key = asset.slice(hash + 1);
  return key.length > 0 ? key : null;
}

// Fixed single-key FX/UI asset families. Each is gated by the matching
// manifest.viewport asset field, which theme migration backfills onto every
// manifest (see themeMigration.ts) — so by the time a manifest reaches this
// check the gate is essentially always set. A manifest that genuinely
// predates the field (pre-migration / hand-built test fixture) is treated as
// not-yet-expecting the family rather than guessed at, so it never
// false-positives. Current gameplay depends on all three (see media/main.js
// themeHasProjectile / themeHasPoofAsset gating), so a genuinely-expected but
// missing/empty entry is an error, not a warning.
interface FixedAssetFamily {
  entity: string;
  fallbackKey: string;
  impact: string;
  gate: (manifest: ThemeManifest) => string | undefined;
}

const FIXED_ASSET_FAMILIES: FixedAssetFamily[] = [
  {
    entity: 'Projectile FX',
    fallbackKey: 'projectile',
    impact: 'ranged attacks will render with no visible projectile',
    gate: (manifest) => manifest.viewport?.projectile_asset,
  },
  {
    entity: 'Poof FX',
    fallbackKey: 'poof',
    impact: 'build/reveal poof animation will render nothing',
    gate: (manifest) => manifest.viewport?.poof_asset,
  },
  {
    entity: 'Crate icon',
    fallbackKey: 'crate',
    impact: 'crate reveal will render nothing',
    gate: (manifest) => manifest.viewport?.crate_asset,
  },
];

export interface ThemeIntegrityValidationOptions {
  /**
   * The set of frame keys whose owning board is EXPECTED to be complete —
   * i.e. its theme-image-review item has status 'accepted' (see
   * themeImageReviewState.ts's ThemeImageReviewItem.frame_keys, which is
   * exactly the set of frame keys a board owns). When provided, a
   * "no frames" (kind 'missing_frames') issue is only emitted for a key in
   * this set; keys outside it belong to a board that is still
   * pending/rejected/never-reviewed and a missing frame there is expected,
   * not a bug, so the issue is suppressed. An accepted board that is still
   * missing its frames DOES get flagged (the 0.0.384 accepted-but-frameless
   * regression this health check exists to catch).
   *
   * When omitted (the default), every "no frames" issue is emitted
   * unconditionally — the original, generation-unaware behavior. This keeps
   * every existing caller/test byte-for-byte compatible.
   */
  acceptedFrameKeys?: ReadonlySet<string>;
}

export function validateThemeIntegrity(
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  options?: ThemeIntegrityValidationOptions,
): ThemeIntegrityIssue[] {
  const issues: ThemeIntegrityIssue[] = [];
  const framesRecord = frames ?? {};
  const acceptedFrameKeys = options?.acceptedFrameKeys;
  // No acceptedFrameKeys set => generation-unaware legacy behavior (always
  // flag). With a set, a "no frames" issue only fires for a key whose owning
  // board is accepted — everything else is presumed still in progress.
  const isExpectedComplete = (key: string): boolean => !acceptedFrameKeys || acceptedFrameKeys.has(key);

  // Tracks every frames key that is accounted for by a roster entry (or one of
  // the fixed families below), so the orphan pass can skip them.
  const claimedKeys = new Set<string>();

  const checkRoster = (
    prefix: (typeof ROSTER_FRAME_PREFIXES)[number],
    entries: Array<{ id: string; label: string; asset?: string }>,
  ) => {
    const entity = FRAME_ENTITY_BY_PREFIX[prefix];
    for (const { id, label, asset } of entries) {
      // Prefer the authoritative key from the asset field; fall back to a
      // prefix-safe reconstruction so an already-prefixed id ("rival_scarlett")
      // is never double-prefixed.
      const key = frameKeyFromAsset(asset) ?? (id.startsWith(prefix) ? id : `${prefix}${id}`);
      claimedKeys.add(key);
      const value = framesRecord[key];
      if (value === undefined) {
        if (isExpectedComplete(key)) {
          issues.push({
            severity: 'error',
            kind: 'missing_frames',
            entity,
            key,
            message: `${entity} "${label}" (${key}) has no frames — will render as a placeholder`,
          });
        }
      } else if (Array.isArray(value) && value.length === 0) {
        issues.push({
          severity: 'warning',
          kind: 'empty_frames',
          entity,
          key,
          message: `${entity} "${label}" (${key}) has an empty frames array`,
        });
      }
    }
  };

  checkRoster(
    'character_',
    (manifest.roster_agents ?? []).map((a) => ({ id: String(a.slot_id), label: a.name, asset: a.atlas_asset })),
  );
  checkRoster(
    'rival_',
    (manifest.roster_rivals ?? []).map((r) => ({ id: r.rival_id, label: r.name, asset: r.atlas_asset })),
  );
  checkRoster(
    'object_',
    (manifest.buildable_objects ?? []).map((o) => ({ id: o.object_id, label: o.display_name, asset: o.sprite_asset })),
  );
  checkRoster(
    'decor_',
    (manifest.decor_objects ?? []).map((d) => ({ id: d.decor_id, label: d.display_name, asset: d.sprite_asset })),
  );

  // Fixed single-key FX families: projectile / poof / crate. Gated on the
  // manifest.viewport.*_asset field so a legacy-shaped manifest that predates
  // the field is skipped instead of guessed at.
  for (const family of FIXED_ASSET_FAMILIES) {
    const gateAsset = family.gate(manifest);
    if (typeof gateAsset !== 'string' || gateAsset.length === 0) continue;
    const key = frameKeyFromAsset(gateAsset) ?? family.fallbackKey;
    claimedKeys.add(key);
    const value = framesRecord[key];
    if (value === undefined) {
      if (isExpectedComplete(key)) {
        issues.push({
          severity: 'error',
          kind: 'missing_frames',
          entity: family.entity,
          key,
          message: `${family.entity} (${key}) has no frames — ${family.impact}`,
        });
      }
    } else if (Array.isArray(value) && value.length === 0) {
      issues.push({
        severity: 'error',
        kind: 'empty_frames',
        entity: family.entity,
        key,
        message: `${family.entity} (${key}) has an empty frames array — ${family.impact}`,
      });
    }
  }

  // Expressions: a fixed-size cosmetic set (THEME_EXPRESSION_COUNT slots keyed
  // expression_0..expression_<N-1>, see themePlan.ts) with no manifest-side
  // roster to check against — the count is a hardcoded pipeline constant, so
  // it applies uniformly to every current-format theme. Cosmetic-only
  // (emotes), so missing/empty entries are warnings, never errors.
  for (let i = 0; i < THEME_EXPRESSION_COUNT; i++) {
    const key = `expression_${i}`;
    claimedKeys.add(key);
    const value = framesRecord[key];
    if (value === undefined) {
      if (isExpectedComplete(key)) {
        issues.push({
          severity: 'warning',
          kind: 'missing_frames',
          entity: 'Expression',
          key,
          message: `Expression frame "${key}" has no frames — that emote will not play`,
        });
      }
    } else if (Array.isArray(value) && value.length === 0) {
      issues.push({
        severity: 'warning',
        kind: 'empty_frames',
        entity: 'Expression',
        key,
        message: `Expression frame "${key}" has an empty frames array`,
      });
    }
  }

  // Badge/achievement icons: keyed via each badge's own icon_asset field, the
  // same asset-key convention as the roster checks above. manifest.badges is
  // the authoritative expected set here (badges are planner/user content, not
  // a fixed count like expressions). Cosmetic-only (a badge just won't show
  // its icon), so missing/empty entries are warnings, never errors.
  (manifest.badges ?? []).forEach((badge, index) => {
    const key = frameKeyFromAsset(badge.icon_asset) ?? `achievement_${index}`;
    claimedKeys.add(key);
    const value = framesRecord[key];
    if (value === undefined) {
      if (isExpectedComplete(key)) {
        issues.push({
          severity: 'warning',
          kind: 'missing_frames',
          entity: 'Badge icon',
          key,
          message: `Badge icon "${badge.display_name}" (${key}) has no frames`,
        });
      }
    } else if (Array.isArray(value) && value.length === 0) {
      issues.push({
        severity: 'warning',
        kind: 'empty_frames',
        entity: 'Badge icon',
        key,
        message: `Badge icon "${badge.display_name}" (${key}) has an empty frames array`,
      });
    }
  });

  // Orphan pass: any character_/rival_/object_/decor_/expression_/achievement_
  // frames key with no matching entry from the checks above is dead art
  // (harmless but worth flagging).
  for (const key of Object.keys(framesRecord)) {
    const prefix = Object.keys(FRAME_ENTITY_BY_PREFIX).find((p) => key.startsWith(p));
    if (!prefix) continue;
    if (claimedKeys.has(key)) continue;
    issues.push({
      severity: 'warning',
      kind: 'orphan_frames',
      entity: FRAME_ENTITY_BY_PREFIX[prefix],
      key,
      message: `Frames key "${key}" has no matching entry — unused art`,
    });
  }

  return issues;
}
