import { invoke } from "@tauri-apps/api/core";
import type { AttachmentMeta, MessageStatus, MessageVersion } from "../types";

/** Typed wrappers around the conversation history commands. */

export interface Conversation {
  id: string;
  title: string;
  providerId: string | null;
  modelKey: string | null;
  systemPrompt: string | null;
  /** Assistant this conversation is bound to (null = global default). */
  assistantId: string | null;
  /** Pinned conversations sort above the recency list (P1-11.1). */
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  status: string;
  reasoning?: string | null;
  /** Serialized JSON array of tool-call steps (agent loop). */
  toolCalls?: string | null;
  modelName?: string | null;
  durationMs?: number | null;
  /** Prompt tokens reported by the provider (recorded since v17). */
  inputTokens?: number | null;
  /** Completion tokens reported by the provider (recorded since v17). */
  outputTokens?: number | null;
  /** Serialized JSON array of every version of this message's content. */
  versionsJson?: string | null;
  /** Index of the version mirrored by the row fields above. */
  activeVersion?: number;
  /** Serialized JSON array of `{ name, chars }` for attached documents. */
  attachmentsJson?: string | null;
  createdAt: number;
}

/** Parse persisted attachment metadata, tolerating absent/corrupted payloads. */
export function parseAttachmentsJson(raw?: string | null): AttachmentMeta[] | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as AttachmentMeta[];
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    return parsed
      .filter((entry) => entry && typeof entry.name === "string")
      .map((entry) => ({ name: entry.name, chars: Number(entry.chars) || 0 }));
  } catch {
    return undefined;
  }
}

/** Parse a persisted version stack, tolerating absent/corrupted payloads. */
export function parseVersionsJson(raw?: string | null): MessageVersion[] | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as MessageVersion[];
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    return parsed.map((v) => ({
      content: v.content ?? "",
      reasoning: v.reasoning ?? undefined,
      modelName: v.modelName ?? undefined,
      durationMs: v.durationMs ?? undefined,
      status: v.status as MessageStatus | undefined,
      createdAt: v.createdAt ?? 0,
    }));
  } catch {
    return undefined;
  }
}

/** Edit a user message: appends the new content as a new version. */
export function editMessage(id: string, content: string): Promise<StoredMessage> {
  return invoke<StoredMessage>("edit_message", { id, content });
}

/** Archive the current answer and open a blank version for regeneration. */
export function startMessageVersion(id: string): Promise<StoredMessage> {
  return invoke<StoredMessage>("start_message_version", { id });
}

/** Switch which version of a message is active. */
export function activateMessageVersion(id: string, index: number): Promise<StoredMessage> {
  return invoke<StoredMessage>("activate_message_version", { id, index });
}

/** One full-text search hit across all conversations. */
export interface MessageHit {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  role: string;
  /** Excerpt with 「」 markers around the matched phrase. */
  snippet: string;
  createdAt: number;
}

/** Full-text search over message content (queries of 1-2 chars use LIKE). */
export function searchMessages(query: string, limit = 50): Promise<MessageHit[]> {
  return invoke<MessageHit[]>("search_messages", { query, limit });
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: StoredMessage[];
}

export function listConversations(): Promise<Conversation[]> {
  return invoke<Conversation[]>("list_conversations");
}

export function getConversation(id: string): Promise<ConversationDetail> {
  return invoke<ConversationDetail>("get_conversation", { id });
}

export function createConversation(conv: Conversation): Promise<Conversation> {
  return invoke<Conversation>("create_conversation", { conv });
}

export interface BeginChatTurnArgs {
  conversation: Conversation | null;
  userMessage: StoredMessage;
  assistantMessage: StoredMessage;
  updatedAt: number;
  providerId: string | null;
  modelKey: string | null;
}

export function beginChatTurn(args: BeginChatTurnArgs): Promise<void> {
  return invoke("begin_chat_turn", { args });
}

export function saveMessage(msg: StoredMessage): Promise<void> {
  return invoke("save_message", { msg });
}

export function touchConversation(
  id: string,
  updatedAt: number,
  providerId: string | null,
  modelKey: string | null,
): Promise<void> {
  return invoke("touch_conversation", { id, updatedAt, providerId, modelKey });
}

export function renameConversation(id: string, title: string): Promise<void> {
  return invoke("rename_conversation", { id, title });
}

export function setConversationSystemPrompt(
  id: string,
  systemPrompt: string | null,
): Promise<void> {
  return invoke("set_conversation_system_prompt", { id, systemPrompt });
}

export function deleteConversation(id: string): Promise<void> {
  return invoke("delete_conversation", { id });
}

/** Pin or unpin a conversation. */
export function setConversationPinned(id: string, pinned: boolean): Promise<void> {
  return invoke("set_conversation_pinned", { id, pinned });
}

export function clearAllHistory(): Promise<void> {
  return invoke("clear_all_history");
}
