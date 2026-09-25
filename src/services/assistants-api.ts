import { invoke } from "@tauri-apps/api/core";
import type { ToolPolicy } from "./tools-api";

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

const TOOL_POLICIES: ToolPolicy[] = ["allow", "confirm", "always_allow", "disabled"];

/**
 * Tool-policy overrides stored on an assistant, parsed.  Only tools listed
 * here are overridden; everything else follows the global policy, and the
 * stricter of the two always wins (see the Rust `merge_tool_policies`).
 */
export function assistantToolPolicies(assistant: AssistantView): Record<string, ToolPolicy> {
  if (!assistant.toolPoliciesJson) return {};
  try {
    const parsed: unknown = JSON.parse(assistant.toolPoliciesJson);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, ToolPolicy] =>
          TOOL_POLICIES.includes(entry[1] as ToolPolicy),
      ),
    );
  } catch {
    return {};
  }
}

/** Serialize overrides; an empty map becomes `null` (= no override at all). */
export function serializeToolPolicies(policies: Record<string, ToolPolicy>): string | null {
  const entries = Object.entries(policies).filter(([, policy]) => TOOL_POLICIES.includes(policy));
  return entries.length > 0 ? JSON.stringify(Object.fromEntries(entries)) : null;
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
