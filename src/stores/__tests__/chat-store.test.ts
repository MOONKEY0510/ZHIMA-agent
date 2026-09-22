import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useChatStore } from "../chat-store";
import { useProvidersStore } from "../providers-store";
import { useHistoryStore } from "../../services/history-store";
import { useAssistantsStore } from "../assistants-store";
import { useWindowStore } from "../window-store";
import * as historyApi from "../../services/history-api";
import type { AssistantView } from "../../services/assistants-api";

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
  setConversationModel: vi.fn().mockResolvedValue(undefined),
  parseAttachmentsJson: vi.fn().mockReturnValue(undefined),
  editMessage: vi.fn(),
  startMessageVersion: vi.fn(),
  activateMessageVersion: vi.fn(),
  // Mirror of the real parser: absent/corrupted payloads yield undefined.
  parseVersionsJson: (raw?: string | null) => {
    if (!raw || !raw.trim()) return undefined;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
    } catch {
      return undefined;
    }
  },
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
    streams: {},
    lastSendOptions: null,
    compareTargets: [],
    backgroundMessages: {},
    unreadDone: {},
    draftSelection: null,
  });
  useHistoryStore.setState({
    loaded: true,
    historyEnabled: true,
    conversations: [],
    activeId: null,
  });
  useWindowStore.setState({ view: "chat", fullMode: false });
  useAssistantsStore.setState({ loaded: true, assistants: [], activeId: null });
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
  const rid = Object.keys(useChatStore.getState().streams)[0];
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
    // Since P1-6 the assistant placeholder lives in the list from the start.
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({ role: "user", content: "你好", status: "done" });
    expect(state.messages[1]).toMatchObject({ role: "assistant", status: "streaming" });
    expect(state.streams[rid]).toMatchObject({ messageId: state.messages[1].id });

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
        skillIds: [],
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
    expect(final.streams).toEqual({});
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
    expect(state.streams).toEqual({});
    expect(state.messages[1]).toMatchObject({ status: "error", retryable: true });

    // A subsequent send must be allowed (not silently dropped).
    mockedInvoke.mockResolvedValue(undefined);
    await useChatStore.getState().send("再次发送");
    expect(Object.keys(useChatStore.getState().streams)).toHaveLength(1);
  });

  it("rejects events from unknown request ids", async () => {
    const rid = await sendAndGetRid("问题");

    useChatStore.getState().onFinish("some-other-req", "stop");

    const state = useChatStore.getState();
    expect(Object.keys(state.streams)).toEqual([rid]);
    expect(state.messages[1]?.status).toBe("streaming");
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
    const rid2 = Object.keys(useChatStore.getState().streams)[0];

    const state = useChatStore.getState();
    // Only the fresh user message and its assistant placeholder remain.
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({ role: "user", content: "原始问题" });
    expect(state.messages[1]).toMatchObject({ role: "assistant", status: "streaming" });
    expect(Object.keys(state.streams)).toEqual([rid2]);

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
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]).toMatchObject({ role: "assistant", status: "streaming" });
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
        skillIds: [],
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
      skillIds: [],
    });
    expect(Object.keys(useChatStore.getState().streams)).toEqual([rid]);
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

/** Build a persisted-row payload the version commands would return. */
function storedRow(overrides: Partial<historyApi.StoredMessage> & { id: string; role: string }) {
  return {
    conversationId: "c1",
    content: "",
    status: "done",
    createdAt: 1,
    ...overrides,
  } as historyApi.StoredMessage;
}

