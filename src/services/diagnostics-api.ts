import { invoke } from "@tauri-apps/api/core";

/** A redacted agent-run trace (no credentials or message bodies). */
export interface RunTrace {
  id: string;
  conversationId: string | null;
  modelKey: string | null;
  status: string;
  errorCode: string | null;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  /** Number of tool calls executed during the run. */
  toolCount: number;
  /** Number of HTTP retries performed during the run. */
  retryCount: number;
}

export function listRuns(limit?: number): Promise<RunTrace[]> {
  return invoke<RunTrace[]>("list_runs", { limit });
}

export function clearRuns(): Promise<void> {
  return invoke("clear_runs");
}
