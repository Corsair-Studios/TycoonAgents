/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * Resolve and (on demand) install Trashbyrd's UEFN Power Tools.
 *
 * Power Tools used to ship bundled inside this extension at
 * `<extensionDir>/media/uefn-bridge`. It now lives as its own standalone
 * public repo, `Corsair-Studios/trashbyrds-uefn-power-tools`, released as a
 * versioned zip on GitHub Releases. This module implements the
 * `docs/PATH-DISCOVERY.md` ladder for locating a working copy, and a
 * best-effort installer that fetches the latest (or a pinned) release and
 * unpacks it into this extension's global storage.
 *
 * Discovery ladder (see `resolvePowerToolsDir`):
 *   1. `POWERTOOLS_DIR` env override - always wins, no validation beyond
 *      "the directory exists" (an explicit override is trusted).
 *   2. An already-installed copy under `<globalStorageDir>/powertools`,
 *      confirmed by content (contains `uefn-server.mjs`) rather than by
 *      name alone - an interrupted/corrupt install must not be returned as
 *      a working one.
 *   3. The legacy bundled copy at `<extensionDir>/media/uefn-bridge`,
 *      confirmed by content (contains `uefn_bridge.py`, the Python bridge
 *      module unique to the bundled layout) - kept as the final fallback
 *      while older installs may still only have this copy.
 *
 * Nothing here touches `panel.ts`, `mcpHeal.ts`, or `engineDetect.ts` -
 * wiring this resolver into those call sites is a later step.
 */

import * as fs from "fs";
import * as path from "path";
import { unzipSync } from "fflate";

const POWERTOOLS_REPO = "Corsair-Studios/trashbyrds-uefn-power-tools";
const POWERTOOLS_RELEASES_API = `https://api.github.com/repos/${POWERTOOLS_REPO}/releases`;
const INSTALLED_MARKER = "uefn-server.mjs";
const BUNDLED_MARKER = "uefn_bridge.py";
const ZIP_ASSET_RE = /^trashbyrds-power-tools-.*\.zip$/;

export type PowerToolsSource = "env" | "installed" | "bundled";

export interface PowerToolsLocation {
  dir: string;
  source: PowerToolsSource;
  tried: string[];
}

export type InstallPowerToolsResult =
  | { ok: true; dir: string; version: string }
  | { ok: false; error: string; tried: string[] };

/** Where an installed copy lives under a given global storage directory. */
function installedDir(globalStorageDir: string): string {
  return path.join(globalStorageDir, "powertools");
}

/**
 * Content-validated existence check. A directory only "has" Power Tools if
 * it actually contains the given marker file - matching by directory name
 * or mere presence is exactly the failure mode `docs/PATH-DISCOVERY.md`
 * rules out (rule 3: content-based over name-based matching).
 */
function hasMarker(dir: string, markerFile: string): boolean {
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, markerFile));
  } catch {
    return false;
  }
}

/**
 * Discover a working Power Tools directory, in priority order:
 * env override > installed copy > legacy bundled copy. Never throws;
 * returns `null` (with every path it tried) when nothing validates.
 */
export function resolvePowerToolsDir(extensionDir: string, globalStorageDir: string): PowerToolsLocation | null {
  const tried: string[] = [];

  try {
    const envDir = process.env.POWERTOOLS_DIR;
    if (typeof envDir === "string" && envDir.trim() !== "") {
      const resolved = path.resolve(envDir);
      tried.push(resolved);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        return { dir: resolved, source: "env", tried };
      }
    }
  } catch {
    // fall through to the next rung - a bad override must not crash discovery
  }

  const installed = installedDir(globalStorageDir);
  tried.push(installed);
  if (hasMarker(installed, INSTALLED_MARKER)) {
    return { dir: installed, source: "installed", tried };
  }

  const bundled = path.join(extensionDir, "media", "uefn-bridge");
  tried.push(bundled);
  if (hasMarker(bundled, BUNDLED_MARKER)) {
    return { dir: bundled, source: "bundled", tried };
  }

  return null;
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
}

const GITHUB_HEADERS = {
  "User-Agent": "TycoonAgents-PowerToolsInstaller",
  Accept: "application/vnd.github+json",
};

/** Fetch the release to install: a pinned tag, or the latest release. */
async function fetchRelease(version: string | undefined): Promise<GitHubRelease> {
  const url = version ? `${POWERTOOLS_RELEASES_API}/tags/${encodeURIComponent(version)}` : `${POWERTOOLS_RELEASES_API}/latest`;
  const response = await fetch(url, { headers: GITHUB_HEADERS });
  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      // ignore
    }
    throw new Error(`GitHub release lookup failed (${response.status}) for ${url}: ${body.slice(0, 300)}`);
  }
  const json = (await response.json()) as GitHubRelease;
  if (typeof json.tag_name !== "string" || !Array.isArray(json.assets)) {
    throw new Error(`GitHub release response for ${url} was missing tag_name/assets.`);
  }
  return json;
}

/** Recursively remove a directory if it exists. Swallows errors - caller decides if that matters. */
function rmDirSafe(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup only
  }
}

