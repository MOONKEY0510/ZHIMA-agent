import { currentMonitor, getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

/** Width of the compact floating window in logical pixels. */
export const WINDOW_WIDTH = 560;
/** Compact "quick ask" height. */
export const QUICK_HEIGHT = 260;
/** Upper bound for the expanded height when the monitor is unknown. */
const FALLBACK_EXPANDED_HEIGHT = 560;
/** Full conversation mode (plan §3.2) target size. */
const FULL_WIDTH = 980;
const FULL_HEIGHT = 660;

type HideHandler = () => void;
let hideHandler: HideHandler | null = null;

/**
 * Register the animated dismiss routine.
 *
 * `App` owns it because the exit animation lives in React (react-spring drives
 * transform/opacity and then reports back).  Everything else should dismiss via
 * `requestHide()` so the animation is never bypassed by accident.
 */
export function setHideHandler(fn: HideHandler | null): () => void {
  hideHandler = fn;
  return () => {
    if (hideHandler === fn) hideHandler = null;
  };
}

/**
 * Ask for the window to be dismissed.  Plays the exit animation when one is
 * registered; falls back to hiding immediately when it is not.
 */
export function requestHide(): void {
  if (hideHandler) hideHandler();
  else void hideWindow();
}

/**
 * Save the window position and hide it right away, skipping the animation.
 *
 * Routed through the `finish_hide` command rather than the window API so the
 * backend can also clear its safety timer — otherwise it would fire a redundant
 * hide a moment later.
 */
export async function hideWindow(): Promise<void> {
  try {
    const win = getCurrentWindow();
    const pos = await win.outerPosition();
    await invoke("save_window_position", { x: pos.x, y: pos.y });
  } catch {
    // Position saving is best-effort; don't block hide on failure.
  }
  await invoke("finish_hide");
}

/** Minimise the floating window to the taskbar. */
export async function minimizeWindow(): Promise<void> {
  await getCurrentWindow().minimize();
}

/**
 * Apply the window size for the current mode:
 * - quick mode: small composer-only window;
 * - expanded chat: grows downward, capped at 70% of the screen (plan §3.1 C);
 * - full mode: wide layout with history sidebar, clamped to the monitor.
 *
 * Only fires when the size actually changes: resizing a transparent WebView2
 * window reallocates its compositor surface, and doing that while the entry
 * animation is settling would cost frames for no reason.
 */
export async function syncWindowSize(expanded: boolean, full = false): Promise<void> {
  const win = getCurrentWindow();

  const target = await resolveSize(expanded, full);

  try {
    const current = (await win.innerSize()).toLogical(await win.scaleFactor());
    if (
      Math.abs(current.width - target.width) < 1 &&
      Math.abs(current.height - target.height) < 1
    ) {
      return;
    }
  } catch {
    // Size read failed; fall through and set it anyway.
  }

  await win.setSize(new LogicalSize(target.width, target.height));
}

async function resolveSize(
  expanded: boolean,
  full: boolean,
): Promise<{ width: number; height: number }> {
  if (!expanded) return { width: WINDOW_WIDTH, height: QUICK_HEIGHT };

  let maxHeight = FALLBACK_EXPANDED_HEIGHT;
  let maxWidth = FULL_WIDTH;
  try {
    const monitor = await currentMonitor();
    if (monitor) {
      const logical = monitor.size.toLogical(monitor.scaleFactor);
      maxHeight = Math.round(logical.height * 0.7);
      maxWidth = Math.round(logical.width * 0.85);
    }
  } catch {
    // Keep the fallback size.
  }

  if (full) {
    return {
      width: Math.min(FULL_WIDTH, maxWidth),
      height: Math.min(FULL_HEIGHT, maxHeight),
    };
  }
  return { width: WINDOW_WIDTH, height: Math.min(FALLBACK_EXPANDED_HEIGHT, maxHeight) };
}
