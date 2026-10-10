#!/usr/bin/env node
// Build a clean snapshot of the tracked files for the public repository.
//
//   node scripts/export-public.mjs <target-dir> [--force]
//
// Copies `git ls-files` minus the paths matched by public-export.exclude into
// <target-dir>, then scrubs every exported text file for personal paths,
// emails, private repo names and high-signal key patterns. Exits non-zero
// (listing file:line) when the scrub finds anything not covered by
// public-export.allow. It never runs git init/commit/push.
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Scrub rules. `secret` rules never echo the matched value.
export const SCRUB_RULES = [
  // Separators tolerate repeated or escaped forms (C:\Users\x, C:\\Users\\x, \/Users\/x).
  { name: 'personal-path-windows', re: /[A-Za-z]:(?:\\+|\/)+Users(?:\\+|\/)+[^\\/\s"'`]+/g },
  { name: 'personal-path-dev-root', re: /[A-Za-z]:(?:\\+|\/)+ACode\b/gi },
  { name: 'personal-path-posix', re: /(?<![A-Za-z0-9_.-])\/Users(?:\\+|\/)+[A-Za-z0-9._-]+/g },
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  { name: 'private-repo-name', re: /corsair-theme-service/gi },
  { name: 'key-sk-ant', re: /sk-ant-[A-Za-z0-9_-]{8,}/g, secret: true },
  { name: 'key-sk-proj', re: /sk-proj-[A-Za-z0-9_-]{8,}/g, secret: true },
  { name: 'key-ghp', re: /ghp_[A-Za-z0-9]{8,}/g, secret: true },
  { name: 'key-github-pat', re: /github_pat_[A-Za-z0-9_]{8,}/g, secret: true },
  { name: 'key-aws', re: /AKIA[0-9A-Z]{16}/g, secret: true },
  { name: 'key-stripe-live', re: /sk_live_[A-Za-z0-9]{8,}/g, secret: true },
  { name: 'key-stripe-webhook', re: /whsec_[A-Za-z0-9]{8,}/g, secret: true },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, secret: true },
];

// Narrow built-in exemptions (everything else stays strict):
//  - path rules: exempt only when the username segment itself is a `<...>`
//    placeholder such as C:\Users\<user>; C:\Users\name\<x> is still flagged.
//  - email rule: RFC 2606 reserved domains (example.com/.org/.net, *.example,
//    *.test, *.invalid, localhost) cannot belong to a real person.
const RESERVED_EMAIL_DOMAIN = /(?:@|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost)$/i;

function isBenign(ruleName, text) {
  if (ruleName.startsWith('personal-path-')) {
    const segment = text.split(/[\\/]+/).pop() ?? '';
    return /^<[^<>\s]*(?:>|$)/.test(segment);
  }
  if (ruleName === 'email') return RESERVED_EMAIL_DOMAIN.test(text);
  return false;
}

// Scripts removed from the exported package.json (copy only) because the
// script file itself is withheld from the public snapshot.
const EXPORT_STRIPPED_SCRIPTS = ['export:public'];

// Containers that cannot be text-scanned; an exported one fails the scrub
// unless public-export.allow lists its path with the `*` needle.
const CONTAINER_EXT = new Set(['.docx', '.xlsx', '.pptx', '.zip', '.vsix', '.jar', '.7z']);

const MARKER_FILE = '.tycoon-public-export';

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.vsix',
  '.docx', '.xlsx', '.pptx', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4',
  '.wav', '.ogg', '.webm', '.exe', '.dll', '.node', '.gz', '.7z',
]);

function escapeRe(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globToRegexSource(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else { out += '.*'; }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += escapeRe(c);
    }
  }
  return out;
}

