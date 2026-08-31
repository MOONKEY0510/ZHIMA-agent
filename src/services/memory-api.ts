import { invoke } from "@tauri-apps/api/core";

/** A user-confirmed long-term memory (v2.0 phase 4). */
export interface Memory {
  id: string;
  category: string;
  content: string;
  keywordsJson: string | null;
  sensitivity: string;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  useCount: number;
}

export function listMemories(): Promise<Memory[]> {
  return invoke<Memory[]>("list_memories");
}

export function createMemory(
  id: string,
  category: string,
  content: string,
  source?: { conversationId: string | null; messageId: string },
): Promise<Memory> {
  return invoke<Memory>("create_memory", {
    id,
    category,
    content,
    sourceConversationId: source?.conversationId ?? null,
    sourceMessageId: source?.messageId ?? null,
  });
}

export function updateMemory(
  id: string,
  content: string,
  category: string,
): Promise<void> {
  return invoke("update_memory", { id, content, category });
}

export function setMemoryEnabled(id: string, enabled: boolean): Promise<void> {
  return invoke("set_memory_enabled", { id, enabled });
}

export function deleteMemory(id: string): Promise<void> {
  return invoke("delete_memory", { id });
}

export function clearMemories(): Promise<void> {
  return invoke("clear_memories");
}
