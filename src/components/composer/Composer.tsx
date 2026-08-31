import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronUp,
  Calculator,
  Brain,
  Clipboard,
  ClipboardPaste,
  Clock,
  ExternalLink,
  FileText,
  FileType,
  Globe,
  Link as LinkIcon,
  MonitorUp,
  Square,
  Paperclip,
  Wrench,
  X,
} from "lucide-react";
import { useChatStore } from "../../stores/chat-store";
import { useWindowStore } from "../../stores/window-store";
import {
  useSettingsStore,
  type PromptPreset,
  type ThinkingEffort,
} from "../../stores/settings-store";
import { requestHide } from "../../lib/window";
import { listTools, readClipboardText, type ToolInfo } from "../../services/tools-api";
import { open } from "@tauri-apps/plugin-dialog";

/** Quick clipboard actions: prepend an instruction, keep the original text. */
const CLIPBOARD_ACTIONS: { id: string; label: string; instruction: string }[] = [
  { id: "summarize", label: "总结剪贴板", instruction: "请总结以下内容，输出简洁要点：" },
  { id: "translate", label: "翻译剪贴板", instruction: "请将以下内容翻译成简体中文，保留原文格式：" },
  { id: "polish", label: "改写润色", instruction: "请改写以下内容，使其更通顺、表达更清晰，不改变原意：" },
  { id: "todos", label: "提取待办", instruction: "请从以下内容中提取待办事项，按优先级列出：" },
  { id: "format_json", label: "格式化 JSON", instruction: "请将以下内容格式化为可读的 JSON，修正语法错误：" },
  { id: "format_sql", label: "格式化 SQL", instruction: "请将以下 SQL 语句格式化为易读的分层缩进，保留原有逻辑和关键字：" },
  { id: "clean_text", label: "清理文本格式", instruction: "请清理以下文本：去除多余空行、混乱的缩进和格式残留，输出干净正文：" },
];

/** File processing presets shown after picking files. */
const FILE_ACTIONS: { id: string; label: string; instruction: string }[] = [
  { id: "summary", label: "汇总文件内容", instruction: "请阅读以下每个文件的内容，逐文件给出简短摘要，最后给出整体结论：" },
  { id: "compare", label: "对比文件", instruction: "请对比以下文件的相同点和不同点，指出关键差异：" },
  { id: "todos", label: "提取任务", instruction: "请从以下文件中提取所有待办事项和行动项：" },
  { id: "report", label: "生成报告", instruction: "请基于以下文件内容生成一份结构化报告（背景、要点、结论）：" },
];

const MAX_INPUT_HEIGHT = 152;
const MAX_IMAGES = 4;
const THINKING_EFFORT_OPTIONS: { value: ThinkingEffort; label: string; hint: string }[] = [
  { value: "low", label: "低", hint: "更快响应" },
  { value: "medium", label: "中", hint: "平衡" },
  { value: "high", label: "高", hint: "更深入" },
  { value: "max", label: "最大", hint: "最强推理" },
];

