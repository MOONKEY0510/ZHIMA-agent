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
 * Resolve the model + system prompt for a turn (P1-7).
 *
 * Priority for the system prompt: the conversation's own override > the bound
 * assistant's prompt > the global default.  The model comes from the
 * assistant's pinned selection when it has one, else the global selection.
 */
function resolveTurnContext(conversationId: string | null): {
  selection: ModelSelection;
  systemPrompt: string | null;
  assistantId: string | null;
} {
  const assistant = activeAssistant();
  const selection =
    modelFor(assistant?.providerId ?? null, assistant?.modelKey ?? null) ?? currentModel();

  const conversationPrompt = conversationId
    ? useHistoryStore.getState().conversations.find((c) => c.id === conversationId)
        ?.systemPrompt ?? null
    : null;
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
}

/** One model of a multi-model turn (P1-6). */
export interface ModelTarget {
  providerId: string;
  modelKey: string;
}

/**
 * Apply an update to the message a specific stream is filling.  Unknown
 * request ids are ignored, so events from a cancelled or finished stream can
 * never touch the list.
 */
function patchStream(
  state: { streams: Record<string, ActiveStream>; messages: Message[] },
  requestId: string,
  updater: (msg: Message) => Message,
): Partial<ChatState> {
  const stream = state.streams[requestId];
  if (!stream) return {};
  const { messageId } = stream;
  return {
    messages: state.messages.map((m) => (m.id === messageId ? updater(m) : m)),
  };
}

/** Drop one stream from the map without mutating the original. */
function withoutStream(
  streams: Record<string, ActiveStream>,
  requestId: string,
): Record<string, ActiveStream> {
  const { [requestId]: _removed, ...rest } = streams;
  return rest;
}

