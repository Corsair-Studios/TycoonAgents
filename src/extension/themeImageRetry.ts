export type ThemeImageRetryMode = 'augment' | 'replace' | 'retry';

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
