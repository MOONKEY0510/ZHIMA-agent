import { BackupPanel } from "./BackupPanel";
import type { BackupUiPreferences } from "../../services/backup-api";
import { useSettingsStore, exportPromptPresets } from "../../stores/settings-store";
import { sanitizePresets } from "../actions/desktop-actions";
import { useProvidersStore } from "../../stores/providers-store";
import { DIAGRAM_STYLES, type DiagramStyle } from "../../lib/mermaid-theme";
import type { ThemeMode } from "../../types";

export async function applyBackupPreferences(prefs: BackupUiPreferences): Promise<void> {
  const settings = useSettingsStore.getState();
  const themes: ThemeMode[] = ["system", "light", "dark", "paper", "paper-dark", "warm", "rose", "spring"];
  if (typeof prefs.theme === "string" && themes.includes(prefs.theme as ThemeMode)) {
    await settings.setTheme(prefs.theme as ThemeMode);
  }
  if (typeof prefs.hideOnBlur === "boolean") await settings.setHideOnBlur(prefs.hideOnBlur);
  if (prefs.aiAvatar === "circle" || prefs.aiAvatar === "rounded" || prefs.aiAvatar === "square") {
    await settings.setAiAvatar(prefs.aiAvatar);
  }
  if (prefs.userAvatar === "circle" || prefs.userAvatar === "rounded" || prefs.userAvatar === "square") {
    await settings.setUserAvatar(prefs.userAvatar);
  }
  if (typeof prefs.aiAvatarColor === "string" && /^#[0-9a-f]{6}$/i.test(prefs.aiAvatarColor)) {
    await settings.setAiAvatarColor(prefs.aiAvatarColor);
  }
  if (typeof prefs.userAvatarColor === "string" && /^#[0-9a-f]{6}$/i.test(prefs.userAvatarColor)) {
    await settings.setUserAvatarColor(prefs.userAvatarColor);
  }
  if (typeof prefs.defaultEnableTools === "boolean") await settings.setDefaultEnableTools(prefs.defaultEnableTools);
  if (typeof prefs.defaultEnableThinking === "boolean") await settings.setDefaultEnableThinking(prefs.defaultEnableThinking);
  if (["low", "medium", "high", "max"].includes(String(prefs.defaultThinkingEffort))) {
    await settings.setDefaultThinkingEffort(prefs.defaultThinkingEffort as "low" | "medium" | "high" | "max");
  }
  if (DIAGRAM_STYLES.includes(prefs.diagramStyle as DiagramStyle)) {
    await settings.setDiagramStyle(prefs.diagramStyle as DiagramStyle);
  }
  if (Array.isArray(prefs.presets)) {
    await settings.setPresets(sanitizePresets(prefs.presets));
  }
}

export function BackupSettings() {
  const settings = useSettingsStore();
  const uiPreferences: BackupUiPreferences = {
    theme: settings.theme,
    hideOnBlur: settings.hideOnBlur,
    aiAvatar: settings.aiAvatar,
    aiAvatarColor: settings.aiAvatarColor,
    userAvatar: settings.userAvatar,
    userAvatarColor: settings.userAvatarColor,
    defaultEnableTools: settings.defaultEnableTools,
    defaultEnableThinking: settings.defaultEnableThinking,
    defaultThinkingEffort: settings.defaultThinkingEffort,
    diagramStyle: settings.diagramStyle,
    presets: exportPromptPresets(),
  };
  return <BackupPanel uiPreferences={uiPreferences} onRestorePreferences={applyBackupPreferences}
    onConfigRestored={() => useProvidersStore.getState().load()} />;
}
