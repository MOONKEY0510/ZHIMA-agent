import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DeltaBuffer } from "../../../services/stream-events";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
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

describe("knowledge evidence UI", () => {
  const evidence = [{ index: 1, documentId: "doc-1", chunkIndex: 0, title: "手册.pdf",
    snippet: "原始片段 <script>不执行</script>", truncated: false,
    sourceType: "url", sourceRef: "https://example.test/manual" }];

  it.each(["reject", "cancel", "connection-error", "stream-error"] as const)("keeps prepared evidence honest through the real UI/store %s path", async (outcome) => {
    vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
    useHistoryStore.setState({ activeId: null, historyEnabled: false });
    useChatStore.setState({ messages: [{ id: "a", role: "assistant", content: "", status: "streaming" }],
      streams: { r: { messageId: "a", startedAt: Date.now(), conversationId: null } } });
    const buffer = new DeltaBuffer();
    buffer.handle({ type: "kb_used", seq: 0, requestId: "r", count: 1, titles: ["手册.pdf"], evidence });
    buffer.handle({ type: "tool_pending", seq: 1, requestId: "r", callId: "provider-round-0",
      name: "发送本地数据至模型", summary: "即将发送本地资料，需要单独确认", canRemember: false });
    render(<MessageList />);
    fireEvent.click(screen.getByRole("button", { name: /检索参考资料 1 条/ }));
    expect(screen.getByText(/本次请求准备的检索参考资料；是否发送以请求状态为准/)).toBeInTheDocument();
    if (outcome === "reject") {
      fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("chat_approve_tool", expect.objectContaining({ approved: false })));
      act(() => {
        buffer.handle({ type: "tool_rejected", seq: 2, requestId: "r", callId: "provider-round-0", name: "发送本地数据至模型" });
        buffer.handle({ type: "error", seq: 3, requestId: "r", code: "data_transfer_denied", message: "本地数据发送未获授权，已停止请求。", retryable: false });
      });
    } else if (outcome === "cancel") {
      fireEvent.click(screen.getByRole("button", { name: "停止" }));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("chat_cancel", { requestId: "r" }));
    } else {
      fireEvent.click(screen.getByRole("button", { name: "仅一次" }));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("chat_approve_tool", expect.objectContaining({ approved: true })));
      act(() => {
        if (outcome === "stream-error") buffer.handle({ type: "delta", seq: 2, requestId: "r", text: "已开始回答" });
        buffer.handle({ type: "error", seq: outcome === "stream-error" ? 3 : 2, requestId: "r", code: "network_error", message: "连接失败", retryable: true });
      });
    }
    expect(useChatStore.getState().messages[0]).toMatchObject({
      status: outcome === "cancel" ? "cancelled" : "error", kbEvidence: evidence, kbEvidenceStage: "prepared",
    });
    expect(screen.getByText(evidence[0].snippet)).toBeInTheDocument();
    expect(screen.queryByText(/本次注入模型|实际注入片段/)).not.toBeInTheDocument();
    expect(screen.getByText(/不代表服务商已收到/)).toBeInTheDocument();
  });

  it("opens the actual numbered snapshot and copies verbatim without retrieval", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.mocked(invoke).mockClear();
    vi.mocked(openUrl).mockClear();
    useChatStore.setState({ messages: [{ id: "a", role: "assistant", content: "回答 [资料1]", status: "done",
      kbHits: 1, kbTitles: ["手册.pdf"], kbEvidence: evidence }] });
    render(<MessageList />);
    const entry = screen.getByRole("button", { name: /检索参考资料 1 条/ });
    expect(entry).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(evidence[0].snippet)).not.toBeInTheDocument();
    fireEvent.click(entry);
    expect(entry).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("[资料1] 手册.pdf")).toBeInTheDocument();
    expect(screen.getByText("关于检索参考资料").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "复制资料1原文" })).toHaveClass("text-ink");
    expect(screen.getByText(evidence[0].snippet)).toBeInTheDocument();
    expect(screen.getByText(/不代表回答已引用/)).toBeInTheDocument();
    expect(openUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "复制资料1原文" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(evidence[0].snippet));
    fireEvent.click(screen.getByRole("button", { name: "打开资料1网页来源" }));
    expect(openUrl).toHaveBeenCalledWith(evidence[0].sourceRef);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["file:///C:/secret.txt", "javascript:alert(1)", "data:text/html,hi", "C:\\secret.txt", "//example.test"])("does not offer opening unsafe source %s", (sourceRef) => {
    useChatStore.setState({ messages: [{ id: "a", role: "assistant", content: "回答", status: "done",
      kbHits: 1, kbEvidence: [{ ...evidence[0], sourceRef }] }] });
    render(<MessageList />);
    fireEvent.click(screen.getByRole("button", { name: /检索参考资料 1 条/ }));
    expect(screen.queryByRole("button", { name: /网页来源/ })).not.toBeInTheDocument();
    expect(screen.getByText(sourceRef)).toBeInTheDocument();
  });

  it("explains missing historical evidence instead of treating model markers as evidence", () => {
    useChatStore.setState({ messages: [{ id: "old", role: "assistant", content: "旧回答 [资料1]", status: "done",
      kbEvidenceUnavailable: true }] });
    render(<MessageList />);
    fireEvent.click(screen.getByRole("button", { name: /检索参考资料：证据不可用/ }));
    expect(screen.getByText(/未保存本次请求准备的资料快照/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /复制资料/ })).not.toBeInTheDocument();
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