/**
 * Unpack a Power Tools release zip into `destDir`, guarding against
 * zip-slip (an entry whose normalized path would land outside `destDir`).
 */
function extractZip(zipBytes: Uint8Array, destDir: string): void {
  const unzipped = unzipSync(zipBytes);
  const destResolved = path.resolve(destDir);

  for (const [entryName, bytes] of Object.entries(unzipped)) {
    if (entryName.endsWith("/")) continue; // directory entry, nothing to write

    const targetPath = path.resolve(destDir, entryName);
    const relative = path.relative(destResolved, targetPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Refusing to extract entry outside install directory (zip-slip): "${entryName}"`);
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, bytes);
  }
}

/**
 * Download and install Power Tools from its GitHub Release into
 * `<globalStorageDir>/powertools`. Installs atomically via a temp sibling
 * directory + rename, so a failed or partial download can never leave a
 * half-installed directory that `resolvePowerToolsDir` would mistake for a
 * working one. Never throws - all failures come back as `{ ok: false }`.
 */
export async function installPowerTools(
  globalStorageDir: string,
  opts?: { version?: string; onProgress?: (msg: string) => void },
): Promise<InstallPowerToolsResult> {
  const tried: string[] = [];
  const report = (msg: string): void => {
    try {
      opts?.onProgress?.(msg);
    } catch {
      // a broken progress callback must not abort the install
    }
  };

  const finalDir = installedDir(globalStorageDir);
  const tempDir = path.join(globalStorageDir, `powertools.download-${process.pid}-${Date.now()}`);

  try {
    report("Resolving Power Tools release...");
    let release: GitHubRelease;
    try {
      release = await fetchRelease(opts?.version);
    } catch (e) {
      const url = opts?.version
        ? `${POWERTOOLS_RELEASES_API}/tags/${opts.version}`
        : `${POWERTOOLS_RELEASES_API}/latest`;
      tried.push(url);
      return {
        ok: false,
        error: `Could not resolve a Power Tools release: ${String(e)}. Set POWERTOOLS_DIR to an existing install to skip this step.`,
        tried,
      };
    }

    const asset = release.assets.find((a) => ZIP_ASSET_RE.test(a.name));
    if (!asset) {
      const names = release.assets.map((a) => a.name).join(", ") || "(none)";
      return {
        ok: false,
        error: `Release ${release.tag_name} has no asset matching ${ZIP_ASSET_RE} (found: ${names}). Set POWERTOOLS_DIR to an existing install instead.`,
        tried,
      };
    }
    tried.push(asset.browser_download_url);

    report(`Downloading ${asset.name} (${release.tag_name})...`);
    let zipBytes: Uint8Array;
    try {
      const response = await fetch(asset.browser_download_url, { headers: GITHUB_HEADERS });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const buf = await response.arrayBuffer();
      zipBytes = new Uint8Array(buf);
    } catch (e) {
      return {
        ok: false,
        error: `Failed to download ${asset.browser_download_url}: ${String(e)}. Set POWERTOOLS_DIR to an existing install to skip downloading.`,
        tried,
      };
    }

    report("Unpacking Power Tools...");
    rmDirSafe(tempDir);
    try {
      fs.mkdirSync(tempDir, { recursive: true });
      extractZip(zipBytes, tempDir);
    } catch (e) {
      rmDirSafe(tempDir);
      return {
        ok: false,
        error: `Failed to unpack ${asset.name}: ${String(e)}. Set POWERTOOLS_DIR to an existing install to skip this step.`,
        tried,
      };
    }

    if (!hasMarker(tempDir, INSTALLED_MARKER)) {
      rmDirSafe(tempDir);
      return {
        ok: false,
        error: `Unpacked ${asset.name} but it did not contain ${INSTALLED_MARKER} at its root - archive layout may have changed. Set POWERTOOLS_DIR to an existing install instead.`,
        tried,
      };
    }

    report("Finalizing install...");
    try {
      const staleFinalDir = fs.existsSync(finalDir) ? `${finalDir}.old-${Date.now()}` : null;
      if (staleFinalDir) fs.renameSync(finalDir, staleFinalDir);
      try {
        fs.renameSync(tempDir, finalDir);
      } catch (renameErr) {
        // Roll back the old install if the swap itself failed, so we never
        // strand the user with neither the old nor the new copy in place.
        if (staleFinalDir) {
          try {
            fs.renameSync(staleFinalDir, finalDir);
          } catch {
            // best-effort rollback only
          }
        }
        throw renameErr;
      }
      if (staleFinalDir) rmDirSafe(staleFinalDir);
    } catch (e) {
      rmDirSafe(tempDir);
      return {
        ok: false,
        error: `Failed to move unpacked Power Tools into place at "${finalDir}": ${String(e)}.`,
        tried,
      };
    }

    report(`Power Tools ${release.tag_name} installed.`);
    return { ok: true, dir: finalDir, version: release.tag_name };
  } finally {
    rmDirSafe(tempDir);
  }
}
