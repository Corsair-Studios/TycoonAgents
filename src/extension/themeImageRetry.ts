export type ThemeImageRetryMode = 'augment' | 'replace' | 'retry';

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

/**
 * Guard against retry-notes snowballing: if a user pastes a full saved
 * generation prompt (or something that looks like one) into the retry notes
 * box, salvage just the trailing creative-direction text instead of letting
 * the whole nested prompt get embedded verbatim into the next prompt. Every
 * prompt builder appends `Creative direction: ${creativeDirection}` with no
 * cap, so an unfiltered paste grows and contradicts itself on each retry.
 */
export function sanitizeRetryNotes(notes: string): string {
  const trimmed = notes.trim();
  if (!trimmed) return trimmed;
  if (!looksLikePastedGenerationPrompt(trimmed)) return trimmed;

  const markers = [...trimmed.matchAll(CREATIVE_DIRECTION_MARKER_RE)];
  if (markers.length > 0) {
    const last = markers[markers.length - 1];
    const tail = trimmed.slice((last.index ?? 0) + last[0].length).trim();
    if (tail) return tail;
  }

  throw new Error(
    'These notes look like a full generation prompt. Paste only short creative-direction notes — '
    + 'the board layout and rules are added automatically.',
  );
}

/** Select the prompt used for a review-image retry. */
export function selectThemeImageRetryPrompt(
  savedPrompt: string | undefined,
  replacementPrompt: string,
  feedback: string,
  mode: ThemeImageRetryMode,
): string {
  if (mode === 'retry') {
    if (!savedPrompt?.trim()) {
      throw new Error('This image has no saved prompt to retry. Add notes or replace the creative direction instead.');
    }
    return savedPrompt;
  }

  const notes = feedback.trim();
  if (!notes) throw new Error('Add retry instructions before generating a replacement.');
  return mode === 'augment' && savedPrompt
    ? `${savedPrompt}\n\nREVISION NOTES — correct the previous result:\n${notes}`
    : replacementPrompt;
}