/** Selector: whether any generation is currently in flight. */
export function selectStreaming(state: { streams: Record<string, ActiveStream> }): boolean {
  return Object.keys(state.streams).length > 0;
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
  /**
   * Snapshot of the last send() options so retryLast() can replay the same
   * web-search / agent-tools configuration instead of silently dropping it.
   */
  lastSendOptions: {
    webSearch: boolean;
    enableTools: boolean;
    enableThinking: boolean;
    thinkingEffort: ThinkingEffort;
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
   * Models picked for the next multi-model comparison (P1-6). Empty means a
   * normal single-model send.
   */
  compareTargets: ModelTarget[];

  /** Arm the clipboard writeback for the next assistant reply. */
  armClipboardWriteback: (label: string) => void;
  /** Set (or clear, with an empty list) the comparison targets. */
  setCompareTargets: (targets: ModelTarget[]) => void;
  /** Ask the message list to reveal a specific message. */
  focusMessage: (messageId: string) => void;
  /** Called by the message list once the focus request has been handled. */
  clearFocusMessage: () => void;

  send: (
    text: string,
    images?: string[],
    webSearch?: boolean,
    enableTools?: boolean,
    enableThinking?: boolean,
    thinkingEffort?: ThinkingEffort,
    /** Metadata of documents already folded into `text` (P1-8). */
    attachments?: AttachmentMeta[],
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
  pendingToolCall: (requestId: string, callId: string, name: string, summary: string) => void;
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
  /** Cancel every in-flight generation. */
  stop: () => void;
  /** Cancel one column (used by the per-column stop button). */
  stopStream: (requestId: string) => void;
  /** Re-run the last user turn; `disableTools` optionally turns the agent loop off. */
  retryLast: (opts?: { disableTools?: boolean }) => void;
  /** Edit a user message (kept as a new version) and regenerate its reply. */
  editMessage: (messageId: string, content: string) => Promise<void>;
  /** Re-run an assistant reply in place, archiving the current answer. */
  regenerate: (messageId: string, opts?: { disableTools?: boolean }) => Promise<void>;
  /** Switch the displayed version of a message. */
  switchMessageVersion: (messageId: string, index: number) => Promise<void>;
  clearConversation: () => void;
  /** Start a branch from the given message (cut everything after it). */
  branchFrom: (messageId: string) => void;
  /** Load a persisted conversation into the message list. */
  loadConversation: (id: string) => Promise<void>;
}

/**
 * Tool calls whose results may contain local-sensitive data (clipboard,
 * file contents, PDF text, screenshots) must NOT be persisted in full to
 * SQLite.  We keep only a redacted summary: name, status and (for safe,
 * non-sensitive tools) the result.  The result payload is dropped for
 * sensitive tools to avoid writing secrets or full document text to disk.
 */
const SENSITIVE_TOOL_NAMES = new Set([
  "read_clipboard",
  "select_and_read_text_file",
  "read_pdf",
  "capture_screen",
]);

/** Persist the final state of the assistant message once streaming settles. */
function persistAssistantFinal(messageId: string | null, status: MessageStatus) {
  const history = useHistoryStore.getState();
  if (!history.historyEnabled || !history.activeId || !messageId) return;
  const msg = useChatStore.getState().messages.find((m) => m.id === messageId);
  if (!msg) return;
  const toolCalls = msg.toolCalls && msg.toolCalls.length > 0
    ? JSON.stringify(
        msg.toolCalls.map((call) =>
          SENSITIVE_TOOL_NAMES.has(call.name)
            ? { ...call, result: undefined, arguments: undefined, summary: call.summary }
            : call,
        ),
      )
    : null;
  void historyApi
    .saveMessage({
      id: msg.id,
      conversationId: history.activeId,
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
    })
    .catch((err) => console.error("保存会话消息失败:", err));
}

/** Read a File/data-URL and return a compressed data URL (max ~512px). */
async function compressImage(dataUrl: string, maxDim = 768): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
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
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  streams: {},
  conversationNonce: 0,
  lastSendOptions: null,
  clipboardWriteback: null,
  focusMessageId: null,
  compareTargets: [],

  armClipboardWriteback: (label) => set({ clipboardWriteback: label }),
  setCompareTargets: (targets) => set({ compareTargets: targets }),
  focusMessage: (messageId) => set({ focusMessageId: messageId }),
  clearFocusMessage: () => set({ focusMessageId: null }),

  send: async (
    text,
    images,
    webSearch,
    enableTools,
    enableThinking = true,
    thinkingEffort: ThinkingEffort = "medium",
    attachments,
  ) => {
    const trimmed = text.trim();
    if (!trimmed && (!images || images.length === 0)) return;

    const { streams, messages } = get();
    if (Object.keys(streams).length > 0) return;

    // Model + prompt come from the active assistant (P1-7), falling back to
    // the global default selection.
    const {
      selection,
      systemPrompt,
      assistantId: boundAssistantId,
    } = resolveTurnContext(useHistoryStore.getState().activeId);
    if (!selection || !selection.provider.hasApiKey) {
      useWindowStore.getState().openSettings();
      return;
    }

    // Determine if we need vision fallback.
    const modelSupportsVision = selection.model.supportsVision;
    const store = useProvidersStore.getState();
    const hasVisionFallback = !!(store.visionProviderId && store.visionModelKey);
    const hasImages = images && images.length > 0;

    // If images present but current model doesn't support vision, use fallback.
    let effectiveText = trimmed;
    let effectiveImages: string[] | undefined = images;

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
      modelName: selection.model.displayName || selection.model.modelKey,
    };

    // Both messages enter the list immediately: a stream always fills an
    // existing message, which is what lets several run in parallel (P1-6)
    // without a separate draft channel.  The request slot is reserved before
    // any async preprocessing so the UI shows the busy state right away and
    // concurrent sends are rejected; the same requestId goes to the backend
    // so stream events match.
    const requestId = `req-${Date.now().toString(36)}-${(seq++).toString(36)}`;
    set({
      messages: [...messages, userMessage, assistantMessage],
      streams: { [requestId]: { messageId: assistantId, startedAt: Date.now() } },
    });

    // Hoisted so the invoke error handler below can roll back a conversation
    // that was created during preprocessing.
    let conversationId: string | null = null;
    let createdNew = false;
    let history: { role: Role; content: string; images?: string[] }[] = [];

    try {
      if (hasImages && !modelSupportsVision) {
        if (!hasVisionFallback) {
          // No fallback configured — fail the column in place.
          set((state) => ({
            streams: withoutStream(state.streams, requestId),
            messages: state.messages.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    status: "error" as const,
                    error:
                      "当前模型不支持图片，且未配置视觉模型。请在设置→模型设置中配置默认视觉模型。",
                    retryable: false,
                  }
                : m,
            ),
          }));
          return;
        }

        // The placeholder is already in the list, so the user sees
        // "正在思考…" while the vision model processes each image.

        // Compress images and call vision model to describe each.
        const descriptions: string[] = [];
        for (let i = 0; i < images!.length; i++) {
          const compressed = await compressImage(images![i]);
          try {
            const desc = await invoke<string>("describe_image", {
              request: {
                providerId: store.visionProviderId,
                modelKey: store.visionModelKey,
                imageDataUrl: compressed,
                prompt: "请详细描述这张图片的内容，包括所有可见的文字、物体、场景和布局。",
              },
            });
            descriptions.push(`[图片${i + 1}]\n${desc}`);
          } catch {
            descriptions.push(`[图片${i + 1}]\n（图片描述失败）`);
          }
        }

        // Combine descriptions with user text.
        const imageContext = descriptions.join("\n\n");
        effectiveText = trimmed
          ? `${trimmed}\n\n---\n以下是用户上传的图片内容描述：\n\n${imageContext}`
          : `用户上传了图片，以下是图片内容描述：\n\n${imageContext}`;
        effectiveImages = undefined; // Don't send images to non-vision model
      } else if (hasImages && modelSupportsVision) {
        // Compress images for direct vision send.
        effectiveImages = await Promise.all(images!.map((img) => compressImage(img)));
      }

      history = [...messages, { ...userMessage, content: effectiveText }]
        .filter((m) => m.content.length > 0 && m.status !== "error")
        .slice(-CONTEXT_LIMIT)
        .map((m) => ({
          role: m.role,
          content: m.content,
          images: m.role === "user" && m.id === userMessage.id ? effectiveImages : undefined,
        }));

      // Reserve an id for a new conversation. The row itself is created
      // atomically with both messages after chat_send accepts the request.
      const historyStore = useHistoryStore.getState();
      conversationId = historyStore.historyEnabled ? historyStore.activeId : null;
      if (historyStore.historyEnabled && !conversationId) {
        conversationId = nextConvId();
        createdNew = true;
      }
    } catch (err) {
      // Unexpected failure during preprocessing (image compression, vision
      // description or conversation creation).  Release the request slot and
      // surface the error so the UI never stays stuck in the generating state.
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        streams: withoutStream(state.streams, requestId),
        messages: state.messages.map((m) =>
          m.id === assistantId
            ? { ...m, status: "error" as const, error: message, retryable: true }
            : m,
        ),
      }));
      return;
    }

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
        },
      });
      // Snapshot the send options so retryLast() can replay the exact same
      // web-search / agent-tools configuration instead of silently dropping it.
      set({
        lastSendOptions: {
          webSearch: webSearch ?? false,
          enableTools: enableTools ?? false,
          enableThinking,
          thinkingEffort,
        },
      });

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
          if (createdNew) useHistoryStore.getState().setActive(conversationId);
          void useHistoryStore.getState().refreshList();
        } catch (err) {
          console.error("保存聊天轮次失败:", err);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        streams: withoutStream(state.streams, requestId),
        messages: state.messages.map((m) =>
          m.id === assistantId
            ? { ...m, status: "error" as const, error: message, retryable: true }
            : m,
        ),
      }));
      if (createdNew) {
        useHistoryStore.getState().setActive(null);
      }
    }
  },

  sendMulti: async (
    text,
    targets,
    webSearch,
    enableThinking = true,
    thinkingEffort: ThinkingEffort = "medium",
  ) => {
    const trimmed = text.trim();
    if (!trimmed || targets.length === 0) return;

    const { streams, messages } = get();
    if (Object.keys(streams).length > 0) return;

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

    const startedAt = Date.now();
    const streamEntries: Record<string, ActiveStream> = {};
    assistants.forEach((m, index) => {
      streamEntries[requestIds[index]] = { messageId: m.id, startedAt };
    });

    let conversationId: string | null = historyStore.historyEnabled
      ? historyStore.activeId
      : null;
    const createdNew = historyStore.historyEnabled && !conversationId;
    if (createdNew) conversationId = nextConvId();

    const context = [...messages, userMessage]
      .filter((m) => m.content.length > 0 && m.status !== "error")
      .slice(-CONTEXT_LIMIT)
      .map((m) => ({ role: m.role, content: m.content }));

    set({
      messages: [...messages, userMessage, ...assistants],
      streams: streamEntries,
      lastSendOptions: {
        webSearch: webSearch ?? false,
        // The agent loop is a single-model feature (see chat_send_multi).
        enableTools: false,
        enableThinking,
        thinkingEffort,
      },
    });

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
        },
      });

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
          }
          if (createdNew) useHistoryStore.getState().setActive(conversationId);
          void useHistoryStore.getState().refreshList();
        } catch (err) {
          console.error("保存对比轮次失败:", err);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failedIds = new Set(assistants.map((a) => a.id));
      set((state) => ({
        streams: {},
        messages: state.messages.map((m) =>
          failedIds.has(m.id)
            ? { ...m, status: "error" as const, error: message, retryable: true }
            : m,
        ),
      }));
      if (createdNew) {
        useHistoryStore.getState().setActive(null);
      }
    }
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

  pendingToolCall: (requestId, callId, name, summary) => {
    const step: ToolCallStep = { callId, name, arguments: "{}", status: "pending", summary };
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
    const durationMs = Date.now() - stream.startedAt;

    set((state) => ({
      streams: withoutStream(state.streams, requestId),
      messages: state.messages.map((m) =>
        m.id === stream.messageId ? syncActiveVersion({ ...m, status, durationMs }) : m,
      ),
    }));
    persistAssistantFinal(stream.messageId, status);

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
      messages: state.messages.map((m) =>
        m.id === stream.messageId
          ? syncActiveVersion({ ...m, status: "error", error: message, retryable, durationMs })
          : m,
      ),
    }));
    persistAssistantFinal(stream.messageId, "error");
  },

  stopStream: (requestId) => {
    const stream = get().streams[requestId];
    if (!stream) return;
    void invoke("chat_cancel", { requestId }).catch(() => undefined);

    const durationMs = Date.now() - stream.startedAt;
    set((state) => ({
      streams: withoutStream(state.streams, requestId),
      messages: state.messages.map((m) =>
        m.id === stream.messageId
          ? syncActiveVersion({ ...m, status: "cancelled" as const, durationMs })
          : m,
      ),
    }));
    persistAssistantFinal(stream.messageId, "cancelled");
  },

  stop: () => {
    const { streams } = get();
    const entries = Object.entries(streams);
    if (entries.length === 0) return;

    // Tell the backend to cancel every in-flight request.
    for (const [requestId] of entries) {
      void invoke("chat_cancel", { requestId }).catch(() => undefined);
    }

    // Optimistically mark every column as cancelled immediately so the UI
    // does not appear stuck if a stream is blocked on a slow read.
    const now = Date.now();
    const finished = new Map(entries.map(([, s]) => [s.messageId, now - s.startedAt]));
    set((state) => ({
      streams: {},
      messages: state.messages.map((m) =>
        finished.has(m.id)
          ? syncActiveVersion({
              ...m,
              status: "cancelled" as const,
              durationMs: finished.get(m.id),
            })
          : m,
      ),
    }));
    for (const messageId of finished.keys()) {
      persistAssistantFinal(messageId, "cancelled");
    }
  },

  retryLast: (opts) => {
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
    };
    const enableTools = opts?.disableTools ? false : base.enableTools;
    void get().send(
      lastUser.content,
      lastUser.images,
      base.webSearch,
      enableTools,
      base.enableThinking,
      base.thinkingEffort,
    );
  },

  editMessage: async (messageId, content) => {
    const { messages, streams } = get();
    if (Object.keys(streams).length > 0) return;
    const index = messages.findIndex((m) => m.id === messageId);
    if (index < 0 || messages[index].role !== "user") return;
    const target = messages[index];
    const trimmed = content.trim();
    if (!trimmed) return;

    const history = useHistoryStore.getState();
    let updated: Message;
    if (history.historyEnabled && history.activeId) {
      try {
        const row = await historyApi.editMessage(messageId, trimmed);
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
    const { messages, streams, lastSendOptions } = get();
    if (Object.keys(streams).length > 0) return;
    const index = messages.findIndex((m) => m.id === messageId);
    if (index < 0) return;
    const target = messages[index];
    if (target.role !== "assistant") return;

    const activeConversationId = useHistoryStore.getState().activeId;
    const { selection, systemPrompt } = resolveTurnContext(activeConversationId);
    if (!selection || !selection.provider.hasApiKey) {
      useWindowStore.getState().openSettings();
      return;
    }
    const modelLabel = selection.model.displayName || selection.model.modelKey;

    // Archive the current answer so the version switcher can reach it again.
    const history = useHistoryStore.getState();
    let archived: Message;
    if (history.historyEnabled && history.activeId) {
      try {
        const row = await historyApi.startMessageVersion(messageId);
        // The fresh attempt starts clean: stale token counters from the
        // archived answer must not leak into the regenerated one.
        archived = { ...applyStoredRow(target, row), modelName: modelLabel, usage: undefined };
      } catch (err) {
        console.error("归档消息版本失败:", err);
        return;
      }
    } else {
      const { versions, activeVersion } = appendVersionLocally(target, {
        content: "",
        modelName: modelLabel,
        status: "streaming",
        createdAt: Date.now(),
      });
      archived = {
        ...target,
        content: "",
        reasoning: undefined,
        durationMs: undefined,
        error: undefined,
        usage: undefined,
        status: "streaming",
        modelName: modelLabel,
        versions,
        activeVersion,
      };
    }

    // Context is everything before the regenerated reply.
    const base = lastSendOptions ?? {
      webSearch: false,
      enableTools: false,
      enableThinking: true,
      thinkingEffort: "medium" as ThinkingEffort,
    };
    const context = messages
      .slice(0, index)
      .filter((m) => m.content.length > 0 && m.status !== "error")
      .slice(-CONTEXT_LIMIT)
      .map((m) => ({ role: m.role, content: m.content }));

    // In-place: the target message is already in the list, so the stream just
    // fills it where it sits.
    const requestId = `req-${Date.now().toString(36)}-${(seq++).toString(36)}`;
    set((state) => ({
      messages: state.messages.map((m) => (m.id === messageId ? archived : m)),
      streams: {
        ...state.streams,
        [requestId]: { messageId, startedAt: Date.now() },
      },
    }));

    try {
      const activeId = useHistoryStore.getState().activeId;
      await invoke<string>("chat_send", {
        request: {
          providerId: selection.provider.id,
          modelKey: selection.model.modelKey,
          messages: context,
          systemPrompt,
          webSearch: base.webSearch,
          enableTools: opts?.disableTools ? false : base.enableTools,
          enableThinking: base.enableThinking,
          thinkingEffort: base.thinkingEffort,
          requestId,
          conversationId: activeId ?? undefined,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        streams: withoutStream(state.streams, requestId),
        messages: state.messages.map((m) =>
          m.id === messageId
            ? syncActiveVersion({ ...m, status: "error", error: message, retryable: true })
            : m,
        ),
      }));
      persistAssistantFinal(messageId, "error");
    }
  },

  switchMessageVersion: async (messageId, index) => {
    const { messages, streams } = get();
    if (Object.keys(streams).length > 0) return;
    const target = messages.find((m) => m.id === messageId);
    if (!target) return;

    const history = useHistoryStore.getState();
    if (history.historyEnabled && history.activeId) {
      try {
        const row = await historyApi.activateMessageVersion(messageId, index);
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

    // Local-only switch (history recording disabled).
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

  /** Start a branch from the given message: cut everything after it and
   * focus the composer so the user can continue with a new prompt.  The
   * chosen message becomes the last one in the conversation. */
  branchFrom: (messageId: string) => {
    const { messages, streams, conversationNonce } = get();
    if (Object.keys(streams).length > 0) return;
    const index = messages.findIndex((m) => m.id === messageId);
    if (index < 0) return;
    const kept = messages.slice(0, index + 1);
    // Bump the nonce so the composer re-focuses, prompting the user to
    // continue from this branch point.
    set({ messages: kept, conversationNonce: conversationNonce + 1 });
  },

  clearConversation: () => {
    const { streams, conversationNonce } = get();
    for (const requestId of Object.keys(streams)) {
      void invoke("chat_cancel", { requestId }).catch(() => undefined);
    }
    set({
      messages: [],
      streams: {},
      conversationNonce: conversationNonce + 1,
    });
    useHistoryStore.getState().setActive(null);
  },

  loadConversation: async (id) => {
    const { streams } = get();
    if (Object.keys(streams).length > 0) return;
    try {
      const detail = await historyApi.getConversation(id);
      const messages: Message[] = detail.messages.map((m) => ({
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
      }));
      useHistoryStore.getState().setActive(id);
      // Follow the conversation's assistant so the sidebar reflects what this
      // chat actually uses (P1-7).
      useAssistantsStore.getState().setActive(detail.conversation.assistantId ?? null);
      set({ messages, streams: {} });
    } catch (err) {
      console.error("加载会话失败:", err);
      void useHistoryStore.getState().refreshList();
    }
  },
}));
