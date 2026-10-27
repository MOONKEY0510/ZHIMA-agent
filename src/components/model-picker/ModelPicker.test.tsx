import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";
import { useProvidersStore } from "../../stores/providers-store";
import { useWindowStore } from "../../stores/window-store";
import { useChatStore } from "../../stores/chat-store";
import { useHistoryStore } from "../../services/history-store";
import { useAssistantsStore } from "../../stores/assistants-store";

const provider = {
  id: "p1",
  name: "Fixture",
  baseUrl: "https://fixture.invalid/v1",
  apiType: "chat_completions",
  hasApiKey: true,
  models: [
    { modelKey: "m1", displayName: "Fixture model", supportsVision: true, isFavorite: false, sortOrder: 0 },
  ],
  createdAt: 1,
  updatedAt: 1,
};
const originalInnerHeight = window.innerHeight;

beforeEach(() => {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 260 });
  useProvidersStore.setState({ providers: [provider], defaultProviderId: "p1", defaultModelKey: "m1" });
  useWindowStore.setState({ openSettings: vi.fn() });
  useChatStore.setState({ compareTargets: [], draftSelection: null });
  useHistoryStore.setState({ activeId: null, conversations: [] });
  useAssistantsStore.setState({ assistants: [], activeId: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
});

describe("ModelPicker responsive layout", () => {
  it("uses the full compact-window panel and provides an explicit close button", () => {
    render(<ModelPicker />);
    fireEvent.click(screen.getByTitle(/本对话的模型/));
    const menu = screen.getByRole("dialog", { name: "选择模型" });
    expect(menu).toHaveClass("fixed");
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveStyle({ top: "44px", right: "12px", bottom: "12px", left: "12px" });
    expect(within(menu).getByText("Fixture model")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索模型或服务商…")).toBeVisible();

    fireEvent.click(screen.getByTitle("关闭模型选择"));
    expect(screen.queryByRole("dialog", { name: "选择模型" })).not.toBeInTheDocument();
  });

  it("keeps the anchored menu in tall windows and switches layouts after resize", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 660 });
    render(<ModelPicker />);
    const trigger = screen.getByTitle(/本对话的模型/);
    const root = trigger.parentElement!;
    let top = 600;
    vi.spyOn(root, "getBoundingClientRect").mockImplementation(() => ({
      x: 312,
      y: top,
      top,
      right: 440,
      bottom: top + 28,
      left: 312,
      width: 128,
      height: 28,
      toJSON: () => ({}),
    }) as DOMRect);

    fireEvent.click(trigger);
    const menu = screen.getByRole("dialog", { name: "选择模型" });
    expect(menu).toHaveClass("absolute");
    expect(menu.parentElement).toBe(root);
    expect(menu.style.maxHeight).toBe("462px");

    top = 500;
    fireEvent.resize(window);
    expect(menu).toHaveStyle({ maxHeight: "448px" });

    Object.defineProperty(window, "innerHeight", { configurable: true, value: 260 });
    fireEvent.resize(window);
    const compactMenu = screen.getByRole("dialog", { name: "选择模型" });
    expect(compactMenu).toHaveClass("fixed");
    expect(compactMenu.parentElement).toBe(document.body);
    expect(compactMenu).toHaveStyle({ top: "44px", bottom: "12px" });
  });
});
