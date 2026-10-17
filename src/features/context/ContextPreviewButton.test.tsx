import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ContextPreviewButton } from "./ContextPreviewButton";
import { useChatStore } from "../../stores/chat-store";
import { useContextOptionsStore } from "../../stores/context-options-store";
import { useProvidersStore } from "../../stores/providers-store";
import { useHistoryStore } from "../../services/history-store";
import { invoke } from "@tauri-apps/api/core";
import { Modal } from "../settings/ui";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ LazyStore: class {} }));

beforeEach(() => {
  vi.clearAllMocks();
  useContextOptionsStore.getState().reset();
  useChatStore.setState({ messages: [], compareTargets: [], streams: {}, importingBackup: false, draftSelection: null });
  useHistoryStore.setState({ activeId: null, conversations: [] });
  useProvidersStore.setState({ defaultProviderId: "p", defaultModelKey: "m", providers: [{
    id: "p", name: "测试", baseUrl: "", apiType: "chat_completions", hasApiKey: false, createdAt: 0, updatedAt: 0,
    models: [{ modelKey: "m", displayName: "预览模型", supportsVision: false, isFavorite: false, sortOrder: 0 }],
  }] });
  vi.mocked(invoke).mockResolvedValue({
    memories: [{ id: "mem", category: "偏好", content: "简洁回答", excluded: false }],
    knowledge: [{ index: 1, documentId: "doc", chunkIndex: 0, title: "资料", snippet: "片段正文", truncated: false }],
    excludedKnowledgeDocumentIds: [], skillsBlock: "技能正文", summary: "摘要正文", systemPrompt: "安全规则",
    inputMessageCount: 1, retainedMessageCount: 1, droppedMessageCount: 0,
    estimatedTokens: 100, inputBudget: 32000, oversizedMessage: false, overBudget: false, dynamicContent: ["动态内容未计入"],
  });
});

