import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isPrinting, subscribePrinting } from "../../lib/print";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  Bookmark,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  GitBranch,
  Globe,
  Pencil,
  RefreshCw,
  Square,
  Wrench,
} from "lucide-react";
import type { Message, MessageVersion, SearchResult, ToolCallStep } from "../../types";
import { formatChars, splitAttachments } from "../../lib/attachments";
import {
  streamRequestIdForMessage,
  useActiveStreaming,
  useChatStore,
} from "../../stores/chat-store";
import { useHistoryStore } from "../../services/history-store";
import { createMemory } from "../../services/memory-api";
import { useProvidersStore } from "../../stores/providers-store";
import { useWindowStore } from "../../stores/window-store";
import { useSettingsStore, type AvatarShape } from "../../stores/settings-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Markdown } from "../markdown/Markdown";
import { StreamingMarkdown } from "../markdown/StreamingMarkdown";
import { markdownToPlainText } from "../../lib/markdown-plain";

/** Small reusable dropdown used by the memory category picker. */
function Dropdown({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div ref={ref} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between gap-2 rounded-btn border border-line bg-panel-2 px-1.5 py-1 text-left text-[11px] text-ink outline-none transition-colors hover:bg-panel focus:border-[var(--cf-text-2)]"
      >
        <span>{selected?.label ?? value}</span>
        <ChevronDown
          size={12}
          className={`shrink-0 text-ink-2 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 min-w-full overflow-hidden rounded-btn border border-line bg-panel py-1 shadow-lg">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              className={`block w-full whitespace-nowrap px-2 py-1 text-left text-[11px] transition-colors ${
                option.value === value
                  ? "bg-accent/15 text-accent"
                  : "text-ink hover:bg-panel-2"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One rendered row of the list: a single message, or the answers of a
 * multi-model turn (P1-6) that share one prompt and render side by side.
 */
type ListRow =
  | { kind: "single"; id: string; message: Message }
  | { kind: "group"; id: string; messages: Message[] };

/** The messages a row contains (used for search-hit lookup). */
function messagesOf(row: ListRow): Message[] {
  return row.kind === "single" ? [row.message] : row.messages;
}

/** Group consecutive assistant replies (2+) under their prompt into one row. */
function groupRows(messages: Message[]): ListRow[] {
  const rows: ListRow[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (message.role !== "user") {
      rows.push({ kind: "single", id: message.id, message });
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < messages.length && messages[j].role === "assistant") j += 1;
    const assistants = messages.slice(i + 1, j);
    rows.push({ kind: "single", id: message.id, message });
    if (assistants.length === 1) {
      rows.push({ kind: "single", id: assistants[0].id, message: assistants[0] });
    } else if (assistants.length > 1) {
      rows.push({ kind: "group", id: `group-${assistants[0].id}`, messages: assistants });
    }
    i = j;
  }
  return rows;
}

export function MessageList() {
  const messages = useChatStore((s) => s.messages);
  // Printing expands the virtual list so every message reaches the paper.
  const printing = useSyncExternalStore(subscribePrinting, isPrinting);
  const activeId = useHistoryStore((s) => s.activeId);
  // The displayed conversation's own stream state (background conversations
  // may generate in parallel without affecting this list).
  const streaming = useActiveStreaming();
  const listRef = useRef<VirtuosoHandle>(null);
  const previousLength = useRef(messages.length);
  const [activeTurn, setActiveTurn] = useState(0);
  const focusMessageId = useChatStore((s) => s.focusMessageId);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const handledFocus = useRef<string | null>(null);

  const rows = useMemo(() => groupRows(messages), [messages]);
  const turnIndexes = useMemo(
    () => rows.flatMap((row, index) => (row.kind === "single" && row.message.role === "user" ? [index] : [])),
    [rows],
  );

  // A new prompt must always land at the latest turn, even if the user had
  // browsed older messages before sending it.
  useEffect(() => {
    if (rows.length > previousLength.current) {
      listRef.current?.scrollToIndex({ index: rows.length - 1, align: "end", behavior: "smooth" });
    }
    previousLength.current = rows.length;
  }, [rows.length]);

  useEffect(() => {
    previousLength.current = rows.length;
    setActiveTurn(Math.max(0, turnIndexes.length - 1));
  }, [activeId]);

  // Reveal a message requested by the sidebar's search results (P0-2):
  // scroll it into view once and flash a highlight so the user spots it.
  useEffect(() => {
    if (!focusMessageId || handledFocus.current === focusMessageId) return;
    const index = rows.findIndex((row) =>
      messagesOf(row).some((m) => m.id === focusMessageId),
    );
    if (index < 0) return;
    handledFocus.current = focusMessageId;
    setHighlightId(focusMessageId);
    const frame = window.requestAnimationFrame(() => {
      listRef.current?.scrollToIndex({ index, align: "center", behavior: "smooth" });
      useChatStore.getState().clearFocusMessage();
    });
    const timer = window.setTimeout(() => setHighlightId(null), 2200);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [focusMessageId, rows]);

  if (messages.length === 0) {
    return <EmptyState />;
  }

  const jumpToTurn = (turn: number) => {
    const index = turnIndexes[turn];
    if (index === undefined) return;
    setActiveTurn(turn);
    listRef.current?.scrollToIndex({ index, align: "start", behavior: "smooth" });
  };

  return (
    // `data-export-root` marks the pane that image export snapshots; the
    // print stylesheet keeps only this subtree visible (P1-11.2 / P1-11.3).
    <div className="cf-print-area relative flex min-h-0 flex-1" data-export-root>
      <Virtuoso
        ref={listRef}
        // Re-mount on conversation switch so the list starts at the newest
        // message (bottom) instead of the top.
        key={activeId ?? "new"}
        data={rows}
        computeItemKey={(_index, row) => row.id}
        initialTopMostItemIndex={Math.max(0, rows.length - 1)}
        style={{ height: "100%" }}
        className="flex-1"
        followOutput={"smooth"}
        // While printing, every row must exist in the DOM (the list is
        // virtualised), so the viewport is widened to the whole conversation.
        increaseViewportBy={printing ? { top: 200_000, bottom: 200_000 } : { top: 200, bottom: 200 }}
        rangeChanged={({ startIndex, endIndex }) => {
          let visibleTurn = -1;
          for (let turn = turnIndexes.length - 1; turn >= 0; turn--) {
            if (turnIndexes[turn] <= endIndex) {
              visibleTurn = turn;
              break;
            }
          }
          if (visibleTurn >= 0 && startIndex <= turnIndexes[visibleTurn] + 1) {
            setActiveTurn(visibleTurn);
          }
        }}
        itemContent={(_index, row) => (
          <div
            className={`px-3 pb-5 transition-colors duration-500 ${
              messagesOf(row).some((m) => m.id === highlightId)
                ? "rounded-input bg-[color-mix(in_srgb,var(--cf-accent)_10%,transparent)]"
                : ""
            }`}
          >
            {row.kind === "single" ? (
              <MessageItem message={row.message} streaming={streaming} />
            ) : (
              // Multi-model answers to one prompt, side by side (P1-6).
              <div
                className="grid gap-3"
                style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}
              >
                {row.messages.map((m) => (
                  <div key={m.id} className="min-w-0">
                    <MessageItem message={m} streaming={streaming} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      />
      {turnIndexes.length > 1 && (
        <nav aria-label="对话轮次索引" className="cf-turn-index">
          {turnIndexes.map((messageIndex, turn) => (
            <button
              key={rows[messageIndex]?.id}
              type="button"
              title={`跳转到第 ${turn + 1} 轮对话`}
              aria-label={`跳转到第 ${turn + 1} 轮对话`}
              aria-current={turn === activeTurn ? "true" : undefined}
              onClick={() => jumpToTurn(turn)}
              className={`cf-turn-index-dot ${turn === activeTurn ? "is-active" : ""}`}
            />
          ))}
        </nav>
      )}
    </div>
  );
}

const EmptyState = memo(function EmptyState() {
  const providerCount = useProvidersStore((s) => s.providers.length);
  const openSettings = useWindowStore((s) => s.openSettings);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
      <p className="text-sm text-ink-2">有什么可以帮你的？直接输入问题，让我这个桌面小助手来协助你。</p>
      {providerCount === 0 && (
        <button
          onClick={() => openSettings()}
          className="mt-1 rounded-btn border border-line px-3 py-1 text-xs text-ink transition-colors hover:bg-panel-2"
        >
          先配置服务商
        </button>
      )}
    </div>
  );
});

function avatarRadius(shape: AvatarShape): string {
  return shape === "circle" ? "50%" : shape === "rounded" ? "28%" : "20%";
}

/** AI avatar — shows custom image if set, otherwise shape + color fallback. */
function AiAvatar() {
  const shape = useSettingsStore((s) => s.aiAvatar);
  const color = useSettingsStore((s) => s.aiAvatarColor);
  const image = useSettingsStore((s) => s.aiAvatarImage);
  const radius = avatarRadius(shape);

  if (image) {
    return (
      <img
        src={image}
        alt="AI"
        className="h-7 w-7 shrink-0 select-none object-cover"
        style={{ borderRadius: radius }}
      />
    );
  }

  return (
    <div
      className="flex h-7 w-7 shrink-0 select-none items-center justify-center text-[11px] font-bold text-white"
      style={{ backgroundColor: color, borderRadius: radius }}
    >
      AI
    </div>
  );
}

/** User avatar — shows custom image if set, otherwise shape + color fallback. */
function UserAvatar() {
  const shape = useSettingsStore((s) => s.userAvatar);
  const color = useSettingsStore((s) => s.userAvatarColor);
  const image = useSettingsStore((s) => s.userAvatarImage);
  const radius = avatarRadius(shape);

  if (image) {
    return (
      <img
        src={image}
        alt="Me"
        className="h-7 w-7 shrink-0 select-none object-cover"
        style={{ borderRadius: radius }}
      />
    );
  }

  return (
    <div
      className="flex h-7 w-7 shrink-0 select-none items-center justify-center text-[11px] font-bold text-white"
      style={{ backgroundColor: color, borderRadius: radius }}
    >
      我
    </div>
  );
}

const MessageItem = memo(function MessageItem({
  message,
  streaming,
}: {
  message: Message;
  streaming: boolean;
}) {
  if (message.role === "user") {
    return <UserMessage message={message} streaming={streaming} />;
  }

  const isStreamingThis = message.status === "streaming" && streaming;

  // Some providers (e.g. certain DeepSeek relays) return the bulk of the answer
  // inside the reasoning/thinking field and leave the content field almost
  // empty. When content is abnormally short but reasoning exists, expand the
  // reasoning block automatically so the user sees the actual reply.
  const expandReasoning =
    message.content.trim().length <= 2 && (message.reasoning?.trim().length ?? 0) > 0;

  return (
    <div className="group flex gap-2" data-message-id={message.id}>
      <AiAvatar />
      <div className="min-w-0 flex-1">
        {message.reasoning && (
          <ReasoningBlock text={message.reasoning} defaultOpen={expandReasoning} />
        )}

        {/* Web search status / sources */}
        {message.searchingQuery && (
          <div className="mb-1 flex items-center gap-1.5 py-1 text-xs text-ink-2">
            <Globe size={12} className="animate-pulse text-accent" />
            正在搜索：{message.searchingQuery}
          </div>
        )}
        {message.sources && message.sources.length > 0 && (
          <SourcesBlock sources={message.sources} />
        )}

        {/* Local knowledge base hint (P1-9) */}
        {message.kbHits != null && message.kbHits > 0 && (
          <div
            className="mb-1 flex items-center gap-1.5 py-0.5 text-[11px] text-ink-2"
            title={message.kbTitles?.join("\n")}
          >
            <Bookmark size={11} className="text-accent" />
            已参考知识库 {message.kbHits} 条
          </div>
        )}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <ToolCallsBlock toolCalls={message.toolCalls} messageId={message.id} />
        )}

        {message.content.length > 0 && (
          <div className="md-body select-text text-sm">
            {isStreamingThis ? (
              <StreamingMarkdown content={message.content} caret />
            ) : (
              <Markdown content={message.content} />
            )}
          </div>
        )}

        {/* Short-reply hint: when the model returns a suspiciously short answer
            without any reasoning, surface a likely-cause hint instead of leaving
            the user guessing. */}
        {!isStreamingThis &&
          message.content.trim().length <= 2 &&
          !message.reasoning &&
          message.status === "done" && (
            <p className="mt-1 text-[11px] leading-4 text-ink-2">
              模型返回异常简短。常见原因：当前模型行为、系统提示词要求“简洁”，或最大输出长度被限制。可尝试切换模型或检查设置 → 模型设置。
            </p>
          )}

        {isStreamingThis && message.content.length === 0 && !message.searchingQuery && (
          <div className="flex items-center gap-1.5 py-1 text-xs text-ink-2">
            <span className="stream-caret" />
            正在思考…
          </div>
        )}

        {message.status === "error" && (
          <div className="mt-1 rounded-btn border border-[color-mix(in_srgb,var(--cf-danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--cf-danger)_8%,transparent)] px-3 py-2 text-xs leading-5 text-danger">
            <p>{message.error ?? "请求失败"}</p>
            {message.retryable && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => void useChatStore.getState().regenerate(message.id)}
                  className="inline-flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-0.5 text-xs text-ink transition-colors hover:bg-panel-2"
                >
                  <RefreshCw size={11} /> 重试
                </button>
                {message.toolCalls && message.toolCalls.length > 0 && (
                  <button
                    onClick={() =>
                      void useChatStore.getState().regenerate(message.id, { disableTools: true })
                    }
                    className="inline-flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-0.5 text-xs text-ink transition-colors hover:bg-panel-2"
                    title="关闭 Agent 工具后重新提问，常用于工具调用失败时的恢复"
                  >
                    <Wrench size={11} className="opacity-60" /> 不使用工具重试
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {message.status === "cancelled" && message.content.length > 0 && (
          <p className="mt-1 text-xs text-ink-2">已停止生成</p>
        )}

        {/* Per-column stop: a multi-model turn runs several streams at once,
            so each one can be cancelled on its own. */}
        {isStreamingThis && (
          <button
            onClick={() => {
              const requestId = streamRequestIdForMessage(
                useChatStore.getState(),
                message.id,
              );
              if (requestId) useChatStore.getState().stopStream(requestId);
            }}
            className="mt-1.5 flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink"
          >
            <Square size={10} /> 停止
          </button>
        )}

        {(message.status === "done" || message.status === "cancelled") &&
          message.content.length > 0 && (
            <MessageActions
              content={message.content}
              usage={message.usage}
              modelName={message.modelName}
              durationMs={message.durationMs}
              messageId={message.id}
            />
          )}

        {message.versions && message.versions.length > 1 && (
          <VersionSwitcher
            messageId={message.id}
            versions={message.versions}
            activeVersion={message.activeVersion ?? 0}
          />
        )}
      </div>
    </div>
  );
});

/** Collapsible list of web search sources shown under the answer. */
function SourcesBlock({ sources }: { sources: SearchResult[] }) {
  const [open, setOpen] = useState(false);

  if (sources.length === 0) return null;

  return (
    <div className="mb-1.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink"
      >
        <Globe size={11} />
        {sources.length} 个来源
        <ChevronRight
          size={11}
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="mt-1 space-y-1.5 rounded-btn border border-line bg-panel-2 p-2">
          {sources.map((s, i) => (
            <a
              key={i}
              href={s.url}
              onClick={(e) => {
                e.preventDefault();
                void openUrl(s.url);
              }}
              className="group flex items-start gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-panel"
              title={s.url}
            >
              <span className="mt-0.5 shrink-0 font-mono text-[10px] text-accent">
                [{i + 1}]
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs text-ink">{s.title}</span>
                <span className="block truncate text-[11px] text-ink-2">{s.snippet}</span>
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCallsBlock({
  toolCalls,
  messageId,
}: {
  toolCalls: ToolCallStep[];
  messageId: string;
}) {
  const [open, setOpen] = useState(false);
  const running = toolCalls.some((call) => call.status === "running");
  const pending = toolCalls.some((call) => call.status === "pending");
  const doneCount = toolCalls.filter((call) => call.status === "done").length;
  // The verdict must reach the stream that produced this call, so resolve the
  // request id from the owning message instead of assuming a single stream.
  const requestId = useChatStore((s) => streamRequestIdForMessage(s, messageId));

  // Auto-expand while a tool call is awaiting approval so the allow/reject
  // buttons are immediately visible instead of hidden behind the toggle.
  useEffect(() => {
    if (pending) setOpen(true);
  }, [pending]);

  const statusText = pending
    ? "等待授权"
    : running
      ? "正在调用工具"
      : `已调用 ${doneCount}/${toolCalls.length} 个工具`;

  return (
    <div className="mb-1.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink"
      >
        <Wrench size={11} className={running || pending ? "animate-pulse text-accent" : ""} />
        {statusText}
        <ChevronRight
          size={11}
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="mt-1 space-y-1.5 rounded-btn border border-line bg-panel-2 p-2">
          {toolCalls.map((call, index) => (
            <div key={call.callId}>
              <ToolCallRow call={call} requestId={requestId} index={index} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** One tool call entry; renders an approval card while pending. */
function ToolCallRow({
  call,
  requestId,
  index,
}: {
  call: ToolCallStep;
  requestId: string | null;
  index: number;
}) {
  const statusLabel =
    call.status === "pending"
      ? "等待授权"
      : call.status === "running"
        ? "执行中"
        : call.status === "done"
          ? "已完成"
          : call.status === "rejected"
            ? "已拒绝"
            : "失败";
  const statusClass =
    call.status === "error"
      ? "text-danger"
      : call.status === "pending" || call.status === "running"
        ? "text-accent"
        : "text-ink-2";
  const done = call.status === "done";
  const [resultOpen, setResultOpen] = useState(false);

  const approve = (policy: "once" | "session" | "always") => {
    if (!requestId) return;
    useChatStore.getState().resolveToolCall(requestId, call.callId, true, policy);
  };
  const reject = () => {
    if (!requestId) return;
    useChatStore.getState().resolveToolCall(requestId, call.callId, false, "once");
  };

  return (
    <div className="rounded-md px-1 py-1 text-[11px]">
      <div className="flex items-center gap-1.5 text-ink">
        <span
          className={`grid h-4 w-4 shrink-0 place-items-center rounded-full text-[9px] ${
            done
              ? "bg-[var(--cf-success-weak,#e6f9ef)] text-[var(--cf-success,#16a34a)]"
              : call.status === "error"
                ? "bg-[var(--cf-danger-weak,#fde)] text-danger"
                : "bg-panel-2 text-ink-2"
          }`}
        >
          {done ? <Check size={10} /> : index + 1}
        </span>
        <span className="font-mono">{call.name}</span>
        <span className={statusClass}>{statusLabel}</span>
        {call.durationMs !== undefined && done && (
          <span className="ml-auto shrink-0 text-ink-2">{formatDuration(call.durationMs)}</span>
        )}
      </div>

      {call.summary && call.status === "pending" ? (
        <div className="mt-1.5 rounded-btn border border-line bg-panel px-2 py-1.5">
          <p className="whitespace-pre-wrap break-all text-ink-2">{call.summary}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <button
              onClick={() => approve("once")}
              className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-accent-fg transition-colors hover:opacity-90"
              title="仅允许这一次"
            >
              <Check size={11} /> 仅一次
            </button>
            <button
              onClick={() => approve("session")}
              className="inline-flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-1 text-[11px] text-ink transition-colors hover:bg-panel-2"
              title="本次会话内不再询问该工具"
            >
              本次会话允许
            </button>
            <button
              onClick={() => approve("always")}
              className="inline-flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-1 text-[11px] text-ink transition-colors hover:bg-panel-2"
              title="永久允许该工具，不再询问"
            >
              永久允许
            </button>
            <button
              onClick={reject}
              className="inline-flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-1 text-[11px] text-danger transition-colors hover:bg-panel-2"
            >
              <XIcon size={11} /> 拒绝
            </button>
          </div>
        </div>
      ) : (
        <>
          {call.error && <div className="mt-1 text-danger">错误：{call.error}</div>}
          {call.status === "rejected" && <div className="mt-1 text-ink-2">用户已拒绝该工具调用</div>}
          {(call.arguments || call.result) && (
            <>
              <button
                onClick={() => setResultOpen((v) => !v)}
                className="mt-1 flex items-center gap-1 text-[10px] text-ink-2 transition-colors hover:text-ink"
              >
                <ChevronRight
                  size={11}
                  className={`transition-transform ${resultOpen ? "rotate-90" : ""}`}
                />
                查看参数与结果
              </button>
              {resultOpen && (
                <div className="mt-1 space-y-1">
                  {call.arguments && (
                    <div className="max-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded bg-panel px-1.5 py-1 text-ink-2">
                      参数：{call.arguments}
                    </div>
                  )}
                  {call.result && (
                    <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded bg-panel px-1.5 py-1 text-ink-2">
                      结果：{call.result}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function XIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

/**
 * Some compatibility relays wrap every reasoning token in `**…**` and
 * concatenate tokens without a newline, producing `****` between steps.
 * Reasoning is an activity trace rather than answer prose, so normalize it
 * to subdued plain text instead of rendering every streamed step as bold.
 */
function formatReasoningMarkdown(text: string): string {
  return text
    .replace(/\*{4,}/g, "\n")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function ReasoningBlock({ text, defaultOpen = false }: { text: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const formattedText = formatReasoningMarkdown(text);

  return (
    <div className="mb-1.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink"
      >
        <ChevronRight
          size={11}
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        />
        思考过程
      </button>
      {open && (
        <div className="mt-1 max-h-48 select-text overflow-y-auto whitespace-pre-wrap rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-[11px] leading-5 text-ink-2">
          {formattedText}
        </div>
      )}
    </div>
  );
}

/**
 * User bubble with hover actions and inline editing (P0-1).  Saving an edit
 * appends a new version and re-runs the turn's reply; the previous prompt
 * stays reachable through the version switcher.
 */
const UserMessage = memo(function UserMessage({
  message,
  streaming,
}: {
  message: Message;
  streaming: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [saving, setSaving] = useState(false);
  const [showAttachmentText, setShowAttachmentText] = useState(false);
  // Attachment blocks live inside the content (P1-8); split them out so the
  // bubble stays compact.
  const { blocks: attachmentBlocks, prompt: userPrompt } = splitAttachments(message.content);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable; ignore quietly.
    }
  };

  const startEdit = () => {
    setDraft(message.content);
    setEditing(true);
  };

  const save = async () => {
    const next = draft.trim();
    if (!next) return;
    if (next === message.content) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await useChatStore.getState().editMessage(message.id, next);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const iconBtn =
    "grid h-5 w-5 place-items-center rounded-md text-ink-2 opacity-0 transition-opacity hover:bg-panel-2 hover:text-ink group-hover:opacity-100 disabled:opacity-30 disabled:hover:bg-transparent";

  return (
    <div className="group flex justify-end gap-2" data-message-id={message.id}>
      <div className="min-w-0 max-w-[85%]">
        {message.images && message.images.length > 0 && (
          <div className="mb-1 flex flex-wrap justify-end gap-1.5">
            {message.images.map((img, idx) => (
              <img
                key={idx}
                src={img}
                alt={`图片 ${idx + 1}`}
                className="h-20 w-20 rounded-btn border border-line object-cover"
              />
            ))}
          </div>
        )}

        {editing ? (
          <div className="rounded-input border border-line bg-panel-2 p-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(10, Math.max(2, draft.split("\n").length))}
              autoFocus
              spellCheck={false}
              className="w-full resize-none bg-transparent text-sm leading-6 text-ink outline-none"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void save();
                }
              }}
            />
            <div className="mt-1.5 flex items-center gap-1.5">
              <span className="mr-auto text-[10px] text-ink-2">
                保存后自动重新生成回复（Ctrl+Enter 保存）
              </span>
              <button
                onClick={() => setEditing(false)}
                className="rounded-btn border border-line px-2 py-0.5 text-[11px] text-ink-2 transition-colors hover:bg-panel"
              >
                取消
              </button>
              <button
                onClick={() => void save()}
                disabled={saving || !draft.trim()}
                className="rounded-btn bg-accent px-2.5 py-0.5 text-[11px] font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        ) : attachmentBlocks.length > 0 ? (
          // Document attachments (P1-8): the text is part of the content, but
          // the bubble shows a chip + the prompt, with the text on demand.
          <div className="flex flex-col items-end gap-1">
            {attachmentBlocks.map((block, idx) => (
              <button
                key={`${block.name}-${idx}`}
                type="button"
                onClick={() => setShowAttachmentText((v) => !v)}
                title={showAttachmentText ? "收起附件内容" : "查看附件内容"}
                className="flex items-center gap-1.5 rounded-btn border border-line bg-panel-2 px-2 py-1 text-[11px] text-ink transition-colors hover:bg-panel"
              >
                <FileText size={11} className="shrink-0 text-ink-2" />
                <span className="max-w-[12rem] truncate">{block.name}</span>
                <span className="shrink-0 text-ink-2">{formatChars(block.text.length)}</span>
              </button>
            ))}
            {userPrompt.length > 0 && (
              <div className="select-text whitespace-pre-wrap rounded-input rounded-br-md bg-[var(--cf-user-bubble)] px-3 py-2 text-sm leading-6">
                {userPrompt}
              </div>
            )}
            {showAttachmentText && (
              <pre className="max-h-64 w-full select-text overflow-auto whitespace-pre-wrap rounded-input border border-line bg-panel-2 px-3 py-2 text-[11px] leading-5 text-ink-2">
                {attachmentBlocks.map((block) => block.text).join("\n\n")}
              </pre>
            )}
          </div>
        ) : (
          message.content.length > 0 && (
            <div className="select-text whitespace-pre-wrap rounded-input rounded-br-md bg-[var(--cf-user-bubble)] px-3 py-2 text-sm leading-6">
              {message.content}
            </div>
          )
        )}

        {!editing && (
          <div className="mt-0.5 flex justify-end">
            <button className={iconBtn} title="复制消息" onClick={() => void copy()}>
              {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
            </button>
            <button
              className={iconBtn}
              title="编辑消息（保存后重新生成回复）"
              onClick={startEdit}
              disabled={streaming}
            >
              <Pencil size={11} />
            </button>
            <button
              className={iconBtn}
              title="从这里继续（创建分支）"
              onClick={() => useChatStore.getState().branchFrom(message.id)}
            >
              <GitBranch size={11} />
            </button>
          </div>
        )}

        {message.versions && message.versions.length > 1 && (
          <div className="flex justify-end">
            <VersionSwitcher
              messageId={message.id}
              versions={message.versions}
              activeVersion={message.activeVersion ?? 0}
            />
          </div>
        )}
      </div>
      <UserAvatar />
    </div>
  );
});

/** `‹ n/m ›` control for messages that carry more than one version. */
function VersionSwitcher({
  messageId,
  versions,
  activeVersion,
}: {
  messageId: string;
  versions: MessageVersion[];
  activeVersion: number;
}) {
  const streaming = useActiveStreaming();
  const total = versions.length;
  const current = Math.min(Math.max(activeVersion, 0), total - 1);

  const go = (index: number) => {
    if (streaming || index < 0 || index >= total || index === current) return;
    void useChatStore.getState().switchMessageVersion(messageId, index);
  };

  const btn =
    "grid h-4 w-4 place-items-center rounded text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent";

  return (
    <div className="mt-1 flex items-center gap-0.5 text-[10px] text-ink-2" title="切换历史版本">
      <button
        className={btn}
        onClick={() => go(current - 1)}
        disabled={streaming || current === 0}
        title="上一个版本"
      >
        <ChevronLeft size={11} />
      </button>
      <span className="tabular-nums">
        {current + 1}/{total}
      </span>
      <button
        className={btn}
        onClick={() => go(current + 1)}
        disabled={streaming || current === total - 1}
        title="下一个版本"
      >
        <ChevronRight size={11} />
      </button>
      <span className="ml-0.5 opacity-70">{current === total - 1 ? "最新" : "历史"}</span>
    </div>
  );
}

function MessageActions({
  content,
  usage,
  modelName,
  durationMs,
  messageId,
}: {
  content: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  modelName?: string;
  durationMs?: number;
  messageId: string;
}) {
  const [copied, setCopied] = useState<"plain" | "md" | null>(null);
  const [memOpen, setMemOpen] = useState(false);
  const [memValue, setMemValue] = useState("");
  const [memCategory, setMemCategory] = useState("preference");
  const [memBusy, setMemBusy] = useState(false);
  const [memDone, setMemDone] = useState(false);
  const [memError, setMemError] = useState<string | null>(null);

  const copyPlain = async () => {
    try {
      await navigator.clipboard.writeText(markdownToPlainText(content));
      setCopied("plain");
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard may be unavailable; ignore quietly.
    }
  };

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied("md");
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard may be unavailable; ignore quietly.
    }
  };

  const openMemo = () => {
    // Prefill with the assistant's key point; the user edits it before saving.
    setMemValue(markdownToPlainText(content).slice(0, 200));
    setMemCategory("preference");
    setMemError(null);
    setMemDone(false);
    setMemOpen(true);
  };

  const saveMemory = async () => {
    const trimmed = memValue.trim();
    if (!trimmed) {
      setMemError("记忆内容不能为空");
      return;
    }
    setMemBusy(true);
    setMemError(null);
    try {
      const conversationId = useHistoryStore.getState().activeId;
      await createMemory("", memCategory, trimmed, {
        conversationId,
        messageId,
      });
      setMemDone(true);
      setTimeout(() => setMemOpen(false), 1200);
    } catch (err) {
      setMemError(String(err));
    } finally {
      setMemBusy(false);
    }
  };

  const btn =
    "grid h-6 w-6 place-items-center rounded-md text-ink-2 opacity-0 transition-opacity hover:bg-panel-2 hover:text-ink group-hover:opacity-100";

  const hasUsage = usage && (usage.inputTokens != null || usage.outputTokens != null);

  return (
    <div className="mt-1">
      <div className="flex items-center gap-0.5">
        <button className={btn} title="复制纯文本" onClick={() => void copyPlain()}>
          {copied === "plain" ? <Check size={12} className="text-success" /> : <Copy size={12} />}
        </button>
        <button className={btn} title="复制 Markdown" onClick={() => void copyMarkdown()}>
          {copied === "md" ? (
            <Check size={12} className="text-success" />
          ) : (
            <FileText size={12} />
          )}
        </button>
        <button
          className={btn}
          title="重新生成（当前回答会保留为历史版本）"
          onClick={() => void useChatStore.getState().regenerate(messageId)}
        >
          <RefreshCw size={12} />
        </button>
        <button className={btn} title="记住这条（保存为长期记忆）" onClick={openMemo}>
          <Bookmark size={12} />
        </button>
        <button
          className={btn}
          title="从这里继续（创建分支）"
          onClick={() => useChatStore.getState().branchFrom(messageId)}
        >
          <GitBranch size={12} />
        </button>
        {(hasUsage || modelName || durationMs) && (
          <span className="ml-1 flex items-center gap-1.5 text-[10px] text-ink-2 opacity-0 transition-opacity group-hover:opacity-100">
            {modelName && <span className="truncate max-w-[120px]">{modelName}</span>}
            {durationMs != null && (
              <span>{(durationMs / 1000).toFixed(1)}s</span>
            )}
            {hasUsage && (
              <span className="flex items-center gap-1">
                {usage.inputTokens != null && (
                  <span className="text-success">↑{usage.inputTokens}</span>
                )}
                {usage.outputTokens != null && (
                  <span className="text-accent">↓{usage.outputTokens}</span>
                )}
              </span>
            )}
          </span>
        )}
      </div>
      {memOpen && (
        <div className="mt-1.5 rounded-btn border border-line bg-panel px-2.5 py-2">
          <p className="mb-1 text-[11px] font-medium text-ink">保存为长期记忆</p>
          <textarea
            value={memValue}
            onChange={(e) => setMemValue(e.target.value)}
            rows={3}
            maxLength={500}
            className="w-full resize-none rounded-btn border border-line bg-panel-2 px-2 py-1.5 text-[11px] leading-4 text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-[var(--cf-text-2)]"
            placeholder="编辑要记住的内容（如用户偏好、工作背景等）"
          />
          <div className="mt-1.5 flex items-center gap-1.5">
            <Dropdown
              value={memCategory}
              onChange={(val) => setMemCategory(val)}
              options={[
                { value: "preference", label: "偏好" },
                { value: "background", label: "背景" },
                { value: "project", label: "项目" },
                { value: "task", label: "任务" },
                { value: "custom", label: "自定义" },
              ]}
              className="w-auto"
            />
            <button
              onClick={() => void saveMemory()}
              disabled={memBusy}
              className="flex items-center gap-1 rounded-btn bg-accent px-2 py-1 text-[11px] font-medium text-accent-fg transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {memDone ? <Check size={11} /> : memBusy ? "保存中…" : "确认保存"}
            </button>
            <button
              onClick={() => setMemOpen(false)}
              className="rounded-btn border border-line px-2 py-1 text-[11px] text-ink-2 transition-colors hover:bg-panel-2"
            >
              取消
            </button>
          </div>
          {memError && <p className="mt-1.5 text-[11px] text-danger">{memError}</p>}
        </div>
      )}
    </div>
  );
}
