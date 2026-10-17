import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  AttachmentMeta,
  Message,
  MessageStatus,
  MessageVersion,
  ModelEntry,
  ProviderView,
  Role,
  SearchResult,
  ToolCallStep,
} from "../types";
import { currentModel, modelFor, useProvidersStore } from "./providers-store";
import { activeAssistant, useAssistantsStore } from "./assistants-store";
import { useHistoryStore } from "../services/history-store";
import * as historyApi from "../services/history-api";
import { importData, type ImportReport, type ImportStrategy } from "../services/backup-api";
import { writeClipboardText } from "../services/tools-api";
import { useWindowStore } from "./window-store";
import type { ThinkingEffort } from "./settings-store";

let seq = 0;
const nextId = () => `msg-${Date.now().toString(36)}-${++seq}`;
const nextConvId = () => `conv-${Date.now().toString(36)}-${++seq}`;

/** How many past messages are sent as context. */
const CONTEXT_LIMIT = 40;

function asStatus(s: string): MessageStatus {
  if (s === "streaming" || s === "done" || s === "error" || s === "cancelled") {
    return s;
  }
  return "done";
}

function asRole(s: string): Role {
  return s === "assistant" ? "assistant" : "user";
}

/** Parse the persisted tool-calls JSON array back into steps, if any. */
function parseToolCalls(raw?: string | null): ToolCallStep[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as ToolCallStep[];
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Map a stored database row onto the in-memory message shape. */
function storedMessageToMessage(m: historyApi.StoredMessage): Message {
  return {
    id: m.id,
    role: asRole(m.role),
    content: m.content,
    status: asStatus(m.status),
    reasoning: m.reasoning ?? undefined,
    toolCalls: parseToolCalls(m.toolCalls),
    modelName: m.modelName ?? undefined,
    durationMs: m.durationMs ?? undefined,
    usage:
      m.inputTokens != null || m.outputTokens != null
        ? {
            inputTokens: m.inputTokens ?? undefined,
            outputTokens: m.outputTokens ?? undefined,
          }
        : undefined,
    versions: historyApi.parseVersionsJson(m.versionsJson),
    activeVersion: m.activeVersion ?? 0,
    attachments: historyApi.parseAttachmentsJson(m.attachmentsJson),
    images: historyApi.parseImagesJson(m.imagesJson),
  };
}

/* ------------------------------------------------------------------ */
/* Message version stacks (P0-1)                                       */
/* ------------------------------------------------------------------ */

/** Snapshot a message's own fields as a version entry. */
function snapshotVersion(msg: Message): MessageVersion {
  return {
    content: msg.content,
    reasoning: msg.reasoning,
    modelName: msg.modelName,
    durationMs: msg.durationMs,
    status: msg.status,
    createdAt: Date.now(),
  };
}

/**
 * Build a version stack locally (used when history recording is off, so no
 * backend mirror exists).  Mirrors the Rust-side rule: seed the stack with
 * the message's current state on first use, then append the new version.
 */
function appendVersionLocally(
  msg: Message,
  version: MessageVersion,
): { versions: MessageVersion[]; activeVersion: number } {
  const versions = msg.versions ? [...msg.versions] : [snapshotVersion(msg)];
  versions.push(version);
  return { versions, activeVersion: versions.length - 1 };
}

/** Keep `versions[activeVersion]` in step with the message's own fields. */
function syncActiveVersion(msg: Message): Message {
  if (!msg.versions || msg.activeVersion == null) return msg;
  const active = msg.activeVersion;
  return {
    ...msg,
    versions: msg.versions.map((v, i) =>
      i === active
        ? {
            ...v,
            content: msg.content,
            reasoning: msg.reasoning,
            modelName: msg.modelName,
            durationMs: msg.durationMs,
            status: msg.status,
          }
        : v,
    ),
  };
}

/** Fields a persisted row carries that the store mirrors onto a local message. */
type StoredRowMirror = {
  content: string;
  reasoning?: string | null;
  modelName?: string | null;
  durationMs?: number | null;
  status: string;
  versionsJson?: string | null;
  activeVersion?: number;
};

/** Apply a versioned row (returned by the version commands) onto a message. */
function applyStoredRow(msg: Message, row: StoredRowMirror): Message {
  return {
    ...msg,
    content: row.content,
    reasoning: row.reasoning ?? undefined,
    modelName: row.modelName ?? undefined,
    durationMs: row.durationMs ?? undefined,
    status: asStatus(row.status),
    error: undefined,
    versions: historyApi.parseVersionsJson(row.versionsJson),
    activeVersion: row.activeVersion ?? 0,
  };
}

/** A resolved provider/model pair for one turn. */
type ModelSelection = { provider: ProviderView; model: ModelEntry } | null;

/**
 * Resolve the model + system prompt for a turn (P1-7, 对话级模型).
 *
 * Priority for the system prompt: the conversation's own override > the bound
 * assistant's prompt > the global default.
 *
 * Priority for the model: the conversation's own binding (对话级模型, set from
 * the composer) > the draft selection of a fresh chat > the assistant's pinned
 * model > the global default.
 */
function resolveTurnContext(conversationId: string | null): {
  selection: ModelSelection;
  systemPrompt: string | null;
  assistantId: string | null;
} {
  const assistant = activeAssistant();
  const historyState = useHistoryStore.getState();
  const conversation = conversationId
    ? historyState.conversations.find((c) => c.id === conversationId) ?? null
    : null;
  const draft = useChatStore.getState().draftSelection;

  const selection =
    (conversation?.providerId
      ? modelFor(conversation.providerId, conversation.modelKey)
      : null) ??
    (!conversationId && draft ? modelFor(draft.providerId, draft.modelKey) : null) ??
    modelFor(assistant?.providerId ?? null, assistant?.modelKey ?? null) ??
    currentModel();

  const conversationPrompt = conversation?.systemPrompt ?? null;
  const systemPrompt =
    conversationPrompt ||
    (assistant?.systemPrompt?.trim() ? assistant.systemPrompt : null) ||
    useProvidersStore.getState().defaultSystemPrompt;

  return { selection, systemPrompt, assistantId: assistant?.id ?? null };
}

/** One in-flight generation, addressed by its request id. */
export interface ActiveStream {
  /** Assistant message this stream fills (always present in `messages`). */
  messageId: string;
  /** Wall-clock start, used for the per-message duration badge. */
  startedAt: number;
  /** Reserved conversation ID from the beginning of a recorded turn; null
   * when history recording is disabled. Drives background routing. */
  conversationId: string | null;
  /** Shared with async setup; cancellation survives removing the stream slot. */
  lifecycle?: { cancelled: boolean; setupStarted: boolean };
}

/** One model of a multi-model turn (P1-6). */
export interface ModelTarget {
  providerId: string;
  modelKey: string;
}

/**
 * Apply `updater` to one message wherever it lives: the visible list or one
 * of the background conversation snapshots.  Unknown ids are ignored, so
 * events from a cancelled or finished stream can never touch anything — and
 * a background generation keeps updating its own snapshot while the user is
 * reading another conversation.
 */
function patchMessage(
  state: { messages: Message[]; backgroundMessages: Record<string, Message[]> },
  messageId: string,
  updater: (msg: Message) => Message,
): Partial<ChatState> {
  if (state.messages.some((m) => m.id === messageId)) {
    return {
      messages: state.messages.map((m) => (m.id === messageId ? updater(m) : m)),
    };
  }
  for (const [conversationId, list] of Object.entries(state.backgroundMessages)) {
    if (list.some((m) => m.id === messageId)) {
      return {
        backgroundMessages: {
          ...state.backgroundMessages,
          [conversationId]: list.map((m) => (m.id === messageId ? updater(m) : m)),
        },
      };
    }
  }
  return {};
}

/**
 * Apply an update to the message a specific stream is filling.  Unknown
 * request ids are ignored, so events from a cancelled or finished stream can
 * never touch the list.
 */
function patchStream(
  state: {
    streams: Record<string, ActiveStream>;
    messages: Message[];
    backgroundMessages: Record<string, Message[]>;
  },
  requestId: string,
  updater: (msg: Message) => Message,
): Partial<ChatState> {
  const stream = state.streams[requestId];
  if (!stream) return {};
  return patchMessage(state, stream.messageId, updater);
}

/** Drop one stream from the map without mutating the original. */
function withoutStream(
  streams: Record<string, ActiveStream>,
  requestId: string,
): Record<string, ActiveStream> {
  const { [requestId]: _removed, ...rest } = streams;
  return rest;
}

function isVisibleStream(stream: ActiveStream, activeId: string | null, messages: Message[]): boolean {
  return activeId ? stream.conversationId === activeId : messages.some((m) => m.id === stream.messageId);
}

function visibleConversationId(
  state: { streams: Record<string, ActiveStream>; messages: Message[] },
  activeId: string | null,
): string | null {
  if (activeId) return activeId;
  const visibleMessageIds = new Set(state.messages.map((message) => message.id));
  return Object.values(state.streams).find(
    (stream) => stream.conversationId && visibleMessageIds.has(stream.messageId),
  )?.conversationId ?? null;
}

/** Whether the displayed chat is generating (other chats remain usable). */
export function useActiveStreaming(): boolean {
  const streams = useChatStore((s) => s.streams);
  const messages = useChatStore((s) => s.messages);
  const activeId = useHistoryStore((s) => s.activeId);
  return Object.values(streams).some((stream) => isVisibleStream(stream, activeId, messages));
}

/** Selector: request id of the stream filling `messageId`, if any. */
export function streamRequestIdForMessage(
  state: { streams: Record<string, ActiveStream> },
  messageId: string,
): string | null {
  for (const [requestId, stream] of Object.entries(state.streams)) {
    if (stream.messageId === messageId) return requestId;
  }
  return null;
}

interface ChatState {
  /** Import owns a write barrier until caches have been refreshed. */
  importingBackup: boolean;
  importBackup: (path: string, strategy: ImportStrategy) => Promise<ImportReport>;
  messages: Message[];
  /**
   * In-flight generations keyed by request id.  Normally exactly one entry;
   * a multi-model turn (P1-6) keeps one per column, which is what makes the
   * parallel streams independently routable.
   */
  streams: Record<string, ActiveStream>;
  /**
   * Bumped every time a "new conversation" starts. The Composer watches this
   * to re-focus the input so the user lands right on the fresh composer.
   */
  conversationNonce: number;
  /** Ephemeral scope of tool approvals for the currently displayed chat. */
  approvalSessionId: string;
  /**
   * Snapshot of the last send() options so retryLast() can replay the same
   * web-search / agent-tools configuration instead of silently dropping it.
   */
  lastSendOptions: {
    webSearch: boolean;
    enableTools: boolean;
    enableThinking: boolean;
    thinkingEffort: ThinkingEffort;
    /** Manually activated skills (自定义技能) replayed by retry / regenerate. */
    skillIds: string[];
  } | null;
  /**
   * When set (via a clipboard quick action), the next assistant reply is
   * written back to the clipboard on finish. Cleared after the writeback.
   */
  clipboardWriteback: string | null;
  /**
   * Message the message list should scroll to and highlight (set when the
   * user opens a full-text search hit). Cleared once handled.
   */
  focusMessageId: string | null;
  /**
   * Text the composer should load into its input and focus (set by the
   * empty-state suggestion chips). Cleared once the composer has applied it,
   * mirroring `focusMessageId` above — a one-shot signal, not persisted state.
   */
  composerPrefill: string | null;
  /**
   * Models picked for the next multi-model comparison (P1-6). Empty means a
   * normal single-model send.
   */
  compareTargets: ModelTarget[];
  /**
   * Message lists of conversations that are **not** currently displayed.
   *
   * Switching away from a conversation snapshots its messages here instead
   * of dropping them: generations keep flowing into the snapshot (see
   * `patchMessage`) and switching back is instant.
   */
  backgroundMessages: Record<string, Message[]>;
  /**
   * Conversations whose generation finished while a different conversation
   * was on screen.  The sidebar shows a dot; opening the conversation clears
   * it.
   */
  unreadDone: Record<string, true>;
  /**
   * Provider/model picked while no conversation exists yet (a fresh chat).
   * The conversation created by the next send binds to it.
   */
  draftSelection: ModelTarget | null;

  /** Arm the clipboard writeback for the next assistant reply. */
  armClipboardWriteback: (label: string) => void;
  /** Set (or clear, with an empty list) the comparison targets. */
  setCompareTargets: (targets: ModelTarget[]) => void;
  /** Ask the message list to reveal a specific message. */
  focusMessage: (messageId: string) => void;
  /** Called by the message list once the focus request has been handled. */
  clearFocusMessage: () => void;
  setComposerPrefill: (text: string) => void;
  clearComposerPrefill: () => void;

  send: (
    text: string,
    images?: string[],
    webSearch?: boolean,
    enableTools?: boolean,
    enableThinking?: boolean,
    thinkingEffort?: ThinkingEffort,
    /** Metadata of documents already folded into `text` (P1-8). */
    attachments?: AttachmentMeta[],
    /** Skills manually activated in the composer (自定义技能). */
    skillIds?: string[],
  ) => Promise<void>;
  /**
   * Send one prompt to several models at once (P1-6).  Text only; the agent
   * loop and vision fallback stay single-model features.
   */
  sendMulti: (
    text: string,
    targets: ModelTarget[],
    webSearch?: boolean,
    enableThinking?: boolean,
    thinkingEffort?: ThinkingEffort,
    /** Skills manually activated in the composer (自定义技能). */
    skillIds?: string[],
  ) => Promise<void>;
  appendDelta: (requestId: string, text: string) => void;
  appendReasoning: (requestId: string, text: string) => void;
  setUsage: (requestId: string, inputTokens?: number, outputTokens?: number) => void;
  /** Show the "searching web…" status while the backend runs a web search. */
  setSearchStatus: (requestId: string, query: string) => void;
  /** Record injected local knowledge-base passages for the hint chip (P1-9). */
  markKbUsed: (requestId: string, count: number, titles: string[]) => void;
  /** Attach the search results (sources) to the in-flight assistant message. */
  setSearchResults: (requestId: string, results: SearchResult[]) => void;
  /** Attach a running tool call to the in-flight assistant message. */
  startToolCall: (requestId: string, callId: string, name: string, argumentsText: string) => void;
  finishToolCall: (requestId: string, callId: string, result: string) => void;
  failToolCall: (requestId: string, callId: string, message: string) => void;
  /** Show a tool call awaiting the user's approval. */
  pendingToolCall: (requestId: string, callId: string, name: string, summary: string, canRemember?: boolean) => void;
  /** Mark a tool call as rejected by the user. */
  rejectToolCall: (requestId: string, callId: string) => void;
  /** Deliver the user's verdict (approve/reject) to the backend. */
  resolveToolCall: (
    requestId: string,
    callId: string,
    approved: boolean,
    policy?: "once" | "session" | "always",
  ) => void;
  onFinish: (requestId: string, reason?: string) => void;
  onError: (requestId: string, message: string, retryable: boolean) => void;
  /** Cancel the in-flight generation of the displayed conversation. */
  stop: () => void;
  /** Cancel one column (used by the per-column stop button). */
  stopStream: (requestId: string) => void;
  /** Re-run the last user turn; `disableTools` optionally turns the agent loop off. */
  retryLast: (opts?: RetryOptions) => void;
  /** Edit a user message (kept as a new version) and regenerate its reply. */
  editMessage: (messageId: string, content: string) => Promise<void>;
  /** Re-run an assistant reply in place, archiving the current answer. */
  regenerate: (messageId: string, opts?: RetryOptions) => Promise<void>;
  /** Switch the displayed version of a message. */
  switchMessageVersion: (messageId: string, index: number) => Promise<void>;
  clearConversation: () => void;
  /** Start a branch from the given message (cut everything after it). */
  branchFrom: (messageId: string) => Promise<void>;
  /** Load a persisted conversation into the message list. */
  loadConversation: (id: string) => Promise<void>;
  /**
   * Bind the displayed conversation (or the next new one) to a provider and
   * model — the composer-level "对话级模型" switch.
   */
  setConversationModel: (providerId: string, modelKey: string) => Promise<void>;
  /** Clear a conversation's "finished" dot (called when it is opened). */
  clearUnreadDone: (conversationId: string) => void;
  /**
   * Start a blank conversation.  Unlike `clearConversation` this keeps every
   * running generation alive (they continue in their own conversations).
   */
  startNewConversation: () => void;
}

/** Tool inputs, results, errors and approval summaries may all contain local data.
 * Persist only the non-content timeline, regardless of tool name or MCP origin.
 */
function persistedToolCalls(calls: ToolCallStep[]): string {
  return JSON.stringify(calls.map(({ callId, name, status, startedAt, finishedAt, durationMs }) => ({
    callId,
    name,
    status,
    arguments: "{}",
    startedAt,
    finishedAt,
    durationMs,
  })));
}

type TurnWrite = {
  ready: Promise<boolean>;
  complete: (saved: boolean) => void;
  settled: boolean;
  saved?: boolean;
};
const turnWrites = new Map<string, TurnWrite>();
const finalWrites = new Map<string, Promise<void>>();
// Track setup/writes, not image decoding or model completion. Import can abandon
// preprocessing immediately, but must drain every already-dispatched DB write.
const pendingOperations = new Set<Promise<unknown>>();
let dataEpoch = 0;
function trackOperation<T>(promise: Promise<T>): Promise<T> {
  pendingOperations.add(promise);
  void promise.then(() => pendingOperations.delete(promise), () => pendingOperations.delete(promise));
  return promise;
}
function cancelBackend(requestId: string): Promise<void> {
  return trackOperation(invoke<void>("chat_cancel", { requestId }).catch(() => undefined));
}
function operationAllowed(epoch: number): boolean {
  return epoch === dataEpoch && !useChatStore.getState().importingBackup;
}

type RequestMessage = { role: Role; content: string; images?: string[] };
type RetryOptions = { disableTools?: boolean };

/** Only the user turn being sent/replayed carries images. Old turns remain text
 * only, so switching to a non-vision model never leaks previous raw images. */
function buildTurnMessages(messages: Message[], userId: string, content: string, images?: string[]): RequestMessage[] {
  return messages
    .map((message) => message.id === userId ? { ...message, content } : message)
    .filter((message) => message.content.length > 0 && message.status !== "error")
    .slice(-CONTEXT_LIMIT)
    .map((message) => ({
      role: message.role,
      content: message.content,
      images: message.role === "user" && message.id === userId ? images : undefined,
    }));
}

async function prepareTurnMessages(
  messages: Message[], user: Message, model: ModelEntry, alive: () => boolean,
): Promise<RequestMessage[] | null> {
  let content = user.content;
  let images: string[] | undefined;
  if (user.images?.length) {
    const { visionProviderId, visionModelKey } = useProvidersStore.getState();
    if (!model.supportsVision && (!visionProviderId || !visionModelKey)) {
      throw new Error("当前模型不支持图片，且未配置视觉模型。请在设置→模型设置中配置默认视觉模型。");
    }
    const descriptions: string[] = [];
    images = [];
    for (const [index, image] of user.images.entries()) {
      if (!alive()) return null;
      const compressed = await compressImage(image);
      if (!alive()) return null;
      if (model.supportsVision) {
        images.push(compressed);
      } else {
        try {
          const description = await invoke<string>("describe_image", { request: {
            providerId: visionProviderId, modelKey: visionModelKey,
            imageDataUrl: compressed,
            prompt: "请详细描述这张图片的内容，包括所有可见的文字、物体、场景和布局。",
          } });
          if (!alive()) return null;
          descriptions.push(`[图片${index + 1}]\n${description}`);
        } catch {
          if (!alive()) return null;
          descriptions.push(`[图片${index + 1}]\n（图片描述失败）`);
        }
      }
    }
    if (!model.supportsVision) {
      content = `${content}\n\n---\n以下是用户上传的图片内容描述：\n\n${descriptions.join("\n\n")}`;
      images = undefined;
    }
  }
  return alive() ? buildTurnMessages(messages, user.id, content, images) : null;
}

function reserveTurnWrite(messageId: string) {
  let complete!: (saved: boolean) => void;
  const entry: TurnWrite = {
    ready: new Promise<boolean>((resolve) => { complete = resolve; }),
    complete: (saved) => {
      if (entry.settled) return;
      entry.settled = true;
      entry.saved = saved;
      complete(saved);
    },
    settled: false,
  };
  turnWrites.set(messageId, entry);
}

function completeTurnWrite(messageId: string, saved: boolean) {
  turnWrites.get(messageId)?.complete(saved);
}

function discardTurnWrite(messageId: string) {
  const entry = turnWrites.get(messageId);
  entry?.complete(false);
  turnWrites.delete(messageId);
}

/** A final answer must never race its placeholder or follow the visible chat. */
function persistAssistantFinal(stream: ActiveStream, status: MessageStatus) {
  const conversationId = stream.conversationId;
  if (!conversationId) return;
  const state = useChatStore.getState();
  const msg = state.messages.find((m) => m.id === stream.messageId)
    ?? state.backgroundMessages[conversationId]?.find((m) => m.id === stream.messageId);
  if (!msg || (msg.historyPersisted === false && !turnWrites.has(msg.id))) return;
  const toolCalls = msg.toolCalls?.length ? persistedToolCalls(msg.toolCalls) : null;
  const barrier = turnWrites.get(msg.id);
  const epoch = dataEpoch;
  const write = (async () => {
    try {
      if (barrier && (barrier.settled ? !barrier.saved : !(await barrier.ready))) return;
      if (epoch !== dataEpoch || !useHistoryStore.getState().historyEnabled) return;
      await historyApi.saveMessage({
        id: msg.id,
        conversationId,
        role: msg.role,
        content: msg.content,
        status,
        reasoning: msg.reasoning ?? null,
        toolCalls,
        modelName: msg.modelName ?? null,
        durationMs: msg.durationMs ?? null,
        inputTokens: msg.usage?.inputTokens ?? null,
        outputTokens: msg.usage?.outputTokens ?? null,
        createdAt: Date.now(),
      });
    } catch (err) {
      console.error("保存会话消息失败:", err);
    } finally {
      turnWrites.delete(msg.id);
    }
  })();
  finalWrites.set(msg.id, write);
  void write.finally(() => {
    if (finalWrites.get(msg.id) === write) finalWrites.delete(msg.id);
  });
}

/** Read a File/data-URL and return a compressed data URL (max ~512px). */
async function compressImage(dataUrl: string, maxDim = 768): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      } catch (error) {
        reject(error);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export const useChatStore = create<ChatState>((set, get) => ({
  importingBackup: false,
  importBackup: async (path, strategy) => {
    if (get().importingBackup) throw new Error("正在导入备份，请稍候。");
    const activeId = useHistoryStore.getState().activeId;
    set({ importingBackup: true, approvalSessionId: nextConvId() });
    // Cancellation changes local state synchronously. Setup that is awaiting
    // chat_send will cancel once more after backend registration acknowledges.
    for (const requestId of Object.keys(get().streams)) get().stopStream(requestId);
    try {
      while (pendingOperations.size || finalWrites.size) {
        await Promise.allSettled([...pendingOperations, ...finalWrites.values()]);
      }
      dataEpoch++;
      const report = await importData(path, strategy);
      // Do not snapshot the old visible list while reloading a same-ID import.
      set((state) => ({
        messages: [], backgroundMessages: {}, unreadDone: {}, streams: {},
        lastSendOptions: null, focusMessageId: null, clipboardWriteback: null,
        conversationNonce: state.conversationNonce + 1, approvalSessionId: nextConvId(),
      }));
      useHistoryStore.getState().setActive(null);
      useAssistantsStore.getState().setActive(null);
      await useHistoryStore.getState().refreshList();
      if (activeId && useHistoryStore.getState().conversations.some((conversation) => conversation.id === activeId)) {
        const detail = await historyApi.getConversation(activeId);
        useHistoryStore.getState().setActive(activeId);
        useAssistantsStore.getState().setActive(detail.conversation.assistantId ?? null);
        set({ messages: detail.messages.map(storedMessageToMessage) });
      }
      return report;
    } finally {
      set({ importingBackup: false });
    }
  },
  messages: [],
  streams: {},
  conversationNonce: 0,
  approvalSessionId: nextConvId(),
  lastSendOptions: null,
  clipboardWriteback: null,
  focusMessageId: null,
  composerPrefill: null,
  compareTargets: [],
  backgroundMessages: {},
  unreadDone: {},
  draftSelection: null,

  armClipboardWriteback: (label) => set({ clipboardWriteback: label }),
  setCompareTargets: (targets) => set({ compareTargets: targets }),
  focusMessage: (messageId) => set({ focusMessageId: messageId }),
  clearFocusMessage: () => set({ focusMessageId: null }),
  setComposerPrefill: (text) => set({ composerPrefill: text }),
  clearComposerPrefill: () => set({ composerPrefill: null }),

  send: async (
    text,
    images,
    webSearch,
    enableTools,
    enableThinking = true,
    thinkingEffort: ThinkingEffort = "medium",
    attachments,
    skillIds,
  ) => {
    if (get().importingBackup) return;
    const epoch = dataEpoch;
    const trimmed = text.trim();
    if (!trimmed && (!images || images.length === 0)) return;

    const { streams, messages, approvalSessionId } = get();
    // Only the displayed conversation is busy-checked: generations in other
    // conversations may keep running while this one sends (multi-conversation).
    const activeConvId = useHistoryStore.getState().activeId;
    if (Object.values(streams).some((stream) => isVisibleStream(stream, activeConvId, messages))) {
      return;
    }

    // Model + prompt come from the conversation binding (对话级模型), then
    // the active assistant (P1-7), then the global default selection.
    const {
      selection,
      systemPrompt,
      assistantId: boundAssistantId,
    } = resolveTurnContext(useHistoryStore.getState().activeId);
    if (!selection || !selection.provider.hasApiKey) {
      useWindowStore.getState().openSettings();
      return;
    }

    const lifecycle = { cancelled: false, setupStarted: false };
    const alive = () => !lifecycle.cancelled && operationAllowed(epoch);
    const hasImages = images && images.length > 0;

    // Create user + assistant messages early so the UI shows immediate
    // feedback (including during the vision-model processing phase).
    const userMessage: Message = {
      id: nextId(),
      role: "user",
      content: trimmed || "(图片)",
      images: hasImages ? images : undefined,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      status: "done",
    };
    const assistantId = nextId();
    const assistantMessage: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
      status: "streaming",
      historyPersisted: false,
      modelName: selection.model.displayName || selection.model.modelKey,
    };

    // Both messages enter the list immediately: a stream always fills an
    // existing message, which is what lets several run in parallel (P1-6)
    // without a separate draft channel.  The request slot is reserved before
    // any async preprocessing so the UI shows the busy state right away and
    // concurrent sends are rejected; the same requestId goes to the backend
    // so stream events match.
    const requestId = `req-${Date.now().toString(36)}-${(seq++).toString(36)}`;
    const historyState = useHistoryStore.getState();
    const initialNonce = get().conversationNonce;
    const conversationId = historyState.historyEnabled
      ? historyState.activeId ?? nextConvId()
      : null;
    const createdNew = historyState.historyEnabled && historyState.activeId === null;
    if (conversationId) reserveTurnWrite(assistantId);
    set({
      messages: [...messages, userMessage, assistantMessage],
      streams: {
        ...streams,
        [requestId]: {
          messageId: assistantId,
          startedAt: Date.now(),
          conversationId,
          lifecycle,
        },
      },
    });

    // Capture even a failed preprocessing attempt so retry keeps its options.
    set({
      lastSendOptions: {
        webSearch: webSearch ?? false,
        enableTools: enableTools ?? false,
        enableThinking,
        thinkingEffort,
        skillIds: skillIds ?? [],
      },
    });

    let history: RequestMessage[];
    try {
      // Text-only sends stay synchronous until the backend dispatch.
      const prepared = hasImages
        ? await prepareTurnMessages([...messages, userMessage], userMessage, selection.model, alive)
        : buildTurnMessages([...messages, userMessage], userMessage.id, trimmed);
      if (!prepared || !alive()) {
        discardTurnWrite(assistantId);
        return;
      }
      history = prepared;
    } catch (err) {
      if (!alive()) { discardTurnWrite(assistantId); return; }
      completeTurnWrite(assistantId, false);
      get().onError(requestId, err instanceof Error ? err.message : String(err), true);
      return;
    }

    // Track the whole setup so import waits for both registration and the
    // initial history transaction, including any final-write barrier it opens.
    lifecycle.setupStarted = true;
    const setup = async () => {
      try {
        await invoke<string>("chat_send", {
          request: {
            providerId: selection.provider.id,
            modelKey: selection.model.modelKey,
            messages: history,
            systemPrompt,
            webSearch: webSearch ?? false,
            enableTools: enableTools ?? false,
            enableThinking,
            thinkingEffort,
            requestId,
            conversationId: conversationId ?? undefined,
            approvalSessionId,
            skillIds: skillIds ?? [],
          },
        });
        if (!alive()) {
          discardTurnWrite(assistantId);
          await cancelBackend(requestId);
          return;
        }

        if (conversationId) {
          const now = Date.now();
          const conversation = createdNew
            ? {
                id: conversationId,
                title: (trimmed || "图片对话").slice(0, 32),
                providerId: selection.provider.id,
                modelKey: selection.model.modelKey,
                systemPrompt: null,
                assistantId: boundAssistantId,
                pinned: false,
                createdAt: now,
                updatedAt: now,
              }
            : null;
          try {
            await historyApi.beginChatTurn({
              conversation,
              userMessage: {
                id: userMessage.id,
                conversationId,
                role: "user",
                content: userMessage.content,
                status: "done",
                attachmentsJson: userMessage.attachments
                  ? JSON.stringify(userMessage.attachments)
                  : null,
                imagesJson: userMessage.images ? JSON.stringify(userMessage.images) : null,
                createdAt: now,
              },
              assistantMessage: {
                id: assistantId,
                conversationId,
                role: "assistant",
                content: "",
                status: "streaming",
                createdAt: now,
              },
              updatedAt: now,
              providerId: selection.provider.id,
              modelKey: selection.model.modelKey,
            });
            completeTurnWrite(assistantId, true);
            set((state) => patchMessage(state, assistantId, (message) => ({ ...message, historyPersisted: true })));
            if (alive() && createdNew && useChatStore.getState().conversationNonce === initialNonce
              && useHistoryStore.getState().activeId === null) {
              useHistoryStore.getState().setActive(conversationId);
            }
            if (alive()) void useHistoryStore.getState().refreshList();
          } catch (err) {
            completeTurnWrite(assistantId, false);
            console.error("保存聊天轮次失败:", err);
          }
        }
      } catch (err) {
        if (!alive()) { discardTurnWrite(assistantId); return; }
        completeTurnWrite(assistantId, false);
        get().onError(requestId, err instanceof Error ? err.message : String(err), true);
      }
    };
    await trackOperation(setup());
  },

  sendMulti: async (
    text,
    targets,
    webSearch,
    enableThinking = true,
    thinkingEffort: ThinkingEffort = "medium",
    skillIds,
  ) => {
    const trimmed = text.trim();
    if (!trimmed || targets.length === 0 || get().importingBackup) return;
    const epoch = dataEpoch;

    const { streams, messages, approvalSessionId } = get();
    // Only the displayed conversation is busy-checked (multi-conversation).
    const activeConvId = useHistoryStore.getState().activeId;
    if (Object.values(streams).some((stream) => isVisibleStream(stream, activeConvId, messages))) {
      return;
    }

    // Resolve every target up front so unknown providers are dropped before
    // any placeholder or backend call is made.
    const resolved = targets
      .slice(0, 4)
      .map((t) => modelFor(t.providerId, t.modelKey))
      .filter((sel): sel is NonNullable<typeof sel> => sel !== null);
    if (resolved.length === 0) {
      useWindowStore.getState().openSettings();
      return;
    }

    const historyStore = useHistoryStore.getState();
    const { systemPrompt, assistantId: boundAssistantId } = resolveTurnContext(
      historyStore.activeId,
    );

    const userMessage: Message = {
      id: nextId(),
      role: "user",
      content: trimmed,
      status: "done",
    };

    // One assistant placeholder (and one request id) per column.
    const requestIds: string[] = [];
    const assistants: Message[] = resolved.map((sel) => {
      requestIds.push(`req-${Date.now().toString(36)}-${(seq++).toString(36)}`);
      return {
        id: nextId(),
        role: "assistant",
        content: "",
        status: "streaming",
        modelName: sel.model.displayName || sel.model.modelKey,
      };
    });

    // Reserve the conversation id before creating the streams so they can be
    // bound to it from the start.
    let conversationId: string | null = historyStore.historyEnabled
      ? historyStore.activeId
      : null;
    const createdNew = historyStore.historyEnabled && !conversationId;
    if (createdNew) conversationId = nextConvId();
    const initialNonce = get().conversationNonce;

    const startedAt = Date.now();
    const streamEntries: Record<string, ActiveStream> = {};
    assistants.forEach((m, index) => {
      streamEntries[requestIds[index]] = {
        messageId: m.id,
        startedAt,
        conversationId,
        lifecycle: { cancelled: false, setupStarted: true },
      };
    });

    const context = [...messages, userMessage]
      .filter((m) => m.content.length > 0 && m.status !== "error")
      .slice(-CONTEXT_LIMIT)
      .map((m) => ({ role: m.role, content: m.content }));

    if (conversationId) {
      assistants.forEach((assistant) => reserveTurnWrite(assistant.id));
    }
    set((state) => ({
      messages: [...messages, userMessage, ...assistants],
      streams: { ...state.streams, ...streamEntries },
      lastSendOptions: {
        webSearch: webSearch ?? false,
        // The agent loop is a single-model feature (see chat_send_multi).
        enableTools: false,
        enableThinking,
        thinkingEffort,
        skillIds: skillIds ?? [],
      },
    }));

    const setup = async () => {
      try {
        await invoke<string[]>("chat_send_multi", {
          request: {
            targets: resolved.map((sel) => ({
              providerId: sel.provider.id,
              modelKey: sel.model.modelKey,
            })),
            requestIds,
            messages: context,
            systemPrompt,
            webSearch: webSearch ?? false,
            enableTools: false,
            enableThinking,
            thinkingEffort,
            conversationId: conversationId ?? undefined,
            approvalSessionId,
            skillIds: skillIds ?? [],
          },
        });

        const cancelled = requestIds.filter((id) => streamEntries[id].lifecycle?.cancelled);
        await Promise.all(cancelled.map(cancelBackend));
        if (!operationAllowed(epoch) || cancelled.length === requestIds.length) {
          assistants.forEach((assistant) => discardTurnWrite(assistant.id));
          return;
        }
        if (conversationId) {
          const now = Date.now();
          const conversation = createdNew
            ? {
                id: conversationId,
                title: trimmed.slice(0, 32),
                providerId: resolved[0].provider.id,
                modelKey: resolved[0].model.modelKey,
                systemPrompt: null,
                assistantId: boundAssistantId,
                pinned: false,
                createdAt: now,
                updatedAt: now,
              }
            : null;
          try {
            await historyApi.beginChatTurn({
              conversation,
              userMessage: {
                id: userMessage.id,
                conversationId,
                role: "user",
                content: userMessage.content,
                status: "done",
                createdAt: now,
              },
              assistantMessage: {
                id: assistants[0].id,
                conversationId,
                role: "assistant",
                content: "",
                status: "streaming",
                createdAt: now,
              },
              updatedAt: now,
              providerId: resolved[0].provider.id,
              modelKey: resolved[0].model.modelKey,
            });
            completeTurnWrite(assistants[0].id, true);
            // Every extra column is persisted too, so reopening the
            // conversation restores the whole comparison.
            for (const extra of assistants.slice(1)) {
              await historyApi.saveMessage({
                id: extra.id,
                conversationId,
                role: "assistant",
                content: "",
                status: "streaming",
                modelName: extra.modelName ?? null,
                createdAt: now,
              });
              completeTurnWrite(extra.id, true);
            }
            if (operationAllowed(epoch) && createdNew && useChatStore.getState().conversationNonce === initialNonce
              && useHistoryStore.getState().activeId === null) {
              useHistoryStore.getState().setActive(conversationId);
            }
            if (operationAllowed(epoch)) void useHistoryStore.getState().refreshList();
          } catch (err) {
            completeTurnWrite(assistants[0].id, false);
            assistants.slice(1).forEach((assistant) => completeTurnWrite(assistant.id, false));
            console.error("保存对比轮次失败:", err);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        assistants.forEach((assistant) => discardTurnWrite(assistant.id));
        for (const id of requestIds) {
          if (!streamEntries[id].lifecycle?.cancelled && operationAllowed(epoch)) get().onError(id, message, true);
        }
      }
    };
    await trackOperation(setup());
  },

  appendDelta: (requestId, text) => {
    set((state) =>
      patchStream(state, requestId, (msg) => ({ ...msg, content: msg.content + text })),
    );
  },

  appendReasoning: (requestId, text) => {
    set((state) =>
      patchStream(state, requestId, (msg) => ({
        ...msg,
        reasoning: (msg.reasoning ?? "") + text,
      })),
    );
  },

  setUsage: (requestId, inputTokens, outputTokens) => {
    set((state) =>
      patchStream(state, requestId, (msg) => ({ ...msg, usage: { inputTokens, outputTokens } })),
    );
  },

  setSearchStatus: (requestId, query) => {
    set((state) => patchStream(state, requestId, (msg) => ({ ...msg, searchingQuery: query })));
  },

  markKbUsed: (requestId, count, titles) => {
    set((state) =>
      patchStream(state, requestId, (msg) => ({ ...msg, kbHits: count, kbTitles: titles })),
    );
  },

  setSearchResults: (requestId, results) => {
    set((state) =>
      patchStream(state, requestId, (msg) => ({
        ...msg,
        searchingQuery: undefined,
        sources: results.length > 0 ? results : undefined,
      })),
    );
  },

  startToolCall: (requestId, callId, name, argumentsText) => {
    const step: ToolCallStep = {
      callId,
      name,
      arguments: argumentsText,
      status: "running",
      startedAt: Date.now(),
    };
    set((state) =>
      patchStream(state, requestId, (msg) => ({
        ...msg,
        toolCalls: [...(msg.toolCalls ?? []).filter((call) => call.callId !== callId), step],
      })),
    );
  },

  finishToolCall: (requestId, callId, result) => {
    set((state) =>
      patchStream(state, requestId, (msg) => ({
        ...msg,
        toolCalls: msg.toolCalls?.map((call) => {
          if (call.callId !== callId) return call;
          const finishedAt = Date.now();
          const durationMs = call.startedAt ? finishedAt - call.startedAt : undefined;
          return { ...call, status: "done", result, finishedAt, durationMs };
        }),
      })),
    );
  },

  failToolCall: (requestId, callId, message) => {
    set((state) =>
      patchStream(state, requestId, (msg) => ({
        ...msg,
        toolCalls: msg.toolCalls?.map((call) => {
          if (call.callId !== callId) return call;
          const finishedAt = Date.now();
          const durationMs = call.startedAt ? finishedAt - call.startedAt : undefined;
          return {
            ...call,
            status: "error",
            error: message,
            finishedAt,
            durationMs,
          };
        }),
      })),
    );
  },

  pendingToolCall: (requestId, callId, name, summary, canRemember = false) => {
    const step: ToolCallStep = { callId, name, arguments: "{}", status: "pending", summary, canRemember };
    set((state) =>
      patchStream(state, requestId, (msg) => ({
        ...msg,
        toolCalls: [...(msg.toolCalls ?? []).filter((call) => call.callId !== callId), step],
      })),
    );
  },

  rejectToolCall: (requestId, callId) => {
    set((state) =>
      patchStream(state, requestId, (msg) => ({
        ...msg,
        toolCalls: msg.toolCalls?.map((call) =>
          call.callId === callId ? { ...call, status: "rejected" } : call,
        ),
      })),
    );
  },

  resolveToolCall: (requestId, callId, approved, policy = "once") => {
    void invoke("chat_approve_tool", { requestId, callId, approved, policy }).catch(
      (err) => console.error("发送工具审批结果失败:", err),
    );
  },

  onFinish: (requestId, reason) => {
    const stream = get().streams[requestId];
    if (!stream) return;
    const status = reason === "cancelled" ? "cancelled" : "done";
    if (status === "cancelled" && stream.lifecycle) stream.lifecycle.cancelled = true;
    const durationMs = Date.now() - stream.startedAt;
    const activeConvId = useHistoryStore.getState().activeId;
    // A generation that finishes while the user reads another conversation
    // raises a "finished" dot in the sidebar (cancellations do not).
    const finishedInBackground =
      status === "done" &&
      stream.conversationId !== null &&
      !isVisibleStream(stream, activeConvId, get().messages);

    set((state) => ({
      streams: withoutStream(state.streams, requestId),
      ...patchMessage(state, stream.messageId, (m) =>
        syncActiveVersion({ ...m, status, durationMs }),
      ),
      ...(finishedInBackground
        ? { unreadDone: { ...state.unreadDone, [stream.conversationId as string]: true } }
        : {}),
    }));
    persistAssistantFinal(stream, status);

    // If this reply was triggered by a clipboard quick action, write the
    // result back to the clipboard so the user can paste it right away.
    const writeback = get().clipboardWriteback;
    if (writeback) {
      set({ clipboardWriteback: null });
      const final = get().messages.find((m) => m.id === stream.messageId);
      if (status === "done" && final?.content.trim()) {
        void writeClipboardText(final.content.trim()).catch((err) =>
          console.error("写回剪贴板失败:", err),
        );
      }
    }
  },

  onError: (requestId, message, retryable) => {
    const stream = get().streams[requestId];
    if (!stream) return;
    const durationMs = Date.now() - stream.startedAt;

    set((state) => ({
      streams: withoutStream(state.streams, requestId),
      ...patchMessage(state, stream.messageId, (m) =>
        syncActiveVersion({ ...m, status: "error", error: message, retryable, durationMs }),
      ),
    }));
    persistAssistantFinal(stream, "error");
  },

  stopStream: (requestId) => {
    const stream = get().streams[requestId];
    if (!stream) return;
    if (stream.lifecycle) stream.lifecycle.cancelled = true;
    void cancelBackend(requestId);

    const durationMs = Date.now() - stream.startedAt;
    set((state) => ({
      streams: withoutStream(state.streams, requestId),
      ...patchMessage(state, stream.messageId, (m) =>
        syncActiveVersion({ ...m, status: "cancelled", durationMs }),
      ),
    }));
    if (stream.lifecycle && !stream.lifecycle.setupStarted) {
      discardTurnWrite(stream.messageId);
    } else {
      persistAssistantFinal(stream, "cancelled");
    }
  },

  stop: () => {
    const { streams } = get();
    // Only the displayed conversation is cancelled; background generations
    // in other conversations keep running (multi-conversation support).
    const activeConvId = useHistoryStore.getState().activeId;
    const entries = Object.entries(streams).filter(
      ([, stream]) => isVisibleStream(stream, activeConvId, get().messages),
    );
    if (entries.length === 0) return;

    for (const [requestId] of entries) get().stopStream(requestId);
  },

  retryLast: (opts) => {
    if (get().importingBackup) return;
    const { messages, streams, lastSendOptions } = get();
    if (Object.keys(streams).length > 0) return;

    const failed = [...messages].reverse().find((m) => m.role === "assistant");
    // A failed regeneration already owns a version stack: retry it in place so
    // the archived versions and the edited prompt survive the retry.
    if (failed && failed.status === "error" && (failed.versions?.length ?? 0) > 0) {
      void get().regenerate(failed.id, { disableTools: opts?.disableTools });
      return;
    }

    const lastUser = [...messages]
      .reverse()
      .find((m) => m.role === "user" && m.content.length > 0);
    if (!lastUser) return;

    // Remove BOTH the failed assistant message and the last user message so
    // that send() can create fresh ones without leaving a duplicate user
    // turn in the message list.
    const idsToRemove = new Set<string>();
    if (failed) idsToRemove.add(failed.id);
    idsToRemove.add(lastUser.id);

    set({
      messages: messages.filter((m) => !idsToRemove.has(m.id)),
    });

    // Replay with the original send options (web search / agent tools),
    // unless the caller explicitly disables the agent tools (e.g. a failed
    // tool loop — retrying without tools usually recovers gracefully).
    const base = lastSendOptions ?? {
      webSearch: false,
      enableTools: false,
      enableThinking: true,
      thinkingEffort: "medium" as ThinkingEffort,
      skillIds: [] as string[],
    };
    const enableTools = opts?.disableTools ? false : base.enableTools;
    void get().send(
      lastUser.content,
      lastUser.images,
      base.webSearch,
      enableTools,
      base.enableThinking,
      base.thinkingEffort,
      lastUser.attachments,
      base.skillIds,
    );
  },

  editMessage: async (messageId, content) => {
    if (get().importingBackup) return;
    const { messages, streams } = get();
    if (Object.keys(streams).length > 0) return;
    const index = messages.findIndex((m) => m.id === messageId);
    if (index < 0 || messages[index].role !== "user") return;
    const target = messages[index];
    const trimmed = content.trim();
    if (!trimmed) return;

    const history = useHistoryStore.getState();
    const epoch = dataEpoch;
    const navigationScope = get().approvalSessionId;
    let updated: Message;
    if (history.historyEnabled && history.activeId) {
      try {
        const row = await trackOperation(historyApi.editMessage(messageId, trimmed));
        if (!operationAllowed(epoch) || get().approvalSessionId !== navigationScope) return;
        updated = applyStoredRow(target, row);
      } catch (err) {
        console.error("编辑消息失败:", err);
        return;
      }
    } else {
      const { versions, activeVersion } = appendVersionLocally(target, {
        content: trimmed,
        status: "done",
        createdAt: Date.now(),
      });
      updated = { ...target, content: trimmed, versions, activeVersion };
    }

    set((state) => ({
      messages: state.messages.map((m) => (m.id === messageId ? updated : m)),
    }));

    // Editing the latest turn re-runs its answer so the two stay consistent;
    // earlier turns keep their (now historical) replies.
    const isLastUserTurn = !messages.slice(index + 1).some((m) => m.role === "user");
    const reply = messages.slice(index + 1).find((m) => m.role === "assistant");
    if (isLastUserTurn && reply) {
      await get().regenerate(reply.id);
    }
  },

  regenerate: async (messageId, opts) => {
    if (get().importingBackup) return;
    const { messages, streams, lastSendOptions, approvalSessionId } = get();
    if (Object.keys(streams).length > 0) return;
    const index = messages.findIndex((m) => m.id === messageId);
    const target = messages[index];
    if (!target || target.role !== "assistant") return;
    const preceding = messages.slice(0, index);
    const user = [...preceding].reverse().find((message) => message.role === "user");
    if (!user) return;
    const activeConversationId = useHistoryStore.getState().activeId;
    const { selection, systemPrompt } = resolveTurnContext(activeConversationId);
    if (!selection || !selection.provider.hasApiKey) {
      useWindowStore.getState().openSettings();
      return;
    }
    const epoch = dataEpoch;
    const lifecycle = { cancelled: false, setupStarted: false };
    const alive = () => !lifecycle.cancelled && operationAllowed(epoch);
    const modelLabel = selection.model.displayName || selection.model.modelKey;
    const requestId = `req-${Date.now().toString(36)}-${(seq++).toString(36)}`;
    // Reserve before the first await: stop and import must see pending setup.
    set((state) => ({ streams: { ...state.streams, [requestId]: {
      messageId, startedAt: Date.now(), conversationId: activeConversationId, lifecycle,
    } } }));
    try {
      await finalWrites.get(messageId);
      if (!alive()) return;
      if (get().approvalSessionId !== approvalSessionId) {
        get().stopStream(requestId);
        return;
      }
      // The initial turn may have become persistent while its final write was
      // pending. Never archive/spread the pre-await placeholder snapshot.
      const target = get().messages.find((message) => message.id === messageId);
      if (!target || target.role !== "assistant") {
        get().stopStream(requestId);
        return;
      }
      const history = useHistoryStore.getState();
      const conversationId = history.historyEnabled && target.historyPersisted !== false
        ? history.activeId : null;
      set((state) => ({ streams: { ...state.streams, [requestId]: {
        ...state.streams[requestId], conversationId: history.activeId,
      } } }));
      let archived: Message;
      if (conversationId) {
        reserveTurnWrite(messageId);
        lifecycle.setupStarted = true;
        try {
          const row = await trackOperation(historyApi.startMessageVersion(messageId));
          completeTurnWrite(messageId, true);
          if (!alive()) return;
          archived = { ...applyStoredRow(target, row), modelName: modelLabel, usage: undefined };
        } catch (err) {
          completeTurnWrite(messageId, false);
          throw err;
        }
      } else {
        const { versions, activeVersion } = appendVersionLocally(target, {
          content: "", modelName: modelLabel, status: "streaming", createdAt: Date.now(),
        });
        archived = { ...target, content: "", reasoning: undefined, durationMs: undefined,
          error: undefined, usage: undefined, status: "streaming", modelName: modelLabel,
          versions, activeVersion };
      }
      set((state) => patchMessage(state, messageId, () => archived));
      const context = user.images?.length
        ? await prepareTurnMessages(preceding, user, selection.model, alive)
        : buildTurnMessages(preceding, user.id, user.content);
      if (!context || !alive()) return;
      const base = lastSendOptions ?? {
        webSearch: false, enableTools: false, enableThinking: true,
        thinkingEffort: "medium" as ThinkingEffort, skillIds: [],
      };
      lifecycle.setupStarted = true;
      await trackOperation((async () => {
        await invoke<string>("chat_send", { request: {
          providerId: selection.provider.id, modelKey: selection.model.modelKey,
          messages: context, systemPrompt, webSearch: base.webSearch,
          enableTools: opts?.disableTools ? false : base.enableTools,
          enableThinking: base.enableThinking, thinkingEffort: base.thinkingEffort,
          requestId, conversationId: conversationId ?? undefined,
          approvalSessionId, skillIds: base.skillIds,
        } });
        if (!alive()) await cancelBackend(requestId);
      })());
    } catch (err) {
      if (!alive()) return;
      get().onError(requestId, err instanceof Error ? err.message : String(err), true);
    }
  },

  switchMessageVersion: async (messageId, index) => {
    if (get().importingBackup) return;
    const { messages, streams } = get();
    if (Object.keys(streams).length > 0) return;
    if (!messages.some((m) => m.id === messageId)) return;

    const epoch = dataEpoch;
    const navigationScope = get().approvalSessionId;
    await finalWrites.get(messageId);
    if (!operationAllowed(epoch) || get().approvalSessionId !== navigationScope) return;
    const target = get().messages.find((message) => message.id === messageId);
    if (!target) return;
    const history = useHistoryStore.getState();
    if (history.historyEnabled && history.activeId && target.historyPersisted !== false) {
      try {
        const row = await trackOperation(historyApi.activateMessageVersion(messageId, index));
        if (!operationAllowed(epoch) || get().approvalSessionId !== navigationScope) return;
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === messageId ? applyStoredRow(m, row) : m,
          ),
        }));
      } catch (err) {
        console.error("切换消息版本失败:", err);
      }
      return;
    }

    // Local-only switch: recording is disabled or this retry has no DB row.
    const versions = target.versions;
    if (!versions || index < 0 || index >= versions.length) return;
    const version = versions[index];
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              content: version.content,
              reasoning: version.reasoning,
              modelName: version.modelName,
              durationMs: version.durationMs,
              status: version.status ?? "done",
              error: undefined,
              activeVersion: index,
            }
          : m,
      ),
    }));
  },

  /**
   * Branch from `messageId`: with history recording on, persist a new
   * conversation holding every message up to and including it, then switch to
   * it — the source conversation keeps its full history.  With recording off
   * it falls back to a local, unsaved cut so the action still does something
   * useful.  Nothing is branched while a generation is running.
   */
  branchFrom: async (messageId: string) => {
    if (get().importingBackup) return;
    const { messages, streams, conversationNonce } = get();
    if (Object.keys(streams).length > 0) return;
    const index = messages.findIndex((m) => m.id === messageId);
    if (index < 0) return;

    const history = useHistoryStore.getState();
    const sourceId = visibleConversationId(get(), history.activeId);
    if (!history.historyEnabled || !sourceId) {
      // Unsaved conversation: keep the old local behaviour.
      set({ messages: messages.slice(0, index + 1), conversationNonce: conversationNonce + 1 });
      return;
    }

    const navigationScope = get().approvalSessionId;
    try {
      const detail = await trackOperation(historyApi.branchConversation(sourceId, messageId));
      // A navigation or reload while the backend worked invalidates this branch.
      if (get().approvalSessionId !== navigationScope) return;
      if (visibleConversationId(get(), useHistoryStore.getState().activeId) !== sourceId) return;

      const latest = get();
      const latestBackground = { ...latest.backgroundMessages };
      const leavingId = visibleConversationId(latest, useHistoryStore.getState().activeId);
      if (leavingId) latestBackground[leavingId] = latest.messages;
      const branchId = detail.conversation.id;
      const { [branchId]: _staleSnapshot, ...restBackground } = latestBackground;
      const { [branchId]: _seenDot, ...restUnread } = latest.unreadDone;
      useHistoryStore.getState().setActive(branchId);
      useAssistantsStore.getState().setActive(detail.conversation.assistantId ?? null);
      set({
        messages: detail.messages.map(storedMessageToMessage),
        backgroundMessages: restBackground,
        unreadDone: restUnread,
        // Re-focus the composer so the user continues from the branch point.
        conversationNonce: latest.conversationNonce + 1,
        approvalSessionId: nextConvId(),
      });
      void useHistoryStore.getState().refreshList();
    } catch (err) {
      console.error("创建分支失败:", err);
    }
  },

  clearConversation: () => {
    if (get().importingBackup) return;
    const { streams, backgroundMessages, conversationNonce } = get();
    const currentId = visibleConversationId(get(), useHistoryStore.getState().activeId);
    // Only this conversation's generations are cancelled; runs in other
    // conversations are left alone (multi-conversation support).
    for (const [requestId, stream] of Object.entries(streams)) {
      if (stream.conversationId === currentId) {
        get().stopStream(requestId);
      }
    }
    const { [currentId ?? ""]: _droppedSnapshot, ...restBackground } = backgroundMessages;
    set({
      messages: [],
      streams: Object.fromEntries(
        Object.entries(streams).filter(
          ([, stream]) => stream.conversationId !== currentId,
        ),
      ),
      backgroundMessages: restBackground,
      conversationNonce: conversationNonce + 1,
      approvalSessionId: nextConvId(),
    });
    useHistoryStore.getState().setActive(null);
  },

  loadConversation: async (id) => {
    if (get().importingBackup) return;
    const currentId = useHistoryStore.getState().activeId;
    if (currentId === id) return;
    const navigationScope = get().approvalSessionId;
    const { messages, backgroundMessages } = get();

    // Snapshot the latest visible conversation, including a turn whose DB row
    // has not been created yet. The scope check below prevents stale loads
    // from taking over after another navigation.
    const nextBackground = { ...backgroundMessages };
    const leavingId = visibleConversationId(get(), currentId);
    if (leavingId) nextBackground[leavingId] = messages;
    const { [id]: _seenDot, ...nextUnread } = get().unreadDone;

    const cached = nextBackground[id];
    if (cached) {
      useHistoryStore.getState().setActive(id);
      const conv = useHistoryStore.getState().conversations.find((c) => c.id === id);
      useAssistantsStore.getState().setActive(conv?.assistantId ?? null);
      set({
        messages: cached,
        backgroundMessages: nextBackground,
        unreadDone: nextUnread,
        approvalSessionId: nextConvId(),
      });
      return;
    }

    try {
      const detail = await historyApi.getConversation(id);
      if (useChatStore.getState().approvalSessionId !== navigationScope) return;
      const loaded: Message[] = detail.messages.map(storedMessageToMessage);
      const latest = get();
      const latestLeavingId = visibleConversationId(latest, useHistoryStore.getState().activeId);
      const latestBackground = { ...latest.backgroundMessages };
      if (latestLeavingId) latestBackground[latestLeavingId] = latest.messages;
      useHistoryStore.getState().setActive(id);
      // Follow the conversation's assistant so the sidebar reflects what this
      // chat actually uses (P1-7).
      useAssistantsStore.getState().setActive(detail.conversation.assistantId ?? null);
      // Fresh server state wins over any leftover snapshot.
      const { [id]: _staleSnapshot, ...restBackground } = latestBackground;
      set({
        messages: loaded,
        backgroundMessages: restBackground,
        unreadDone: nextUnread,
        approvalSessionId: nextConvId(),
      });
    } catch (err) {
      console.error("加载会话失败:", err);
      void useHistoryStore.getState().refreshList();
    }
  },

  setConversationModel: async (providerId, modelKey) => {
    if (get().importingBackup) return;
    const activeId = useHistoryStore.getState().activeId;
    if (!activeId) {
      // No conversation yet: remember the choice for the conversation the
      // next send creates.
      set({ draftSelection: { providerId, modelKey } });
      return;
    }
    const epoch = dataEpoch;
    try {
      await trackOperation(historyApi.setConversationModel(activeId, providerId, modelKey));
    } catch (err) {
      console.error("更新会话模型失败:", err);
    }
    if (!operationAllowed(epoch)) return;
    useHistoryStore.setState((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === activeId ? { ...c, providerId, modelKey } : c,
      ),
    }));
  },

  clearUnreadDone: (conversationId) => {
    const { unreadDone } = get();
    if (!unreadDone[conversationId]) return;
    const { [conversationId]: _clearedDot, ...rest } = unreadDone;
    set({ unreadDone: rest });
  },

  startNewConversation: () => {
    if (get().importingBackup) return;
    const { messages, backgroundMessages, conversationNonce } = get();
    const currentId = visibleConversationId(get(), useHistoryStore.getState().activeId);
    const patch: Partial<ChatState> = {
      messages: [],
      conversationNonce: conversationNonce + 1,
      approvalSessionId: nextConvId(),
    };
    // Keep the conversation being left in memory (including anything still
    // streaming) instead of dropping it.
    if (currentId) {
      patch.backgroundMessages = { ...backgroundMessages, [currentId]: messages };
    }
    set(patch);
    useHistoryStore.getState().setActive(null);
  },
}));
