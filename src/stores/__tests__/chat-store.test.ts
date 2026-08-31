import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useChatStore } from "../chat-store";
import { useProvidersStore } from "../providers-store";
import { useHistoryStore } from "../../services/history-store";
import { useWindowStore } from "../window-store";
import * as historyApi from "../../services/history-api";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../../services/history-api", () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn(),
  createConversation: vi.fn().mockImplementation((conv) => Promise.resolve(conv)),
  beginChatTurn: vi.fn().mockResolvedValue(undefined),
  saveMessage: vi.fn().mockResolvedValue(undefined),
  touchConversation: vi.fn().mockResolvedValue(undefined),
  renameConversation: vi.fn().mockResolvedValue(undefined),
  deleteConversation: vi.fn().mockResolvedValue(undefined),
  clearAllHistory: vi.fn().mockResolvedValue(undefined),
}));

const mockedInvoke = vi.mocked(invoke);

const seededProvider = {
  id: "p1",
  name: "测试服务商",
  baseUrl: "https://api.test/v1",
  apiType: "chat_completions",
  hasApiKey: true,
  models: [
    { modelKey: "m1", displayName: "模型一", isFavorite: false, sortOrder: 0, supportsVision: false },
  ],
  createdAt: 1,
  updatedAt: 1,
};

function resetStores() {
  useChatStore.setState({
    messages: [],
    streamingRequestId: null,
    streamingMessageId: null,
    lastSendOptions: null,
  });
  useHistoryStore.setState({
    loaded: true,
    historyEnabled: true,
    conversations: [],
    activeId: null,
  });
  useWindowStore.setState({ view: "chat", fullMode: false });
  useProvidersStore.setState({
    loaded: true,
    providers: [seededProvider],
    defaultProviderId: "p1",
    defaultModelKey: "m1",
    generation: { temperature: null, maxTokens: null },
    visionProviderId: null,
    visionModelKey: null,
    imageProviderId: null,
    imageModelKey: null,
    defaultSystemPrompt: null,
    rememberWindowPosition: false,
    proxyUrl: null,
    useSystemProxy: false,
  });
}

beforeEach(() => {
  resetStores();
  vi.clearAllMocks();
  mockedInvoke.mockResolvedValue(undefined);
});

/** Helper: send a message and return the frontend-generated requestId. */
async function sendAndGetRid(
  text: string,
  images?: string[],
  webSearch?: boolean,
  enableTools?: boolean,
  enableThinking?: boolean,
  thinkingEffort?: "low" | "medium" | "high" | "max",
): Promise<string> {
  await useChatStore
    .getState()
    .send(text, images, webSearch, enableTools, enableThinking, thinkingEffort);
  const rid = useChatStore.getState().streamingRequestId;
  expect(rid).toBeTruthy();
  return rid!;
}

