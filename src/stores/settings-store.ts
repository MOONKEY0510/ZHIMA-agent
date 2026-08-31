import { create } from "zustand";
import { LazyStore } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ThemeMode } from "../types";

/**
 * Non-sensitive UI preferences (plan §2.1: ordinary settings in store/JSON).
 * Provider configuration lives on the Rust side (`providers.json`), and API
 * keys live in the Windows Credential Manager — neither is handled here.
 */
export const uiPrefsStore = new LazyStore("settings.json");

/** localStorage mirror key — used for instant theme application on boot
 *  before the Tauri plugin store has loaded. */
const THEME_LS_KEY = "cf:theme";

const THEME_KEY = "theme";
const HIDE_ON_BLUR_KEY = "hideOnBlur";
const AVATAR_KEY = "aiAvatar";
const AVATAR_COLOR_KEY = "aiAvatarColor";
const USER_AVATAR_KEY = "userAvatar";
const USER_AVATAR_COLOR_KEY = "userAvatarColor";
const PRESETS_KEY = "promptPresets";
const ENABLE_TOOLS_KEY = "enableTools";
const ENABLE_THINKING_KEY = "enableThinking";
const THINKING_EFFORT_KEY = "thinkingEffort";

export const THINKING_EFFORTS = ["low", "medium", "high", "max"] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];

/** A user-customizable quick command triggered by typing `/` in the composer. */
export interface PromptPreset {
  id: string;
  name: string;
  command: string;
  content: string;
}

/** Built-in presets shipped with the app; used on first launch or reset. */
export const DEFAULT_PRESETS: PromptPreset[] = [
  { id: "translate", name: "翻译", command: "/翻译", content: "请将以下内容翻译为中文。如果已经是中文，则翻译为英文：" },
  { id: "summarize", name: "总结", command: "/总结", content: "请用简洁的中文总结以下内容的核心要点，分条列出：" },
  { id: "review", name: "代码审查", command: "/审查", content: "请审查以下代码，指出潜在问题、安全风险和改进建议：" },
  { id: "explain", name: "解释", command: "/解释", content: "请用通俗易懂的方式解释以下内容：" },
  { id: "polish", name: "润色", command: "/润色", content: "请润色以下文字，使其更加流畅自然，保持原意不变：" },
];

function resolvedTheme(mode: ThemeMode): string {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return mode;
}

function applyTheme(mode: ThemeMode) {
  document.documentElement.dataset.theme = resolvedTheme(mode);
}

/** Preset avatar shapes. */
export const AVATAR_SHAPES = [
  "circle",
  "rounded",
  "square",
] as const;

export type AvatarShape = (typeof AVATAR_SHAPES)[number];

/** Preset avatar colors (background for the AI avatar). */
export const AVATAR_COLORS = [
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#f59e0b",
  "#10b981",
  "#06b6d4",
  "#ef4444",
  "#64748b",
] as const;

interface SettingsState {
  theme: ThemeMode;
  hideOnBlur: boolean;
  aiAvatar: AvatarShape;
  aiAvatarColor: string;
  aiAvatarImage: string; // convertFileSrc URL or ""
  userAvatar: AvatarShape;
  userAvatarColor: string;
  userAvatarImage: string; // convertFileSrc URL or ""
  backgroundImage: string; // convertFileSrc URL or ""
  presets: PromptPreset[];
  /** Whether the Agent tool button starts enabled on each new conversation. */
  defaultEnableTools: boolean;
  /** Whether reasoning models expose their thinking trace by default. */
  defaultEnableThinking: boolean;
  /** Default depth for a model's reasoning pass. */
  defaultThinkingEffort: ThinkingEffort;
  loaded: boolean;
  load: () => Promise<void>;
  setTheme: (theme: ThemeMode) => Promise<void>;
  setHideOnBlur: (value: boolean) => Promise<void>;
  setAiAvatar: (shape: AvatarShape) => Promise<void>;
  setAiAvatarColor: (color: string) => Promise<void>;
  setAiAvatarImage: (data: string | null) => Promise<void>;
  setUserAvatar: (shape: AvatarShape) => Promise<void>;
  setUserAvatarColor: (color: string) => Promise<void>;
  setUserAvatarImage: (data: string | null) => Promise<void>;
  setBackgroundImage: (data: string | null) => Promise<void>;
  setPresets: (presets: PromptPreset[]) => Promise<void>;
  setDefaultEnableTools: (value: boolean) => Promise<void>;
  setDefaultEnableThinking: (value: boolean) => Promise<void>;
  setDefaultThinkingEffort: (value: ThinkingEffort) => Promise<void>;
}

