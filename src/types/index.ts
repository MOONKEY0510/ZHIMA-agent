export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** One tool call step attached to an assistant message. */
export interface ToolCallStep {
  /** Backend call id (matches the provider's `tool_call_id`). */
  callId: string;
  name: string;
  /** Serialized JSON arguments the model requested. */
  arguments: string;
  status: "pending" | "running" | "done" | "error" | "rejected";
  /** Human-readable summary shown on the confirmation card. */
  summary?: string;
  /** Whether ordinary permission may be remembered for this action. */
  canRemember?: boolean;
  /** Serialized JSON result when `status === "done"`. */
  result?: string;
  /** Error message when `status === "error"`. */
  error?: string;
  /** Wall-clock time (ms) when the tool started executing. */
  startedAt?: number;
  /** Wall-clock time (ms) when the tool finished (success or failure). */
  finishedAt?: number;
  /** Execution duration in ms, derived from startedAt/finishedAt. */
  durationMs?: number;
}

export type ChatStreamEvent =
  | { type: "start"; seq: number; requestId: string }
  | { type: "search_start"; seq: number; requestId: string; query: string }
  | { type: "search_end"; seq: number; requestId: string; results: SearchResult[] }
  | { type: "kb_used"; seq: number; requestId: string; count: number; titles: string[] }
  | {
      type: "tool_start";
      seq: number;
      requestId: string;
      callId: string;
      name: string;
      arguments: string;
    }
  | {
      type: "tool_end";
      seq: number;
      requestId: string;
      callId: string;
      name: string;
      result: string;
    }
  | {
      type: "tool_error";
      seq: number;
      requestId: string;
      callId: string;
      name: string;
      message: string;
    }
  | {
      type: "tool_pending";
      seq: number;
      requestId: string;
      callId: string;
      name: string;
      summary: string;
      canRemember?: boolean;
    }
  | {
      type: "tool_rejected";
      seq: number;
      requestId: string;
      callId: string;
      name: string;
    }
  | { type: "delta"; seq: number; requestId: string; text: string }
  | { type: "reasoning_delta"; seq: number; requestId: string; text: string }
  | {
      type: "usage";
      seq: number;
      requestId: string;
      inputTokens?: number;
      outputTokens?: number;
    }
  | { type: "finish"; seq: number; requestId: string; reason?: string }
  | {
      type: "error";
      seq: number;
      requestId: string;
      code: string;
      message: string;
      retryable: boolean;
    };

export type Role = "user" | "assistant";

export type MessageStatus = "streaming" | "done" | "error" | "cancelled";

/** Metadata of a document attached to a prompt (P1-8). */
export interface AttachmentMeta {
  name: string;
  chars: number;
}

/**
 * One entry inside a message's version stack.  The stack holds every version
 * of the message content (oldest first) and is what the `‹ n/m ›` switcher
 * walks through; `Message.activeVersion` points at the visible entry.
 */
export interface MessageVersion {
  content: string;
  reasoning?: string;
  modelName?: string;
  durationMs?: number;
  status?: MessageStatus;
  createdAt: number;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  status: MessageStatus;
  /** Model thinking trace, shown collapsed; never mixed into `content`. */
  reasoning?: string;
  /** Error text shown for `status === "error"`. */
  error?: string;
  /** Whether the failed request can be retried. */
  retryable?: boolean;
  /** Image thumbnails attached to the message (data URLs). */
  images?: string[];
  /** Token usage from the API response (assistant messages only). */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Display name of the model that produced this assistant message. */
  modelName?: string;
  /** How long the assistant turn took from send to finish (milliseconds). */
  durationMs?: number;
  /** Web search sources (assistant messages only, when web search was on). */
  sources?: SearchResult[];
  /** Transient: the query being searched while the backend runs a web search. */
  searchingQuery?: string;
  /** Tool calls executed during this assistant turn (agent loop). */
  toolCalls?: ToolCallStep[];
  /** Version stack of this message's content (created by edit / regenerate). */
  versions?: MessageVersion[];
  /** Index of the active version inside `versions`. */
  activeVersion?: number;
  /**
   * Documents attached to this prompt (P1-8).  Their text is part of
   * `content`; this is the metadata used for the badge.
   */
  attachments?: AttachmentMeta[];
  /** Knowledge-base passages injected into this turn (P1-9). */
  kbHits?: number;
  /** Titles of those passages (tooltip of the hint chip). */
  kbTitles?: string[];
}

export interface ModelEntry {
  modelKey: string;
  displayName: string;
  isFavorite: boolean;
  sortOrder: number;
  supportsVision: boolean;
}

/** Provider as returned by the backend — never contains key material. */
export interface ProviderView {
  id: string;
  name: string;
  baseUrl: string;
  apiType: string;
  hasApiKey: boolean;
  models: ModelEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface GenerationPrefs {
  temperature: number | null;
  maxTokens: number | null;
}

export interface ProvidersStateView {
  providers: ProviderView[];
  defaultProviderId: string | null;
  defaultModelKey: string | null;
  generation: GenerationPrefs;
  visionProviderId: string | null;
  visionModelKey: string | null;
  imageProviderId: string | null;
  imageModelKey: string | null;
  defaultSystemPrompt: string | null;
  rememberWindowPosition: boolean;
  proxyUrl: string | null;
  useSystemProxy: boolean;
}

export type ThemeMode = "system" | "light" | "dark" | "warm" | "rose" | "spring";
