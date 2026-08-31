import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { animated, to, useSpring } from "@react-spring/web";
import { TitleBar } from "../components/window-shell/TitleBar";
import { Composer } from "../components/composer/Composer";
import { MessageList } from "../components/conversation/MessageList";
import { HistorySidebar } from "../components/history/HistorySidebar";
import { ImageHistorySidebar } from "../components/history/ImageHistorySidebar";
const SettingsPanel = lazy(() => import("../features/settings/SettingsPanel").then((m) => ({ default: m.SettingsPanel })));
const ImageGenView = lazy(() => import("../features/imagegen/ImageGenView").then((m) => ({ default: m.ImageGenView })));
const UpdateBanner = lazy(() => import("../components/updater/UpdateBanner").then((m) => ({ default: m.UpdateBanner })));
import { useChatStore } from "../stores/chat-store";
import { useSettingsStore } from "../stores/settings-store";
import { useProvidersStore } from "../stores/providers-store";
import { useHistoryStore } from "../services/history-store";
import { useImageGenStore } from "../stores/imagegen-store";
import { useWindowStore } from "../stores/window-store";
import { startStreamListener, stopStreamListener } from "../services/stream-events";
import { hideWindow, requestHide, setHideHandler, syncWindowSize } from "../lib/window";
import {
  ENTRY_BLUR_PX,
  ENTRY_RISE_PX,
  ENTRY_SCALE,
  EXIT_HIDE_MS,
  EXIT_SCALE,
  EXIT_SINK_PX,
  HEAD_NUDGE_PX,
  TAIL_NUDGE_PX,
  WATER_HEAD,
  WATER_RIPPLE,
  WATER_RISE,
  WATER_SHARPEN,
  WATER_SINK,
  WATER_TAIL,
} from "../lib/motion";

/** The pose the window surfaces from, and the one it sinks back to. */
const HIDDEN_POSE = {
  opacity: 0,
  y: ENTRY_RISE_PX,
  scale: ENTRY_SCALE,
  blur: ENTRY_BLUR_PX,
};

