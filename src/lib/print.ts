/**
 * "Print → save as PDF" export (P1-11.3).
 *
 * The conversation list is virtualised, so only the visible rows exist in the
 * DOM.  Before opening the system print dialog we flip a flag that makes the
 * list render every row, then print, then restore.  A dedicated `@media print`
 * stylesheet hides the app chrome (title bar, sidebar, composer).
 */

let printing = false;
const listeners = new Set<() => void>();

export function isPrinting(): boolean {
  return printing;
}

export function subscribePrinting(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setPrinting(value: boolean): void {
  if (printing === value) return;
  printing = value;
  for (const listener of listeners) listener();
}

/**
 * Run `task` with every message rendered.  Image export uses this so a long
 * conversation is not captured half-empty (the list is virtualised).
 */
export async function withExpandedList<T>(task: () => Promise<T>): Promise<T> {
  setPrinting(true);
  // Give React a tick to mount the extra rows.
  await new Promise((resolve) => window.setTimeout(resolve, 300));
  try {
    return await task();
  } finally {
    setPrinting(false);
  }
}

/** Render every message, open the print dialog, then restore the list. */
export function printConversation(): void {
  setPrinting(true);
  const cleanup = () => {
    window.removeEventListener("afterprint", cleanup);
    setPrinting(false);
  };
  window.addEventListener("afterprint", cleanup);

  // One frame for React to mount the expanded rows before printing.
  window.setTimeout(() => {
    window.print();
    // Safety net: some webviews never fire `afterprint`.
    window.setTimeout(cleanup, 5000);
  }, 300);
}
