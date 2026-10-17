import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { buildContextPreviewRequest, contextScope, useChatStore } from "../chat-store";
import { EMPTY_CONTEXT_EXCLUSIONS, useContextOptionsStore } from "../context-options-store";
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
  // Mirror of the real parser: only data-URL images survive.
  parseImagesJson: (raw?: string | null) => {
    if (!raw || !raw.trim()) return undefined;
    try {
      const parsed = JSON.parse(raw);
      const images = Array.isArray(parsed)
        ? parsed.filter((entry: unknown) => typeof entry === "string" && entry.startsWith("data:image/"))
        : [];
      return images.length > 0 ? images : undefined;
    } catch {
      return undefined;
    }
  },
  branchConversation: vi.fn(),
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
  useContextOptionsStore.getState().reset();
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

afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const imageUrl = "data:image/png;base64,aW1hZ2U=";
function mockImages() {
  const pending: Array<{ onerror: () => void }> = [];
  vi.stubGlobal("Image", class {
    onerror = () => {};
    set src(_value: string) { pending.push(this); }
  });
  return pending;
}
function seedVisionModel() {
  useProvidersStore.setState({ providers: [{ ...seededProvider, models: [
    { ...seededProvider.models[0], supportsVision: true },
  ] }] });
}
const importedConversation: historyApi.Conversation = {
  id: "c1", title: "导入会话", providerId: "p1", modelKey: "m1",
  systemPrompt: null, assistantId: null, pinned: false, createdAt: 1, updatedAt: 2,
};
function seedImport() {
  useHistoryStore.setState({ activeId: "c1", conversations: [importedConversation] });
  useChatStore.setState({
    messages: [{ id: "a1", role: "assistant", content: "旧数据", status: "done" }],
    backgroundMessages: { c2: [{ id: "a2", role: "assistant", content: "旧后台", status: "done" }] },
    unreadDone: { c2: true },
  });
  vi.mocked(historyApi.listConversations).mockResolvedValue([importedConversation]);
  vi.mocked(historyApi.getConversation).mockResolvedValue({
    conversation: importedConversation,
    messages: [storedRow({ id: "a1", role: "assistant", content: "导入数据" })],
  });
}

