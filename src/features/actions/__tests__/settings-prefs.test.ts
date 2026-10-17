import { beforeEach, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => ({ get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined), save: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-store", () => ({ LazyStore: class { get = storage.get; set = storage.set; save = storage.save; } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(""), convertFileSrc: vi.fn((s) => s) }));
import { exportPromptPresets, useSettingsStore } from "../../../stores/settings-store";
const legacy = { id: "old", name: "Old", command: "/old", content: "legacy body" };
const action = { id: "action", name: "Action", command: "/action", content: "compatibility", desktopAction: { source: "clipboard" as const, template: "{{input}}", assistantId: "a", skillIds: ["s"], output: "copy" as const, favorite: true } };
beforeEach(() => { vi.clearAllMocks(); });
it("persists desktop metadata under existing UI promptPresets and exports a detached allowlisted copy", async () => {
  await useSettingsStore.getState().setPresets([legacy, action]);
  expect(storage.set).toHaveBeenCalledWith("promptPresets", [legacy, action]);
  expect(storage.save).toHaveBeenCalledOnce();
  const exported = exportPromptPresets();
  expect(exported).toEqual([legacy, action]);
  exported[1].desktopAction!.skillIds.push("mutation");
  expect(useSettingsStore.getState().presets[1].desktopAction!.skillIds).toEqual(["s"]);
});
it("preserves in-memory presets if persistence fails", async () => {
  useSettingsStore.setState({ presets: [legacy] });
  storage.save.mockRejectedValueOnce(new Error("fixture save failure"));
  await expect(useSettingsStore.getState().setPresets([action])).rejects.toThrow("fixture save failure");
  expect(useSettingsStore.getState().presets).toEqual([legacy]);
});