/** Parse gitignore-style lines into an ordered matcher list. */
export function parsePatterns(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.replace(/\/+$/, '');
    const anchored = line.includes('/');
    line = line.replace(/^\//, '');
    const body = globToRegexSource(line);
    const prefix = anchored ? '^' : '^(?:.*/)?';
    const re = dirOnly
      ? new RegExp(`${prefix}${body}/`)
      : new RegExp(`${prefix}${body}(?:/.*)?$`);
    rules.push({ negate, dirOnly, re });
  }
  return rules;
}

/** True when the repo-relative posix path is matched (last matching rule wins). */
export function isMatched(rules, relPath) {
  let hit = false;
  for (const r of rules) {
    if (r.re.test(relPath)) hit = !r.negate;
  }
  return hit;
}

/** Allowlist lines are `path-glob:substring` (substring of the matched text, or `*`). */
export function parseAllowlist(text) {
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const pathGlob = line.slice(0, idx).trim();
    const needle = line.slice(idx + 1).trim();
    entries.push({ rules: parsePatterns(pathGlob), needle });
  }
  return entries;
}

// Collapse escaped/repeated separators so one allowlist needle covers C:\Users\x and C:\\Users\\x.
const normalizeSeparators = (s) => s.replace(/\\+/g, '\\').replace(/\\\//g, '/');

function isAllowed(allow, relPath, matchedText) {
  const text = normalizeSeparators(matchedText);
  return allow.some((e) => isMatched(e.rules, relPath)
    && (e.needle === '*' || text.includes(normalizeSeparators(e.needle))));
}

function redact(text) {
  return `${text.slice(0, 4)}***`;
}

function looksBinary(buf, rel) {
  if (BINARY_EXT.has(path.extname(rel).toLowerCase())) return true;
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Scan one text blob. Returns [{ file, line, rule, text }] with secrets already redacted. */
export function scrubText(rel, content, allow = [], tokens = []) {
  const findings = [];
  const tokenRules = tokens
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({ name: 'personal-token', re: new RegExp(`(?<![A-Za-z0-9_])${escapeRe(t)}(?![A-Za-z0-9_])`, 'gi') }));
  // Opaque base64 payloads can coincidentally match key patterns.
  const lines = content
    .replace(/base64,[A-Za-z0-9+/=]{200,}/g, 'base64,<payload>')
    .split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of [...SCRUB_RULES, ...tokenRules]) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        if (!isBenign(rule.name, m[0]) && !isAllowed(allow, rel, m[0])) {
          findings.push({ file: rel, line: i + 1, rule: rule.name, text: rule.secret ? redact(m[0]) : m[0] });
        }
        if (m[0].length === 0) rule.re.lastIndex++;
      }
    }
  });
  return findings;
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realOrResolved(p) {
  // Resolve symlinks on the deepest existing ancestor so a target under a
  // linked path is still recognised as inside the repo.
  let cur = path.resolve(p);
  const tail = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(realpathSync(cur), ...tail);
}

function defaultTokens(repoRoot) {
  const tokens = [];
  try { tokens.push(os.userInfo().username); } catch { /* no resolvable user */ }
  const file = path.join(repoRoot, '.public-export.tokens');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#')) tokens.push(t);
    }
  }
  return tokens;
}

function gitLsFiles(repoRoot) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 });
  return out.toString('utf8').split('\0').filter(Boolean);
}

function refusal(message) {
  return Object.assign(new Error(message), { code: 'TARGET_INVALID' });
}

/**
 * Run the export. Throws an Error with `.code === 'TARGET_INVALID'` for
 * refusals; otherwise returns { copied, excluded, scanned, findings, target }.
 */
