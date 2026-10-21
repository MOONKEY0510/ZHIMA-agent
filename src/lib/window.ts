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

  let from: { width: number; height: number } | null = null;
  try {
    const current = (await win.innerSize()).toLogical(await win.scaleFactor());
    if (
      Math.abs(current.width - target.width) < 1 &&
      Math.abs(current.height - target.height) < 1
    ) {
      return;
    }
    from = current;
  } catch {
    // Size read failed; fall through and set it anyway.
  }

  await animateSize(win, from, target);
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

/**
 * Glide from the current size to the target through an ease-in-out timeline
 * of keyframes, applied on a dedicated Rust thread (see the `animate_size`
 * command).  Width and height animate together so the quick ↔ full-mode
 * transition reads as one smooth morph instead of a snap-plus-stretch.
 *
 * Keyframes are in logical size on the JS side and converted to physical
 * pixels for the backend, which keeps the thread's work in the same unit the
 * window API expects.
 */
async function animateSize(
  win: ReturnType<typeof getCurrentWindow>,
  from: { width: number; height: number } | null,
  target: { width: number; height: number },
): Promise<void> {
  if (!from) {
    await win.setSize(new LogicalSize(target.width, target.height));
    return;
  }

  const dw = target.width - from.width;
  const dh = target.height - from.height;
  if (Math.abs(dw) < 2 && Math.abs(dh) < 3) return;

  let scale = 1;
  try {
    scale = await win.scaleFactor();
  } catch {
    // Assume 1x if the factor cannot be read.
  }

  const span = Math.hypot(dw, dh);
  const duration = Math.round(Math.min(360, Math.max(160, 140 + span * 0.22)));
  // ~60 fps worth of keyframes; the backend interpolates inside each gap.
  const steps = Math.max(2, Math.round(duration / 16));
  const frames: Array<{ width: number; height: number; ms: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const eased = easeInOutCubic(t);
    frames.push({
      width: Math.max(1, Math.round((from.width + dw * eased) * scale)),
      height: Math.max(1, Math.round((from.height + dh * eased) * scale)),
      ms: Math.round(t * duration),
    });
  }

  try {
    await invoke("animate_size", { frames });
  } catch {
    // Command missing or failed — land on the target instead of being stuck.
    await win.setSize(new LogicalSize(target.width, target.height));
  }
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
