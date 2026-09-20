import { invoke } from "@tauri-apps/api/core";

/** Typed wrapper around the model-usage statistics command (v17). */

/** Aggregated token usage for one model. */
export interface ModelUsage {
  /** Model display name; `null` for rows that never recorded one. */
  modelName: string | null;
  inputTokens: number;
  outputTokens: number;
  /** Finished assistant turns attributed to this model. */
  rounds: number;
  /** Mean wall-clock duration of those turns (ms); `null` without data. */
  avgDurationMs: number | null;
  /** Timestamp (ms) of the most recent turn using this model. */
  lastUsedAt: number | null;
}

/** Tokens consumed on one calendar day (local time). */
export interface DailyUsage {
  /** `YYYY-MM-DD` in the user's local time zone. */
  day: string;
  inputTokens: number;
  outputTokens: number;
  rounds: number;
}

/** Tokens consumed by one model on one calendar day (trend lines). */
export interface ModelDailyUsage {
  /** Model display name; `null` for the "unknown model" bucket. */
  modelName: string | null;
  /** `YYYY-MM-DD` in the user's local time zone. */
  day: string;
  inputTokens: number;
  outputTokens: number;
}

/** Everything the usage panel needs, from one backend round of queries. */
export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  /** Finished assistant turns on record. */
  rounds: number;
  /** Rounds that carry token numbers (older rows and some providers have none). */
  roundsWithUsage: number;
  /** Longest span between the first and last message of a conversation. */
  longestSessionMs: number;
  /** Per-model breakdown, ordered by total tokens (descending). */
  models: ModelUsage[];
  /** Per-day totals, ascending by day. */
  daily: DailyUsage[];
  /** Per-model per-day totals over the last year. */
  modelDaily: ModelDailyUsage[];
}

export function getUsageStats(): Promise<UsageStats> {
  return invoke<UsageStats>("get_usage_stats");
}