describe("context preview and per-turn exclusions", () => {
  const exclusions = { memoryIds: ["mem1"], knowledgeDocumentIds: ["doc1"] };
  const arm = () => {
    useContextOptionsStore.getState().toggle(contextScope(), "memoryIds", "mem1");
    useContextOptionsStore.getState().toggle(contextScope(), "knowledgeDocumentIds", "doc1");
  };
  const requests = (command = "chat_send") => mockedInvoke.mock.calls.filter(([cmd]) => cmd === command)
    .map(([, args]) => (args as { request: { contextExclusions: typeof exclusions; messages: unknown[] } }).request);

  it("previews the actual conversation model/prompt/history without preparing images or writing", async () => {
    useHistoryStore.setState({ activeId: "c1", conversations: [{ ...importedConversation, systemPrompt: "会话覆盖" }] });
    useChatStore.setState({ messages: [{ id: "u", role: "user", content: "历史", images: [imageUrl], status: "done" }] });
    arm();
    const before = useChatStore.getState().messages;
    await useChatStore.getState().previewContext("附件正文", { webSearch: true, enableTools: true, skillIds: ["skill"] });
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith("chat_preview_context", { request: expect.objectContaining({
      providerId: "p1", modelKey: "m1", systemPrompt: "会话覆盖", conversationId: "c1", contextExclusions: exclusions,
      messages: [{ role: "user", content: "历史", images: undefined }, { role: "user", content: "附件正文", images: undefined }],
      skillIds: ["skill"], webSearch: true, enableTools: true,
    }) });
    expect(useChatStore.getState().messages).toBe(before);
    expect(historyApi.beginChatTurn).not.toHaveBeenCalled();
    expect(useContextOptionsStore.getState().drafts.c1).toEqual(exclusions);
  });

  it("consumes exclusions once and replays the original turn on regenerate and retry", async () => {
    useHistoryStore.setState({ historyEnabled: false });
    arm();
    await useChatStore.getState().send("原始问题");
    const rid = Object.keys(useChatStore.getState().streams)[0];
    useChatStore.getState().onError(rid, "失败", true);
    useChatStore.getState().retryLast();
    await vi.waitFor(() => expect(requests()).toHaveLength(2));
    expect(requests().map((r) => r.contextExclusions)).toEqual([exclusions, exclusions]);
    const retryId = Object.keys(useChatStore.getState().streams)[0];
    useChatStore.getState().onFinish(retryId);
    const assistant = useChatStore.getState().messages[1];
    await useChatStore.getState().regenerate(assistant.id);
    expect(requests()[requests().length - 1]?.contextExclusions).toEqual(exclusions);
    useChatStore.getState().onFinish(Object.keys(useChatStore.getState().streams)[0]);
    await useChatStore.getState().send("下一轮");
    expect(requests()[requests().length - 1]?.contextExclusions).toEqual(EMPTY_CONTEXT_EXCLUSIONS);
  });

  it("isolates draft exclusions by conversation and forwards them to every comparison target", async () => {
    useHistoryStore.setState({ activeId: "c1" }); arm();
    useHistoryStore.setState({ activeId: "c2" });
    expect(buildContextPreviewRequest("二").request.contextExclusions).toEqual(EMPTY_CONTEXT_EXCLUSIONS);
    useHistoryStore.setState({ activeId: "c1" });
    await useChatStore.getState().sendMulti("对比", [{ providerId: "p1", modelKey: "m1" }, { providerId: "p1", modelKey: "m1" }]);
    expect(requests("chat_send_multi")[0].contextExclusions).toEqual(exclusions);
    expect(useContextOptionsStore.getState().drafts.c1).toBeUndefined();
  });

  it("changes fingerprint on text/model/options and reports frontend history trimming", () => {
    useChatStore.setState({ messages: Array.from({ length: 45 }, (_, i) => ({ id: String(i), role: "user", content: `history ${i}`, status: "done" })) });
    const initial = buildContextPreviewRequest("问题");
    expect(initial.frontendDroppedMessageCount).toBe(6);
    expect(buildContextPreviewRequest("新问题").fingerprint).not.toBe(initial.fingerprint);
    arm();
    expect(buildContextPreviewRequest("问题").fingerprint).not.toBe(initial.fingerprint);
  });

  it("clears temporary turn and draft exclusions after backup import", async () => {
    arm();
    useContextOptionsStore.getState().capture(contextScope(), "old-user");
    arm();
    await useChatStore.getState().importBackup("mock.json", "replace");
    expect(useContextOptionsStore.getState().drafts).toEqual({});
    expect(useContextOptionsStore.getState().turns).toEqual({});
  });
});

