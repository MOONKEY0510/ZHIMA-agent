import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyBackupPreferences } from "../BackupSettings";
import { useSettingsStore } from "../../../stores/settings-store";

vi.mock("../BackupPanel", () => ({ BackupPanel: () => null }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ LazyStore: class {} }));

const setTheme = vi.fn().mockResolvedValue(undefined);
const setPresets = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ setTheme, setPresets });
});

describe("backup UI preference integration", () => {
  it.each(["paper", "paper-dark"])("restores the supported %s theme", async (theme) => {
    await applyBackupPreferences({ theme });
    expect(setTheme).toHaveBeenCalledWith(theme);
  });

  it("sanitizes desktop actions before restoring presets", async () => {
    await applyBackupPreferences({ presets: [{
      id: "a", name: "动作", command: "/a", content: "模板", secret: "must-not-survive",
      desktopAction: { source: "clipboard", template: "{{input}}", output: "copy", skillIds: [], command: "do-not-run" },
    }] });
    expect(setPresets).toHaveBeenCalledWith([{
      id: "a", name: "动作", command: "/a", content: "模板",
      desktopAction: { source: "clipboard", template: "{{input}}", output: "copy", skillIds: [] },
    }]);
  });

  it("propagates preference persistence failures", async () => {
    setTheme.mockRejectedValueOnce(new Error("disk full"));
    await expect(applyBackupPreferences({ theme: "dark" })).rejects.toThrow("disk full");
  });
});
