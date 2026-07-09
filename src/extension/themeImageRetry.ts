export type ThemeImageRetryMode = 'augment' | 'replace' | 'retry' | 'custom';

/** Notes longer than this are treated as a probable pasted full prompt. */
const RETRY_NOTES_MAX_CHARS = 4000;

const CELL_LINE_RE = /^\s*Cell \d+:/m;
const SPRITE_BOARD_HEADER_RE = /^Create one .*(sprite board|sprite sheet|atlas)/i;
const CREATIVE_DIRECTION_MARKER_RE = /Creative direction:/g;

function looksLikePastedGenerationPrompt(notes: string): boolean {
  if (notes.length > RETRY_NOTES_MAX_CHARS) return true;
  if (notes.includes('512 x 512') && /magenta/i.test(notes)) return true;
  const cellLineCount = (notes.match(new RegExp(CELL_LINE_RE, 'gm')) ?? []).length;
  if (cellLineCount >= 2) return true;
  if (SPRITE_BOARD_HEADER_RE.test(notes)) return true;
  return false;
}

/** Result of {@link sanitizeRetryNotes}: the notes to use, plus whether they
 * were salvaged (trimmed) from a pasted full prompt so the caller can warn
 * the user their text was cut instead of silently swapping it in. */
export interface SanitizedRetryNotes {
  notes: string;
  trimmed: boolean;
}

/**
 * Guard against retry-notes snowballing: if a user pastes a full saved
 * generation prompt (or something that looks like one) into the retry notes
 * box, salvage just the trailing creative-direction text instead of letting
 * the whole nested prompt get embedded verbatim into the next prompt. Every
 * prompt builder appends `Creative direction: ${creativeDirection}` with no
 * cap, so an unfiltered paste grows and contradicts itself on each retry.
 *
 * Returns `trimmed: true` when the input was salvaged from a pasted prompt,
 * so callers can surface a visible warning instead of silently swapping in
 * the shortened text.
 */
export function sanitizeRetryNotes(notes: string): SanitizedRetryNotes {
  const input = notes.trim();
  if (!input) return { notes: input, trimmed: false };
  if (!looksLikePastedGenerationPrompt(input)) return { notes: input, trimmed: false };

  const markers = [...input.matchAll(CREATIVE_DIRECTION_MARKER_RE)];
  if (markers.length > 0) {
    const last = markers[markers.length - 1];
    const tail = input.slice((last.index ?? 0) + last[0].length).trim();
    if (tail) return { notes: tail, trimmed: true };
  }

  throw new Error(
    'These notes look like a full generation prompt. Paste only short creative-direction notes — '
    + 'the board layout and rules are added automatically.',
  );
}

/**
 * Select the prompt used for a review-image retry.
 *
 * `freshBasePrompt` is always a rebuild from the CURRENT template + manifest
 * (same buildReplacementPrompt machinery 'replace' uses), just with the
 * theme's own creative direction instead of user notes — see
 * themeService.retryThemeImage. This is what makes 'retry' mean "reroll the
 * CURRENT contract": a board generated before a prompt-template fix (e.g. a
 * margin/geometry rule added in a later release) picks up that fix on its
 * very next retry instead of replaying whatever template was current when it
 * was first generated. 'augment' appends the user's notes onto that same
 * fresh base, so a revision request also benefits from any template fixes.
 * 'replace' is the one mode that intentionally swaps the creative direction
 * itself for the user's notes (`replacementPrompt`).
 *
 * Because a fresh base is always constructible from the manifest, 'retry' can
 * no longer fail with "no saved prompt" — that error is gone.
 *
 * 'custom' is the power-user escape hatch: the notes ARE the entire
 * generation prompt, verbatim, with no board/cell template and no
 * creative-direction wrapper. `freshBasePrompt`/`replacementPrompt` are
 * ignored in this mode — the caller (retryThemeImage) still builds them
 * unconditionally since that's cheap string composition, but they play no
 * role in what gets sent to the image provider.
 */
export function selectThemeImageRetryPrompt(
  freshBasePrompt: string,
  replacementPrompt: string,
  feedback: string,
  mode: ThemeImageRetryMode,
): string {
  if (mode === 'retry') return freshBasePrompt;

  const notes = feedback.trim();
  if (mode === 'custom') {
    if (!notes) throw new Error('Custom mode needs a prompt.');
    return notes;
  }
  if (!notes) throw new Error('Add retry instructions before generating a replacement.');
  return mode === 'augment'
    ? `${freshBasePrompt}\n\nREVISION NOTES — correct the previous result:\n${notes}`
    : replacementPrompt;
}
