import { invoke } from "@tauri-apps/api/core";

/** Typed wrappers around the conversation history commands. */

export interface Conversation {
  id: string;
  title: string;
  providerId: string | null;
  modelKey: string | null;
  systemPrompt: string | null;
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
  createdAt: number;
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

export function clearAllHistory(): Promise<void> {
  return invoke("clear_all_history");
}