describe("knowledge evidence lifecycle", () => {
  const evidence = [{ index: 1, documentId: "doc", chunkIndex: 0, title: "原文档", snippet: "本轮片段", truncated: false }];

  it("keeps background evidence through finish and conversation switching, ignoring late events", async () => {
    await useChatStore.getState().send("问题");
    const rid = Object.keys(useChatStore.getState().streams)[0];
    const cid = useHistoryStore.getState().activeId!;
    useChatStore.getState().startNewConversation();
    useChatStore.getState().markKbUsed(rid, 1, ["原文档"], evidence);
    useChatStore.getState().appendDelta(rid, "回答");
    useChatStore.getState().onFinish(rid);
    useChatStore.getState().markKbUsed(rid, 0, [], []);
    await useChatStore.getState().loadConversation(cid);
    expect(useChatStore.getState().messages[1].kbEvidence).toEqual(evidence);
    expect(historyApi.getConversation).not.toHaveBeenCalled();
  });

  it("clears retry evidence and restores the correct local version snapshot", async () => {
    useHistoryStore.setState({ historyEnabled: false });
    useChatStore.setState({ messages: [
      { id: "u", role: "user", content: "问题", status: "done" },
      { id: "a", role: "assistant", content: "旧回答", status: "done", kbHits: 1, kbEvidence: evidence },
    ] });
    await useChatStore.getState().regenerate("a");
    expect(useChatStore.getState().messages[1].kbEvidence).toBeUndefined();
    const rid = Object.keys(useChatStore.getState().streams)[0];
    useChatStore.getState().appendDelta(rid, "新回答");
    useChatStore.getState().onFinish(rid);
    await useChatStore.getState().switchMessageVersion("a", 0);
    expect(useChatStore.getState().messages[1].kbEvidence).toEqual(evidence);
    await useChatStore.getState().switchMessageVersion("a", 1);
    expect(useChatStore.getState().messages[1].kbEvidence).toBeUndefined();
  });

  it("preserves per-version evidence through persisted regenerate and activation", async () => {
    useHistoryStore.setState({ activeId: "c1" });
    useChatStore.setState({ messages: [
      { id: "u", role: "user", content: "问题", status: "done" },
      { id: "a", role: "assistant", content: "旧回答", status: "done", kbHits: 1, kbEvidence: evidence },
    ] });
    const versions = [{ content: "旧回答", status: "done", createdAt: 1 },
      { content: "", status: "streaming", createdAt: 2 }];
    vi.mocked(historyApi.startMessageVersion).mockResolvedValue(storedRow({ id: "a", role: "assistant",
      status: "streaming", versionsJson: JSON.stringify(versions), activeVersion: 1 }));
    await useChatStore.getState().regenerate("a");
    expect(useChatStore.getState().messages[1].kbEvidence).toBeUndefined();
    const rid = Object.keys(useChatStore.getState().streams)[0];
    const nextEvidence = [{ ...evidence[0], snippet: "新片段" }];
    useChatStore.getState().markKbUsed(rid, 1, ["原文档"], nextEvidence);
    useChatStore.getState().appendDelta(rid, "新回答");
    useChatStore.getState().onFinish(rid);
    versions[1] = { content: "新回答", status: "done", createdAt: 2 };
    for (const index of [0, 1]) {
      vi.mocked(historyApi.activateMessageVersion).mockResolvedValue(storedRow({ id: "a", role: "assistant",
        content: versions[index].content, versionsJson: JSON.stringify(versions), activeVersion: index }));
      await useChatStore.getState().switchMessageVersion("a", index);
      expect(useChatStore.getState().messages[1].kbEvidence).toEqual(index === 0 ? evidence : nextEvidence);
    }
  });

  it("keeps evidence on cancellation, rejects late events, and isolates concurrent targets", () => {
    useChatStore.setState({ messages: [
      { id: "a", role: "assistant", content: "", status: "streaming" },
      { id: "b", role: "assistant", content: "", status: "streaming" },
    ], streams: {
      r1: { messageId: "a", startedAt: 1, conversationId: null },
      r2: { messageId: "b", startedAt: 1, conversationId: null },
    } });
    useChatStore.getState().markKbUsed("r1", 1, ["原文档"], evidence);
    useChatStore.getState().stopStream("r1");
    useChatStore.getState().markKbUsed("r1", 1, ["伪造"], [{ ...evidence[0], snippet: "迟到" }]);
    expect(useChatStore.getState().messages[0].kbEvidence).toEqual(evidence);
    expect(useChatStore.getState().messages[1].kbEvidence).toBeUndefined();
    expect(useChatStore.getState().streams.r2).toBeDefined();
  });

  it("does not resurrect pre-import evidence on same-ID restored history", async () => {
    seedImport();
    useChatStore.setState({ messages: [{ id: "a1", role: "assistant", content: "旧回答", status: "done", kbEvidence: evidence }] });
    await useChatStore.getState().importBackup("mock.json", "replace");
    expect(useChatStore.getState().messages[0]).toMatchObject({ kbEvidenceUnavailable: true });
    expect(useChatStore.getState().messages[0].kbEvidence).toBeUndefined();
  });
});

