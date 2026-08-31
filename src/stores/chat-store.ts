import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Message, MessageStatus, Role, SearchResult, ToolCallStep } from "../types";
import { currentModel, useProvidersStore } from "./providers-store";
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

interface ChatState {
  messages: Message[];
  /** Rust-side request id of the in-flight generation, if any. */
  streamingRequestId: string | null;
  /** Local id of the assistant message being filled. */
  streamingMessageId: string | null;
  /** In-flight assistant draft, kept outside stable history during streaming. */
  streamingMessage: Message | null;
  /** Timestamp (ms) when the current assistant turn started. */
  sendStartTime: number | null;
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

  /** Arm the clipboard writeback for the next assistant reply. */
  armClipboardWriteback: (label: string) => void;

  send: (
    text: string,
    images?: string[],
    webSearch?: boolean,
    enableTools?: boolean,
    enableThinking?: boolean,
    thinkingEffort?: ThinkingEffort,
  ) => Promise<void>;
  appendDelta: (requestId: string, text: string) => void;
  appendReasoning: (requestId: string, text: string) => void;
  setUsage: (requestId: string, inputTokens?: number, outputTokens?: number) => void;
  /** Show the "searching web…" status while the backend runs a web search. */
  setSearchStatus: (requestId: string, query: string) => void;
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
  stop: () => void;
  /** Re-run the last user turn; `disableTools` optionally turns the agent loop off. */
  retryLast: (opts?: { disableTools?: boolean }) => void;
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
  streamingRequestId: null,
  streamingMessageId: null,
  streamingMessage: null,
  sendStartTime: null,
  conversationNonce: 0,
  lastSendOptions: null,
  clipboardWriteback: null,

  armClipboardWriteback: (label) => set({ clipboardWriteback: label }),

  send: async (
    text,
    images,
    webSearch,
    enableTools,
    enableThinking = true,
    thinkingEffort: ThinkingEffort = "medium",
  ) => {
    const trimmed = text.trim();
    if (!trimmed && (!images || images.length === 0)) return;

    const { streamingRequestId, messages } = get();
    if (streamingRequestId) return;

    const selection = currentModel();
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

    // Reserve the request slot BEFORE any async preprocessing (image
    // compression / vision description / conversation creation) so the UI
    // shows the busy state and concurrent sends are rejected.  The same
    // requestId is passed to the backend so stream events match.
    const requestId = `req-${Date.now().toString(36)}-${(seq++).toString(36)}`;
    set({ streamingRequestId: requestId, sendStartTime: Date.now() });

    // Hoisted so the invoke error handler below can roll back a conversation
    // that was created during preprocessing.
    let conversationId: string | null = null;
    let createdNew = false;
    let history: { role: Role; content: string; images?: string[] }[] = [];

    try {
      if (hasImages && !modelSupportsVision) {
        if (!hasVisionFallback) {
          // No fallback configured — show error.
          const errMsg: Message = {
            ...assistantMessage,
            status: "error",
            error: "当前模型不支持图片，且未配置视觉模型。请在设置→模型设置中配置默认视觉模型。",
            retryable: false,
          };
          set({ messages: [...messages, userMessage, errMsg], streamingRequestId: null });
          return;
        }

        // Show the assistant message immediately so the user sees "正在思考…"
        // while the vision model processes each image.
        set({
          messages: [...messages, userMessage],
          streamingMessageId: assistantId,
          streamingMessage: assistantMessage,
        });

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

      // For the non-vision-fallback path, add messages now. For the vision
      // fallback path they were already added above.
      if (!hasImages || modelSupportsVision) {
        set({
          messages: [...messages, userMessage],
          streamingMessageId: assistantId,
          streamingMessage: assistantMessage,
        });
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
        streamingRequestId: null,
        streamingMessageId: null,
        streamingMessage: null,
        messages: state.streamingMessage
          ? [
              ...state.messages,
              { ...state.streamingMessage, status: "error", error: message, retryable: true },
            ]
          : state.messages,
      }));
      return;
    }