describe("chat-store send()", () => {
  it("opens settings and does not call the backend when no provider exists", async () => {
    useProvidersStore.setState({ providers: [] });

    await useChatStore.getState().send("你好");

    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(useWindowStore.getState().view).toBe("settings");
    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it("creates a conversation, persists both messages and starts streaming", async () => {
    const rid = await sendAndGetRid("你好");

    const state = useChatStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ role: "user", content: "你好", status: "done" });
    expect(state.streamingMessage).toMatchObject({ role: "assistant", status: "streaming" });
    expect(state.streamingRequestId).toBe(rid);

    // Backend receives provider/model selection, never credentials.
    expect(mockedInvoke).toHaveBeenCalledWith("chat_send", {
      request: {
        providerId: "p1",
        modelKey: "m1",
        messages: [{ role: "user", content: "你好", images: undefined }],
        systemPrompt: null,
        webSearch: false,
        enableTools: false,
        enableThinking: true,
        thinkingEffort: "medium",
        requestId: rid,
        conversationId: expect.any(String),
      },
    });

    // History orchestration is committed by one atomic backend command.
    expect(historyApi.beginChatTurn).toHaveBeenCalledTimes(1);
    expect(historyApi.beginChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({ id: expect.any(String) }),
        userMessage: expect.objectContaining({ role: "user", content: "你好" }),
        assistantMessage: expect.objectContaining({ role: "assistant", status: "streaming" }),
      }),
    );
    expect(historyApi.createConversation).not.toHaveBeenCalled();
    expect(historyApi.touchConversation).not.toHaveBeenCalled();
    expect(useHistoryStore.getState().activeId).toBeTruthy();
  });

  it("appends deltas and finalizes on finish, persisting the final content", async () => {
    const rid = await sendAndGetRid("问题");

    const store = useChatStore.getState();
    store.appendDelta(rid, "回答");
    store.appendDelta(rid, "内容");
    store.onFinish(rid, "stop");

    const final = useChatStore.getState();
    expect(final.streamingRequestId).toBeNull();
    const assistant = final.messages[1];
    expect(assistant.status).toBe("done");
    expect(assistant.content).toBe("回答内容");

    // Final upsert carries the accumulated content.
    const saveCalls = vi.mocked(historyApi.saveMessage).mock.calls;
    const lastSave = saveCalls[saveCalls.length - 1]?.[0];
    expect(lastSave).toMatchObject({ status: "done", content: "回答内容" });
  });

  it("marks cancelled runs and keeps partial text", async () => {
    const rid = await sendAndGetRid("问题");

    useChatStore.getState().appendDelta(rid, "一半");
    useChatStore.getState().onFinish(rid, "cancelled");

    const assistant = useChatStore.getState().messages[1];
    expect(assistant.status).toBe("cancelled");
    expect(assistant.content).toBe("一半");
  });

  it("surfaces readable errors and flags retryability", async () => {
    const rid = await sendAndGetRid("问题");

    useChatStore.getState().onError(rid, "鉴权失败（401）：请检查 API Key", false);

    const assistant = useChatStore.getState().messages[1];
    expect(assistant.status).toBe("error");
    expect(assistant.error).toContain("401");
    expect(assistant.retryable).toBe(false);
  });

  it("releases the request slot when chat_send is rejected, so the UI is not stuck", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("invoke 被拒绝"));

    await useChatStore.getState().send("问题");

    const state = useChatStore.getState();
    expect(state.streamingRequestId).toBeNull();
    expect(state.streamingMessageId).toBeNull();
    expect(state.messages[1]).toMatchObject({ status: "error", retryable: true });

    // A subsequent send must be allowed (not silently dropped).
    mockedInvoke.mockResolvedValue(undefined);
    await useChatStore.getState().send("再次发送");
    expect(useChatStore.getState().streamingRequestId).toBeTruthy();
  });

  it("rejects events from unknown request ids", async () => {
    const rid = await sendAndGetRid("问题");

    useChatStore.getState().onFinish("some-other-req", "stop");

    const state = useChatStore.getState();
    expect(state.streamingRequestId).toBe(rid);
    expect(state.streamingMessage?.status).toBe("streaming");
  });

  it("stop() cancels the in-flight request via the backend", async () => {
    const rid = await sendAndGetRid("问题");

    useChatStore.getState().stop();

    expect(mockedInvoke).toHaveBeenCalledWith("chat_cancel", { requestId: rid });
  });

  it("retryLast removes the failed assistant and user message, then replays with original options", async () => {
    // Send with webSearch + enableTools enabled.
    const rid1 = await sendAndGetRid("原始问题", undefined, true, true);
    useChatStore.getState().onError(rid1, "网络错误", true);

    // Retry — should remove both old messages and call send with same options.
    await useChatStore.getState().retryLast();
    const rid2 = useChatStore.getState().streamingRequestId!;

    const state = useChatStore.getState();
    // Only the new stable user message and assistant draft should remain.
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ role: "user", content: "原始问题" });
    expect(state.streamingMessage).toMatchObject({ role: "assistant", status: "streaming" });
    expect(state.streamingRequestId).toBe(rid2);

    // The replayed chat_send call must include webSearch=true and enableTools=true.
    const lastCall = mockedInvoke.mock.calls[mockedInvoke.mock.calls.length - 1]!;
    const args = lastCall[1] as { request: { webSearch: boolean; enableTools: boolean } };
    expect(args.request.webSearch).toBe(true);
    expect(args.request.enableTools).toBe(true);
  });

  it("does not persist anything when history recording is disabled", async () => {
    useHistoryStore.setState({ historyEnabled: false });

    await useChatStore.getState().send("你好");

    expect(historyApi.createConversation).not.toHaveBeenCalled();
    expect(historyApi.beginChatTurn).not.toHaveBeenCalled();
    expect(historyApi.saveMessage).not.toHaveBeenCalled();
    const state = useChatStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.streamingMessage).toMatchObject({ role: "assistant", status: "streaming" });
  });

  it("builds multi-turn context from previous messages", async () => {
    const rid1 = await sendAndGetRid("第一问");
    useChatStore.getState().appendDelta(rid1, "第一答");
    useChatStore.getState().onFinish(rid1, "stop");

    const rid2 = await sendAndGetRid("第二问");

    expect(mockedInvoke).toHaveBeenLastCalledWith("chat_send", {
      request: {
        providerId: "p1",
        modelKey: "m1",
        messages: [
          { role: "user", content: "第一问", images: undefined },
          { role: "assistant", content: "第一答", images: undefined },
          { role: "user", content: "第二问", images: undefined },
        ],
        systemPrompt: null,
        webSearch: false,
        enableTools: false,
        enableThinking: true,
        thinkingEffort: "medium",
        requestId: rid2,
        conversationId: expect.any(String),
      },
    });
  });

  it("forwards a disabled thinking toggle to the backend", async () => {
    const rid = await sendAndGetRid("直接回答", undefined, false, false, false, "low");

    expect(mockedInvoke).toHaveBeenLastCalledWith(
      "chat_send",
      expect.objectContaining({
        request: expect.objectContaining({
          enableThinking: false,
          thinkingEffort: "low",
          enableTools: false,
        }),
      }),
    );
    expect(useChatStore.getState().lastSendOptions).toEqual({
      webSearch: false,
      enableTools: false,
      enableThinking: false,
      thinkingEffort: "low",
    });
    expect(useChatStore.getState().streamingRequestId).toBe(rid);
  });

  it("branchFrom keeps the chosen message and cuts everything after it", async () => {
    const rid1 = await sendAndGetRid("问题一");
    useChatStore.getState().appendDelta(rid1, "回答一");
    useChatStore.getState().onFinish(rid1, "stop");

    const rid2 = await sendAndGetRid("问题二");
    useChatStore.getState().appendDelta(rid2, "回答二");
    useChatStore.getState().onFinish(rid2, "stop");

    const before = useChatStore.getState().messages;
    expect(before).toHaveLength(4);

    const firstAssistant = before.find((m) => m.role === "assistant");
    expect(firstAssistant).toBeDefined();
    useChatStore.getState().branchFrom(firstAssistant!.id);

    const after = useChatStore.getState().messages;
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ role: "user", content: "问题一" });
    expect(after[1]).toMatchObject({ role: "assistant", content: "回答一" });
  });

  it("branchFrom is a no-op while streaming", async () => {
    await sendAndGetRid("问题");
    const before = useChatStore.getState().messages.length;
    useChatStore.getState().branchFrom("unknown-or-any");
    expect(useChatStore.getState().messages).toHaveLength(before);
  });
});
