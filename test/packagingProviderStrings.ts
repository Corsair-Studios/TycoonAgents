// test/packagingProviderStrings.ts
//
// Side-effect-free provider-string scanning code shared by
// test/packagingManifest.check.ts (VSIX content checks, requires dist/) and
// test/packagingProviderStrings.test.ts (pure unit tests against in-memory
// fixtures). This module registers no node:test test(...) blocks — it must
// stay pure so importing it never runs anything.
//
// p45-t5: release checklist provider-key grep. Guards against a shipped
// VSIX leaking an OpenAI/Google API hostname, SDK package, or a live
// provider key pattern (this project talks to those providers only via
// user-configured routing, never a bundled key/hostname).

import path from "node:path";

export interface Finding {
  path: string;
  pattern: string;
  match: string;
}

export const FORBIDDEN_HOSTNAMES = [
  "api.openai.com",
  "generativelanguage.googleapis.com",
];

export const FORBIDDEN_PACKAGE_DIRS = [
  "node_modules/openai/",
  "node_modules/@google/generative-ai/",
  "node_modules/@google/genai/",
];

export const FORBIDDEN_PACKAGE_IMPORTS = [
  {
    pattern: "openai",
    regex: /(?:require\(\s*["']openai["']\s*\)|from\s+["']openai["']|import\(\s*["']openai["']\s*\))/,
  },
  {
    pattern: "@google/generative-ai",
    regex: /(?:require\(\s*["']@google\/generative-ai["']\s*\)|from\s+["']@google\/generative-ai["']|import\(\s*["']@google\/generative-ai["']\s*\))/,
  },
  {
    pattern: "@google/genai",
    regex: /(?:require\(\s*["']@google\/genai["']\s*\)|from\s+["']@google\/genai["']|import\(\s*["']@google\/genai["']\s*\))/,
  },
];

// OpenAI-style keys ("sk-" + 20+ alnum/_/- chars) and Google-style API keys
// ("AIza" + 35 alnum/_/- chars). The 20-char OpenAI bound is deliberate: it
// clears benign short "sk-..." model-id-shaped strings that are not keys.
export const OPENAI_KEY_RE = /sk-[A-Za-z0-9_-]{20,}/;
export const GOOGLE_KEY_RE = /AIza[0-9A-Za-z_-]{35}/;

export const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".woff",
  ".woff2",
  ".ttf",
  ".vsix",
  ".zip",
  ".webp",
  ".mp3",
  ".ogg",
]);

export function isBinaryPath(entryPath: string): boolean {
  const ext = path.extname(entryPath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

export function findForbiddenProviderStrings(
  entries: { path: string; text: string }[]
): Finding[] {
  const findings: Finding[] = [];

  for (const { path: entryPath, text } of entries) {
    for (const dir of FORBIDDEN_PACKAGE_DIRS) {
      if (entryPath.includes(dir)) {
        findings.push({ path: entryPath, pattern: `package:${dir}`, match: entryPath });
      }
    }

    for (const host of FORBIDDEN_HOSTNAMES) {
      if (text.includes(host)) {
        findings.push({ path: entryPath, pattern: `hostname:${host}`, match: host });
      }
    }

    for (const { pattern, regex } of FORBIDDEN_PACKAGE_IMPORTS) {
      const match = text.match(regex);
      if (match) {
        findings.push({ path: entryPath, pattern: `import:${pattern}`, match: match[0] });
      }
    }

    const openaiMatch = text.match(OPENAI_KEY_RE);
    if (openaiMatch) {
      findings.push({ path: entryPath, pattern: "key:openai(sk-)", match: openaiMatch[0] });
    }

    const googleMatch = text.match(GOOGLE_KEY_RE);
    if (googleMatch) {
      findings.push({ path: entryPath, pattern: "key:google(AIza)", match: googleMatch[0] });
    }
  }

  return findings;
}