describe("version persistence review regressions", () => {
  it("rechecks persistence after a fast finish waits for initial history", async () => {
    useHistoryStore.setState({ activeId: "c1", conversations: [importedConversation] });
    const initial = deferred<void>();
    vi.mocked(historyApi.beginChatTurn).mockImplementationOnce(() => initial.promise);
    const sending = useChatStore.getState().send("问题");
    await vi.waitFor(() => expect(historyApi.beginChatTurn).toHaveBeenCalled());
    const rid = Object.keys(useChatStore.getState().streams)[0];
    const assistantId = useChatStore.getState().messages[1].id;
    useChatStore.getState().appendDelta(rid, "原回答");
    useChatStore.getState().onFinish(rid);
    expect(useChatStore.getState().messages[1].historyPersisted).toBe(false);
    vi.mocked(historyApi.startMessageVersion).mockResolvedValueOnce(storedRow({
      id: assistantId, role: "assistant", status: "streaming",
      versionsJson: JSON.stringify([
        { content: "原回答", status: "done", createdAt: 1 },
        { content: "", status: "streaming", createdAt: 2 },
      ]), activeVersion: 1,
    }));
    const regenerating = useChatStore.getState().regenerate(assistantId);
    expect(historyApi.startMessageVersion).not.toHaveBeenCalled();
    initial.resolve();
    await Promise.all([sending, regenerating]);
    expect(historyApi.startMessageVersion).toHaveBeenCalledWith(assistantId);
    expect(useChatStore.getState().messages[1].historyPersisted).toBe(true);
    const retryId = Object.keys(useChatStore.getState().streams)[0];
    useChatStore.getState().appendDelta(retryId, "新回答");
    useChatStore.getState().onFinish(retryId);
    await vi.waitFor(() => expect(historyApi.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: assistantId, conversationId: "c1", content: "新回答", status: "done" }),
    ));
  });

  it("switches an unpersisted retry version locally inside a saved conversation", async () => {
    useHistoryStore.setState({ activeId: "c1", conversations: [importedConversation] });
    useChatStore.setState({ messages: [{
      id: "local-answer", role: "assistant", content: "新回答", status: "done", historyPersisted: false,
      versions: [
        { content: "原回答", status: "done", createdAt: 1 },
        { content: "新回答", status: "done", createdAt: 2 },
      ], activeVersion: 1,
    }] });
    await useChatStore.getState().switchMessageVersion("local-answer", 0);
    expect(historyApi.activateMessageVersion).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages[0]).toMatchObject({
      content: "原回答", activeVersion: 0, historyPersisted: false,
    });
  });
});

