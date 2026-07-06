import { unzipSync, zipSync } from 'fflate';
import { BADGE_TRIGGER_TYPES } from '../shared/types';
import type { ThemeManifest } from '../shared/types';

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 768 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 512;

export interface ThemeArchiveContents {
  themeId: string;
  displayName: string;
  files: Map<string, Uint8Array>;
}

/** Build a portable theme archive whose files live at the root of the zip. */
export function createThemeArchive(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const zippable: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  let expandedBytes = 0;
  let entryCount = 0;
  for (const [path, data] of files) {
    const normalized = normalizeArchivePath(path);
    if (!normalized || normalized.endsWith('/')) continue;
    entryCount += 1;
    expandedBytes += data.byteLength;
    if (entryCount > MAX_ARCHIVE_ENTRIES) {
      throw new Error(`Theme contains more than ${MAX_ARCHIVE_ENTRIES} files.`);
    }
    if (expandedBytes > MAX_EXPANDED_BYTES) {
      throw new Error('Theme is larger than the 768 MB expanded-size limit.');
    }
    zippable[normalized] = data;
  }
  const archive = zipSync(zippable, { level: 6 });
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error('Compressed theme archive is larger than 256 MB.');
  }
  return archive;
}

/** Validate and unpack a root-level theme or a theme inside one enclosing folder. */
export function parseThemeArchive(data: Uint8Array): ThemeArchiveContents {
  if (data.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error('Theme archive is larger than 256 MB.');
  }

  let entryCount = 0;
  let expandedBytes = 0;
  const unzipped = unzipSync(data, {
    filter: (entry) => {
      entryCount += 1;
      expandedBytes += entry.originalSize;
      if (entryCount > MAX_ARCHIVE_ENTRIES) {
        throw new Error(`Theme archive contains more than ${MAX_ARCHIVE_ENTRIES} entries.`);
      }
      if (expandedBytes > MAX_EXPANDED_BYTES) {
        throw new Error('Theme archive expands beyond the 768 MB safety limit.');
      }
      normalizeArchivePath(entry.name);
      return true;
    },
  });

  const entries = new Map<string, Uint8Array>();
  for (const [path, bytes] of Object.entries(unzipped)) {
    const normalized = normalizeArchivePath(path);
    if (!normalized || normalized.endsWith('/')) continue;
    if (entries.has(normalized)) throw new Error(`Theme archive contains duplicate path "${normalized}".`);
    entries.set(normalized, bytes);
  }

  const manifestPaths = [...entries.keys()].filter((path) => path === 'manifest.json' || path.endsWith('/manifest.json'));
  if (manifestPaths.length !== 1) {
    throw new Error('Theme archive must contain exactly one manifest.json.');
  }
  const manifestPath = manifestPaths[0];
  const prefix = manifestPath.slice(0, -'manifest.json'.length);
  const files = new Map<string, Uint8Array>();
  const caseInsensitivePaths = new Set<string>();
  for (const [path, bytes] of entries) {
    if (!path.startsWith(prefix)) continue;
    const relativePath = path.slice(prefix.length);
    if (!relativePath) continue;
    const comparablePath = relativePath.toLowerCase();
    if (files.has(relativePath) || caseInsensitivePaths.has(comparablePath)) {
      throw new Error(`Theme archive contains duplicate path "${relativePath}".`);
    }
    files.set(relativePath, bytes);
    caseInsensitivePaths.add(comparablePath);
  }
  for (const relativePath of files.keys()) {
    const segments = relativePath.split('/');
    for (let length = 1; length < segments.length; length++) {
      if (caseInsensitivePaths.has(segments.slice(0, length).join('/').toLowerCase())) {
        throw new Error(`Theme archive path "${relativePath}" is nested beneath a file.`);
      }
    }
  }

  const manifest = parseJson<Partial<ThemeManifest>>(files.get('manifest.json'), 'manifest.json');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('manifest.json must contain a JSON object.');
  }
  if (typeof manifest.theme_id !== 'string' || !/^[a-z0-9_]+$/.test(manifest.theme_id)) {
    throw new Error('manifest.json contains an invalid theme_id. Use lowercase letters, numbers, and underscores.');
  }
  if (typeof manifest.display_name !== 'string' || !manifest.display_name.trim()) {
    throw new Error('manifest.json must contain a display_name.');
  }
  if (!isThemeManifest(manifest)) {
    throw new Error('manifest.json does not match the TycoonAgents theme manifest format.');
  }

  const frames = parseJson<unknown>(files.get('frames.json'), 'frames.json');
  if (!isFramesDocument(frames)) {
    throw new Error('frames.json must map frame names to arrays of strings.');
  }

  return {
    themeId: manifest.theme_id,
    displayName: manifest.display_name.trim(),
    files,
  };
}

