/**
 * Spring presets for the "water" show / hide transition.
 *
 * The shell animates as a single body — opacity, vertical drift, scale and a
 * resolving blur all move together — so the window reads as one mass of water
 * surfacing, rather than a set of parts arriving one after another.  Every
 * value maps onto `opacity`, `transform` or `filter`, which keeps the whole
 * transition on the compositor.
 */

/**
 * Entry: water seeping up out of the desktop.
 *
 * Deliberately underdamped (ζ ≈ 0.69): the panel drifts a few percent past its
 * resting size and rocks back, which is the "water settles after spilling"
 * beat.  Never clamped — that overshoot is the entire effect.
 */
export const WATER_RISE = { mass: 1, tension: 235, friction: 21, clamp: false };

/**
 * Exit: the same water being sucked back down.  Faster and heavier than the
 * entry, and clamped: an overshoot on the way out would bounce the panel back
 * up instead of letting it fall away.
 */
export const WATER_SINK = { mass: 0.5, tension: 380, friction: 26, clamp: true };

/**
 * Blur rides its own spring because it cannot be allowed to overshoot — a
 * negative blur radius is invalid CSS.  It tracks the entry's timing closely
 * enough to feel like one motion rather than two.
 */
export const WATER_SHARPEN = { mass: 0.8, tension: 260, friction: 26, clamp: true };

/** Decorative bottom ripple that spreads once the water has landed. */
export const WATER_RIPPLE = { mass: 1.2, tension: 200, friction: 30, clamp: false, delay: 40 };

/**
 * The header and body keep a few pixels of lead / lag on top of the shell's
 * own travel.  The shell still owns opacity, scale and blur, so the window
 * arrives as one body; this only stops it reading as a rigid plate.
 */
export const WATER_HEAD = { mass: 0.9, tension: 250, friction: 21, clamp: false };
export const WATER_TAIL = { mass: 1.1, tension: 205, friction: 23, clamp: false, delay: 45 };

/** Extra drift the header and body add on top of the shell's motion. */
export const HEAD_NUDGE_PX = 5;
export const TAIL_NUDGE_PX = 7;

/** How far below its resting place the window surfaces from, in CSS pixels. */
export const ENTRY_RISE_PX = 12;
/** How far it falls as it is drawn back down. */
export const EXIT_SINK_PX = 20;
/** Entry / exit scale: the water spreads as it rises, contracts as it sinks. */
export const ENTRY_SCALE = 0.955;
export const EXIT_SCALE = 0.92;
/** Blur radius the shell resolves from as the window sharpens into focus. */
export const ENTRY_BLUR_PX = 4;

/**
 * How long the exit is allowed to run before the window is hidden outright.
 *
 * Springs are asymptotic: they are visually finished long before `onRest`
 * fires, and waiting for that last fraction of a pixel left the window sitting
 * on screen doing nothing.  Hiding on a schedule keeps dismissals crisp; the
 * spring simply gets cut off during its final, imperceptible settle.
 */
export const EXIT_HIDE_MS = 160;