describe("cancellation and image replay regressions", () => {
  it("does not launch chat_send after stop during image compression", async () => {
    seedVisionModel();
    const images = mockImages();
    const sending = useChatStore.getState().send("图片", [imageUrl]);
    useChatStore.getState().stop();
    images[0].onerror();
    await sending;
    expect(mockedInvoke).not.toHaveBeenCalledWith("chat_send", expect.anything());
    expect(historyApi.beginChatTurn).not.toHaveBeenCalled();
    expect(historyApi.saveMessage).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages[1].status).toBe("cancelled");
  });

  it("ignores a compression exception that arrives after cancellation", async () => {
    seedVisionModel();
    let fail!: () => void;
    vi.stubGlobal("Image", class {
      onload = () => {};
      get width(): number { throw new Error("decode failed"); }
      set src(_value: string) { fail = () => this.onload(); }
    });
    const sending = useChatStore.getState().send("图片", [imageUrl]);
    useChatStore.getState().stop();
    fail();
    await sending;
    expect(useChatStore.getState().messages[1].status).toBe("cancelled");
    expect(mockedInvoke).not.toHaveBeenCalledWith("chat_send", expect.anything());
  });

  it("does not launch the main request after stopping a vision description", async () => {
    useProvidersStore.setState({ visionProviderId: "p1", visionModelKey: "vision" });
    const images = mockImages();
    const description = deferred<string>();
    mockedInvoke.mockImplementation((command) => command === "describe_image" ? description.promise : Promise.resolve(undefined));
    const sending = useChatStore.getState().send("图片", [imageUrl, imageUrl]);
    images[0].onerror();
    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("describe_image", expect.anything()));
    useChatStore.getState().stop();
    description.reject(new Error("描述失败"));
    await sending;
    expect(images).toHaveLength(1);
    expect(mockedInvoke).not.toHaveBeenCalledWith("chat_send", expect.anything());
    expect(useChatStore.getState().messages[1].status).toBe("cancelled");
  });

  it("keeps cancelled state when an unregistered request rejects late", async () => {
    const registration = deferred<unknown>();
    mockedInvoke.mockImplementation((command) => command === "chat_send" ? registration.promise : Promise.resolve(undefined));
    const sending = useChatStore.getState().send("问题");
    useChatStore.getState().stop();
    registration.reject(new Error("late failure"));
    await sending;
    expect(useChatStore.getState().messages[1].status).toBe("cancelled");
  });

  it("cancels again after registration and does not initialize stopped history", async () => {
    const registration = deferred<unknown>();
    mockedInvoke.mockImplementation((command) => command === "chat_send" ? registration.promise : Promise.resolve(undefined));
    const sending = useChatStore.getState().send("问题");
    useChatStore.getState().stop();
    registration.resolve(undefined);
    await sending;
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "chat_cancel")).toHaveLength(2);
    expect(historyApi.beginChatTurn).not.toHaveBeenCalled();
  });

  it("does not replace cancellation when initial history rejects", async () => {
    const initial = deferred<void>();
    vi.mocked(historyApi.beginChatTurn).mockImplementationOnce(() => initial.promise);
    const sending = useChatStore.getState().send("问题");
    await vi.waitFor(() => expect(historyApi.beginChatTurn).toHaveBeenCalled());
    useChatStore.getState().stop();
    initial.reject(new Error("history unavailable"));
    await sending;
    expect(useChatStore.getState().messages[1].status).toBe("cancelled");
    expect(useHistoryStore.getState().activeId).toBeNull();
  });

  it("does not create a new stream after stopping version initialization", async () => {
    seedImport();
    useChatStore.setState({ messages: [
      { id: "u1", role: "user", content: "问题", status: "done" },
      { id: "a1", role: "assistant", content: "旧回答", status: "done" },
    ] });
    const version = deferred<historyApi.StoredMessage>();
    vi.mocked(historyApi.startMessageVersion).mockImplementationOnce(() => version.promise);
    const regenerating = useChatStore.getState().regenerate("a1");
    await vi.waitFor(() => expect(historyApi.startMessageVersion).toHaveBeenCalled());
    useChatStore.getState().stop();
    version.resolve(storedRow({ id: "a1", role: "assistant", status: "streaming" }));
    await regenerating;
    expect(mockedInvoke).not.toHaveBeenCalledWith("chat_send", expect.anything());
    expect(useChatStore.getState().streams).toEqual({});
    expect(useChatStore.getState().messages[1].status).toBe("cancelled");
  });

  it("regenerates an image prompt without history recording", async () => {
    useHistoryStore.setState({ historyEnabled: false });
    seedVisionModel();
    const images = mockImages();
    useChatStore.setState({ messages: [
      { id: "u1", role: "user", content: "图片问题", images: [imageUrl], status: "done" },
      { id: "a1", role: "assistant", content: "旧回答", status: "done" },
    ] });
    const regenerating = useChatStore.getState().regenerate("a1");
    await vi.waitFor(() => expect(images).toHaveLength(1));
    images[0].onerror();
    await regenerating;
    expect(mockedInvoke).toHaveBeenCalledWith("chat_send", expect.objectContaining({ request: expect.objectContaining({
      messages: [{ role: "user", content: "图片问题", images: [imageUrl] }],
    }) }));
    expect(historyApi.startMessageVersion).not.toHaveBeenCalled();
  });

  it("retries an image preprocessing failure in an existing chat without archiving a missing DB row", async () => {
    useHistoryStore.setState({ activeId: "c1", conversations: [importedConversation] });
    await useChatStore.getState().send("看图", [imageUrl], true, true);
    const assistant = useChatStore.getState().messages[1];
    expect(assistant.status).toBe("error");
    expect(historyApi.beginChatTurn).not.toHaveBeenCalled();
    seedVisionModel();
    const images = mockImages();
    const regenerating = useChatStore.getState().regenerate(assistant.id);
    await vi.waitFor(() => expect(images).toHaveLength(1));
    images[0].onerror();
    await regenerating;
    expect(historyApi.startMessageVersion).not.toHaveBeenCalled();
    expect(mockedInvoke).toHaveBeenCalledWith("chat_send", expect.objectContaining({ request: expect.objectContaining({
      messages: [{ role: "user", content: "看图", images: [imageUrl] }], webSearch: true, enableTools: true,
    }) }));
  });

  it("replays persisted image payloads through regenerate", async () => {
    seedVisionModel();
    const images = mockImages();
    vi.mocked(historyApi.getConversation).mockResolvedValue({
      conversation: importedConversation,
      messages: [
        storedRow({ id: "u1", role: "user", content: "已保存图片", imagesJson: JSON.stringify([imageUrl]) }),
        storedRow({ id: "a1", role: "assistant", content: "原回答" }),
      ],
    });
    vi.mocked(historyApi.startMessageVersion).mockResolvedValue(storedRow({ id: "a1", role: "assistant", status: "streaming" }));
    await useChatStore.getState().loadConversation("c1");
    const regenerating = useChatStore.getState().regenerate("a1");
    await vi.waitFor(() => expect(images).toHaveLength(1));
    images[0].onerror();
    await regenerating;
    expect(mockedInvoke).toHaveBeenCalledWith("chat_send", expect.objectContaining({ request: expect.objectContaining({
      messages: [{ role: "user", content: "已保存图片", images: [imageUrl] }],
    }) }));
  });

  it("uses vision fallback on retry without sending raw images to a text model", async () => {
    useHistoryStore.setState({ historyEnabled: false });
    useProvidersStore.setState({ visionProviderId: "p1", visionModelKey: "vision" });
    const images = mockImages();
    mockedInvoke.mockResolvedValue("图片中有一只猫");
    useChatStore.setState({ messages: [
      { id: "old", role: "user", content: "历史图片", images: [imageUrl], status: "done" },
      { id: "u1", role: "user", content: "图片问题", images: [imageUrl], status: "done" },
      { id: "a1", role: "assistant", content: "", status: "error", retryable: true },
    ] });
    const regenerating = useChatStore.getState().regenerate("a1", { disableTools: true });
    await vi.waitFor(() => expect(images).toHaveLength(1));
    images[0].onerror();
    await regenerating;
    const call = mockedInvoke.mock.calls.find(([command]) => command === "chat_send");
    expect(call?.[1]).toMatchObject({ request: { messages: [
      { role: "user", content: "历史图片" },
      { role: "user", content: expect.stringContaining("图片中有一只猫") },
    ], enableTools: false } });
    expect(JSON.stringify(call?.[1])).not.toContain(imageUrl);
  });
});