describe("ContextPreviewButton", () => {
  it("uses a portal modal with fixed chrome, compact cards and collapsed guidance", async () => {
    const view = render(<ContextPreviewButton text="问题" />);
    fireEvent.click(screen.getByRole("button", { name: "上下文" }));
    await screen.findByText("摘要正文");
    const dialog = screen.getByRole("dialog", { name: "本轮上下文预览" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(view.container.contains(dialog)).toBe(false);
    expect(dialog.querySelector("header")).toBeTruthy();
    expect(dialog.querySelector("footer")).toHaveTextContent("不联网、不调用模型");
    expect(screen.getByRole("region", { name: "上下文概览" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "包含记忆 简洁回答" })).toHaveClass("cf-checkbox");
    expect(screen.getByText("预览与排除说明").closest("details")).not.toHaveAttribute("open");
  });

  it("consumes Escape, restores trigger focus and closes on backdrop without writing", async () => {
    render(<ContextPreviewButton text="问题" />);
    const trigger = screen.getByRole("button", { name: "上下文" });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByText("摘要正文");
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    await screen.findByText("摘要正文");
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(vi.mocked(invoke).mock.calls.every(([name]) => name === "chat_preview_context")).toBe(true);
  });

  it("closes before a previously registered App capture listener can hide the window", async () => {
    const hide = vi.fn();
    const appCapture = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      hide();
    };
    window.addEventListener("keydown", appCapture, true);
    try {
      render(<ContextPreviewButton text="问题" />);
      fireEvent.click(screen.getByRole("button", { name: "上下文" }));
      await screen.findByText("摘要正文");
      fireEvent.keyDown(window, { key: "Escape" });
      expect(hide).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(hide).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener("keydown", appCapture, true); }
  });

  it("keeps focus inside the modal when tabbing past either edge", async () => {
    render(<ContextPreviewButton text="问题" />);
    fireEvent.click(screen.getByRole("button", { name: "上下文" }));
    await screen.findByText("摘要正文");
    const dialog = screen.getByRole("dialog");
    const first = screen.getByRole("button", { name: "刷新预览" });
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(first).not.toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(first).toHaveFocus();
  });

  it("shows consistent loading, error and empty states while retaining refresh", async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    render(<ContextPreviewButton text="问题" />);
    fireEvent.click(screen.getByRole("button", { name: "上下文" }));
    expect(screen.getByRole("status")).toHaveClass("text-ink-2", "bg-panel-2");
    expect(screen.getByRole("button", { name: "刷新预览" })).toBeDisabled();
    await act(async () => { reject(new Error("读取失败")); });
    expect(screen.getByRole("alert")).toHaveClass("text-danger", "bg-panel-2");
    expect(screen.getByRole("button", { name: "刷新预览" })).not.toBeDisabled();
    const fallback = await vi.mocked(invoke)("fixture");
    vi.mocked(invoke).mockResolvedValue({ ...(fallback as object), memories: [], knowledge: [] });
    fireEvent.click(screen.getByRole("button", { name: "刷新预览" }));
    expect(await screen.findByText("无候选记忆")).toHaveClass("text-ink-2", "bg-panel-2");
    expect(screen.getByText("无候选知识片段，或自动注入已关闭")).toHaveClass("text-ink-2");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("only the topmost shared modal handles Escape", () => {
    const lowerClose = vi.fn();
    const topClose = vi.fn();
    render(<><Modal title="底层" onClose={lowerClose}><button>底层操作</button></Modal><Modal title="顶层" onClose={topClose}><button>顶层操作</button></Modal></>);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(topClose).toHaveBeenCalledTimes(1);
    expect(lowerClose).not.toHaveBeenCalled();
  });

  it("does not preview unfinished attachments and only invokes the read-only command", async () => {
    const view = render(<ContextPreviewButton text="完整附件" disabled />);
    fireEvent.click(screen.getByRole("button", { name: "上下文" }));
    expect(invoke).not.toHaveBeenCalled();
    view.rerender(<ContextPreviewButton text="完整附件" />);
    fireEvent.click(screen.getByRole("button", { name: "上下文" }));
    await screen.findByText("摘要正文");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invoke).mock.calls[0][0]).toBe("chat_preview_context");
    expect(screen.getByText(/不是完整请求或精确 token/)).toBeTruthy();
  });

  it("keeps an image-only revision dirty after disabled ends and even after restoring the revision", async () => {
    const view = render(<ContextPreviewButton text="正文不变" inputRevision="images-1" />);
    fireEvent.click(screen.getByRole("button", { name: "上下文" }));
    await screen.findByText("摘要正文");
    expect(screen.queryByText(/上下文已变化/)).toBeNull();
    view.rerender(<ContextPreviewButton text="正文不变" inputRevision="images-2" disabled />);
    expect(screen.getByText(/上下文已变化/)).toBeTruthy();
    view.rerender(<ContextPreviewButton text="正文不变" inputRevision="images-2" />);
    expect(screen.getByText(/上下文已变化/)).toBeTruthy();
    view.rerender(<ContextPreviewButton text="正文不变" inputRevision="images-1" />);
    expect(screen.getByText(/上下文已变化/)).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "刷新预览" }));
    await waitFor(() => expect(screen.queryByText(/上下文已变化/)).toBeNull());
    expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toContain("images-1");
    expect(vi.mocked(invoke).mock.calls.every(([name]) => name === "chat_preview_context")).toBe(true);
  });

  it("rejects an older revision response after a newer preview has completed", async () => {
    const view = render(<ContextPreviewButton text="正文不变" inputRevision="images-1" />);
    fireEvent.click(screen.getByRole("button", { name: "上下文" }));
    await screen.findByText("摘要正文");
    let resolveOld!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "刷新预览" }));
    view.rerender(<ContextPreviewButton text="正文不变" inputRevision="images-2" disabled />);
    view.rerender(<ContextPreviewButton text="正文不变" inputRevision="images-2" />);
    fireEvent.click(screen.getByRole("button", { name: "刷新预览" }));
    await waitFor(() => expect(screen.queryByText(/上下文已变化/)).toBeNull());
    // A malformed old result would break rendering if accepted; it must be discarded.
    await act(async () => { resolveOld({ summary: "旧图片修订响应" }); });
    expect(screen.queryByText("旧图片修订响应")).toBeNull();
    expect(screen.getByText("摘要正文")).toBeTruthy();
    expect(screen.queryByText(/上下文已变化/)).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("marks changed text and exclusions stale until refreshed, without deletion", async () => {
    const view = render(<ContextPreviewButton text="问题" />);
    fireEvent.click(screen.getByRole("button", { name: "上下文" }));
    await screen.findByText("摘要正文");
    fireEvent.click(screen.getByRole("checkbox", { name: "包含记忆 简洁回答" }));
    expect(screen.getByText(/上下文已变化/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "刷新预览" }));
    await waitFor(() => expect(screen.queryByText(/上下文已变化/)).toBeNull());
    view.rerender(<ContextPreviewButton text="新问题" />);
    expect(screen.getByText(/上下文已变化/)).toBeTruthy();
    expect(vi.mocked(invoke).mock.calls.every(([name]) => name === "chat_preview_context")).toBe(true);
  });
});
