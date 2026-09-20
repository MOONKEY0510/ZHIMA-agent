import { create } from "zustand";

export type View = "chat" | "image" | "settings";

interface WindowState {
  view: View;
  /**
   * Full conversation mode (plan §3.2): history sidebar + larger window.
   * When off, the window stays in the compact floating form.
   */
  fullMode: boolean;
  /**
   * The composer's Agent-tools panel is open.  It needs room above the
   * composer, so the window grows while it is visible (and shrinks back when
   * it closes) instead of clipping the panel in the compact window.
   */
  composerPanelOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  switchToImage: () => void;
  switchToChat: () => void;
  toggleFullMode: () => void;
  setFullMode: (value: boolean) => void;
  setComposerPanelOpen: (value: boolean) => void;
}

export const useWindowStore = create<WindowState>((set, get) => ({
  view: "chat",
  fullMode: false,
  composerPanelOpen: false,

  openSettings: () => set({ view: "settings" }),
  closeSettings: () => set({ view: "chat" }),
  // Image mode always starts in full mode so the generation-history sidebar
  // is visible immediately.
  switchToImage: () => set({ view: "image", fullMode: true }),
  switchToChat: () => set({ view: "chat" }),
  toggleFullMode: () => set({ fullMode: !get().fullMode }),
  setFullMode: (value) => set({ fullMode: value }),
  setComposerPanelOpen: (value) => set({ composerPanelOpen: value }),
}));
