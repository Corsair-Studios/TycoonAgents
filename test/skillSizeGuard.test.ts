/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Guards two shipped-markdown hygiene rules under media/skills/** and
// media/commands/*.md:
//   1. No changelog-shaped heading or HTML comment block — changelog content
//      lives in docs/ now (see 6e65ffa moving verse-common-errors' changelog
//      to docs/uefn).
//   2. A per-file size ceiling, so shipped skill/command docs don't balloon.
//      media/skills/uefn/verse-common-errors.md is an intentional exception:
//      it is a last-resort reference for verse-expert/uefn-auditor and must
//      stay complete (83,604 bytes as of 2026-09-15), so it gets its own
//      allowlisted ceiling of 100,000 bytes. Every other shipped file is
//      capped at 40,000 bytes — the largest other file today is
//      media/skills/uefn-bridge/SKILL.md at 21,161 bytes, comfortably under,
//      so 40,000 is used as-is rather than raised.

const repoRoot = path.resolve(__dirname, "..", "..");

export const GENERAL_SIZE_CEILING_BYTES = 40_000;

/** Per-path overrides, keyed by path relative to repoRoot (forward slashes). */
export const SIZE_CEILING_ALLOWLIST: Record<string, number> = {
  "media/skills/uefn/verse-common-errors.md": 100_000,
};

const CHANGELOG_HEADING_RE = /^#{1,6}\s*(changelog|change log|release notes|version history)\b/im;
const CHANGELOG_COMMENT_RE = /<!--\s*changelog/i;

export interface FileContent {
  file: string;
  content: string;
}

export interface SizeGuardViolation {
  file: string;
  reason: "changelog-heading" | "changelog-comment" | "oversized";
  detail: string;
}

/**
 * Pure checker: given shipped {file, content} entries (file paths relative to
 * repo root, forward-slash separated), return every rule violation. No
 * filesystem access — callers do the reading.
 */
export function checkSkillFiles(files: FileContent[]): SizeGuardViolation[] {
  const violations: SizeGuardViolation[] = [];
  for (const { file, content } of files) {
    if (CHANGELOG_HEADING_RE.test(content)) {
      violations.push({ file, reason: "changelog-heading", detail: "changelog-shaped heading found" });
    }
    if (CHANGELOG_COMMENT_RE.test(content)) {
      violations.push({ file, reason: "changelog-comment", detail: "<!-- changelog comment block found" });
    }
    const ceiling = SIZE_CEILING_ALLOWLIST[file] ?? GENERAL_SIZE_CEILING_BYTES;
    const size = Buffer.byteLength(content, "utf8");
    if (size > ceiling) {
      violations.push({
        file,
        reason: "oversized",
        detail: `${size} bytes exceeds ceiling of ${ceiling} bytes`,
      });
    }
  }
  return violations;
}

function collectShippedSkillAndCommandFiles(): FileContent[] {
  const files: FileContent[] = [];
  const skillsDir = path.join(repoRoot, "media", "skills");
  const commandsDir = path.join(repoRoot, "media", "commands");

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push({
          file: path.relative(repoRoot, full).split(path.sep).join("/"),
          content: fs.readFileSync(full, "utf8"),
        });
      }
    }
  }

  walk(skillsDir);
  walk(commandsDir);
  return files;
}

test("no shipped skill/command markdown has a changelog heading, changelog comment, or exceeds its size ceiling", () => {
  const files = collectShippedSkillAndCommandFiles();
  assert.ok(files.length > 0, "expected to find shipped skill/command markdown files under media/");

  const violations = checkSkillFiles(files);
  if (violations.length > 0) {
    const summary = violations.map((v) => `${v.file}: ${v.reason} (${v.detail})`).join("\n");
    assert.deepEqual(violations, [], `Shipped markdown hygiene violation(s):\n${summary}`);
  }
});

test("checkSkillFiles flags a changelog heading and an oversized file (fixture)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillSizeGuard-"));
  try {
    const changelogPath = path.join(tmpDir, "SKILL.md");
    fs.writeFileSync(changelogPath, "# Intro\n\n## Changelog\n\n- did a thing\n", "utf8");

    const oversizedPath = path.join(tmpDir, "big.md");
    fs.writeFileSync(oversizedPath, "x".repeat(GENERAL_SIZE_CEILING_BYTES + 1), "utf8");

    const files: FileContent[] = [
      { file: changelogPath, content: fs.readFileSync(changelogPath, "utf8") },
      { file: oversizedPath, content: fs.readFileSync(oversizedPath, "utf8") },
    ];

    const violations = checkSkillFiles(files);
    assert.equal(violations.length, 2);

    const changelogViolation = violations.find((v) => v.file === changelogPath);
    assert.ok(changelogViolation, "expected the changelog fixture to be flagged");
    assert.equal(changelogViolation!.reason, "changelog-heading");

    const oversizedViolation = violations.find((v) => v.file === oversizedPath);
    assert.ok(oversizedViolation, "expected the oversized fixture to be flagged");
    assert.equal(oversizedViolation!.reason, "oversized");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
