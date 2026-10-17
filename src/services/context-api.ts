import { invoke } from "@tauri-apps/api/core";
import type { ContextExclusions, ContextPreview, Role } from "../types";

export interface ContextPreviewRequest {
  providerId: string;
  modelKey: string;
  messages: { role: Role; content: string; images?: string[] }[];
  systemPrompt: string | null;
  conversationId?: string;
  webSearch: boolean;
  enableTools: boolean;
  enableThinking: boolean;
  thinkingEffort: string;
  skillIds: string[];
  contextExclusions: ContextExclusions;
}

export function previewContext(request: ContextPreviewRequest): Promise<ContextPreview> {
  return invoke("chat_preview_context", { request });
}
