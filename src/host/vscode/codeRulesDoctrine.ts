/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/** Markers wrapping the managed path-scoped coding rules section inside a project's CLAUDE.md. */
export const CODE_RULES_SECTION_START = "<!-- tycoon:coderules -->";
export const CODE_RULES_SECTION_END = "<!-- /tycoon:coderules -->";

/**
 * Path-scoped coding standards, keyed by the area of the codebase a file
 * lives in. These are intentionally generic starting defaults — a fresh
 * project is expected to edit the table (path patterns and standards) to
 * match its own layout and conventions.
 */
const CODE_RULES_BODY = `## Coding standards by path

These are starting defaults, not fixed law — tune the path patterns and
standards below to fit this project's actual layout and conventions.

| Area | Path patterns | Standards |
| --- | --- | --- |
| Gameplay / systems logic | \`src/game/**\`, \`src/systems/**\` | No hardcoded tuning values — read them from data/config; keep simulation logic deterministic and covered by tests. |
| UI / HUD | \`src/ui/**\`, \`**/*.tsx\`, \`**/*.css\` | Keep layout, state, and styling changes reviewable together; prefer the UI/design specialist for canvas, animation, and CSS work. |
| Networking / multiplayer | \`src/net/**\`, \`src/server/**\` | Validate all client input server-side; never trust client-reported state; keep message schemas versioned. |
| Assets / data | \`assets/**\`, \`data/**\`, \`**/*.json\` | No secrets or absolute filesystem paths baked into shipped data; keep generated assets reproducible from their source config. |
| Config / build | \`*.config.*\`, \`package.json\`, \`tsconfig*.json\` | No secrets or machine-specific absolute paths; changes here should not silently alter another area's behavior. |
| Tests | \`test/**\`, \`**/*.spec.*\`, \`**/*.test.*\` | Tests cover the stated acceptance criteria, stay deterministic (no real timers/network), and are verified by someone other than the author of the change under test. |
| Engine scripts (GDScript / C# / Verse / Python) | \`**/*.gd\`, \`**/*.cs\`, \`**/*.verse\`, \`**/*.py\` | Keep editor-bridge imports side-effect-free; match the host engine's idioms rather than porting patterns from another language verbatim. |
`;

/**
 * Render the CLAUDE.md section body for path-scoped coding rules. Pure (no
 * fs/vscode access), so this is unit-testable. The returned string does NOT
 * include the `<!-- tycoon:coderules -->` markers — use
 * {@link upsertCodeRulesSection} to splice it into a CLAUDE.md.
 */
export function renderCodeRules(): string {
  return CODE_RULES_BODY.replace(/\s+$/, "");
}

/**
 * Splice `sectionBody` into `existingContent` between the managed
 * `<!-- tycoon:coderules -->` / `<!-- /tycoon:coderules -->` markers.
 *
 * - `existingContent` null/empty -> produce a minimal new CLAUDE.md (a
 *   heading followed by the marked section).
 * - Markers already present -> replace ONLY the span between them
 *   (inclusive of the markers themselves); everything outside the span is
 *   preserved byte-for-byte.
 * - Content present but no markers -> append the marked section at the end,
 *   separated from existing content by a blank line. Existing content is
 *   preserved byte-for-byte.
 *
 * Idempotent: calling this twice with the same `sectionBody` on the result
 * of the first call produces an identical string. Pure (no fs/vscode
 * access).
 */
export function upsertCodeRulesSection(
  existingContent: string | null,
  sectionBody: string
): string {
  const body = sectionBody.replace(/\s+$/, "");
  const block = `${CODE_RULES_SECTION_START}\n${body}\n${CODE_RULES_SECTION_END}`;

  if (existingContent === null || existingContent.length === 0) {
    return `# Project Instructions\n\n${block}\n`;
  }

  const startIdx = existingContent.indexOf(CODE_RULES_SECTION_START);
  const endIdx = existingContent.indexOf(CODE_RULES_SECTION_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existingContent.slice(0, startIdx);
    const after = existingContent.slice(endIdx + CODE_RULES_SECTION_END.length);
    return `${before}${block}${after}`;
  }

  // No markers found: append at the end, separated by exactly one blank line.
  const separator = existingContent.endsWith("\n") ? "\n" : "\n\n";
  return `${existingContent}${separator}${block}\n`;
}
