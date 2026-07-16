/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * Matches the legacy OfficeAgents-managed CLAUDE.md block, from the opening
 * `<!-- officeagents:begin` comment (whatever trailing text follows it, e.g.
 * "— managed by OfficeAgents; do not edit between markers -->") through the
 * closing `<!-- officeagents:end -->` marker, inclusive. `[\s\S]*?` (dotAll,
 * non-greedy) so the match spans multiple lines but stops at the FIRST end
 * marker rather than swallowing everything to the last one in the file.
 *
 * OfficeAgents is TycoonAgents' retired predecessor plugin (see
 * AGENTS-CONFIG-REPORT.md) — a project that installed it before switching to
 * TycoonAgents ends up with both an `officeagents:*` managed block and our
 * own `tycoon:*` blocks in the same CLAUDE.md.
 */
const LEGACY_BLOCK_RE = /<!--\s*officeagents:begin[\s\S]*?officeagents:end\s*-->/;

/**
 * Detect the legacy OfficeAgents block in a CLAUDE.md's content, without
 * modifying anything. Pure (no fs/vscode access). `lineCount` is the number
 * of lines the matched block spans (0 when absent) — surfaced in the Setup
 * Wizard so the user knows roughly how much is being removed before
 * confirming.
 */
export function detectLegacyOfficeAgentsBlock(content: string): { present: boolean; lineCount: number } {
  const match = LEGACY_BLOCK_RE.exec(content);
  if (!match) {
    return { present: false, lineCount: 0 };
  }
  return { present: true, lineCount: match[0].split(/\r\n|\n/).length };
}

/**
 * Namespaces this detector never reports as "foreign": `tycoon` is
 * TycoonAgents' own managed CLAUDE.md sections — in practice those use a
 * different marker SHAPE (`<!-- tycoon:delegation -->` / `<!--
 * /tycoon:delegation -->`, see delegationDoctrine.ts / codeRulesDoctrine.ts)
 * rather than this file's `<ns>:begin`/`<ns>:end` shape, but `tycoon` is
 * still excluded here as a defensive guard against ever flagging our own
 * config as foreign. `officeagents` already has its own dedicated,
 * REMOVABLE detection path above ({@link detectLegacyOfficeAgentsBlock} /
 * {@link stripLegacyOfficeAgentsBlock}) — this generic detector is
 * inform-only and must not duplicate that entry.
 */
const FOREIGN_NAMESPACE_EXCLUSIONS = new Set(["tycoon", "officeagents"]);

/**
 * Detect every OTHER tool/plugin's HTML-comment managed block in a
 * CLAUDE.md's content — any `<!-- <ns>:begin ... <ns>:end -->` region
 * (same marker shape the legacy OfficeAgents block used) whose namespace
 * isn't ours or OfficeAgents' (see {@link FOREIGN_NAMESPACE_EXCLUSIONS}).
 * The begin/end namespace must match (backreference), so an unrelated
 * `<ns>:begin` and a different tool's own `<ns>:end` never pair up.
 *
 * INFORM-ONLY: unlike {@link detectLegacyOfficeAgentsBlock}, there is no
 * companion strip function — this exists purely to surface how much of a
 * project's CLAUDE.md some other tool is carrying (Settings "Context
 * budget" section, Setup Wizard), never to remove it. Pure (no fs/vscode
 * access), deterministic (entries returned in order of appearance in
 * `content`), and a no-op (`[]`) when nothing matches.
 */
export function detectForeignManagedBlocks(content: string): { namespace: string; lines: number }[] {
  const re = /<!--\s*([a-zA-Z][\w-]*):begin[\s\S]*?\1:end\s*-->/g;
  const results: { namespace: string; lines: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const namespace = match[1];
    if (!FOREIGN_NAMESPACE_EXCLUSIONS.has(namespace.toLowerCase())) {
      results.push({ namespace, lines: match[0].split(/\r\n|\n/).length });
    }
    // `[\s\S]*?` guarantees the match consumes at least the literal
    // ":begin"/":end" text (non-zero width), so `re.lastIndex` always
    // advances -- no risk of an infinite loop here.
  }
  return results;
}

/**
 * Strip the legacy OfficeAgents-managed block out of `content`, touching
 * ONLY the delimited region (`<!-- officeagents:begin ... officeagents:end
 * -->`, inclusive) plus the single extra blank line the removal would
 * otherwise leave behind at the seam. Pure (no fs/vscode access) and
 * idempotent: a no-op (`removed: false`, `content` returned unchanged) when
 * the markers aren't present, so callers can call this unconditionally.
 *
 * Text before and after the block is preserved byte-for-byte except for
 * trailing/leading blank-line runs directly adjacent to the removed block,
 * which are collapsed down to a single blank line separator (or none, if the
 * block was at the very start/end of the file) — this is the "collapse the
 * extra blank line it leaves" cleanup, scoped to the removal seam only so it
 * never touches unrelated blank-line runs elsewhere in the file.
 */
export function stripLegacyOfficeAgentsBlock(content: string): { content: string; removed: boolean } {
  const match = LEGACY_BLOCK_RE.exec(content);
  if (!match) {
    return { content, removed: false };
  }

  const before = content.slice(0, match.index);
  const after = content.slice(match.index + match[0].length);

  const beforeTrimmed = before.replace(/[ \t]*\n+$/, "");
  const afterTrimmed = after.replace(/^[ \t]*\n+/, "");

  let joined: string;
  if (beforeTrimmed.length === 0) {
    joined = afterTrimmed;
  } else if (afterTrimmed.length === 0) {
    joined = beforeTrimmed.endsWith("\n") ? beforeTrimmed : `${beforeTrimmed}\n`;
  } else {
    joined = `${beforeTrimmed}\n\n${afterTrimmed}`;
  }

  return { content: joined, removed: true };
}
