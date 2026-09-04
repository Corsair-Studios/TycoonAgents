/**
 * Shared one-sentence-summary helper for the skills/packs/MCP catalogs.
 *
 * Contract (shared with the webview UI worker): every skill, pack, and MCP
 * server payload item carries `summary: string` — one sentence, ≤ 120
 * characters. Source: an authored `summary` field on the catalog entry;
 * when absent, `catalogSummary(entry)` derives the first sentence of
 * `description` per the rules below. Both the VS Code host (panel.ts) and
 * the standalone server (standalone/src/server.mjs, via the compiled
 * out/src/shared/catalogSummary.js) call this same helper so the payload
 * always has `summary`.
 */

const MAX_SUMMARY_LENGTH = 120;
const ELLIPSIS = "…";

/** Minimal shape this helper needs from a catalog entry. */
export interface CatalogEntryLike {
  summary?: string;
  description?: string;
}

/** Strip markdown backtick code-span markers, keeping their contents. */
function stripBackticks(text: string): string {
  return text.replace(/`+/g, "");
}

/** Collapse all whitespace runs (including newlines) to single spaces and trim. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Extract the first sentence from `text`: everything up to (but not
 * including) the first ". " / "! " / "? " boundary that is followed by a
 * capital letter or the end of the string. If no such boundary is found,
 * the whole (cleaned) string is returned.
 */
function firstSentence(text: string): string {
  const cleaned = collapseWhitespace(stripBackticks(text));
  const re = /[.!?]\s+(?=[A-Z]|$)/;
  const match = re.exec(cleaned);
  if (match && match.index !== undefined) {
    return cleaned.slice(0, match.index + 1);
  }
  // No sentence boundary found (or the string ends without one) — fall
  // back to the whole string, or up to a single trailing terminator.
  const trailing = /[.!?]$/.exec(cleaned);
  if (trailing) return cleaned;
  return cleaned;
}

/**
 * Hard-truncate `text` to at most `max` characters, breaking on a word
 * boundary where possible, and appending an ellipsis. Never returns a
 * string longer than `max`.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const budget = max - ELLIPSIS.length;
  if (budget <= 0) return ELLIPSIS.slice(0, max);
  let cut = text.slice(0, budget);
  const lastSpace = cut.lastIndexOf(" ");
  // Only break on the word boundary if it doesn't throw away most of the
  // budget (avoids pathological single-very-long-word inputs).
  if (lastSpace > 0 && lastSpace >= budget - 40) {
    cut = cut.slice(0, lastSpace);
  }
  cut = cut.replace(/[\s.,;:!?-]+$/, "");
  return cut + ELLIPSIS;
}

/**
 * Return the summary for a catalog entry: the authored `summary` field
 * when present and non-empty, otherwise the first sentence of
 * `description`. Always ≤ 120 characters (truncated on a word boundary
 * with an ellipsis if needed), with backticks stripped and whitespace
 * collapsed.
 */
export function catalogSummary(entry: CatalogEntryLike): string {
  const authored = typeof entry.summary === "string" ? collapseWhitespace(stripBackticks(entry.summary)) : "";
  if (authored !== "") {
    return truncate(authored, MAX_SUMMARY_LENGTH);
  }
  const description = typeof entry.description === "string" ? entry.description : "";
  const sentence = firstSentence(description);
  return truncate(sentence, MAX_SUMMARY_LENGTH);
}