/** One assistant bound to provider p1 / model m1 with its own prompt. */
function assistantFixture(overrides: Partial<AssistantView> = {}): AssistantView {
  return {
    id: "assistant.builtin.coder",
    name: "编程助手",
    icon: "👨‍💻",
    description: "代码相关",
    systemPrompt: "你是一个严谨的编程助手。",
    providerId: "p1",
    modelKey: "m1",
    toolPoliciesJson: null,
    sortOrder: 3,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("assistant binding (P1-7)", () => {
  it("uses the active assistant's prompt for a new conversation and records the binding", async () => {
    useAssistantsStore.setState({
      assistants: [assistantFixture()],
      activeId: "assistant.builtin.coder",
    });

    await useChatStore.getState().send("写个冒泡排序");

    expect(mockedInvoke).toHaveBeenLastCalledWith(
      "chat_send",
      expect.objectContaining({
        request: expect.objectContaining({
          modelKey: "m1",
          systemPrompt: "你是一个严谨的编程助手。",
        }),
      }),
    );
    expect(historyApi.beginChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({ assistantId: "assistant.builtin.coder" }),
      }),
    );
  });

  it("falls back to the global default when no assistant is selected", async () => {
    useProvidersStore.setState({ defaultSystemPrompt: "全局提示词" });

    await useChatStore.getState().send("你好");

    expect(mockedInvoke).toHaveBeenLastCalledWith(
      "chat_send",
      expect.objectContaining({
        request: expect.objectContaining({ systemPrompt: "全局提示词" }),
      }),
    );
    expect(historyApi.beginChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({ assistantId: null }),
      }),
    );
  });

  it("lets a conversation-level prompt override the assistant prompt", async () => {
    useAssistantsStore.setState({
      assistants: [assistantFixture()],
      activeId: "assistant.builtin.coder",
    });
    useHistoryStore.setState({
      activeId: "c1",
      conversations: [
        {
          id: "c1",
          title: "会话",
          providerId: null,
          modelKey: null,
          systemPrompt: "本会话专属提示词",
          assistantId: "assistant.builtin.coder",
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    await useChatStore.getState().send("继续");

    expect(mockedInvoke).toHaveBeenLastCalledWith(
      "chat_send",
      expect.objectContaining({
        request: expect.objectContaining({ systemPrompt: "本会话专属提示词" }),
      }),
    );
  });

  it("follows the conversation's assistant when it is opened", async () => {
    vi.mocked(historyApi.getConversation).mockResolvedValue({
      conversation: {
        id: "c1",
        title: "旧会话",
        providerId: "p1",
        modelKey: "m1",
        systemPrompt: null,
        assistantId: "assistant.builtin.writer",
        pinned: false,
        createdAt: 1,
        updatedAt: 1,
      },
      messages: [],
    });

    await useChatStore.getState().loadConversation("c1");

    expect(useAssistantsStore.getState().activeId).toBe("assistant.builtin.writer");
  });

  it("falls back to the global selection when the pinned model is gone", async () => {
    useAssistantsStore.setState({
      assistants: [assistantFixture({ providerId: "p-gone", modelKey: "m-gone" })],
      activeId: "assistant.builtin.coder",
    });

    await useChatStore.getState().send("你好");

    expect(mockedInvoke).toHaveBeenLastCalledWith(
      "chat_send",
      expect.objectContaining({
        request: expect.objectContaining({ providerId: "p1", modelKey: "m1" }),
      }),
    );
  });
});

describe("multi-model comparison (P1-6)", () => {
  const targets = [
    { providerId: "p1", modelKey: "m1" },
    { providerId: "p1", modelKey: "m2" },
  ];

  /** Add the second model so both columns resolve to a real entry. */
  function seedSecondModel() {
    useProvidersStore.setState({
      providers: [
        {
          ...seededProvider,
          models: [
            ...seededProvider.models,
            {
              modelKey: "m2",
              displayName: "模型二",
              isFavorite: false,
              sortOrder: 1,
              supportsVision: false,
            },
          ],
        },
      ],
    });
  }

  it("fans one prompt out to every target and streams the columns independently", async () => {
    seedSecondModel();

    await useChatStore.getState().sendMulti("对比一下", targets);

    const state = useChatStore.getState();
    // User prompt + one assistant placeholder per column.
    expect(state.messages).toHaveLength(3);
    expect(state.messages[0]).toMatchObject({ role: "user", content: "对比一下" });
    expect(state.messages[1]).toMatchObject({
      role: "assistant",
      modelName: "模型一",
      status: "streaming",
    });
    expect(state.messages[2]).toMatchObject({
      role: "assistant",
      modelName: "模型二",
      status: "streaming",
    });
    const rids = Object.keys(state.streams);
    expect(rids).toHaveLength(2);

    expect(mockedInvoke).toHaveBeenLastCalledWith(
      "chat_send_multi",
      expect.objectContaining({
        request: expect.objectContaining({
          targets,
          requestIds: rids,
          // The agent loop is a single-model feature.
          enableTools: false,
          messages: [{ role: "user", content: "对比一下" }],
        }),
      }),
    );

    // Deltas land in their own column only.
    useChatStore.getState().appendDelta(rids[0], "答案一");
    useChatStore.getState().appendDelta(rids[1], "答案二");
    expect(useChatStore.getState().messages[1].content).toBe("答案一");
    expect(useChatStore.getState().messages[2].content).toBe("答案二");

    // Finishing one column leaves the other streaming.
    useChatStore.getState().onFinish(rids[0], "stop");
    expect(useChatStore.getState().messages[1].status).toBe("done");
    expect(useChatStore.getState().messages[2].status).toBe("streaming");
    expect(Object.keys(useChatStore.getState().streams)).toEqual([rids[1]]);

    // Every extra column is persisted as an assistant row of the same turn.
    expect(historyApi.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: state.messages[2].id, role: "assistant" }),
    );

    // Stopping the remaining column cancels only that request.
    useChatStore.getState().stopStream(rids[1]);
    expect(mockedInvoke).toHaveBeenCalledWith("chat_cancel", { requestId: rids[1] });
    expect(useChatStore.getState().messages[2].status).toBe("cancelled");
    expect(useChatStore.getState().streams).toEqual({});
  });

  it("refuses to start a comparison while another stream is running", async () => {
    await sendAndGetRid("单模型问题");

    await useChatStore.getState().sendMulti("对比", targets);

    expect(mockedInvoke).not.toHaveBeenCalledWith("chat_send_multi", expect.anything());
    expect(useChatStore.getState().messages).toHaveLength(2);
  });

  it("marks every column failed when the backend rejects the turn", async () => {
    seedSecondModel();
    mockedInvoke.mockRejectedValueOnce(new Error("服务商不存在"));

    await useChatStore.getState().sendMulti("对比一下", targets);

    const state = useChatStore.getState();
    expect(state.streams).toEqual({});
    expect(state.messages[1]).toMatchObject({ status: "error", error: "服务商不存在" });
    expect(state.messages[2]).toMatchObject({ status: "error", error: "服务商不存在" });
  });
});

