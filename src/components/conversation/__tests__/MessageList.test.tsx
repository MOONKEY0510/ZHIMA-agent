import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MessageList } from "../MessageList";
import { useChatStore } from "../../../stores/chat-store";
import { useProvidersStore } from "../../../stores/providers-store";
import { useWindowStore } from "../../../stores/window-store";

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
