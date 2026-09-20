/**
 * Helpers for the selected-text hotkey flow (P1-5): trimming an over-long
 * capture and merging it into whatever the composer already holds.
 */

/** Selected text longer than this is truncated before it reaches the prompt. */
export const MAX_SELECTION_CHARS = 12000;

/** Long captures are trimmed so a stray full-page selection cannot flood the prompt. */
export function clampSelection(text: string): string {
  return text.length > MAX_SELECTION_CHARS ? `${text.slice(0, MAX_SELECTION_CHARS)}…` : text;
}

/**
 * Compose the composer text after a capture.
 *
 * An empty box simply receives the captured text; anything else keeps its
 * content and gets the capture appended after a blank line, so a half-written
 * prompt can be finished off with a fresh selection.  Trailing whitespace is
 * trimmed first to avoid stacking empty lines on repeated captures.
 */
export function appendCapture(current: string, captured: string): string {
  const trimmed = current.replace(/\s+$/, "");
  return trimmed.length === 0 ? captured : `${trimmed}\n\n${captured}`;
}
