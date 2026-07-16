/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * Namespaces this detector never reports as "foreign": `tycoon` is
 * TycoonAgents' own managed CLAUDE.md sections — in practice those use a
 * different marker SHAPE (`<!-- tycoon:delegation -->` / `<!--
 * /tycoon:delegation -->`, see delegationDoctrine.ts / codeRulesDoctrine.ts)
 * rather than this file's `<ns>:begin`/`<ns>:end` shape, but `tycoon` is
 * still excluded here as a defensive guard against ever flagging our own
 * config as foreign.
 */
const FOREIGN_NAMESPACE_EXCLUSIONS = new Set(["tycoon"]);

/**
 * Detect every OTHER tool's/plugin's HTML-comment managed block in a
 * CLAUDE.md's content — any `<!-- <ns>:begin ... <ns>:end -->` region whose
 * namespace isn't ours (see {@link FOREIGN_NAMESPACE_EXCLUSIONS}). This
 * covers legacy config carried over from a prior setup (another Claude Code
 * project's generator, or a previous plugin entirely) just as readily as a
 * currently-installed third-party tool — the detector treats every non-tycoon
 * namespace the same way, with no special-cased identity for any one of
 * them. The begin/end namespace must match (backreference), so an unrelated
 * `<ns>:begin` and a different tool's own `<ns>:end` never pair up.
 *
 * Pure (no fs/vscode access), deterministic (entries returned in order of
 * appearance in `content`), and a no-op (`[]`) when nothing matches. Each
 * result is a candidate for opt-in removal via {@link stripManagedBlock}.
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

/** Escape a string for literal use inside a `RegExp` constructor. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip the managed block for the GIVEN `namespace` out of `content`,
 * touching ONLY the delimited region (`<!-- <namespace>:begin ...
 * <namespace>:end -->`, inclusive) plus the single extra blank line the
 * removal would otherwise leave behind at the seam. `namespace` is expected
 * to come from a block actually detected on disk (see
 * {@link detectForeignManagedBlocks}) — it is regex-escaped before use, so a
 * namespace containing regex-special characters can never widen the match or
 * throw. Pure (no fs/vscode access) and idempotent: a no-op (`removed:
 * false`, `content` returned unchanged) when the given namespace's markers
 * aren't present, so callers can call this unconditionally.
 *
 * Text before and after the block is preserved byte-for-byte except for
 * trailing/leading blank-line runs directly adjacent to the removed block,
 * which are collapsed down to a single blank line separator (or none, if the
 * block was at the very start/end of the file) — this is the "collapse the
 * extra blank line it leaves" cleanup, scoped to the removal seam only so it
 * never touches unrelated blank-line runs elsewhere in the file.
 */
export function stripManagedBlock(content: string, namespace: string): { content: string; removed: boolean } {
  const escaped = escapeRegExp(namespace);
  const re = new RegExp(`<!--\\s*${escaped}:begin[\\s\\S]*?${escaped}:end\\s*-->`);
  const match = re.exec(content);
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