export function Composer() {
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [presetIndex, setPresetIndex] = useState(0);
  const [webSearch, setWebSearch] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [clipboardBusy, setClipboardBusy] = useState(false);
  const [clipboardHint, setClipboardHint] = useState<string | null>(null);
  const defaultEnableTools = useSettingsStore((s) => s.defaultEnableTools);
  const [enableTools, setEnableTools] = useState(defaultEnableTools);
  const enableToolsRef = useRef(defaultEnableTools);
  enableToolsRef.current = enableTools;

  // Reflect the persisted default when the app setting changes.
  useEffect(() => {
    setEnableTools(defaultEnableTools);
  }, [defaultEnableTools]);

  const defaultEnableThinking = useSettingsStore((s) => s.defaultEnableThinking);
  const setDefaultEnableThinking = useSettingsStore((s) => s.setDefaultEnableThinking);
  const defaultThinkingEffort = useSettingsStore((s) => s.defaultThinkingEffort);
  const setDefaultThinkingEffort = useSettingsStore((s) => s.setDefaultThinkingEffort);
  const [enableThinking, setEnableThinking] = useState(defaultEnableThinking);
  const [thinkingEffort, setThinkingEffort] = useState(defaultThinkingEffort);
  const enableThinkingRef = useRef(defaultEnableThinking);
  const thinkingEffortRef = useRef(defaultThinkingEffort);
  enableThinkingRef.current = enableThinking;
  thinkingEffortRef.current = thinkingEffort;

  useEffect(() => {
    setEnableThinking(defaultEnableThinking);
  }, [defaultEnableThinking]);

  useEffect(() => {
    setThinkingEffort(defaultThinkingEffort);
  }, [defaultThinkingEffort]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streaming = useChatStore((s) => s.streamingRequestId !== null);
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  const view = useWindowStore((s) => s.view);
  const presets = useSettingsStore((s) => s.presets);

  const conversationNonce = useChatStore((s) => s.conversationNonce);

  // Show the preset picker when the input starts with "/" and isn't a full command yet.
  const showPresets = text.startsWith("/") && !text.includes("\n") && text.length <= 20;
  const filteredPresets = showPresets
    ? presets.filter((p) => p.command.startsWith(text))
    : [];

  useEffect(() => {
    const focusInput = () => textareaRef.current?.focus();
    focusInput();
    window.addEventListener("focus", focusInput);
    return () => window.removeEventListener("focus", focusInput);
  }, [view]);

  // When a new conversation is started, jump to the fresh composer so the
  // user can start typing right away.
  useEffect(() => {
    if (conversationNonce > 0) {
      textareaRef.current?.focus();
    }
  }, [conversationNonce]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [text]);

  const addImages = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    for (const file of arr) {
      if (images.length >= MAX_IMAGES) break;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === "string") {
          setImages((prev) => (prev.length < MAX_IMAGES ? [...prev, result] : prev));
        }
      };
      reader.onerror = () => console.error("读取图片失败:", file.name);
      reader.readAsDataURL(file);
    }
  }, [images.length]);

  const removeImage = (idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  };

  // Paste image support.
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = e.clipboardData.files;
    if (files && files.length > 0) {
      const hasImage = Array.from(files).some((f) => f.type.startsWith("image/"));
      if (hasImage) {
        e.preventDefault();
        addImages(files);
      }
    }
  };

  const submit = useCallback(() => {
    const value = text.trim();
    if ((!value && images.length === 0) || streaming) return;
    setText("");
    setImages([]);
    setWebSearch(false); // Reset after send (one-shot toggle like ChatGPT).
    setEnableTools(defaultEnableTools);
    const imgs = images;
    // Read the live toggle state via ref so the callback never captures a
    // stale value (bug fix: toggling tools then sending used the old value).
    void send(
      value,
      imgs.length > 0 ? imgs : undefined,
      webSearch,
      enableToolsRef.current,
      enableThinkingRef.current,
      thinkingEffortRef.current,
    );
  }, [text, images, streaming, send, webSearch, defaultEnableTools]);

  const applyPreset = useCallback((preset: PromptPreset) => {
    setText(preset.content + "\n");
    setPresetIndex(0);
    // Focus and move cursor to end.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }, []);

  // Read the clipboard and prefill the composer with the chosen action's
  // instruction.  The user reviews and presses Enter to send — we never send
  // automatically, so clipboard contents stay under the user's control.
  const runClipboardAction = async (action: (typeof CLIPBOARD_ACTIONS)[number]) => {
    setClipboardBusy(true);
    setClipboardHint(null);
    try {
      const content = await readClipboardText();
      if (!content.trim()) {
        setClipboardHint("剪贴板中没有文本内容");
        return;
      }
      const wrapped = content.length > 12000 ? `${content.slice(0, 12000)}…` : content;
      setText(`${action.instruction}\n\n${wrapped}`);
      // When this action sends, the reply is written back to the clipboard.
      useChatStore.getState().armClipboardWriteback(action.label.replace("剪贴板", ""));
      setClipboardOpen(false);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    } catch (err) {
      setClipboardHint(String(err));
    } finally {
      setClipboardBusy(false);
    }
  };

  // Pick one or more files and prefill the composer with the chosen
  // processing instruction.  Files are listed by name; the agent tools can
  // open them on request (read_pdf / file reader), so we never inline the
  // full content here.
  const pickFilesForAction = async (action: (typeof FILE_ACTIONS)[number]) => {
    setClipboardBusy(true);
    setClipboardHint(null);
    try {
      const selected = await open({ multiple: true, title: "选择文件" });
      const files = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (files.length === 0) return;
      const listing = files.map((f) => `- ${f}`).join("\n");
      setText(`${action.instruction}\n\n文件列表：\n${listing}\n\n请使用文件读取工具打开并分析以上文件。`);
      setClipboardOpen(false);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    } catch (err) {
      setClipboardHint(String(err));
    } finally {
      setClipboardBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Preset picker navigation.
    if (showPresets && filteredPresets.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPresetIndex((i) => (i + 1) % filteredPresets.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPresetIndex((i) => (i - 1 + filteredPresets.length) % filteredPresets.length);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        applyPreset(filteredPresets[presetIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setText("");
        setPresetIndex(0);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      requestHide();
    }
  };

  const canSend = (text.trim().length > 0 || images.length > 0) && !streaming;

  return (
    <div className="shrink-0 border-t border-line px-3 py-2.5">
      {/* Preset picker dropdown */}
      {showPresets && filteredPresets.length > 0 && (
        <div className="mb-1.5 overflow-hidden rounded-btn border border-line bg-panel shadow-lg">
          {filteredPresets.map((p, i) => (
            <button
              key={p.id}
              onMouseDown={(e) => {
                e.preventDefault();
                applyPreset(p);
              }}
              onMouseEnter={() => setPresetIndex(i)}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors ${
                i === presetIndex ? "bg-panel-2 text-ink" : "text-ink-2"
              }`}
            >
              <span className="shrink-0 font-mono text-[11px] text-accent">{p.command}</span>
              <span className="truncate">{p.name}</span>
            </button>
          ))}
        </div>
      )}

      {/* Agent tools panel */}
      {toolsOpen && (
        <ToolsPanel
          enabled={enableTools}
          onToggle={(v) => setEnableTools(v)}
          onClose={() => setToolsOpen(false)}
        />
      )}

      {/* Image previews */}
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {images.map((img, idx) => (
            <div key={idx} className="group relative">
              <img
                src={img}
                alt={`附件 ${idx + 1}`}
                className="h-14 w-14 rounded-btn border border-line object-cover"
              />
              <button
                onClick={() => removeImage(idx)}
                className="absolute -right-1 -top-1 grid h-4 w-4 place-items-center rounded-full bg-danger text-white opacity-0 transition-opacity group-hover:opacity-100"
              >
                <X size={9} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 rounded-input border border-line bg-panel-2 px-3 py-2 focus-within:border-[var(--cf-text-2)]">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addImages(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          title="添加图片"
          disabled={images.length >= MAX_IMAGES}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-2 transition-colors hover:bg-panel hover:text-ink disabled:opacity-30"
        >
          <Paperclip size={15} />
        </button>
        {/* Thinking toggle and effort picker */}
        <div className="relative flex shrink-0 items-center gap-0.5">
          <button
            onClick={() => {
              const next = !enableThinking;
              setEnableThinking(next);
              if (!next) setThinkingMenuOpen(false);
              void setDefaultEnableThinking(next);
            }}
            disabled={streaming}
            title={
              enableThinking
                ? `思考已开启：${THINKING_EFFORT_OPTIONS.find((o) => o.value === thinkingEffort)?.label}强度`
                : "思考已关闭：模型只输出最终回答"
            }
            aria-pressed={enableThinking}
            className={`grid h-7 w-7 place-items-center rounded-md transition-colors disabled:opacity-30 ${
              enableThinking
                ? "border border-accent bg-transparent text-accent"
                : "text-ink-2 hover:bg-panel hover:text-ink"
            }`}
          >
            <Brain size={15} />
          </button>
          <button
            onClick={() => setThinkingMenuOpen((open) => !open)}
            disabled={streaming || !enableThinking}
            title="选择思考等级"
            aria-label="选择思考等级"
            aria-expanded={thinkingMenuOpen}
            className={`grid h-7 w-4 place-items-center rounded-md transition-colors disabled:opacity-30 ${
              enableThinking ? "text-accent hover:bg-panel" : "text-ink-2"
            }`}
          >
            <ChevronUp size={13} className={thinkingMenuOpen ? "" : "rotate-180 transition-transform"} />
          </button>
          {thinkingMenuOpen && (
            <div className="absolute bottom-8 left-0 z-40 w-36 overflow-hidden rounded-btn border border-line bg-panel p-1 shadow-lg">
              <p className="px-2 py-1 text-[10px] font-medium text-ink-2">思考等级</p>
              {THINKING_EFFORT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => {
                    setThinkingEffort(option.value);
                    setThinkingMenuOpen(false);
                    void setDefaultThinkingEffort(option.value);
                  }}
                  className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[11px] transition-colors ${
                    thinkingEffort === option.value
                      ? "bg-accent/15 text-accent"
                      : "text-ink hover:bg-panel-2"
                  }`}
                >
                  <span>{option.label}</span>
                  <span className="text-[10px] text-ink-2">{option.hint}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          placeholder="输入问题，Enter 发送，Shift+Enter 换行，Esc 隐藏"
          className="max-h-[152px] flex-1 resize-none bg-transparent text-sm leading-5 text-ink outline-none placeholder:text-ink-2"
        />
        {/* Web search toggle */}
        <button
          onClick={() => setWebSearch(!webSearch)}
          disabled={streaming}
          title={webSearch ? "关闭联网搜索" : "开启联网搜索（回答前先搜索网络）"}
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors disabled:opacity-30 ${
            webSearch
              ? "bg-accent text-accent-fg"
              : "text-ink-2 hover:bg-panel hover:text-ink"
          }`}
        >
          <Globe size={15} />
        </button>
        {/* Clipboard quick actions */}
        <div className="relative shrink-0">
          <button
            onClick={() => {
              setClipboardOpen((v) => !v);
              setClipboardHint(null);
            }}
            disabled={streaming}
            title="快捷操作（剪贴板 / 文件）"
            className="grid h-7 w-7 place-items-center rounded-md text-ink-2 transition-colors hover:bg-panel hover:text-ink disabled:opacity-30"
          >
            <ClipboardPaste size={15} />
          </button>
          {clipboardOpen && (
            <div className="absolute bottom-8 right-0 z-40 w-48 overflow-hidden rounded-btn border border-line bg-panel shadow-lg">
              <p className="border-b border-line bg-panel-2 px-2.5 py-1.5 text-[10px] font-medium text-ink-2">
                剪贴板快捷操作
              </p>
              {CLIPBOARD_ACTIONS.map((action) => (
                <button
                  key={action.id}
                  onClick={() => void runClipboardAction(action)}
                  disabled={clipboardBusy}
                  className="block w-full px-2.5 py-1.5 text-left text-[11px] text-ink transition-colors hover:bg-panel-2 disabled:opacity-50"
                >
                  {action.label}
                </button>
              ))}
              <p className="border-b border-t border-line bg-panel-2 px-2.5 py-1.5 text-[10px] font-medium text-ink-2">
                文件批处理
              </p>
              {FILE_ACTIONS.map((action) => (
                <button
                  key={action.id}
                  onClick={() => void pickFilesForAction(action)}
                  disabled={clipboardBusy}
                  className="block w-full px-2.5 py-1.5 text-left text-[11px] text-ink transition-colors hover:bg-panel-2 disabled:opacity-50"
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
          {clipboardHint && (
            <div className="absolute bottom-8 right-0 z-40 w-56 rounded-btn border border-line bg-panel px-2.5 py-1.5 text-[11px] text-ink-2 shadow-lg">
              {clipboardHint}
            </div>
          )}
        </div>
        {/* Agent tools toggle and details */}
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            onClick={() => setEnableTools((value) => !value)}
            disabled={streaming}
            title={enableTools ? "关闭 Agent 工具" : "开启 Agent 工具"}
            aria-pressed={enableTools}
            className={`relative grid h-7 w-7 place-items-center rounded-md transition-colors disabled:opacity-30 ${
              enableTools ? "bg-accent text-accent-fg" : "text-ink-2 hover:bg-panel hover:text-ink"
            }`}
          >
            <Wrench size={15} />
            <span
              className={`absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full ${
                enableTools ? "bg-[var(--cf-success)]" : "bg-ink-2"
              }`}
            />
          </button>
          <button
            onClick={() => setToolsOpen((value) => !value)}
            disabled={streaming}
            title={toolsOpen ? "收起 Agent 工具详情" : "展开 Agent 工具详情"}
            aria-expanded={toolsOpen}
            className="grid h-7 w-5 place-items-center rounded-md text-ink-2 transition-colors hover:bg-panel hover:text-ink disabled:opacity-30"
          >
            <ChevronUp size={13} className={toolsOpen ? "" : "rotate-180 transition-transform"} />
          </button>
        </div>
        {streaming ? (
          <button
            onClick={stop}
            title="停止生成"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent text-accent-fg transition-opacity hover:opacity-85"
          >
            <Square size={11} fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!canSend}
            title="发送（Enter）"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent text-accent-fg transition-opacity hover:opacity-85 disabled:opacity-30"
          >
            <ArrowUp size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Agent tools panel                                                          */
/* ------------------------------------------------------------------------ */

/** Icon for each builtin tool; falls back to the wrench. */
const TOOL_ICONS: Record<string, typeof Wrench> = {
  get_current_time: Clock,
  calculate: Calculator,
  web_search: Globe,
  read_clipboard: ClipboardPaste,
  write_clipboard: Clipboard,
  select_and_read_text_file: FileText,
  read_pdf: FileType,
  capture_screen: MonitorUp,
  fetch_webpage: LinkIcon,
  open_resource: ExternalLink,
};

const RISK_LABEL: Record<string, { text: string; tone: "auto" | "warn" }> = {
  low: { text: "自动执行", tone: "auto" },
  external_read: { text: "只读外部", tone: "auto" },
  sensitive_read: { text: "敏感读取 · 需确认", tone: "warn" },
  external_action: { text: "外部动作 · 需确认", tone: "warn" },
};

export function ToolsPanel({
  enabled,
  onToggle,
  onClose,
}: {
  enabled: boolean;
  onToggle: (v: boolean) => void;
  onClose?: () => void;
}) {
  const [tools, setTools] = useState<ToolInfo[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listTools()
      .then((list) => {
        if (!cancelled) setTools(list);
      })
      .catch((err) => console.error("获取工具列表失败:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  const confirmCount = tools?.filter((t) => t.requiresConfirmation).length ?? 0;
  const disabledCount = tools?.filter((t) => t.policy === "disabled").length ?? 0;

  return (
    <div className="mb-1.5 max-h-72 overflow-y-auto rounded-btn border border-line bg-panel p-2 shadow-lg">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium text-ink">Agent 工具</p>
        <div className="flex items-center gap-2">
          {tools && (
            <span className="text-[10px] text-ink-2">
              {tools.length} 个工具 · {confirmCount} 个需确认 · {disabledCount} 个已禁用
            </span>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="grid h-4 w-4 place-items-center text-ink-2 hover:text-ink"
              title="关闭"
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Master toggle */}
      <div className="mt-1.5 flex items-center justify-between rounded-btn border border-line bg-panel-2 px-2 py-1.5">
        <div className="min-w-0">
          <p className="text-[11px] text-ink">启用 Agent 工具</p>
          <p className="truncate text-[10px] text-ink-2">
            {enabled ? "模型可自动调用下方工具" : "模型只会直接回答，不会调用工具"}
          </p>
        </div>
        <button
          onClick={() => onToggle(!enabled)}
          className={`relative h-4 w-8 shrink-0 rounded-full transition-colors ${
            enabled ? "bg-accent" : "bg-ink-2/50"
          }`}
          role="switch"
          aria-checked={enabled}
          title={enabled ? "关闭 Agent 工具" : "开启 Agent 工具"}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
              enabled ? "translate-x-4" : ""
            }`}
          />
        </button>
      </div>

      {/* Tool list */}
      {tools ? (
        <div className="mt-1.5 space-y-1">
          {tools.map((tool) => {
            const Icon = TOOL_ICONS[tool.name] ?? Wrench;
            const risk = RISK_LABEL[tool.riskLevel] ?? { text: "需确认", tone: "warn" as const };
            const disabled = tool.policy === "disabled";
            const policyText =
              tool.policy === "confirm"
                ? "每次确认"
                : tool.policy === "disabled"
                  ? "已禁用"
                  : null;
            return (
              <div
                key={tool.name}
                className={`flex items-start gap-2 rounded-btn px-1.5 py-1 hover:bg-panel-2 ${
                  disabled ? "opacity-55" : ""
                }`}
              >
                <Icon size={13} className="mt-0.5 shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[11px] text-ink">{tool.name}</span>
                    <span
                      className={`shrink-0 rounded px-1 py-px text-[9px] ${
                        risk.tone === "warn"
                          ? "bg-[var(--cf-warn-bg,var(--cf-danger-weak,#fde))] text-[var(--cf-danger)]"
                          : "bg-panel-2 text-ink-2"
                      }`}
                    >
                      {risk.text}
                    </span>
                    {policyText && (
                      <span
                        className={`shrink-0 rounded px-1 py-px text-[9px] ${
                          disabled
                            ? "bg-panel-2 text-ink-2"
                            : "bg-[var(--cf-warn-bg,var(--cf-danger-weak,#fde))] text-[var(--cf-danger)]"
                        }`}
                      >
                        {policyText}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[10px] leading-4 text-ink-2">{tool.description}</p>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="py-3 text-center text-[10px] text-ink-2">正在加载工具列表…</p>
      )}
    </div>
  );
}