function normalizeArchivePath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Theme archive contains unsafe path "${path}".`);
  }
  const segments = normalized.split('/');
  const comparableSegments = normalized.endsWith('/') ? segments.slice(0, -1) : segments;
  if (comparableSegments.some((segment) =>
    !segment
      || segment === '.'
      || segment === '..'
      || /[\0<>:"|?*]/.test(segment)
      || /[. ]$/.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
  )) {
    throw new Error(`Theme archive contains unsafe path "${path}".`);
  }
  return normalized;
}

function parseJson<T>(bytes: Uint8Array | undefined, filename: string): T {
  if (!bytes) throw new Error(`Theme archive is missing ${filename}.`);
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
  } catch {
    throw new Error(`${filename} is not valid JSON.`);
  }
}

function isFramesDocument(value: unknown): value is Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(
    (frames) => Array.isArray(frames) && frames.every((frame) => typeof frame === 'string'),
  );
}

function isThemeManifest(value: unknown): value is ThemeManifest {
  if (!isRecord(value)
      || !isNonEmptyString(value.manifest_version)
      || !isNonEmptyString(value.theme_id)
      || !isNonEmptyString(value.display_name)
      || !isNonEmptyString(value.author)
      || !isRecord(value.viewport)
      || !isPositiveNumber(value.viewport.native_width)
      || !isPositiveNumber(value.viewport.native_height)
      || !isNonEmptyString(value.viewport.background_asset)
      || !Array.isArray(value.viewport.walkable_nav_polygon)
      || !value.viewport.walkable_nav_polygon.every(isCoordinate)
      || !Array.isArray(value.roster_agents)
      || !Array.isArray(value.roster_rivals)
      || !Array.isArray(value.buildable_objects)
      || !Array.isArray(value.badges)) {
    return false;
  }
  return value.roster_agents.every((agent) =>
    isRecord(agent)
      && Number.isInteger(agent.slot_id)
      && isNonEmptyString(agent.name)
      && isNonEmptyString(agent.atlas_asset)
      && ['pose_crossed', 'pose_down', 'pose_up'].includes(String(agent.preferred_idle_pose)),
  ) && value.roster_rivals.every((rival) =>
    isRecord(rival)
      && isNonEmptyString(rival.rival_id)
      && isNonEmptyString(rival.name)
      && isNonEmptyString(rival.atlas_asset),
  ) && value.buildable_objects.every((object) =>
    isRecord(object)
      && Number.isInteger(object.build_order)
      && isNonEmptyString(object.object_id)
      && isNonEmptyString(object.display_name)
      && isNonEmptyString(object.sprite_asset)
      && isCoordinate(object.anchor_coord)
      && isPositiveNumber(object.exclusion_radius, true)
      && isPositiveNumber(object.work_units_required),
  ) && value.badges.every((badge) =>
    isRecord(badge)
      && isNonEmptyString(badge.badge_id)
      && isNonEmptyString(badge.display_name)
      && typeof badge.description === 'string'
      && (BADGE_TRIGGER_TYPES as readonly string[]).includes(String(badge.trigger_type))
      && isPositiveNumber(badge.threshold, true)
      && isNonEmptyString(badge.icon_asset),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function isPositiveNumber(value: unknown, allowZero = false): value is number {
  return typeof value === 'number' && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
}

function isCoordinate(value: unknown): value is [number, number] {
  return Array.isArray(value)
    && value.length === 2
    && value.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate));
}
