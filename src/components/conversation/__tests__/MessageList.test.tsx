import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useHistoryStore } from "../../../services/history-store";
import { MessageList } from "../MessageList";
import type { ReactNode } from "react";
import { useChatStore } from "../../../stores/chat-store";
import { useProvidersStore } from "../../../stores/providers-store";
import { useWindowStore } from "../../../stores/window-store";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// jsdom has no layout: render the virtualizer's real item content directly.
vi.mock("react-virtuoso", async () => {
  const { forwardRef } = await import("react");
  return { Virtuoso: forwardRef(function TestList(
    { data, itemContent }: { data: unknown[]; itemContent: (index: number, item: unknown) => ReactNode }, _ref,
  ) { return <>{data.map((item, index) => <div key={index}>{itemContent(index, item)}</div>)}</>; }) };
});

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

beforeEach(() => {
  useChatStore.setState({
    messages: [],
    streams: {},
    focusMessageId: null,
    composerPrefill: null,
    compareTargets: [],
  });
  useProvidersStore.setState({ providers: [] });
  useWindowStore.setState({ fullMode: false });
});

afterEach(() => vi.unstubAllGlobals());

describe("image retry UI", () => {
  it.each(["重试", "不使用工具重试"])("%s preserves images through the real regenerate entry", async (label) => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    vi.stubGlobal("Image", class {
      onerror = () => {};
      set src(_value: string) { queueMicrotask(() => this.onerror()); }
    });
    useHistoryStore.setState({ historyEnabled: false, activeId: null });
    useProvidersStore.setState({
      defaultProviderId: "p1", defaultModelKey: "vision",
      providers: [{ id: "p1", name: "测试", baseUrl: "https://example.test", apiType: "chat_completions",
        hasApiKey: true, createdAt: 1, updatedAt: 1,
        models: [{ modelKey: "vision", displayName: "视觉", isFavorite: false, sortOrder: 0, supportsVision: true }] }],
    });
    const image = "data:image/png;base64,aW1hZ2U=";
    useChatStore.setState({ messages: [
      { id: "u", role: "user", content: "看图", images: [image], status: "done" },
      { id: "a", role: "assistant", content: "", status: "error", error: "失败", retryable: true,
        toolCalls: [{ callId: "t", name: "test", arguments: "{}", status: "error" }] },
    ] });
    render(<MessageList />);
    fireEvent.click(await screen.findByRole("button", { name: label }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("chat_send", expect.objectContaining({
      request: expect.objectContaining({ messages: [{ role: "user", content: "看图", images: [image] }] }),
    })));
    expect(useChatStore.getState().messages.map((message) => message.id)).toEqual(["u", "a"]);
  });
});

describe("EmptyState (MessageList)", () => {
  it("shows a time-of-day greeting when the conversation is empty", () => {
    render(<MessageList />);
    // One of the four greetings always matches, regardless of local time.
    const greetings = ["早上好", "下午好", "晚上好", "夜深了"];
    const found = greetings.some((g) => screen.queryByText(g) !== null);
    expect(found).toBe(true);
  });

  it("prompts to configure a provider when none exist", () => {
    render(<MessageList />);
    expect(screen.getByText("先配置服务商")).toBeInTheDocument();
  });

  it("loads a suggestion chip into the composer via composerPrefill", () => {
    useProvidersStore.setState({
      providers: [
        {
          id: "p1",
          name: "测试服务商",
          baseUrl: "https://example.com",
          hasApiKey: true,
          models: [],
        } as unknown as ReturnType<typeof useProvidersStore.getState>["providers"][number],
      ],
    });
    // Suggestion chips are hidden below a measured container height (the
    // 260px floating window); full mode starts "tall" before the real
    // ResizeObserver (stubbed as a no-op in tests) would ever report one.
    useWindowStore.setState({ fullMode: true });
    render(<MessageList />);
    const chip = screen.getByText("翻译");
    fireEvent.click(chip);
    expect(useChatStore.getState().composerPrefill).toContain("翻译");
  });
});