    try {
      // A per-conversation system prompt (set via "会话提示词") takes priority
      // over the global default.
      const historyStore = useHistoryStore.getState();
      const conversationPrompt = conversationId
        ? historyStore.conversations.find((c) => c.id === conversationId)?.systemPrompt
        : null;
      const systemPrompt = conversationPrompt || useProvidersStore.getState().defaultSystemPrompt;

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
        streamingRequestId: null,
        streamingMessageId: null,
        streamingMessage: null,
        messages: state.streamingMessage
          ? [
              ...state.messages,
              { ...state.streamingMessage, status: "error", error: message, retryable: true },
            ]
          : state.messages,
      }));
      if (createdNew) {
        useHistoryStore.getState().setActive(null);
      }
    }
  },

  appendDelta: (requestId, text) => {
    const { streamingRequestId, streamingMessageId } = get();
    if (requestId !== streamingRequestId || !streamingMessageId) return;
    set((state) => ({
      streamingMessage: state.streamingMessage
        ? { ...state.streamingMessage, content: state.streamingMessage.content + text }
        : null,
    }));
  },

  appendReasoning: (requestId, text) => {
    const { streamingRequestId, streamingMessageId } = get();
    if (requestId !== streamingRequestId || !streamingMessageId) return;
    set((state) => ({
      streamingMessage: state.streamingMessage
        ? { ...state.streamingMessage, reasoning: (state.streamingMessage.reasoning ?? "") + text }
        : null,
    }));
  },

  setUsage: (requestId, inputTokens, outputTokens) => {
    if (requestId !== get().streamingRequestId) return;
    set((state) => ({
      streamingMessage: state.streamingMessage
        ? { ...state.streamingMessage, usage: { inputTokens, outputTokens } }
        : null,
    }));
  },

  setSearchStatus: (requestId, query) => {
    if (requestId !== get().streamingRequestId) return;
    set((state) => ({
      streamingMessage: state.streamingMessage
        ? { ...state.streamingMessage, searchingQuery: query }
        : null,
    }));
  },

  setSearchResults: (requestId, results) => {
    if (requestId !== get().streamingRequestId) return;
    set((state) => ({
      streamingMessage: state.streamingMessage
        ? {
            ...state.streamingMessage,
            searchingQuery: undefined,
            sources: results.length > 0 ? results : undefined,
          }
        : null,
    }));
  },

  startToolCall: (requestId, callId, name, argumentsText) => {
    if (requestId !== get().streamingRequestId) return;
    const step: ToolCallStep = {
      callId,
      name,
      arguments: argumentsText,
      status: "running",
      startedAt: Date.now(),
    };
    set((state) => {
      const draft = state.streamingMessage;
      if (!draft) return {};
      const toolCalls = (draft.toolCalls ?? []).filter((call) => call.callId !== callId);
      return { streamingMessage: { ...draft, toolCalls: [...toolCalls, step] } };
    });
  },

  finishToolCall: (requestId, callId, result) => {
    if (requestId !== get().streamingRequestId) return;
    set((state) => ({
      streamingMessage: state.streamingMessage
        ? {
            ...state.streamingMessage,
            toolCalls: state.streamingMessage.toolCalls?.map((call) => {
              if (call.callId !== callId) return call;
              const finishedAt = Date.now();
              const durationMs = call.startedAt ? finishedAt - call.startedAt : undefined;
              return { ...call, status: "done", result, finishedAt, durationMs };
            }),
          }
        : null,
    }));
  },

  failToolCall: (requestId, callId, message) => {
    if (requestId !== get().streamingRequestId) return;
    set((state) => ({
      streamingMessage: state.streamingMessage
        ? {
            ...state.streamingMessage,
            toolCalls: state.streamingMessage.toolCalls?.map((call) => {
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
          }
        : null,
    }));
  },

  pendingToolCall: (requestId, callId, name, summary) => {
    if (requestId !== get().streamingRequestId) return;
    const step: ToolCallStep = { callId, name, arguments: "{}", status: "pending", summary };
    set((state) => {
      const draft = state.streamingMessage;
      if (!draft) return {};
      const toolCalls = (draft.toolCalls ?? []).filter((call) => call.callId !== callId);
      return { streamingMessage: { ...draft, toolCalls: [...toolCalls, step] } };
    });
  },

  rejectToolCall: (requestId, callId) => {
    if (requestId !== get().streamingRequestId) return;
    set((state) => ({
      streamingMessage: state.streamingMessage
        ? {
            ...state.streamingMessage,
            toolCalls: state.streamingMessage.toolCalls?.map((call) =>
              call.callId === callId ? { ...call, status: "rejected" } : call,
            ),
          }
        : null,
    }));
  },

  resolveToolCall: (requestId, callId, approved, policy = "once") => {
    void invoke("chat_approve_tool", { requestId, callId, approved, policy }).catch(
      (err) => console.error("发送工具审批结果失败:", err),
    );
  },

  onFinish: (requestId, reason) => {
    const { streamingRequestId, streamingMessageId, streamingMessage, sendStartTime } = get();
    if (requestId !== streamingRequestId || !streamingMessageId || !streamingMessage) return;
    const status = reason === "cancelled" ? "cancelled" : "done";
    const durationMs = sendStartTime ? Date.now() - sendStartTime : undefined;
    const finalMessage = { ...streamingMessage, status, durationMs } as Message;
    set((state) => ({
      streamingRequestId: null,
      streamingMessageId: null,
      streamingMessage: null,
      sendStartTime: null,
      messages: [...state.messages, finalMessage],
    }));
    persistAssistantFinal(streamingMessageId, status);

    // If this reply was triggered by a clipboard quick action, write the
    // result back to the clipboard so the user can paste it right away.
    const writeback = get().clipboardWriteback;
    if (writeback) {
      set({ clipboardWriteback: null });
      if (status === "done" && finalMessage.content.trim()) {
        void writeClipboardText(finalMessage.content.trim()).catch((err) =>
          console.error("写回剪贴板失败:", err),
        );
      }
    }
  },

  onError: (requestId, message, retryable) => {
    const { streamingRequestId, streamingMessageId, streamingMessage, sendStartTime } = get();
    if (requestId !== streamingRequestId || !streamingMessageId || !streamingMessage) return;
    const durationMs = sendStartTime ? Date.now() - sendStartTime : undefined;
    const finalMessage: Message = {
      ...streamingMessage,
      status: "error",
      error: message,
      retryable,
      durationMs,
    };
    set((state) => ({
      streamingRequestId: null,
      streamingMessageId: null,
      streamingMessage: null,
      sendStartTime: null,
      messages: [...state.messages, finalMessage],
    }));
    persistAssistantFinal(streamingMessageId, "error");
  },

  stop: () => {
    const { streamingRequestId, streamingMessageId, streamingMessage, sendStartTime } = get();
    if (!streamingRequestId || !streamingMessageId || !streamingMessage) return;

    // Tell the backend to cancel the in-flight request.
    void invoke("chat_cancel", { requestId: streamingRequestId }).catch(
      () => undefined,
    );

    // Optimistically mark the reply as cancelled immediately so the UI does
    // not appear stuck if the stream is currently blocked on a slow read.
    const durationMs = sendStartTime ? Date.now() - sendStartTime : undefined;
    const finalMessage = {
      ...streamingMessage,
      status: "cancelled" as const,
      durationMs,
    };
    set((state) => ({
      streamingRequestId: null,
      streamingMessageId: null,
      streamingMessage: null,
      sendStartTime: null,
      messages: [...state.messages, finalMessage],
    }));
    persistAssistantFinal(streamingMessageId, "cancelled");
  },

  retryLast: (opts) => {
    const { messages, streamingRequestId, lastSendOptions } = get();
    if (streamingRequestId) return;

    const failed = [...messages].reverse().find((m) => m.role === "assistant");
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

  /** Start a branch from the given message: cut everything after it and
   * focus the composer so the user can continue with a new prompt.  The
   * chosen message becomes the last one in the conversation. */
  branchFrom: (messageId: string) => {
    const { messages, streamingRequestId, conversationNonce } = get();
    if (streamingRequestId) return;
    const index = messages.findIndex((m) => m.id === messageId);
    if (index < 0) return;
    const kept = messages.slice(0, index + 1);
    // Bump the nonce so the composer re-focuses, prompting the user to
    // continue from this branch point.
    set({ messages: kept, conversationNonce: conversationNonce + 1 });
  },

  clearConversation: () => {
    const { streamingRequestId, conversationNonce } = get();
    if (streamingRequestId) {
      void invoke("chat_cancel", { requestId: streamingRequestId }).catch(
        () => undefined,
      );
    }
    set({
      messages: [],
      streamingRequestId: null,
      streamingMessageId: null,
      streamingMessage: null,
      conversationNonce: conversationNonce + 1,
    });
    useHistoryStore.getState().setActive(null);
  },

  loadConversation: async (id) => {
    const { streamingRequestId } = get();
    if (streamingRequestId) return;
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
      }));
      useHistoryStore.getState().setActive(id);
      set({ messages, streamingRequestId: null, streamingMessageId: null, streamingMessage: null });
    } catch (err) {
      console.error("加载会话失败:", err);
      void useHistoryStore.getState().refreshList();
    }
  },
}));
