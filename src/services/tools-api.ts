import { invoke } from "@tauri-apps/api/core";

export type ToolRiskLevel = "low" | "external_read" | "sensitive_read" | "external_action";

/** Per-tool policy configured by the user. */
export type ToolPolicy = "allow" | "confirm" | "disabled";

/** One tool as reported by the backend `list_tools` command. */
export interface ToolInfo {
  name: string;
  description: string;
  riskLevel: ToolRiskLevel | string;
  requiresConfirmation: boolean;
  /** Current user policy for this tool. */
  policy: ToolPolicy;
}

/** Fetch the builtin tool definitions from the Rust registry. */
export function listTools(): Promise<ToolInfo[]> {
  return invoke<ToolInfo[]>("list_tools");
}

/** Persist the per-tool usage policy. */
export function setToolPolicy(name: string, policy: ToolPolicy): Promise<void> {
  return invoke("set_tool_policy", { name, policy });
}

/** Read the current clipboard text (explicit user action, no approval). */
export function readClipboardText(): Promise<string> {
  return invoke<string>("read_clipboard_text");
}

/** Write text to the clipboard (explicit user action, no approval). */
export function writeClipboardText(text: string): Promise<void> {
  return invoke("write_clipboard_text", { text });
}
