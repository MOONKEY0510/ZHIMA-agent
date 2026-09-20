import { invoke } from "@tauri-apps/api/core";

/**
 * Assistant presets (P1-7): a role bundle of system prompt + optional pinned
 * model + suggested tool policies. Built-ins ship with the app.
 */

/** Id prefix of a shipped assistant (cannot be deleted, only reset). */
export const BUILTIN_ASSISTANT_PREFIX = "assistant.builtin.";

export interface AssistantView {
  id: string;
  name: string;
  icon: string | null;
  description: string | null;
  systemPrompt: string;
  /** Pinned model; null follows the global default selection. */
  providerId: string | null;
  modelKey: string | null;
  /** Suggested tool policies as a serialized JSON object. */
  toolPoliciesJson: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export function isBuiltinAssistant(id: string): boolean {
  return id.startsWith(BUILTIN_ASSISTANT_PREFIX);
}

/** Suggested tool policies of an assistant, parsed (may be empty). */
export function assistantToolPolicies(
  assistant: AssistantView,
): Record<string, "allow" | "confirm" | "disabled"> {
  if (!assistant.toolPoliciesJson) return {};
  try {
    const parsed = JSON.parse(assistant.toolPoliciesJson);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function listAssistants(): Promise<AssistantView[]> {
  return invoke<AssistantView[]>("list_assistants");
}

/** Create (empty id) or update an assistant. */
export function upsertAssistant(assistant: AssistantView): Promise<AssistantView> {
  return invoke<AssistantView>("upsert_assistant", { assistant });
}

export function deleteAssistant(id: string): Promise<void> {
  return invoke("delete_assistant", { id });
}

export function resetBuiltinAssistant(id: string): Promise<AssistantView> {
  return invoke<AssistantView>("reset_builtin_assistant", { id });
}
