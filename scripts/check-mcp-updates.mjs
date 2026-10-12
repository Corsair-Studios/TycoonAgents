#!/usr/bin/env node
// Lists each pinned MCP package in media/mcp/catalog.json against the latest
// version on the registry. Read-only: changes nothing. Run: npm run mcp:outdated
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

/** Catalog entries that carry a `pinned` record, validated. */
export function pinnedPackages(catalog) {
  const out = [];
  for (const e of catalog) {
    const p = e && e.pinned;
    if (!p || p.manager !== 'npm') continue;
    if (typeof p.name !== 'string' || !NPM_NAME_RE.test(p.name)) throw new Error(`catalog "${e.id}": invalid package name`);
    if (typeof p.version !== 'string' || !VERSION_RE.test(p.version)) throw new Error(`catalog "${e.id}": invalid pinned version`);
    out.push({ id: e.id, name: p.name, pinned: p.version });
  }
  return out;
}

/** `npm view <pkg> version` prints the bare version (or a JSON string). */
export function parseNpmView(text) {
  const t = String(text ?? '').trim().replace(/^"|"$/g, '');
  return VERSION_RE.test(t) ? t : null;
}

function defaultNpmView(name) {
  // Name is validated against NPM_NAME_RE before reaching here, so it holds no
  // shell metacharacters (shell is only needed to run npm.cmd on Windows).
  if (!NPM_NAME_RE.test(name)) throw new Error('invalid package name');
  const win = process.platform === 'win32';
  return execFileSync(win ? 'npm.cmd' : 'npm', ['view', name, 'version'], { encoding: 'utf8', shell: win, timeout: 60000 });
}

/** `npmView(name)` is the seam: tests pass a fake returning canned text. */
export function checkUpdates(catalog, npmView = defaultNpmView) {
  return pinnedPackages(catalog).map((p) => {
    let latest = null;
    try { latest = parseNpmView(npmView(p.name)); } catch { latest = null; }
    return { ...p, latest, outdated: latest !== null && latest !== p.pinned };
  });
}

export function formatReport(rows) {
  const lines = ['package'.padEnd(52) + 'pinned'.padEnd(12) + 'latest'.padEnd(12) + 'status'];
  for (const r of rows) {
    const status = r.latest === null ? 'unknown (lookup failed)' : r.outdated ? 'OUTDATED' : 'current';
    lines.push(r.name.padEnd(52) + r.pinned.padEnd(12) + (r.latest ?? '?').padEnd(12) + status);
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const catalog = JSON.parse(readFileSync(path.join(ROOT, 'media', 'mcp', 'catalog.json'), 'utf8'));
  console.log(formatReport(checkUpdates(catalog)));
}
