import type { ThemeManifest } from '../shared/types';

// ============================================================================
// THEME INTEGRITY HEALTH CHECK
// Pure data validation — no API calls. Flags roster<->frames mismatches, the
// bug class that caused the "Roadblock" placeholder (manifest listed 4 rivals
// but frames.json had only 3 rival_* keys).
// ============================================================================

export type ThemeIntegrityIssueKind = 'missing_frames' | 'orphan_frames' | 'empty_frames';

export interface ThemeIntegrityIssue {
  severity: 'error' | 'warning';
  kind: ThemeIntegrityIssueKind;
  entity: string;
  key: string;
  message: string;
}

// Roster arrays that are keyed 1:1 into frames.json via a fixed prefix. The
// achievement_/expression_ frame families are fixed sets (not roster-driven)
// and are intentionally excluded from orphan detection.
const ROSTER_FRAME_PREFIXES = ['character_', 'rival_', 'object_', 'decor_'] as const;

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

function describeEntity(prefix: (typeof ROSTER_FRAME_PREFIXES)[number]): string {
  switch (prefix) {
    case 'character_':
      return 'Agent';
    case 'rival_':
      return 'Rival';
    case 'object_':
      return 'Buildable object';
    case 'decor_':
      return 'Decor object';
  }
}

export function validateThemeIntegrity(
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
): ThemeIntegrityIssue[] {
  const issues: ThemeIntegrityIssue[] = [];
  const framesRecord = frames ?? {};

  // Tracks every frames key that is accounted for by a roster entry, so the
  // orphan pass below can skip them.
  const claimedKeys = new Set<string>();

  const checkRoster = (
    prefix: (typeof ROSTER_FRAME_PREFIXES)[number],
    entries: Array<{ id: string; label: string; asset?: string }>,
  ) => {
    const entity = describeEntity(prefix);
    for (const { id, label, asset } of entries) {
      // Prefer the authoritative key from the asset field; fall back to a
      // prefix-safe reconstruction so an already-prefixed id ("rival_scarlett")
      // is never double-prefixed.
      const key = frameKeyFromAsset(asset) ?? (id.startsWith(prefix) ? id : `${prefix}${id}`);
      claimedKeys.add(key);
      const value = framesRecord[key];
      if (value === undefined) {
        issues.push({
          severity: 'error',
          kind: 'missing_frames',
          entity,
          key,
          message: `${entity} "${label}" (${key}) has no frames — will render as a placeholder`,
        });
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

  // Orphan pass: any character_/rival_/object_/decor_ frames key with no
  // matching roster entry is dead art (harmless but worth flagging).
  for (const key of Object.keys(framesRecord)) {
    const prefix = ROSTER_FRAME_PREFIXES.find((p) => key.startsWith(p));
    if (!prefix) continue;
    if (claimedKeys.has(key)) continue;
    issues.push({
      severity: 'warning',
      kind: 'orphan_frames',
      entity: describeEntity(prefix),
      key,
      message: `Frames key "${key}" has no matching roster entry — unused art`,
    });
  }

  return issues;
}
