import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HistorySidebar } from "../HistorySidebar";
import { useHistoryStore } from "../../../services/history-store";
import { useChatStore } from "../../../stores/chat-store";
import * as historyApi from "../../../services/history-api";

vi.mock("../../../services/history-api", () => ({
  searchMessages: vi.fn(),
  setConversationSystemPrompt: vi.fn(),
}));

const conversation = {
  id: "c1",
  title: "会话一",
  providerId: "p1",
  modelKey: "m1",
  systemPrompt: null,
  assistantId: null,
  pinned: false,
  createdAt: 1,
  updatedAt: Date.now(),
};

beforeEach(() => {
  vi.clearAllMocks();
  useHistoryStore.setState({
    loaded: true,
    historyEnabled: true,
    conversations: [conversation],
    activeId: "c1",
  });
  useChatStore.setState({
    messages: [],
    streams: {},
    focusMessageId: null,
    compareTargets: [],
  });
});

describe("HistorySidebar full-text search (P0-2)", () => {
  it("runs a debounced message search and reveals the hit when clicked", async () => {
    vi.mocked(historyApi.searchMessages).mockResolvedValue([
      {
        messageId: "m9",
        conversationId: "c1",
        conversationTitle: "会话一",
        role: "user",
        snippet: "包含「关键词」的片段",
        createdAt: Date.now(),
      },
    ]);

    render(<HistorySidebar />);
    fireEvent.change(screen.getByPlaceholderText("搜索会话或消息内容…"), {
      target: { value: "关键词" },
    });

    await waitFor(() => expect(historyApi.searchMessages).toHaveBeenCalledWith("关键词", 30));

    const hit = await screen.findByText(/包含/);
    fireEvent.click(hit);

    // Same conversation → no reload, just a focus request for the message.
    expect(useChatStore.getState().focusMessageId).toBe("m9");
  });

  it("skips the backend query for single-character input", async () => {
    render(<HistorySidebar />);
    fireEvent.change(screen.getByPlaceholderText("搜索会话或消息内容…"), {
      target: { value: "关" },
    });

    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(historyApi.searchMessages).not.toHaveBeenCalled();
  });

  it("shows an empty state when nothing matches", async () => {
    vi.mocked(historyApi.searchMessages).mockResolvedValue([]);

    render(<HistorySidebar />);
    fireEvent.change(screen.getByPlaceholderText("搜索会话或消息内容…"), {
      target: { value: "不存在的词" },
    });

    expect(await screen.findByText("没有匹配的消息")).toBeTruthy();
  });
});