export function exportPublic({
  repoRoot = REPO_ROOT,
  target,
  force = false,
  files,
  excludeFile = 'public-export.exclude',
  allowFile = 'public-export.allow',
  tokens,
} = {}) {
  if (!target) throw refusal('A target directory argument is required.');
  const root = realOrResolved(repoRoot);
  const dest = realOrResolved(target);
  if (isInside(root, dest)) throw refusal('Refusing: target directory is inside this repository.');
  if (isInside(dest, root)) throw refusal('Refusing: target directory contains this repository.');
  if (existsSync(dest) && readdirSync(dest).length > 0) {
    if (!force) throw refusal('Refusing: target directory is not empty (use --force to overwrite).');
    if (!existsSync(path.join(dest, MARKER_FILE))) {
      throw refusal(`Refusing: target directory is not empty and has no ${MARKER_FILE} marker from a previous export.`);
    }
    // rmSync removes symlinks themselves and never follows them out of the target.
    for (const entry of readdirSync(dest)) rmSync(path.join(dest, entry), { recursive: true, force: true });
  }

  const readOptional = (name) => {
    const p = path.join(repoRoot, name);
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  };
  const exclude = parsePatterns(readOptional(excludeFile));
  const allow = parseAllowlist(readOptional(allowFile));

  const tracked = (files ?? gitLsFiles(repoRoot)).map((f) => f.replace(/\\/g, '/'));
  const copiedFiles = [];
  const skippedSymlinks = [];
  let excluded = 0;
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, MARKER_FILE), 'Written by scripts/export-public.mjs; --force may clear this directory.\n');
  for (const rel of tracked) {
    const src = path.join(repoRoot, rel);
    let st;
    try { st = lstatSync(src); } catch { continue; } // tracked but deleted in the working tree
    if (isMatched(exclude, rel)) { excluded++; continue; }
    if (st.isSymbolicLink()) { skippedSymlinks.push(rel); continue; }
    const out = path.join(dest, rel);
    mkdirSync(path.dirname(out), { recursive: true });
    if (rel === 'package.json') {
      const pkg = JSON.parse(readFileSync(src, 'utf8'));
      for (const name of EXPORT_STRIPPED_SCRIPTS) if (pkg.scripts) delete pkg.scripts[name];
      writeFileSync(out, `${JSON.stringify(pkg, null, 2)}
`);
    } else {
      copyFileSync(src, out);
    }
    copiedFiles.push(rel);
  }

  const findings = [];
  const scrubTokens = tokens ?? defaultTokens(repoRoot);
  let scanned = 0;
  for (const rel of copiedFiles) {
    if (CONTAINER_EXT.has(path.extname(rel).toLowerCase())) {
      if (!allow.some((e) => e.needle === '*' && isMatched(e.rules, rel))) {
        findings.push({ file: rel, line: 0, rule: 'unscannable-container', text: path.extname(rel).toLowerCase() });
      }
      continue;
    }
    const buf = readFileSync(path.join(dest, rel));
    if (looksBinary(buf, rel)) continue;
    scanned++;
    findings.push(...scrubText(rel, buf.toString('utf8'), allow, scrubTokens));
  }

  return { copied: copiedFiles.length, excluded, scanned, findings, skippedSymlinks, target: dest };
}

function main(argv) {
  const args = argv.slice(2);
  const force = args.includes('--force');
  const positional = args.filter((a) => !a.startsWith('--'));
  if (positional.length !== 1) {
    process.stderr.write('Usage: node scripts/export-public.mjs <target-dir> [--force]\n');
    return 2;
  }
  let result;
  try {
    result = exportPublic({ target: positional[0], force });
  } catch (err) {
    if (err && err.code === 'TARGET_INVALID') {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
  process.stdout.write(`Files copied: ${result.copied}\nFiles excluded: ${result.excluded}\nText files scanned: ${result.scanned}\n`);
  for (const rel of result.skippedSymlinks) process.stdout.write(`Skipped symlink: ${rel}\n`);
  if (result.findings.length === 0) {
    process.stdout.write('Scrub: clean\n');
    return 0;
  }
  process.stdout.write(`Scrub: FAILED with ${result.findings.length} finding(s)\n`);
  for (const f of result.findings) {
    process.stdout.write(`  ${f.file}:${f.line}  [${f.rule}]  ${f.text}\n`);
  }
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}
