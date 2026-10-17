import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsPanel } from "../SettingsPanel";
import { SettingsSection } from "../ui";
import { useWindowStore } from "../../../stores/window-store";
import { useSettingsStore } from "../../../stores/settings-store";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }));
afterEach(cleanup);
beforeEach(() => {
  useWindowStore.setState({ settingsTab: "context" });
  useSettingsStore.setState({ presets: [{ id: "shared", name: "翻译", command: "/translate", content: "翻译", desktopAction: { source: "clipboard", template: "翻译 {{input}}", skillIds: [], output: "display" } }] });
});

it("keeps section copy separate from a wrapping, non-shrinking action group", () => {
  render(<SettingsSection title="标题" description="说明" action={<button>添加记忆</button>}><p>内容</p></SettingsSection>);
  expect(screen.getByRole("heading", { name: "标题", level: 2 }).parentElement).toHaveClass("cf-settings-section-copy");
  expect(screen.getByRole("button", { name: "添加记忆" }).parentElement).toHaveClass("cf-settings-section-actions");
});

it("uses the same section hierarchy for commands, desktop actions and memories on a settings-only surface", async () => {
  const { container } = render(<SettingsPanel />);
  await screen.findByText("暂无记忆。");
  expect(container.querySelector(".cf-settings-content .cf-settings-page")).toBeInTheDocument();
  for (const title of ["快捷指令", "桌面动作", "长期记忆"]) {
    const heading = screen.getByRole("heading", { name: title, level: 2 });
    expect(heading.closest("section")).toHaveClass("cf-settings-section");
    expect(heading.parentElement).toHaveClass("cf-settings-section-copy");
  }
  const memory = screen.getByRole("heading", { name: "长期记忆" }).closest("section")!;
  expect(within(memory).getByRole("button", { name: "添加记忆" }).parentElement).toHaveClass("cf-settings-section-actions");
  expect(screen.getAllByText(/共享模板/).length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText("桌面动作 · 共享模板")).toBeInTheDocument();
  fireEvent.click(within(memory).getByRole("button", { name: "添加记忆" }));
  expect(within(memory).getByRole("textbox", { name: "内容" }).closest(".cf-settings-editor")).toBeInTheDocument();
});