export default function App() {
  const view = useWindowStore((s) => s.view);
  const fullMode = useWindowStore((s) => s.fullMode);
  const openSettings = useWindowStore((s) => s.openSettings);
  const hasMessages = useChatStore((s) => s.messages.length > 0);
  const loaded = useSettingsStore((s) => s.loaded);
  const providersLoaded = useProvidersStore((s) => s.loaded);
  const providerCount = useProvidersStore((s) => s.providers.length);
  const hideOnBlur = useSettingsStore((s) => s.hideOnBlur);
  const backgroundImage = useSettingsStore((s) => s.backgroundImage);

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const lastShownAt = useRef(0);

  // Chat view is "expanded" as soon as a conversation exists or full mode is on.
  const expandedNow = view === "settings" || fullMode || hasMessages;

  /* --- Water transition ---------------------------------------------------
   * One spring drives the whole shell — opacity, drift, scale and blur move
   * as a single body, so the window surfaces like a mass of water instead of
   * assembling itself out of separately-arriving parts.  The header and body
   * then add a few pixels of lead / lag (see WATER_HEAD / WATER_TAIL) so the
   * surface flows; they deliberately own no opacity or scale of their own.
   *
   * The shell is driven imperatively rather than declaratively: every entry
   * has to restart from the same hidden pose (`from`), which a declarative
   * `to: { opacity: shown ? 1 : 0 }` cannot express once the exit needs to
   * hold a different set of targets.
   */
  const [shown, setShown] = useState(false);
  // Frosted glass is only enabled once the motion has settled: `backdrop-filter`
  // is expensive to composite and would cost frames during the flight.
  const [settled, setSettled] = useState(false);
  const shownRef = useRef(false);
  const everShown = useRef(false);
  shownRef.current = shown;

  const reducedMotion = useRef(false);
  useEffect(() => {
    reducedMotion.current =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  useEffect(() => {
    if (!shown) setSettled(false);
  }, [shown]);

  const [shell, shellApi] = useSpring(() => ({
    ...HIDDEN_POSE,
    config: WATER_RISE,
  }));

  useEffect(() => {
    if (shown) {
      shellApi.start({
        from: HIDDEN_POSE,
        to: { opacity: 1, y: 0, scale: 1, blur: 0 },
        config: (key) => (key === "blur" ? WATER_SHARPEN : WATER_RISE),
        immediate: reducedMotion.current,
        onRest: () => {
          if (shownRef.current) setSettled(true);
        },
      });
      return;
    }
    if (!everShown.current) return;
    shellApi.start({
      to: { opacity: 0, y: EXIT_SINK_PX, scale: EXIT_SCALE, blur: 0 },
      config: (key) => (key === "blur" ? WATER_SHARPEN : WATER_SINK),
      immediate: reducedMotion.current,
    });
  }, [shown, shellApi]);

  // Hide on a schedule instead of waiting for the spring to come to a complete
  // stop — see EXIT_HIDE_MS.  Cancelled if the window is re-shown before it
  // fires, so a fast re-open never gets yanked off screen mid-entry.
  useEffect(() => {
    if (shown || !everShown.current) return;
    const timer = window.setTimeout(() => void hideWindow(), EXIT_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [shown]);

  /* A few pixels of lead / lag layered on top of the shell.  These carry
   * translation only — opacity, scale and blur stay with the shell, so the
   * window still reads as one body of water rather than separate parts
   * arriving on their own schedules. */
  const head = useSpring({
    y: shown ? 0 : HEAD_NUDGE_PX,
    config: shown ? WATER_HEAD : WATER_SINK,
    immediate: reducedMotion.current,
  });

  const tail = useSpring({
    y: shown ? 0 : TAIL_NUDGE_PX,
    config: shown ? WATER_TAIL : WATER_SINK,
    immediate: reducedMotion.current,
  });

  /** Aurora ripple along the bottom edge, spreading once the water lands. */
  const ripple = useSpring({
    scaleX: shown ? 1 : 0,
    config: WATER_RIPPLE,
    immediate: reducedMotion.current,
  });

  // Startup: load settings/providers/history and start the stream bridge.
  useEffect(() => {
    void useSettingsStore.getState().load();
    void useProvidersStore.getState().load();
    void useHistoryStore.getState().load();
    void useImageGenStore.getState().load();
    void startStreamListener();
    return () => stopStreamListener();
  }, []);

  // Track programmatic shows: the blur that immediately follows a hotkey press
  // / tray click must not trigger hide-on-blur. The same events drive the water
  // transition — the backend asks us to play the exit before it hides.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    void (async () => {
      const offShown = await listen("window-shown", () => {
        lastShownAt.current = Date.now();
        everShown.current = true;
        setShown(true);
      });
      const offPrepareHide = await listen("window-prepare-hide", () => {
        setShown(false);
      });

      if (cancelled) {
        offShown();
        offPrepareHide();
        return;
      }
      unlisteners.push(offShown, offPrepareHide);
    })();

    // Anything in the UI that wants to dismiss the window goes through
    // requestHide(), which lands here and plays the exit animation.
    unlisteners.push(setHideHandler(() => setShown(false)));

    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, []);

  // Resize the floating window when the mode changes. Settings opened from
  // full mode keep the wide window.
  useEffect(() => {
    void syncWindowSize(expandedNow, fullMode);
  }, [expandedNow, fullMode, view]);

  // First run: jump straight into settings so the user can add a provider.
  const onboarded = useRef(false);
  useEffect(() => {
    if (loaded && providersLoaded && !onboarded.current) {
      onboarded.current = true;
      if (providerCount === 0) openSettings();
    }
  }, [loaded, providersLoaded, providerCount, openSettings]);

  // Hide on blur (user-configurable), never while generating (plan §3.1 C).
  useEffect(() => {
    const onBlur = () => {
      const state = useChatStore.getState();
      const settings = useSettingsStore.getState();
      const justShown = Date.now() - lastShownAt.current < 600;
      if (
        settings.hideOnBlur &&
        state.streamingRequestId === null &&
        !justShown
      ) {
        requestHide();
      }
    };
    if (hideOnBlur) {
      window.addEventListener("blur", onBlur);
      return () => window.removeEventListener("blur", onBlur);
    }
  }, [hideOnBlur]);

  // Esc dismisses from anywhere, not just from the composer. Capture phase so
  // it wins over widget handlers, but it yields whenever something has already
  // claimed the key via `preventDefault()` — a popover closing itself on Esc
  // should not also take the whole window down with it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) requestHide();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Surface global-shortcut conflicts and other shell notices.
  useEffect(() => {
    const showToast = (message: string) => {
      setToast(message);
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => setToast(null), 4500);
    };
    const unlisteners: Array<() => void> = [];
    void listen<string>("shortcut-error", (e) => showToast(e.payload)).then(
      (u) => unlisteners.push(u),
    );
    return () => unlisteners.forEach((u) => u());
  }, []);

  return (
    <div className="cf-app relative h-screen w-screen overflow-hidden">
      <animated.div
        className={`cf-window-shell relative flex h-full w-full flex-col overflow-hidden bg-panel ${
          backgroundImage ? "cf-window-shell--custom-bg" : ""
        } ${settled ? "cf-shell--settled" : "cf-shell--in-flight"}`}
        style={{
          backgroundImage: backgroundImage ? `url("${backgroundImage}")` : undefined,
          opacity: shell.opacity,
          transform: to(
            [shell.y, shell.scale],
            (y, s) => `translateY(${y}px) scale(${s})`,
          ),
          // Resolve the shell out of a soft blur as it surfaces. Dropped
          // entirely once it is sharp, so idle frames cost nothing.
          filter: shell.blur.to((b) => (b > 0.05 ? `blur(${b}px)` : "none")),
        }}
      >
        {/* Highlight sweeping across the top edge. A wide gradient that is
            translated rather than a background-position animation, so the
            movement is composited instead of repainting every frame. */}
        <div aria-hidden="true" className="cf-sheen pointer-events-none absolute inset-x-0 top-0 z-20 h-14" />

        {/* Aurora ripple hugging the bottom edge. */}
        <animated.div
          aria-hidden="true"
          className="cf-ripple pointer-events-none absolute inset-x-0 bottom-0 z-20 h-px origin-center"
          style={{ transform: ripple.scaleX.to((x) => `scaleX(${x})`) }}
        />

        {/* Header and body ride the shell, plus a few pixels of their own so
            the surface flows instead of moving like a rigid plate.  They carry
            no opacity or scale of their own — the shell owns those. */}
        <animated.div
          className="relative z-10 shrink-0"
          style={{ transform: head.y.to((y) => `translateY(${y}px)`) }}
        >
          <TitleBar />
        </animated.div>

        <animated.div
          className="relative z-0 flex min-h-0 flex-1"
          style={{ transform: tail.y.to((y) => `translateY(${y}px)`) }}
        >
          {fullMode && view === "chat" && <HistorySidebar />}
          {fullMode && view === "image" && <ImageHistorySidebar />}

          <div className="flex min-w-0 flex-1 flex-col">
            <Suspense fallback={<div className="flex flex-1 items-center justify-center text-xs text-ink-2">正在加载…</div>}>
              {/* Keyed so each view replays its enter animation; the shell
                  itself is not re-created, only the inner content. */}
              <div key={view} className="cf-view-enter flex min-h-0 flex-1 flex-col">
                {view === "settings" ? (
                  <SettingsPanel />
                ) : view === "image" ? (
                  <ImageGenView />
                ) : (
                  <>
                    <MessageList />
                    <Composer />
                  </>
                )}
              </div>
            </Suspense>
          </div>
        </animated.div>
      </animated.div>

      {toast && (
        <div className="pointer-events-none absolute left-1/2 top-4 z-50 -translate-x-1/2 rounded-btn border border-line bg-panel-2 px-3 py-1.5 text-xs text-ink shadow-lg">
          {toast}
        </div>
      )}

      <Suspense fallback={null}>
        <UpdateBanner />
      </Suspense>
    </div>
  );
}
