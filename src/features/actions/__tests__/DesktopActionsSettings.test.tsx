import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopActionsSettings } from "../DesktopActionsSettings";
import { useSettingsStore } from "../../../stores/settings-store";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }));
const save = vi.fn(async (presets) => { useSettingsStore.setState({ presets }); });
beforeEach(() => {
  save.mockClear();
  useSettingsStore.setState({ presets: [{ id: "legacy", name: "old", command: "/old", content: "old body" }], setPresets: save });
});
afterEach(cleanup);

it("creates, edits, favorites, reorders and deletes actions without discarding slash entries", async () => {
  render(<DesktopActionsSettings />);
  fireEvent.click(screen.getByText("新建动作"));
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Fixture action" } });
  fireEvent.change(screen.getByLabelText("模板"), { target: { value: "Review {{input}}" } });
  await act(async () => fireEvent.click(screen.getByText("保存动作")));
  expect(useSettingsStore.getState().presets[0].id).toBe("legacy");
  expect(screen.getByText("Fixture action")).toBeInTheDocument();
  await act(async () => fireEvent.click(screen.getByLabelText("收藏 Fixture action")));
  expect(useSettingsStore.getState().presets[1].desktopAction?.favorite).toBe(true);
  fireEvent.click(screen.getByLabelText("编辑 Fixture action"));
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Renamed action" } });
  await act(async () => fireEvent.click(screen.getByText("保存动作")));
  await act(async () => fireEvent.click(screen.getByText("添加内置样例")));
  await act(async () => fireEvent.click(screen.getByLabelText("下移 Renamed action")));
  expect(useSettingsStore.getState().presets[1].name).not.toBe("Renamed action");
  await act(async () => fireEvent.click(screen.getByLabelText("删除 Renamed action")));
  expect(screen.getByText("确认删除此动作？")).toBeInTheDocument();
  await act(async () => fireEvent.click(screen.getByText("确认删除")));
  expect(screen.queryByText("Renamed action")).not.toBeInTheDocument();
  expect(useSettingsStore.getState().presets[0].id).toBe("legacy");
});

it("provides a section header, empty state, and labelled editor instead of bare controls", async () => {
  render(<DesktopActionsSettings />);
  await act(async () => {});
  const heading = screen.getByRole("heading", { name: "桌面动作", level: 2 });
  expect(heading.closest("section")).toHaveClass("cf-settings-section");
  expect(screen.getByText(/暂无桌面动作/)).toHaveClass("cf-settings-empty");
  expect(screen.getByRole("button", { name: "新建动作" }).parentElement).toHaveClass("cf-settings-section-actions");
  fireEvent.click(screen.getByRole("button", { name: "新建动作" }));
  expect(screen.getByRole("group", { name: "新建动作" })).toHaveClass("cf-settings-editor");
  expect(screen.getByLabelText("名称").parentElement).toHaveClass("cf-settings-field");
  expect(screen.getByLabelText("模板")).toHaveClass("cf-input");
  fireEvent.click(screen.getByRole("button", { name: "取消编辑" }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "添加内置样例" })));
  expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
  expect(screen.getAllByRole("listitem")[0]).toHaveClass("cf-settings-action-card");
});

it("requires an input placeholder and displays storage errors without claiming success", async () => {
  render(<DesktopActionsSettings />);
  fireEvent.click(screen.getByText("新建动作"));
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Fixture" } });
  fireEvent.change(screen.getByLabelText("模板"), { target: { value: "invalid" } });
  fireEvent.click(screen.getByText("保存动作"));
  expect(screen.getByRole("alert")).toHaveTextContent("{{input}}");
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("模板"), { target: { value: "{{input}}" } });
  save.mockRejectedValueOnce(new Error("fixture persistence error"));
  fireEvent.click(screen.getByText("保存动作"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("fixture persistence error"));
});
