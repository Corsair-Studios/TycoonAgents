#!/usr/bin/env node
// Build gate: fail packaging if any shipped artifact contains an absolute
// filesystem path. Absolute paths are machine-specific and break every other
// install. Catalogs/configs must use ${EXTENSION_DIR} or relative paths, and
// runtime-generated files (.mcp.json, logs) must be kept out of the VSIX.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

// Roots that get packaged into the VSIX (mirrors the .vscodeignore allowlist).
const SHIPPED = [
  'media',
  'hooks',
  'out/extension.js',
  'package.json',
  'readme.md',
  'LICENSE.txt',
];

const TEXT_EXT = new Set([
  '.js', '.cjs', '.mjs', '.json', '.css', '.html', '.htm', '.md', '.txt', '.svg',
]);

// Absolute-path patterns. URLs (scheme://) are intentionally NOT matched —
// the drive-path rule excludes a letter preceded by another letter (http:) and
// a colon followed by a double slash (://).
export const PATTERNS = [
  { name: 'windows-drive-path', re: /(?<![A-Za-z0-9_./\\])[A-Za-z]:[\\/](?![\\/])/g },
  { name: 'users-path', re: /[\\/]Users[\\/]/gi },
  { name: 'home-path', re: /[\\/]home[\\/][A-Za-z0-9._-]+/g },
  { name: 'root-path', re: /(?<![A-Za-z0-9_])[\\/]root[\\/][A-Za-z0-9._-]+/g },
  { name: 'antigravity-ide', re: /\.antigravity-ide/g },
];

// Base64 data-URL payloads (e.g. bundled theme frames.json image data) are
// opaque encoded binary, not text — random base64 characters can coincidence-
// match a path pattern (e.g. "home-path") and trip a false positive. Replace
// well-formed `data:<mime>;base64,<payload>` blobs with a short placeholder
// before running the path patterns, so only the encoded payload is skipped
// and any REAL path elsewhere in the file (even on the same line) is still
// caught. The payload character class excludes newlines, so a match can
// never span a line break — swapping it for a placeholder can't delete or
// merge lines, which keeps reported line numbers accurate. This is a single
// flat character class with no nested/ambiguous quantifiers, so it runs in
// linear time with no catastrophic-backtracking risk even on the ~8.8 MB
// theme JSON files that hold these payloads.
const DATA_URL_RE = /data:[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;

export function neutralizeDataUrls(content) {
  return content.replace(DATA_URL_RE, 'data:__BASE64_PAYLOAD_REDACTED__');
}

// Scans already-read file text for absolute-path leaks, after neutralizing
// base64 data-URL payloads. Exported (alongside neutralizeDataUrls/PATTERNS)
// so tests can exercise the detection logic directly on in-memory strings
// without touching disk or the SHIPPED walk below.
export function findLeaksInContent(content) {
  const neutralized = neutralizeDataUrls(content);
  const lines = neutralized.split(/\r?\n/);
  const hits = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(neutralized)) !== null) {
      const line = neutralized.slice(0, m.index).split(/\r?\n/).length;
      const snippet = (lines[line - 1] || '').trim().slice(0, 120);
      hits.push({ line, pattern: name, snippet });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return hits;
}

function walk(p, out) {
  let st;
  try { st = statSync(p); } catch { return; }
  if (st.isDirectory()) {
    for (const e of readdirSync(p)) walk(join(p, e), out);
  } else if (st.isFile() && TEXT_EXT.has(extname(p).toLowerCase())) {
    out.push(p);
  }
}

function main() {
  const files = [];
  for (const root of SHIPPED) walk(root, files);

  const hits = [];
  for (const file of files) {
    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    for (const h of findLeaksInContent(content)) {
      hits.push({ file: file.replace(/\\/g, '/'), ...h });
    }
  }

  if (hits.length > 0) {
    console.error(`\n[check-no-absolute-paths] FAILED: ${hits.length} absolute-path leak(s) in shipped files:\n`);
    for (const h of hits) {
      console.error(`  ${h.file}:${h.line}  [${h.pattern}]  ${h.snippet}`);
    }
    console.error(
      '\nNo shipped artifact may contain an absolute filesystem path.\n' +
      'Use ${EXTENSION_DIR} or a relative path in catalogs/configs, and keep\n' +
      'runtime-generated files (.mcp.json, logs) out of the package.\n',
    );
    process.exit(1);
  }

  console.log(`[check-no-absolute-paths] OK — scanned ${files.length} shipped files, no absolute paths.`);
}

// Only run the full shipped-file scan (and its process.exit on failure) when
// this script is executed directly, e.g. `node scripts/check-no-absolute-paths.mjs`
// or `npm run check:paths`. Tests import neutralizeDataUrls/findLeaksInContent
// as a module, which must NOT trigger a disk walk or an exit call.
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