/** Fetch the avatar file path from Rust and convert to a displayable URL. */
async function loadAvatarUrl(kind: "ai" | "user" | "background"): Promise<string> {
  try {
    const path = await invoke<string>("get_avatar_path", { kind });
    return path ? convertFileSrc(path) : "";
  } catch {
    return "";
  }
}

export const useSettingsStore = create<SettingsState>((set) => ({
  theme: "system",
  hideOnBlur: true,
  aiAvatar: "circle",
  aiAvatarColor: AVATAR_COLORS[0],
  aiAvatarImage: "",
  userAvatar: "circle",
  userAvatarColor: AVATAR_COLORS[5],
  userAvatarImage: "",
  backgroundImage: "",
  presets: DEFAULT_PRESETS,
  defaultEnableTools: false,
  defaultEnableThinking: true,
  defaultThinkingEffort: "medium",
  loaded: false,

  load: async () => {
    let theme: ThemeMode | null | undefined = null;
    let hideOnBlur: boolean | null | undefined = null;
    let avatar: AvatarShape | null | undefined = null;
    let avatarColor: string | null | undefined = null;
    let userAvatar: AvatarShape | null | undefined = null;
    let userAvatarColor: string | null | undefined = null;
    let presets: PromptPreset[] | null | undefined = null;
    let enableTools: boolean | null | undefined = null;
    let enableThinking: boolean | null | undefined = null;
    let thinkingEffort: ThinkingEffort | null | undefined = null;

    try {
      [
        theme,
        hideOnBlur,
        avatar,
        avatarColor,
        userAvatar,
        userAvatarColor,
        presets,
        enableTools,
        enableThinking,
        thinkingEffort,
      ] = await Promise.all([
        uiPrefsStore.get<ThemeMode | null>(THEME_KEY),
        uiPrefsStore.get<boolean | null>(HIDE_ON_BLUR_KEY),
        uiPrefsStore.get<AvatarShape | null>(AVATAR_KEY),
        uiPrefsStore.get<string | null>(AVATAR_COLOR_KEY),
        uiPrefsStore.get<AvatarShape | null>(USER_AVATAR_KEY),
        uiPrefsStore.get<string | null>(USER_AVATAR_COLOR_KEY),
        uiPrefsStore.get<PromptPreset[] | null>(PRESETS_KEY),
        uiPrefsStore.get<boolean | null>(ENABLE_TOOLS_KEY),
        uiPrefsStore.get<boolean | null>(ENABLE_THINKING_KEY),
        uiPrefsStore.get<ThinkingEffort | null>(THINKING_EFFORT_KEY),
      ]);
    } catch {
      // Browser-only Vite previews do not expose the Tauri plugin store.
      try {
        theme = localStorage.getItem(THEME_LS_KEY) as ThemeMode | null;
      } catch {
        theme = null;
      }
    }

    const mode: ThemeMode = theme ?? "system";
    try {
      localStorage.setItem(THEME_LS_KEY, mode);
    } catch {
      // localStorage may be unavailable; ignore.
    }
    applyTheme(mode);

    // Follow OS-level theme changes while in "system" mode.
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        if (useSettingsStore.getState().theme === "system") {
          applyTheme("system");
        }
      });

    // Load custom avatar images (if any).
    const [aiImg, userImg, backgroundImg] = await Promise.all([
      loadAvatarUrl("ai"),
      loadAvatarUrl("user"),
      loadAvatarUrl("background"),
    ]);

    set({
      theme: mode,
      hideOnBlur: hideOnBlur ?? true,
      aiAvatar: avatar ?? "circle",
      aiAvatarColor: avatarColor ?? AVATAR_COLORS[0],
      aiAvatarImage: aiImg,
      userAvatar: userAvatar ?? "circle",
      userAvatarColor: userAvatarColor ?? AVATAR_COLORS[5],
      userAvatarImage: userImg,
      backgroundImage: backgroundImg,
      presets: presets ?? DEFAULT_PRESETS,
      defaultEnableTools: enableTools ?? false,
      defaultEnableThinking: enableThinking ?? true,
      defaultThinkingEffort: THINKING_EFFORTS.includes(thinkingEffort ?? "medium")
        ? thinkingEffort ?? "medium"
        : "medium",
      loaded: true,
    });
  },

  setTheme: async (theme) => {
    applyTheme(theme);
    set({ theme });
    try {
      localStorage.setItem(THEME_LS_KEY, theme);
    } catch {
      // localStorage may be unavailable; the in-memory theme still applies.
    }
    try {
      await uiPrefsStore.set(THEME_KEY, theme);
      await uiPrefsStore.save();
    } catch {
      // Browser-only Vite previews have no Tauri plugin store.
    }
  },

  setHideOnBlur: async (value) => {
    await uiPrefsStore.set(HIDE_ON_BLUR_KEY, value);
    await uiPrefsStore.save();
    set({ hideOnBlur: value });
  },

  setAiAvatar: async (shape) => {
    await uiPrefsStore.set(AVATAR_KEY, shape);
    await uiPrefsStore.save();
    set({ aiAvatar: shape });
  },

  setAiAvatarColor: async (color) => {
    await uiPrefsStore.set(AVATAR_COLOR_KEY, color);
    await uiPrefsStore.save();
    set({ aiAvatarColor: color });
  },

  setAiAvatarImage: async (data) => {
    if (data === null) {
      await invoke("delete_avatar", { kind: "ai" });
      set({ aiAvatarImage: "" });
    } else {
      await invoke("save_avatar", { kind: "ai", data });
      const url = await loadAvatarUrl("ai");
      set({ aiAvatarImage: url });
    }
  },

  setUserAvatar: async (shape) => {
    await uiPrefsStore.set(USER_AVATAR_KEY, shape);
    await uiPrefsStore.save();
    set({ userAvatar: shape });
  },

  setUserAvatarColor: async (color) => {
    await uiPrefsStore.set(USER_AVATAR_COLOR_KEY, color);
    await uiPrefsStore.save();
    set({ userAvatarColor: color });
  },

  setUserAvatarImage: async (data) => {
    if (data === null) {
      await invoke("delete_avatar", { kind: "user" });
      set({ userAvatarImage: "" });
    } else {
      await invoke("save_avatar", { kind: "user", data });
      const url = await loadAvatarUrl("user");
      set({ userAvatarImage: url });
    }
  },

  setBackgroundImage: async (data) => {
    if (data === null) {
      await invoke("delete_avatar", { kind: "background" });
      set({ backgroundImage: "" });
    } else {
      await invoke("save_avatar", { kind: "background", data });
      const url = await loadAvatarUrl("background");
      set({ backgroundImage: url });
    }
  },

  setPresets: async (presets) => {
    await uiPrefsStore.set(PRESETS_KEY, presets);
    await uiPrefsStore.save();
    set({ presets });
  },

  setDefaultEnableTools: async (value) => {
    await uiPrefsStore.set(ENABLE_TOOLS_KEY, value);
    await uiPrefsStore.save();
    set({ defaultEnableTools: value });
  },

  setDefaultEnableThinking: async (value) => {
    await uiPrefsStore.set(ENABLE_THINKING_KEY, value);
    await uiPrefsStore.save();
    set({ defaultEnableThinking: value });
  },

  setDefaultThinkingEffort: async (value) => {
    await uiPrefsStore.set(THINKING_EFFORT_KEY, value);
    await uiPrefsStore.save();
    set({ defaultThinkingEffort: value });
  },
}));