describe("chat-store message versions (P0-1)", () => {
  it("editing the last user turn archives versions and regenerates the reply in place", async () => {
    const rid = await sendAndGetRid("原始问题");
    useChatStore.getState().appendDelta(rid, "原始回答");
    useChatStore.getState().onFinish(rid, "stop");

    const [userMsg, assistantMsg] = useChatStore.getState().messages;
    vi.mocked(historyApi.editMessage).mockResolvedValue(
      storedRow({
        id: userMsg.id,
        role: "user",
        content: "修改后的问题",
        versionsJson: JSON.stringify([
          { content: "原始问题", status: "done", createdAt: 1 },
          { content: "修改后的问题", status: "done", createdAt: 2 },
        ]),
        activeVersion: 1,
      }),
    );
    vi.mocked(historyApi.startMessageVersion).mockResolvedValue(
      storedRow({
        id: assistantMsg.id,
        role: "assistant",
        content: "",
        status: "streaming",
        modelName: "模型一",
        versionsJson: JSON.stringify([
          { content: "原始回答", status: "done", createdAt: 1 },
          { content: "", status: "streaming", createdAt: 2 },
        ]),
        activeVersion: 1,
      }),
    );

    await useChatStore.getState().editMessage(userMsg.id, "修改后的问题");

    const state = useChatStore.getState();
    // The edited prompt is active and keeps the previous one in the stack.
    expect(state.messages[0].content).toBe("修改后的问题");
    expect(state.messages[0].versions?.map((v) => v.content)).toEqual([
      "原始问题",
      "修改后的问题",
    ]);
    expect(state.messages[0].activeVersion).toBe(1);

    // The reply is regenerated in place (same id, same index), streaming again.
    expect(historyApi.editMessage).toHaveBeenCalledWith(userMsg.id, "修改后的问题");
    expect(historyApi.startMessageVersion).toHaveBeenCalledWith(assistantMsg.id);
    expect(state.messages[1].id).toBe(assistantMsg.id);
    expect(state.messages[1].status).toBe("streaming");
    // The stream is registered against the existing message (in place).
    expect(Object.values(state.streams)).toEqual([
      expect.objectContaining({ messageId: assistantMsg.id }),
    ]);

    // The regenerated request carries the edited prompt as its context.
    expect(mockedInvoke).toHaveBeenLastCalledWith(
      "chat_send",
      expect.objectContaining({
        request: expect.objectContaining({
          messages: [{ role: "user", content: "修改后的问题" }],
        }),
      }),
    );
  });

  it("streams a regeneration into the existing message and syncs its version", async () => {
    const rid = await sendAndGetRid("问题");
    useChatStore.getState().appendDelta(rid, "回答一");
    useChatStore.getState().onFinish(rid, "stop");

    const assistant = useChatStore.getState().messages[1];
    vi.mocked(historyApi.startMessageVersion).mockResolvedValue(
      storedRow({
        id: assistant.id,
        role: "assistant",
        content: "",
        status: "streaming",
        versionsJson: JSON.stringify([
          { content: "回答一", status: "done", createdAt: 1 },
          { content: "", status: "streaming", createdAt: 2 },
        ]),
        activeVersion: 1,
      }),
    );

    await useChatStore.getState().regenerate(assistant.id);

    const mid = useChatStore.getState();
    expect(mid.messages).toHaveLength(2);
    expect(mid.messages[1].status).toBe("streaming");
    expect(mid.messages[1].versions?.[0].content).toBe("回答一");

    // Deltas land in the existing list entry.
    const rid2 = Object.keys(mid.streams)[0];
    useChatStore.getState().appendDelta(rid2, "回答二");
    expect(useChatStore.getState().messages[1].content).toBe("回答二");

    useChatStore.getState().onFinish(rid2, "stop");
    const final = useChatStore.getState().messages[1];
    expect(final.status).toBe("done");
    expect(final.content).toBe("回答二");
    // The active version entry mirrors the new answer (no divergence).
    expect(final.versions?.[1].content).toBe("回答二");
    expect(final.versions?.[0].content).toBe("回答一");
  });

  it("switchMessageVersion applies the activated version returned by the backend", async () => {
    const rid = await sendAndGetRid("问题");
    useChatStore.getState().appendDelta(rid, "回答一");
    useChatStore.getState().onFinish(rid, "stop");
    const assistant = useChatStore.getState().messages[1];

    vi.mocked(historyApi.activateMessageVersion).mockResolvedValue(
      storedRow({
        id: assistant.id,
        role: "assistant",
        content: "回答零",
        versionsJson: JSON.stringify([
          { content: "回答零", status: "done", createdAt: 1 },
          { content: "回答一", status: "done", createdAt: 2 },
        ]),
        activeVersion: 0,
      }),
    );

    await useChatStore.getState().switchMessageVersion(assistant.id, 0);

    expect(historyApi.activateMessageVersion).toHaveBeenCalledWith(assistant.id, 0);
    const msg = useChatStore.getState().messages[1];
    expect(msg.content).toBe("回答零");
    expect(msg.activeVersion).toBe(0);
  });

  it("keeps version stacks in memory when history recording is off", async () => {
    useHistoryStore.setState({ historyEnabled: false });
    useChatStore.setState({
      messages: [
        { id: "u1", role: "user", content: "问题一", status: "done" },
        { id: "a1", role: "assistant", content: "回答一", status: "done" },
        { id: "u2", role: "user", content: "问题二", status: "done" },
        { id: "a2", role: "assistant", content: "回答二", status: "done" },
      ],
    });

    // Editing an earlier turn only rewrites that turn (no regeneration).
    await useChatStore.getState().editMessage("u1", "问题一改");

    const edited = useChatStore.getState().messages[0];
    expect(edited.content).toBe("问题一改");
    expect(edited.versions?.map((v) => v.content)).toEqual(["问题一", "问题一改"]);
    expect(edited.activeVersion).toBe(1);
    expect(useChatStore.getState().messages).toHaveLength(4);
    expect(useChatStore.getState().streams).toEqual({});
    expect(historyApi.editMessage).not.toHaveBeenCalled();

    // Switching back restores the original prompt locally.
    await useChatStore.getState().switchMessageVersion("u1", 0);
    expect(useChatStore.getState().messages[0].content).toBe("问题一");
    expect(historyApi.activateMessageVersion).not.toHaveBeenCalled();
  });

  it("retries a failed regeneration in place instead of rebuilding the turn", async () => {
    // An active persisted conversation is what the backend path requires.
    useHistoryStore.setState({
      activeId: "c1",
      conversations: [
        {
          id: "c1",
          title: "会话",
          providerId: "p1",
          modelKey: "m1",
          systemPrompt: null,
          assistantId: null,
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    useChatStore.setState({
      messages: [
        {
          id: "u1",
          role: "user",
          content: "问题",
          status: "done",
          versions: [
            { content: "旧问题", status: "done", createdAt: 1 },
            { content: "问题", status: "done", createdAt: 2 },
          ],
          activeVersion: 1,
        },
        {
          id: "a1",
          role: "assistant",
          content: "",
          status: "error",
          error: "网络错误",
          retryable: true,
          versions: [
            { content: "旧答案", status: "done", createdAt: 1 },
            { content: "", status: "error", createdAt: 2 },
          ],
          activeVersion: 1,
        },
      ],
    });
    vi.mocked(historyApi.startMessageVersion).mockResolvedValue(
      storedRow({
        id: "a1",
        role: "assistant",
        content: "",
        status: "streaming",
        versionsJson: JSON.stringify([
          { content: "旧答案", status: "done", createdAt: 1 },
          { content: "", status: "error", createdAt: 2 },
          { content: "", status: "streaming", createdAt: 3 },
        ]),
        activeVersion: 2,
      }),
    );

    useChatStore.getState().retryLast();

    await vi.waitFor(() => {
      expect(historyApi.startMessageVersion).toHaveBeenCalledWith("a1");
    });
    const state = useChatStore.getState();
    // The turn was not rebuilt: both original message ids survive.
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].id).toBe("u1");
    expect(state.messages[1].id).toBe("a1");
    expect(state.messages[1].status).toBe("streaming");
  });
});

describe("multi-conversation support (多对话并行)", () => {
  const conversationB = {
    id: "conv-b",
    title: "会话 B",
    providerId: "p1",
    modelKey: "m1",
    systemPrompt: null,
    assistantId: null,
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
  };

  /** Register conversation B and stage its backend detail for loadConversation. */
  function seedConversationB() {
    useHistoryStore.setState((state) => ({
      conversations: [...state.conversations, conversationB],
    }));
    vi.mocked(historyApi.getConversation).mockResolvedValue({
      conversation: conversationB,
      messages: [],
    });
  }

  /** Add a second model so a conversation can be bound to a different one. */
  function seedSecondModel() {
    useProvidersStore.setState({
      providers: [
        {
          ...seededProvider,
          models: [
            ...seededProvider.models,
            {
              modelKey: "m2",
              displayName: "模型二",
              isFavorite: false,
              sortOrder: 1,
              supportsVision: false,
            },
          ],
        },
      ],
    });
  }

  it("keeps the generation running in a background snapshot when switching away", async () => {
    const rid = await sendAndGetRid("问题 A");
    const convA = useHistoryStore.getState().activeId!;
    expect(convA).toBeTruthy();

    seedConversationB();
    await useChatStore.getState().loadConversation("conv-b");

    let state = useChatStore.getState();
    // B is displayed (empty); A's messages live in the snapshot and its
    // stream is still alive — switching is never blocked.
    expect(state.messages).toHaveLength(0);
    expect(state.backgroundMessages[convA]).toHaveLength(2);
    expect(Object.keys(state.streams)).toHaveLength(1);

    // Deltas keep flowing into A's snapshot, not into the visible list.
    useChatStore.getState().appendDelta(rid, "后台回答");
    state = useChatStore.getState();
    expect(state.messages).toHaveLength(0);
    expect(state.backgroundMessages[convA][1].content).toBe("后台回答");

    // Finishing in the background raises the "finished" dot.
    useChatStore.getState().onFinish(rid, "stop");
    state = useChatStore.getState();
    expect(state.unreadDone[convA]).toBe(true);
    expect(state.backgroundMessages[convA][1].status).toBe("done");

    // Switching back restores the snapshot and clears the dot.
    await useChatStore.getState().loadConversation(convA);
    state = useChatStore.getState();
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1].content).toBe("后台回答");
    expect(state.unreadDone[convA]).toBeUndefined();
  });

  it("starting a new chat keeps other conversations generating", async () => {
    const rid = await sendAndGetRid("问题 A");
    const convA = useHistoryStore.getState().activeId!;

    useChatStore.getState().startNewConversation();

    const state = useChatStore.getState();
    expect(useHistoryStore.getState().activeId).toBeNull();
    expect(state.messages).toHaveLength(0);
    // A's stream was neither cancelled nor dropped.
    expect(state.streams[rid]).toBeTruthy();
    expect(state.backgroundMessages[convA]).toHaveLength(2);
    expect(mockedInvoke).not.toHaveBeenCalledWith("chat_cancel", { requestId: rid });
  });

  it("a different conversation can send while another one is generating", async () => {
    await sendAndGetRid("问题 A");
    useChatStore.getState().startNewConversation();

    const before = new Set(Object.keys(useChatStore.getState().streams));
    await useChatStore.getState().send("问题 B");

    const state = useChatStore.getState();
    const newRids = Object.keys(state.streams).filter((id) => !before.has(id));
    expect(newRids).toHaveLength(1);
    // Both generations run side by side.
    expect(Object.keys(state.streams)).toHaveLength(2);
  });

  it("uses the conversation-bound model for its next turn (对话级模型)", async () => {
    seedSecondModel();

    const rid = await sendAndGetRid("问题 A");
    useChatStore.getState().onFinish(rid, "stop");
    const convA = useHistoryStore.getState().activeId!;
    // In the app the sidebar list holds the conversation (refreshed on
    // creation); mirror that here so the binding can be updated.
    useHistoryStore.setState((state) => ({
      conversations: [
        ...state.conversations,
        {
          id: convA,
          title: "问题 A",
          providerId: "p1",
          modelKey: "m1",
          systemPrompt: null,
          assistantId: null,
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }));

    // Bind the conversation to another model (what the composer picker does).
    await useChatStore.getState().setConversationModel("p1", "m2");
    expect(
      useHistoryStore.getState().conversations.find((c) => c.id === convA)?.modelKey,
    ).toBe("m2");

    await useChatStore.getState().send("再问一次");
    expect(mockedInvoke).toHaveBeenLastCalledWith(
      "chat_send",
      expect.objectContaining({
        request: expect.objectContaining({ providerId: "p1", modelKey: "m2" }),
      }),
    );
  });

  it("a fresh chat remembers the draft model until the conversation exists", async () => {
    seedSecondModel();

    // No conversation is open: picking a model stores a draft.
    await useChatStore.getState().setConversationModel("p1", "m2");
    expect(useChatStore.getState().draftSelection).toEqual({
      providerId: "p1",
      modelKey: "m2",
    });

    // The next send uses the draft and the created conversation binds to it.
    await sendAndGetRid("第一条");
    expect(mockedInvoke).toHaveBeenLastCalledWith(
      "chat_send",
      expect.objectContaining({
        request: expect.objectContaining({ providerId: "p1", modelKey: "m2" }),
      }),
    );
  });
});
