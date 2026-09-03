/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * "Path Health" diagnostics — the visible half of this repo's Path &
 * Environment Discovery principle (see CLAUDE.md and docs/PATH-DISCOVERY.md).
 * This module is deliberately vscode-free (no `import * as vscode`), matching
 * uefnDetect.ts/engineDetect.ts: panel.ts owns every vscode API call (workspace
 * folders, `vscode.extensions.getExtension`) and hands plain data in here, so
 * everything below stays pure and unit-testable without a vscode shim, and
 * there is no import cycle with panel.ts (panel.ts imports FROM this module,
 * never the reverse).
 *
 * Three responsibilities live here:
 *  1. The `.claude/tycoon/uefn-paths.json` override file (read/write, one
 *     vocabulary shared with the env-var overrides the Python bridge tools
 *     already read — see docs/PATH-DISCOVERY.md's "Known override variables").
 *  2. `probePathHealth()` — resolves each required path through the codified
 *     ladder (override file -> env var -> multi-signal auto-discovery ->
 *     explicit NOT FOUND) and reports exactly how it got there.
 *  3. `detectVerseExtensionState()` — distinguishes "installed & enabled"
 *     from "installed but disabled" from "not installed at all", since the
 *     guidance differs per state (see its own doc comment).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `fs.existsSync`, never throwing (some path shapes can throw on Windows). */
function existsSafe(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Override keys — the single vocabulary shared with env vars AND the Python
// bridge tools (see docs/PATH-DISCOVERY.md's "Known override variables" table
// and media/skills/uefn/verse_lsp_check.py's own VERSE_LSP_PATH /
// UEFN_VERSE_PROJECT_DIR handling). Do not invent a competing name here.
// ---------------------------------------------------------------------------

export const PATH_OVERRIDE_KEYS = [
  "VERSE_LSP_PATH",
  "UEFN_VERSE_PROJECT_DIR",
  "UEFN_BRIDGE_DIR",
  "UEFN_INSTALL_DIR",
  "FORTNITE_INSTALL_DIR",
] as const;

export type PathOverrideKey = (typeof PATH_OVERRIDE_KEYS)[number];

export function isPathOverrideKey(key: string): key is PathOverrideKey {
  return (PATH_OVERRIDE_KEYS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// Task 1 — the override config file: .claude/tycoon/uefn-paths.json
// ---------------------------------------------------------------------------

/** Bump when the shape of this file changes in a way readers need to know about. */
const UEFN_PATHS_FILE_VERSION = 1;

function uefnPathsFilePath(claudeDirPath: string): string {
  return path.join(claudeDirPath, "tycoon", "uefn-paths.json");
}

/** Where the override file lives for a given `.claude` dir — exposed so the UI/copy-paste text can show it. */
export function uefnPathsOverrideFilePath(claudeDirPath: string): string {
  return uefnPathsFilePath(claudeDirPath);
}

/**
 * Read whatever overrides are currently set. Tolerant of a missing file, a
 * missing `.claude/tycoon` directory, invalid JSON, and unknown keys (schema
 * drift) — every one of those falls back to "no overrides", never throws. An
 * empty/absent file behaves EXACTLY like no overrides set (Task 1 contract).
 * Only string values under one of `PATH_OVERRIDE_KEYS` are honored; anything
 * else (wrong type, unknown key, the `version` field itself) is ignored.
 */
export function readUefnPathOverrides(claudeDirPath: string): Partial<Record<PathOverrideKey, string>> {
  try {
    const raw = fs.readFileSync(uefnPathsFilePath(claudeDirPath), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    const out: Partial<Record<PathOverrideKey, string>> = {};
    for (const key of PATH_OVERRIDE_KEYS) {
      const v = (parsed as Record<string, unknown>)[key];
      if (typeof v === "string" && v.trim() !== "") {
        out[key] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export interface WriteOverrideResult {
  ok: boolean;
  error?: string;
}

/**
 * Set (or, when `value` is `null`, clear) a single override key in
 * `.claude/tycoon/uefn-paths.json`. Read-modify-write onto whatever is
 * already on disk (like delegationDoctrine.ts's `writeExecutionConfig`) so
 * setting one key never clobbers another, and unknown keys already present
 * survive untouched (schema-drift tolerant both directions).
 *
 * Writes atomically via a `.tmp` file + rename, then RE-READS the file back
 * and confirms the key actually landed with the expected value before
 * reporting success — this repo has a documented history of writes that
 * reported success without landing (see `uefn_bridge.py`'s
 * `_write_json_checked`, the precedent this mirrors on the TS side). Never
 * throws; failures come back as `{ ok: false, error }`.
 */
export function writeUefnPathOverride(
  claudeDirPath: string,
  key: PathOverrideKey,
  value: string | null,
): WriteOverrideResult {
  const filePath = uefnPathsFilePath(claudeDirPath);

  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed !== null && typeof parsed === "object") {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing file, missing dir, invalid JSON -> merge onto {}.
  }

  const next: Record<string, unknown> = { ...existing, version: UEFN_PATHS_FILE_VERSION };
  if (value === null) {
    delete next[key];
  } else {
    next[key] = value;
  }

  const tmpPath = `${filePath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    return { ok: false, error: errorMessage(err) };
  }

  // Verify-after-write: re-read and confirm the key landed with the value we
  // just wrote (or is genuinely absent, for a clear). A write that "succeeds"
  // but doesn't land is worse than one that raises, because it hides the
  // failure from whoever is debugging it later.
  try {
    const reread = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (reread === null || typeof reread !== "object") {
      return { ok: false, error: "write reported success but re-read content is not a JSON object" };
    }
    const rereadValue = (reread as Record<string, unknown>)[key];
    if (value === null) {
      if (rereadValue !== undefined) {
        return { ok: false, error: "clear reported success but the key is still present after re-read" };
      }
    } else if (rereadValue !== value) {
      return { ok: false, error: "write reported success but the re-read value does not match what was written" };
    }
  } catch (err) {
    return { ok: false, error: `write reported success but re-read failed: ${errorMessage(err)}` };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Task 2 — probe every required path
// ---------------------------------------------------------------------------

export type PathResolutionSource = "override" | "env" | "auto-detected" | "not-found";

export interface PathCandidate {
  /** Where this candidate came from (e.g. "LOCALAPPDATA", "Epic Games Launcher manifest", "~/.cursor/extensions"). */
  origin: string;
  /** The absolute location that was actually checked. */
  location: string;
}

export interface PathHealthEntry {
  key: PathOverrideKey;
  label: string;
  description: string;
  resolvedPath: string | null;
  source: PathResolutionSource;
  /** Whether `resolvedPath` actually exists on disk right now (always `false` when `resolvedPath` is `null`). */
  exists: boolean;
  /** Every candidate location tried, in ladder order — including ones that didn't pan out. */
  candidates: PathCandidate[];
}

export interface PathHealthReport {
  entries: PathHealthEntry[];
  overridesFilePath: string;
  overridesFileExists: boolean;
}

interface KeyMeta {
  label: string;
  description: string;
}

const KEY_META: Record<PathOverrideKey, KeyMeta> = {
  VERSE_LSP_PATH: {
    label: "Verse language server binary",
    description:
      "The verse-lsp executable bundled inside Epic's 'Verse' VS Code extension — verse_lsp_check.py drives it directly for real compiler diagnostics.",
  },
  UEFN_VERSE_PROJECT_DIR: {
    label: "UEFN VerseProject data root",
    description:
      "UEFN's saved Verse project state: one subfolder per project, each holding a vproject/ subfolder (the .vproject file) and *.digest.verse files. UEFN generates this the first time a project is opened in the editor.",
  },
  UEFN_BRIDGE_DIR: {
    label: "UEFN bridge IPC directory",
    description: "Where the Python bridge (running inside UEFN) and the MCP server exchange request/response files.",
  },
  UEFN_INSTALL_DIR: {
    label: "UEFN editor install folder",
    description: "The UnrealEditorFortnite folder itself — the UEFN editor's own install root.",
  },
  FORTNITE_INSTALL_DIR: {
    label: "Fortnite game install root",
    description:
      "The parent of FortniteGame/Content — used to locate/stage the Python bridge into UEFN's engine copy.",
  },
};

/** Every editor/IDE layout known to host a copy of Epic's "Verse" extension, relative to the home dir. Mirrors verse_lsp_check.py's EXTENSION_DIR_NAMES — same vocabulary, both sides must search the same places. */
const KNOWN_IDE_EXTENSION_DIR_NAMES = [
  ".vscode",
  ".vscode-insiders",
  ".cursor",
  ".antigravity",
  ".vscode-server",
  ".windsurf",
] as const;

/** Numeric dot-segment sort key, e.g. "0.0.55550516" -> [0, 0, 55550516]. Mirrors verse_lsp_check.py's `_version_sort_key` so both sides pick the same "newest" candidate. A non-numeric segment degrades to 0 rather than throwing. */
function versionSortKey(version: string): number[] {
  return version.split(".").map((seg) => {
    const digits = seg.replace(/\D/g, "");
    return digits ? parseInt(digits, 10) : 0;
  });
}

function compareVersionsDesc(a: string, b: string): number {
  const ak = versionSortKey(a);
  const bk = versionSortKey(b);
  const len = Math.max(ak.length, bk.length);
  for (let i = 0; i < len; i++) {
    const diff = (bk[i] ?? 0) - (ak[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

interface DiscoverResult {
  resolvedPath: string | null;
  candidates: PathCandidate[];
}

/**
 * Rung 3 (multi-signal auto-discovery) for VERSE_LSP_PATH: scans every known
 * IDE's `extensions/` folder for an `epicgames.verse-*` install, then globs
 * (without an actual glob dep — a plain readdir of `bin/`) for the
 * platform-appropriate `verse-lsp`/`verse-lsp.exe` inside it. Picks the
 * highest-versioned binary found across every IDE. Mirrors
 * verse_lsp_check.py's `locate_lsp_exe` STEP 1.
 */
function discoverVerseLsp(): DiscoverResult {
  const candidates: PathCandidate[] = [];
  const home = os.homedir();
  const expectedBasename = process.platform === "win32" ? "verse-lsp.exe" : "verse-lsp";
  const found: Array<{ version: string; exePath: string }> = [];

  for (const ideDir of KNOWN_IDE_EXTENSION_DIR_NAMES) {
    const extRoot = path.join(home, ideDir, "extensions");
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(extRoot);
    } catch {
      candidates.push({ origin: `${ideDir} extensions root`, location: extRoot });
      continue;
    }
    const verseFolders = entries.filter((e) => e.toLowerCase().startsWith("epicgames.verse-"));
    if (verseFolders.length === 0) {
      candidates.push({ origin: `${ideDir} extensions root (no epicgames.verse-* folder)`, location: extRoot });
      continue;
    }
    for (const folder of verseFolders) {
      const version = folder.slice("epicgames.verse-".length);
      const extDir = path.join(extRoot, folder);
      let binSub: string[] = [];
      try {
        binSub = fs.readdirSync(path.join(extDir, "bin"));
      } catch {
        candidates.push({ origin: `${ideDir}/${folder}/bin`, location: path.join(extDir, "bin") });
        continue;
      }
      for (const platformDir of binSub) {
        const exePath = path.join(extDir, "bin", platformDir, expectedBasename);
        candidates.push({ origin: `${ideDir}/${folder}/bin/${platformDir}`, location: exePath });
        if (existsSafe(exePath)) {
          found.push({ version, exePath });
        }
      }
    }
  }

  if (found.length === 0) {
    return { resolvedPath: null, candidates };
  }
  found.sort((a, b) => compareVersionsDesc(a.version, b.version));
  return { resolvedPath: found[0].exePath, candidates };
}

/** True if `root` directly contains at least one `<project>/vproject/*.vproject` file — the content-based confirmation, not a name match. Mirrors verse_lsp_check.py's `locate_verseproject_root` acceptance check. */
function hasAnyVprojectFile(root: string): boolean {
  try {
    for (const projectDir of fs.readdirSync(root)) {
      const vprojectSub = path.join(root, projectDir, "vproject");
      try {
        if (fs.readdirSync(vprojectSub).some((f) => f.toLowerCase().endsWith(".vproject"))) {
          return true;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Rung 3 for UEFN_VERSE_PROJECT_DIR: gathers candidate `...\UnrealEditorFortnite\Saved\VerseProject`
 * bases from LOCALAPPDATA, USERPROFILE, home, and an APPDATA-derived Local
 * dir (PROGRAMDATA as a last-resort base too), de-duplicated, and accepts
 * the first one that both exists and contains a real `.vproject` file.
 * Mirrors verse_lsp_check.py's `_candidate_verseproject_roots` /
 * `locate_verseproject_root` (registry probe omitted here — the Python tool
 * already covers that rung; this is a diagnostics VIEW, not a second
 * authoritative resolver).
 */
function discoverVerseProjectDir(): DiscoverResult {
  const candidates: PathCandidate[] = [];
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  const appData = process.env.APPDATA;
  const programData = process.env.PROGRAMDATA || process.env.ProgramData;

  const bases: Array<{ origin: string; base: string | undefined }> = [
    { origin: "LOCALAPPDATA", base: localAppData },
    { origin: "USERPROFILE\\AppData\\Local", base: userProfile ? path.join(userProfile, "AppData", "Local") : undefined },
    { origin: "~\\AppData\\Local", base: home ? path.join(home, "AppData", "Local") : undefined },
    {
      origin: "APPDATA-derived Local",
      base: appData ? path.join(path.dirname(appData), "Local") : undefined,
    },
    { origin: "PROGRAMDATA", base: programData },
  ];

  const seen = new Set<string>();
  let resolvedPath: string | null = null;
  for (const { origin, base } of bases) {
    if (!base) continue;
    const candidatePath = path.join(base, "UnrealEditorFortnite", "Saved", "VerseProject");
    const canon = candidatePath.toLowerCase();
    if (seen.has(canon)) continue;
    seen.add(canon);
    candidates.push({ origin, location: candidatePath });
    if (resolvedPath === null && existsSafe(candidatePath) && hasAnyVprojectFile(candidatePath)) {
      resolvedPath = candidatePath;
    }
  }
  return { resolvedPath, candidates };
}

/**
 * Rung 3 for UEFN_BRIDGE_DIR: mirrors `uefn_bridge.py`'s `_get_bridge_dir()`
 * default — the OS temp dir's `uefn_bridge` subfolder. The Python side
 * `os.makedirs`'s this on demand, so it may legitimately not exist yet on a
 * machine that has never run a bridge session; that is reported via `exists`,
 * not treated as "not found" (this IS the location the bridge computes for
 * itself absent an override).
 */
function discoverBridgeDir(): DiscoverResult {
  const defaultDir = path.join(os.tmpdir(), "uefn_bridge");
  return {
    resolvedPath: defaultDir,
    candidates: [{ origin: "OS temp dir (uefn_bridge.py's _get_bridge_dir default)", location: defaultDir }],
  };
}

/** Rung 3 for UEFN_INSTALL_DIR — same ladder as `uefnDetect.ts`'s `uefnInstalled` check (LOCALAPPDATA, else a homedir()-derived AppData\Local), surfaced here as candidates rather than a single boolean. */
function discoverUefnInstallDir(): DiscoverResult {
  const candidates: PathCandidate[] = [];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push({ origin: "LOCALAPPDATA", location: path.join(localAppData, "UnrealEditorFortnite") });
  } else {
    try {
      const home = os.homedir();
      if (home) {
        candidates.push({
          origin: "os.homedir()-derived AppData\\Local",
          location: path.join(home, "AppData", "Local", "UnrealEditorFortnite"),
        });
      }
    } catch {
      // os.homedir() can throw in rare sandboxed/CI environments — leave no candidate from this rung.
    }
  }
  for (const c of candidates) {
    if (existsSafe(c.location)) {
      return { resolvedPath: c.location, candidates };
    }
  }
  return { resolvedPath: null, candidates };
}

function resolveProgramDataRootLocal(): string {
  const envVal = process.env.PROGRAMDATA || process.env.ProgramData;
  if (envVal) return envVal;
  const driveSource = process.env.SystemDrive || process.env.SystemRoot || process.env.windir || os.homedir() || "";
  const driveMatch = /^[A-Za-z]:/.exec(driveSource);
  if (driveMatch) return path.join(`${driveMatch[0]}\\`, "ProgramData");
  return "C:\\ProgramData";
}

function enumerateFixedDrivesLocal(): string[] {
  const drives: string[] = [];
  for (const code of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    try {
      if (existsSafe(`${code}:\\`)) drives.push(`${code}:`);
    } catch {
      /* inaccessible or errored drive letter, skip */
    }
  }
  return drives;
}

/**
 * Rung 3 for FORTNITE_INSTALL_DIR — mirrors panel.ts's `_findFortnitePythonDirs`
 * ladder (Epic Games Launcher manifests, then a bounded probe of every fixed
 * drive letter present) but targets the install ROOT's existence rather than
 * its `FortniteGame/`-relative Python folder subdirectory. Deliberately a separate,
 * small copy rather than importing from panel.ts: this module must stay a
 * leaf (panel.ts imports FROM host modules, never the reverse — see
 * uefnDetect.ts/engineDetect.ts, neither of which imports panel.ts either).
 */
function discoverFortniteInstallDir(): DiscoverResult {
  const candidates: PathCandidate[] = [];
  const found: string[] = [];

  try {
    const programData = resolveProgramDataRootLocal();
    const manifestsDir = path.join(programData, "Epic", "EpicGamesLauncher", "Data", "Manifests");
    candidates.push({ origin: "Epic Games Launcher manifests dir", location: manifestsDir });
    if (existsSafe(manifestsDir)) {
      for (const f of fs.readdirSync(manifestsDir)) {
        if (!f.toLowerCase().endsWith(".item")) continue;
        try {
          const m = JSON.parse(fs.readFileSync(path.join(manifestsDir, f), "utf8"));
          const label = String(m.DisplayName || m.AppName || m.MandatoryAppFolderName || "");
          const loc = String(m.InstallLocation || "");
          if (loc && /fortnite/i.test(`${label} ${loc}`)) {
            candidates.push({ origin: `Epic manifest: ${f}`, location: loc });
            if (existsSafe(loc)) found.push(loc);
          }
        } catch {
          /* skip malformed manifest */
        }
      }
    }
  } catch {
    /* manifests unavailable — fall through to the drive probe */
  }

  if (found.length === 0) {
    for (const drive of enumerateFixedDrivesLocal()) {
      const guess = path.join(`${drive}\\`, "Program Files", "Epic Games", "Fortnite");
      candidates.push({ origin: `drive probe (${drive})`, location: guess });
      if (existsSafe(guess)) found.push(guess);
    }
  }

  return { resolvedPath: found[0] ?? null, candidates };
}

const DISCOVERERS: Record<PathOverrideKey, () => DiscoverResult> = {
  VERSE_LSP_PATH: discoverVerseLsp,
  UEFN_VERSE_PROJECT_DIR: discoverVerseProjectDir,
  UEFN_BRIDGE_DIR: discoverBridgeDir,
  UEFN_INSTALL_DIR: discoverUefnInstallDir,
  FORTNITE_INSTALL_DIR: discoverFortniteInstallDir,
};

function resolveEntry(key: PathOverrideKey, overrides: Partial<Record<PathOverrideKey, string>>): PathHealthEntry {
  const meta = KEY_META[key];

  // Rung 1: explicit override file — always wins, skips every other rung.
  const overrideValue = overrides[key];
  if (overrideValue) {
    return {
      key,
      label: meta.label,
      description: meta.description,
      resolvedPath: overrideValue,
      source: "override",
      exists: existsSafe(overrideValue),
      candidates: [{ origin: "uefn-paths.json override", location: overrideValue }],
    };
  }

  // Rung 2: env var.
  const envValue = process.env[key];
  if (envValue) {
    return {
      key,
      label: meta.label,
      description: meta.description,
      resolvedPath: envValue,
      source: "env",
      exists: existsSafe(envValue),
      candidates: [{ origin: `env.${key}`, location: envValue }],
    };
  }

  // Rung 3: multi-signal auto-discovery.
  const { resolvedPath, candidates } = DISCOVERERS[key]();
  if (resolvedPath) {
    return {
      key,
      label: meta.label,
      description: meta.description,
      resolvedPath,
      source: "auto-detected",
      exists: existsSafe(resolvedPath),
      candidates,
    };
  }

  // Rung 4: NOT FOUND, explicit — never a silent/clean-looking result.
  return {
    key,
    label: meta.label,
    description: meta.description,
    resolvedPath: null,
    source: "not-found",
    exists: false,
    candidates,
  };
}

/**
 * Probe every required UEFN/Verse path and report exactly how each one
 * resolved (or didn't). `claudeDirPath` is the project's `.claude` directory
 * (i.e. `path.join(root, ".claude")`) — where `tycoon/uefn-paths.json` lives.
 * Never throws; every discoverer above is individually guarded.
 */
export function probePathHealth(claudeDirPath: string): PathHealthReport {
  const overrides = readUefnPathOverrides(claudeDirPath);
  const entries = PATH_OVERRIDE_KEYS.map((key) => resolveEntry(key, overrides));
  const overridesFilePath = uefnPathsFilePath(claudeDirPath);
  return {
    entries,
    overridesFilePath,
    overridesFileExists: existsSafe(overridesFilePath),
  };
}

// ---------------------------------------------------------------------------
// Task 3 — Verse extension state: three states, not two
// ---------------------------------------------------------------------------

export interface VerseExtensionVersionFound {
  version: string;
  /** Which known IDE dir this copy was found under (".vscode", ".cursor", ...). */
  ideDir: string;
  extensionDir: string;
}

export type VerseExtensionState = "enabled" | "disabled" | "not-installed";

export interface VerseExtensionReport {
  state: VerseExtensionState;
  /** The version `vscode.extensions.getExtension()` reported, when `state === "enabled"`. */
  enabledVersion: string | null;
  /** Every `epicgames.verse-*` folder found on disk across every known IDE, newest first. */
  versionsFound: VerseExtensionVersionFound[];
  /** True when more than one distinct version was found across IDEs — a stale copy can report confidently wrong diagnostics. */
  multipleVersions: boolean;
  /** Human-readable guidance, phrased differently per state (see the three-state doc below). */
  message: string;
}

/**
 * Distinguishes three states the user (and this feature) care about
 * differently:
 *
 * 1. **Installed and enabled** — `vscode.extensions.getExtension("epicgames.verse")`
 *    returned a live extension object in THIS editor window.
 * 2. **Installed but DISABLED** — that call returned `undefined`, but a copy
 *    of the extension still exists on disk under a known IDE's `extensions/`
 *    folder. This is a real, distinct case: VS Code's disable mechanism
 *    (workspace or global) only excludes an extension from activation — it
 *    is a documented part of the extension host's architecture that
 *    disabling never deletes or moves the extension's files, which is why
 *    "Disable" and "Uninstall" are separate actions in every VS Code-family
 *    UI. `verse_lsp_check.py` reads the analyzer BINARY straight off disk
 *    (see its `locate_lsp_exe`), so it keeps working even while the
 *    extension is disabled — but the user's own in-editor Verse
 *    squiggles/IntelliSense do NOT, since those come from the (disabled)
 *    extension's language client. That distinction is spelled out in the
 *    returned `message` so the UI doesn't have to re-derive it.
 * 3. **Not installed** — no folder found anywhere in `KNOWN_IDE_EXTENSION_DIR_NAMES`.
 *
 * `input.liveExtensionFound`/`liveExtensionVersion` come from panel.ts's
 * `vscode.extensions.getExtension("epicgames.verse")` call (kept out of this
 * module to stay vscode-free); everything else is derived from a disk scan
 * this function does itself, mirroring `discoverVerseLsp`'s search.
 */
export function detectVerseExtensionState(input: {
  liveExtensionFound: boolean;
  liveExtensionVersion?: string | null;
}): VerseExtensionReport {
  const home = os.homedir();
  const versionsFound: VerseExtensionVersionFound[] = [];

  for (const ideDir of KNOWN_IDE_EXTENSION_DIR_NAMES) {
    const extRoot = path.join(home, ideDir, "extensions");
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(extRoot);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().startsWith("epicgames.verse-")) continue;
      const extensionDir = path.join(extRoot, entry);
      if (!existsSafe(extensionDir)) continue;
      versionsFound.push({ version: entry.slice("epicgames.verse-".length), ideDir, extensionDir });
    }
  }
  versionsFound.sort((a, b) => compareVersionsDesc(a.version, b.version));
  const distinctVersions = new Set(versionsFound.map((v) => v.version));
  const multipleVersions = distinctVersions.size > 1;

  if (input.liveExtensionFound) {
    const enabledVersion = input.liveExtensionVersion ?? versionsFound[0]?.version ?? null;
    return {
      state: "enabled",
      enabledVersion,
      versionsFound,
      multipleVersions,
      message: multipleVersions
        ? `Verse extension is installed and enabled (v${enabledVersion ?? "unknown"}), but ${distinctVersions.size} different versions were found across IDE installs on this machine — a stale one could report confidently wrong diagnostics.`
        : `Verse extension is installed and enabled (v${enabledVersion ?? "unknown"}).`,
    };
  }

  if (versionsFound.length > 0) {
    return {
      state: "disabled",
      enabledVersion: null,
      versionsFound,
      multipleVersions,
      message:
        "Epic's Verse extension is installed on disk but DISABLED in this editor window — disabling an extension never deletes its files, the editor just excludes it from activation. " +
        "verse_lsp_check.py reads the analyzer BINARY directly from that extension folder, so it keeps working even while the extension stays disabled here. " +
        "Your OWN editor's live Verse squiggles/IntelliSense will NOT work until you re-enable it.",
    };
  }

  return {
    state: "not-installed",
    enabledVersion: null,
    versionsFound: [],
    multipleVersions: false,
    message:
      "Epic's Verse extension (publisher 'epicgames', extension 'Verse') was not found — neither active in this editor nor on disk under any known IDE's extensions folder. " +
      "Install it from the marketplace, or set VERSE_LSP_PATH directly to a verse-lsp binary from elsewhere on this machine.",
  };
}

// ---------------------------------------------------------------------------
// Task 5 — the copy-to-clipboard "paste into Claude" diagnostic text
// ---------------------------------------------------------------------------

/**
 * Build a deterministic, paste-to-Claude text block listing every probed
 * path's status, every location tried, and the exact override key to set —
 * plus the Verse extension state. Mirrors `media/main.js`'s
 * `buildDelegationTip()` in spirit (plain lines, no markdown table), but this
 * one is built HOST-side (unlike buildDelegationTip, which the webview
 * builds) because it needs real filesystem probing.
 *
 * INTENTIONALLY NOT sanitized: `diagnosticReport.ts`'s `sanitize()` strips
 * absolute paths because THAT report is for public sharing. This text exists
 * so the user can paste it into their OWN Claude Code session and have
 * Claude fix THEIR paths — it is useless with the real paths redacted. See
 * the call site in panel.ts for the same note.
 */
export function buildPathDiagnosticText(
  report: PathHealthReport,
  verse: VerseExtensionReport,
  opts?: { platform?: string; mcpUefnEntryConfigured?: boolean },
): string {
  const lines: string[] = [];
  lines.push("TycoonAgents Path Diagnostic");
  lines.push(`Platform: ${opts?.platform ?? process.platform}`);
  lines.push("");
  lines.push("Paste this whole block into a Claude Code session in this project so Claude can help fix any paths below.");
  lines.push("");

  for (const entry of report.entries) {
    const status =
      entry.source === "not-found" ? "NOT FOUND" : entry.exists ? "OK" : "SET, BUT DOES NOT EXIST ON DISK";
    lines.push(`### ${entry.label} (${entry.key}) — ${status}`);
    lines.push(entry.description);
    lines.push(`Resolved via: ${entry.source}`);
    lines.push(`Resolved path: ${entry.resolvedPath ?? "(none)"}`);
    lines.push("Locations tried, in order:");
    if (entry.candidates.length === 0) {
      lines.push("  (none — no candidate location could be derived at all)");
    } else {
      for (const c of entry.candidates) {
        lines.push(`  [${c.origin}] ${c.location}`);
      }
    }
    lines.push(
      `To fix: set "${entry.key}" in ${report.overridesFilePath} to the correct absolute path (or set the ${entry.key} environment variable).`,
    );
    lines.push("");
  }

  lines.push(`### Verse extension state: ${verse.state}`);
  lines.push(verse.message);
  if (verse.versionsFound.length > 0) {
    lines.push("Versions found on disk:");
    for (const v of verse.versionsFound) {
      lines.push(`  [${v.ideDir}] v${v.version} — ${v.extensionDir}`);
    }
  }
  lines.push("");
  lines.push(`Override file: ${report.overridesFilePath} (${report.overridesFileExists ? "exists" : "does not exist yet"})`);

  // MCP transport note: every path above is a FILESYSTEM discovery signal —
  // none of them can tell you whether the MCP CLIENT (Claude Code, etc.)
  // actually managed to start the server process itself. If a UEFN entry
  // is registered in .mcp.json but its status chip stays gray while
  // everything else here is healthy, the most common remaining cause is
  // the MCP client's own `node` launch failing silently, not a path
  // discovery problem this report can catch.
  if (opts?.mcpUefnEntryConfigured) {
    lines.push("");
    lines.push(
      "Note: the UEFN MCP server is launched via `node` on PATH by your MCP client (not by this extension) — " +
        "if the UEFN status chip stays gray even though every path above is healthy, verify `node --version` " +
        "(v18+) works in a plain terminal.",
    );
  }

  return lines.join("\n");
}
