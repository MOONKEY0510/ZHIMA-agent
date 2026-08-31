import { memo, useEffect, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import {
  Bookmark,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  GitBranch,
  Globe,
  RefreshCw,
  Wrench,
} from "lucide-react";
import type { Message, SearchResult, ToolCallStep } from "../../types";
import { useChatStore } from "../../stores/chat-store";
import { useHistoryStore } from "../../services/history-store";
import { createMemory } from "../../services/memory-api";
import { useProvidersStore } from "../../stores/providers-store";
import { useWindowStore } from "../../stores/window-store";
import { useSettingsStore, type AvatarShape } from "../../stores/settings-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Markdown } from "../markdown/Markdown";
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

export function MessageList() {
  const storedMessages = useChatStore((s) => s.messages);
  const streamingMessage = useChatStore((s) => s.streamingMessage);
  const messages = streamingMessage ? [...storedMessages, streamingMessage] : storedMessages;
  const activeId = useHistoryStore((s) => s.activeId);
  const streaming = useChatStore(
    (s) => s.streamingRequestId !== null || s.streamingMessageId !== null,
  );

  if (messages.length === 0) {
    return <EmptyState />;
  }

  return (
    <Virtuoso
      // Re-mount on conversation switch so the list starts at the newest
      // message (bottom) instead of the top.
      key={activeId ?? "new"}
      data={messages}
      computeItemKey={(_index, message) => message.id}
      initialTopMostItemIndex={Math.max(0, messages.length - 1)}
      style={{ height: "100%" }}
      className="flex-1"
      followOutput={"smooth"}
      increaseViewportBy={{ top: 200, bottom: 200 }}
      itemContent={(_index, message) => (
        <div className="px-3 pb-5">
          <MessageItem message={message} streaming={streaming} />
        </div>
      )}
    />
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
          onClick={openSettings}
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
    return (
      <div className="group flex justify-end gap-2">
        <div className="max-w-[85%]">
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
          {message.content.length > 0 && (
            <div className="select-text whitespace-pre-wrap rounded-input rounded-br-md bg-[var(--cf-user-bubble)] px-3 py-2 text-sm leading-6">
              {message.content}
            </div>
          )}
          <UserMessageActions content={message.content} messageId={message.id} />
        </div>
        <UserAvatar />
      </div>
    );
  }

  const isStreamingThis = message.status === "streaming" && streaming;

  // Some providers (e.g. certain DeepSeek relays) return the bulk of the answer
  // inside the reasoning/thinking field and leave the content field almost
  // empty. When content is abnormally short but reasoning exists, expand the
  // reasoning block automatically so the user sees the actual reply.
  const expandReasoning =
    message.content.trim().length <= 2 && (message.reasoning?.trim().length ?? 0) > 0;

  return (
    <div className="group flex gap-2">
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
        {message.toolCalls && message.toolCalls.length > 0 && (
          <ToolCallsBlock toolCalls={message.toolCalls} />
        )}

        {message.content.length > 0 && (
          <div className="md-body select-text text-sm">
            {isStreamingThis ? (
              <span className="whitespace-pre-wrap break-words">{message.content}</span>
            ) : (
              <Markdown content={message.content} />
            )}
            {isStreamingThis && <span className="stream-caret" />}
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
                  onClick={() => useChatStore.getState().retryLast()}
                  className="inline-flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-0.5 text-xs text-ink transition-colors hover:bg-panel-2"
                >
                  <RefreshCw size={11} /> 重试
                </button>
                {message.toolCalls && message.toolCalls.length > 0 && (
                  <button
                    onClick={() => useChatStore.getState().retryLast({ disableTools: true })}
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

function ToolCallsBlock({ toolCalls }: { toolCalls: ToolCallStep[] }) {
  const [open, setOpen] = useState(false);
  const running = toolCalls.some((call) => call.status === "running");
  const pending = toolCalls.some((call) => call.status === "pending");
  const doneCount = toolCalls.filter((call) => call.status === "done").length;
  const requestId = useChatStore((s) => s.streamingRequestId);

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

function UserMessageActions({ content, messageId }: { content: string; messageId: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable; ignore quietly.
    }
  };

  return (
    <div className="mt-0.5 flex justify-end">
      <button
        className="grid h-5 w-5 place-items-center rounded-md text-ink-2 opacity-0 transition-opacity hover:bg-panel-2 hover:text-ink group-hover:opacity-100"
        title="复制消息"
        onClick={() => void copy()}
      >
        {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
      </button>
      <button
        className="grid h-5 w-5 place-items-center rounded-md text-ink-2 opacity-0 transition-opacity hover:bg-panel-2 hover:text-ink group-hover:opacity-100"
        title="从这里继续（创建分支）"
        onClick={() => useChatStore.getState().branchFrom(messageId)}
      >
        <GitBranch size={11} />
      </button>
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
        <button className={btn} title="重新生成" onClick={() => useChatStore.getState().retryLast()}>
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