describe("backup import coordination regressions", () => {
  it.each(["replace", "merge"] as const)("invalidates same-ID and background caches on %s", async (strategy) => {
    seedImport();
    await useChatStore.getState().importBackup("mock.json", strategy);
    expect(useHistoryStore.getState().activeId).toBe("c1");
    expect(useChatStore.getState().messages[0].content).toBe("导入数据");
    expect(useChatStore.getState().backgroundMessages).toEqual({});
    expect(useChatStore.getState().unreadDone).toEqual({});
  });

  it("abandons image preprocessing without blocking import", async () => {
    seedImport();
    seedVisionModel();
    const images = mockImages();
    const sending = useChatStore.getState().send("图片", [imageUrl]);
    await useChatStore.getState().importBackup("mock.json", "replace");
    images[0].onerror();
    await sending;
    expect(mockedInvoke).not.toHaveBeenCalledWith("chat_send", expect.anything());
    expect(useChatStore.getState().messages[0].content).toBe("导入数据");
  });

  it("waits for pending registration and cancels it again before import", async () => {
    seedImport();
    const registration = deferred<unknown>();
    mockedInvoke.mockImplementation((command) => command === "chat_send" ? registration.promise : Promise.resolve(undefined));
    const sending = useChatStore.getState().send("问题");
    const importing = useChatStore.getState().importBackup("mock.json", "replace");
    await Promise.resolve();
    expect(mockedInvoke).not.toHaveBeenCalledWith("import_data", expect.anything());
    registration.resolve(undefined);
    await Promise.all([sending, importing]);
    expect(historyApi.beginChatTurn).not.toHaveBeenCalled();
    const commands = mockedInvoke.mock.calls.map(([command]) => command);
    expect(commands).toEqual([
      "chat_send", "chat_cancel", "chat_cancel", "import_data",
      "list_assistants", "list_image_generations", "tasks_list",
    ]);
  });

  it("drains history initialization and its cancelled final write before import", async () => {
    seedImport();
    const initial = deferred<void>();
    vi.mocked(historyApi.beginChatTurn).mockImplementationOnce(() => initial.promise);
    const sending = useChatStore.getState().send("问题");
    await vi.waitFor(() => expect(historyApi.beginChatTurn).toHaveBeenCalled());
    const importing = useChatStore.getState().importBackup("mock.json", "replace");
    await Promise.resolve();
    expect(mockedInvoke).not.toHaveBeenCalledWith("import_data", expect.anything());
    initial.resolve();
    await Promise.all([sending, importing]);
    expect(historyApi.saveMessage).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
    expect(useChatStore.getState().messages[0].content).toBe("导入数据");
  });

  it("rejects late pre-import list and conversation loads", async () => {
    seedImport();
    const oldList = deferred<historyApi.Conversation[]>();
    const oldDetail = deferred<historyApi.ConversationDetail>();
    vi.mocked(historyApi.listConversations).mockImplementationOnce(() => oldList.promise);
    vi.mocked(historyApi.getConversation).mockImplementationOnce(() => oldDetail.promise);
    const refreshing = useHistoryStore.getState().refreshList();
    const loading = useChatStore.getState().loadConversation("c3");
    await useChatStore.getState().importBackup("mock.json", "replace");
    oldList.resolve([{ ...importedConversation, title: "旧列表" }]);
    oldDetail.resolve({ conversation: { ...importedConversation, id: "c3" }, messages: [] });
    await Promise.all([refreshing, loading]);
    expect(useHistoryStore.getState().conversations[0].title).toBe("导入会话");
    expect(useHistoryStore.getState().activeId).toBe("c1");
    expect(useChatStore.getState().messages[0].content).toBe("导入数据");
  });

  it("clears an active conversation missing after replacement", async () => {
    seedImport();
    vi.mocked(historyApi.listConversations).mockResolvedValue([]);
    await useChatStore.getState().importBackup("mock.json", "replace");
    expect(useHistoryStore.getState().activeId).toBeNull();
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it("cancels background streams as well as the displayed conversation", async () => {
    seedImport();
    const rid = await sendAndGetRid("后台运行");
    useChatStore.getState().startNewConversation();
    await useChatStore.getState().importBackup("mock.json", "merge");
    expect(mockedInvoke).toHaveBeenCalledWith("chat_cancel", { requestId: rid });
    expect(useChatStore.getState().streams).toEqual({});
    expect(useChatStore.getState().backgroundMessages).toEqual({});
  });

  it("releases the import lock without clearing local data if import fails", async () => {
    seedImport();
    mockedInvoke.mockRejectedValueOnce(new Error("invalid backup"));
    await expect(useChatStore.getState().importBackup("mock.json", "replace")).rejects.toThrow("invalid backup");
    expect(useChatStore.getState().importingBackup).toBe(false);
    expect(useChatStore.getState().messages[0].content).toBe("旧数据");
  });

  it("drains a pending edit without regenerating or applying its stale row", async () => {
    seedImport();
    useChatStore.setState({ messages: [
      { id: "u1", role: "user", content: "问题", status: "done" },
      { id: "a1", role: "assistant", content: "回答", status: "done" },
    ] });
    const edit = deferred<historyApi.StoredMessage>();
    vi.mocked(historyApi.editMessage).mockImplementationOnce(() => edit.promise);
    const editing = useChatStore.getState().editMessage("u1", "新问题");
    const importing = useChatStore.getState().importBackup("mock.json", "replace");
    await Promise.resolve();
    expect(mockedInvoke).not.toHaveBeenCalledWith("import_data", expect.anything());
    edit.resolve(storedRow({ id: "u1", role: "user", content: "过期编辑" }));
    await Promise.all([editing, importing]);
    expect(mockedInvoke).not.toHaveBeenCalledWith("chat_send", expect.anything());
    expect(useChatStore.getState().messages[0].content).toBe("导入数据");
  });

  it("cancels all requests and waits for existing saves before importing", async () => {
    seedImport();
    const rid = await sendAndGetRid("运行中");
    const save = deferred<void>();
    vi.mocked(historyApi.saveMessage).mockImplementationOnce(() => save.promise);
    const importing = useChatStore.getState().importBackup("mock.json", "replace");
    await Promise.resolve();
    expect(mockedInvoke).toHaveBeenCalledWith("chat_cancel", { requestId: rid });
    expect(mockedInvoke).not.toHaveBeenCalledWith("import_data", expect.anything());
    await useChatStore.getState().send("不得发送");
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "chat_send")).toHaveLength(1);
    save.resolve();
    await importing;
    useChatStore.getState().appendDelta(rid, "迟到内容");
    useChatStore.getState().onFinish(rid);
    expect(useChatStore.getState().messages[0].content).toBe("导入数据");
    expect(mockedInvoke).toHaveBeenCalledWith("import_data", { path: "mock.json", strategy: "replace" });
  });
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
        approvalSessionId: expect.any(String),
        skillIds: [],
        contextExclusions: EMPTY_CONTEXT_EXCLUSIONS,
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

  it("waits for the initial history transaction before persisting a fast final event", async () => {
    let release!: () => void;
    vi.mocked(historyApi.beginChatTurn).mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const sending = useChatStore.getState().send("快速问题");
    await Promise.resolve();
    const rid = Object.keys(useChatStore.getState().streams)[0]!;
    useChatStore.getState().appendDelta(rid, "快速回答");
    useChatStore.getState().onFinish(rid, "stop");
    expect(historyApi.saveMessage).not.toHaveBeenCalled();
    release();
    await sending;
    await Promise.resolve();
    expect(historyApi.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: expect.any(String), content: "快速回答", status: "done" }),
    );
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
        approvalSessionId: expect.any(String),
        skillIds: [],
        contextExclusions: EMPTY_CONTEXT_EXCLUSIONS,
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

  it("branchFrom cuts locally when history recording is off", async () => {
    // With recording off there is nothing to persist, so the shortcut keeps
    // the old in-memory behaviour: keep up to the chosen message and stop.
    useHistoryStore.setState({ historyEnabled: false, activeId: null });

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
    await useChatStore.getState().branchFrom(firstAssistant!.id);

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

describe("branchFrom() 创建分支", () => {
  const sourceMessages = [
    { id: "u1", role: "user" as const, content: "问题", status: "done" as const },
    { id: "a1", role: "assistant" as const, content: "回答", status: "done" as const },
    { id: "u2", role: "user" as const, content: "追问", status: "done" as const },
  ];

  it("persists the branch and switches to the new conversation", async () => {
    useHistoryStore.setState({ activeId: "c1", historyEnabled: true });
    useChatStore.setState({ messages: sourceMessages });
    vi.mocked(historyApi.branchConversation).mockResolvedValue({
      conversation: {
        id: "c2",
        title: "问题 · 分支",
        providerId: "p1",
        modelKey: "m1",
        systemPrompt: null,
        assistantId: null,
        pinned: false,
        createdAt: 2,
        updatedAt: 2,
      },
      messages: [
        { id: "nu1", conversationId: "c2", role: "user", content: "问题", status: "done", createdAt: 1 },
        { id: "na1", conversationId: "c2", role: "assistant", content: "回答", status: "done", createdAt: 2 },
      ],
    });

    await useChatStore.getState().branchFrom("a1");

    expect(historyApi.branchConversation).toHaveBeenCalledWith("c1", "a1");
    expect(useHistoryStore.getState().activeId).toBe("c2");
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(["nu1", "na1"]);
    expect(useChatStore.getState().messages[1].content).toBe("回答");
  });

  it("discards a stale branch when the user navigated away", async () => {
    useHistoryStore.setState({ activeId: "c1", historyEnabled: true });
    useChatStore.setState({ messages: sourceMessages });
    vi.mocked(historyApi.branchConversation).mockImplementation(async () => {
      // The user switches conversations while the backend copies the messages.
      useHistoryStore.setState({ activeId: "other" });
      useChatStore.setState({ approvalSessionId: "rotated" });
      return {
        conversation: {
          id: "c2",
          title: "问题 · 分支",
          providerId: "p1",
          modelKey: "m1",
          systemPrompt: null,
          assistantId: null,
          pinned: false,
          createdAt: 2,
          updatedAt: 2,
        },
        messages: [],
      };
    });

    await useChatStore.getState().branchFrom("a1");

    expect(useHistoryStore.getState().activeId).toBe("other");
    expect(useChatStore.getState().messages).toHaveLength(3);
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
    await Promise.resolve();
    state = useChatStore.getState();
    expect(state.unreadDone[convA]).toBe(true);
    expect(historyApi.saveMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversationId: convA, content: "后台回答", status: "done" }),
    );
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
