#!/usr/bin/env node
// Build gate: fail packaging if any shipped artifact contains an absolute
// filesystem path. Absolute paths are machine-specific and break every other
// install. Catalogs/configs must use ${EXTENSION_DIR} or relative paths, and
// runtime-generated files (.mcp.json, logs) must be kept out of the VSIX.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

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
const PATTERNS = [
  { name: 'windows-drive-path', re: /(?<![A-Za-z0-9_./\\])[A-Za-z]:[\\/](?![\\/])/g },
  { name: 'users-path', re: /[\\/]Users[\\/]/gi },
  { name: 'home-path', re: /[\\/]home[\\/][A-Za-z0-9._-]+/g },
  { name: 'root-path', re: /(?<![A-Za-z0-9_])[\\/]root[\\/][A-Za-z0-9._-]+/g },
  { name: 'antigravity-ide', re: /\.antigravity-ide/g },
];

function walk(p, out) {
  let st;
  try { st = statSync(p); } catch { return; }
  if (st.isDirectory()) {
    for (const e of readdirSync(p)) walk(join(p, e), out);
  } else if (st.isFile() && TEXT_EXT.has(extname(p).toLowerCase())) {
    out.push(p);
  }
}

const files = [];
for (const root of SHIPPED) walk(root, files);

const hits = [];
for (const file of files) {
  let content;
  try { content = readFileSync(file, 'utf8'); } catch { continue; }
  const lines = content.split(/\r?\n/);
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      const line = content.slice(0, m.index).split(/\r?\n/).length;
      const snippet = (lines[line - 1] || '').trim().slice(0, 120);
      hits.push({ file: file.replace(/\\/g, '/'), line, pattern: name, snippet });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
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
