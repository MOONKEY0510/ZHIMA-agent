import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronUp,
  Calculator,
  Brain,
  Check,
  Clipboard,
  ClipboardPaste,
  Clock,
  ExternalLink,
  FileText,
  FileType,
  Globe,
  Image as ImageIcon,
  Link as LinkIcon,
  Loader2,
  MonitorUp,
  Settings as SettingsIcon,
  Square,
  Paperclip,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { useActiveStreaming, useChatStore } from "../../stores/chat-store";
import { ModelPicker } from "../model-picker/ModelPicker";
import { useProvidersStore } from "../../stores/providers-store";
import { useWindowStore } from "../../stores/window-store";
import {
  useSettingsStore,
  type PromptPreset,
  type ThinkingEffort,
} from "../../stores/settings-store";
import { requestHide } from "../../lib/window";
import { buildAttachmentBlocks, formatChars } from "../../lib/attachments";
import { appendCapture, clampSelection } from "../../lib/selection-capture";
import { listTools, readClipboardText, type ToolInfo } from "../../services/tools-api";
import { parseDocumentPreview, pickDocument } from "../../services/document-api";
import { listSkills, type SkillView } from "../../services/skills-api";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";

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

/** Actions offered for text captured by the selected-text hotkey (P1-5). */
const QUICK_ACTIONS: { id: string; label: string; instruction: string }[] = [
  {
    id: "translate",
    label: "翻译",
    instruction: "请将以下内容翻译成简体中文（若原文已经是中文则翻译成英文），保留原有格式：",
  },
  { id: "explain", label: "解释", instruction: "请解释以下内容的含义，必要时补充背景：" },
  { id: "summarize", label: "总结", instruction: "请用要点总结以下内容：" },
  { id: "polish", label: "润色", instruction: "请润色以下内容，使其更通顺专业，不改变原意：" },
  { id: "reply", label: "起草回复", instruction: "请基于以下内容起草一段得体的回复：" },
];

/* Selection-capture helpers live in lib/selection-capture.ts (unit-tested). */

/** Kept low enough that the input + toolbar always fit the floating window. */
const MAX_INPUT_HEIGHT = 112;
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
  // Text captured by the selected-text hotkey, awaiting an action (P1-5).
  const [selection, setSelection] = useState<string | null>(null);
  // Where the last capture landed: the text that was already in the composer
  // (`before`, empty for a fresh box) plus the capture itself.  An action
  // click wraps just the capture, leaving a hand-typed draft alone.
  const captureRef = useRef<{ before: string; captured: string } | null>(null);
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
  // Only the displayed conversation's generations block the composer; other
  // conversations may keep running in the background (multi-conversation).
  const streaming = useActiveStreaming();
  const send = useChatStore((s) => s.send);
  const sendMulti = useChatStore((s) => s.sendMulti);
  const compareTargets = useChatStore((s) => s.compareTargets);
  const setCompareTargets = useChatStore((s) => s.setCompareTargets);
  const comparing = compareTargets.length >= 2;
  const providers = useProvidersStore((s) => s.providers);
  const compareLabel = compareTargets
    .map((t) => {
      const provider = providers.find((p) => p.id === t.providerId);
      const model = provider?.models.find((m) => m.modelKey === t.modelKey);
      return model?.displayName || t.modelKey;
    })
    .join(" · ");
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

  // The Agent-tools panel needs room above the composer: tell the window so
  // it grows while the panel is open and shrinks back when it closes.
  useEffect(() => {
    useWindowStore.getState().setComposerPanelOpen(toolsOpen);
    return () => useWindowStore.getState().setComposerPanelOpen(false);
  }, [toolsOpen]);

  // Parsed document attachments (P1-8): their extracted text is folded into
  // the prompt, so only the metadata travels with the message.
  const [docs, setDocs] = useState<{ name: string; chars: number; text: string }[]>([]);
  const [docBusy, setDocBusy] = useState(false);
  const [docNotice, setDocNotice] = useState<{ ok: boolean; text: string } | null>(null);
  /** Attachment menu: one button exposing 图片 / 文档. */
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  /** Skill picker (自定义技能): enabled skills, search text and the selection. */
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const [availableSkills, setAvailableSkills] = useState<SkillView[]>([]);
  const [activeSkills, setActiveSkills] = useState<SkillView[]>([]);

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

  /** Stage already-decoded data URLs (used by native drag & drop). */
  const addImageDataUrls = useCallback((urls: string[]) => {
    if (urls.length === 0) return;
    setImages((prev) => {
      const room = MAX_IMAGES - prev.length;
      return room > 0 ? [...prev, ...urls.slice(0, room)] : prev;
    });
  }, []);

  const removeImage = (idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  };

  /* ---------------- selected-text hotkey (P1-5) ---------------- */

  useEffect(() => {
    let cancelled = false;
    let offAction: (() => void) | undefined;
    let offError: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const first = await listen<string>("quick-action", (event) => {
        const captured = clampSelection(event.payload);
        setSelection(captured);
        setClipboardHint(null);
        setClipboardOpen(false);
        // Drop the captured text straight into the composer so it can be
        // edited and sent immediately; the action chips stay available for
        // the wrapped "translate / explain / …" flows.  Anything already in
        // the box is kept and the capture follows after it, so a half-written
        // prompt can be finished off with a fresh selection.
        setText((current) => {
          const next = appendCapture(current, captured);
          // Everything before the capture is the user's own text (possibly
          // empty): an action click rewrites only the captured part.
          captureRef.current = { before: next.slice(0, next.length - captured.length), captured };
          return next;
        });
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (el) {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          }
        });
      });
      const second = await listen<string>("quick-action-error", (event) => {
        setSelection(null);
        setClipboardHint(event.payload);
      });
      // React may have torn the effect down while these were registering
      // (StrictMode mount → unmount → remount in development): undo them
      // instead of leaking a second listener that would handle every capture
      // twice — the text would land in the composer twice.
      if (cancelled) {
        first();
        second();
        return;
      }
      offAction = first;
      offError = second;
    })();
    return () => {
      cancelled = true;
      offAction?.();
      offError?.();
    };
  }, []);

  /**
   * Apply an action to the captured selection.  When the composer still holds
   * exactly what the capture produced, only the captured part is rewritten —
   * a draft the user typed before capturing is preserved.  The user reviews
   * and presses Enter; nothing is sent automatically, and the reply is
   * written back to the clipboard so it can replace the selected text.
   */
  const runSelectionAction = (action: { label: string; instruction: string }) => {
    if (!selection) return;
    const wrapped = `${action.instruction}\n\n${clampSelection(selection)}`;
    const capture = captureRef.current;
    const captureIntact =
      capture !== null && text === `${capture.before}${capture.captured}`;
    if (captureIntact && capture) {
      setText(`${capture.before}${wrapped}`);
    } else {
      setText(wrapped);
    }
    captureRef.current = null;
    setSelection(null);
    useChatStore.getState().armClipboardWriteback(action.label);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  };

  /** Parse a document path on the Rust side and stage it for sending.
   *  Shared by the file picker and native drag & drop. */
  const stageDocument = useCallback(async (path: string) => {
    setDocNotice(null);
    setDocBusy(true);
    try {
      const preview = await parseDocumentPreview(path);
      setDocs((prev) => [
        ...prev.filter((doc) => doc.name !== preview.name),
        { name: preview.name, chars: preview.chars, text: preview.text },
      ]);
      if (preview.truncated) {
        setDocNotice({
          ok: true,
          text: `${preview.name} 共 ${formatChars(preview.totalChars)}，本次仅取前 ${formatChars(
            preview.chars,
          )}；需要全文可让模型用 read_document 工具按需读取。`,
        });
      }
    } catch (err) {
      setDocNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setDocBusy(false);
    }
  }, []);

  /** Pick a document via the native dialog, then stage it. */
  const addDocument = async () => {
    const path = await pickDocument();
    if (!path) return;
    void stageDocument(path);
  };

  const removeDocument = (idx: number) => {
    setDocs((prev) => prev.filter((_, i) => i !== idx));
  };

  /** Stage files dropped onto the window: images become attachments, documents
   *  are parsed.  Uses Tauri's native drag-drop because the webview never
   *  delivers dropped files through HTML5 events. */
  const handleDroppedPaths = useCallback(
    async (paths: string[]) => {
      const imageExts = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
      const docExts = ["docx", "xlsx", "xlsm", "pptx", "pdf", "txt", "md", "csv", "json", "log"];
      const droppedImages: string[] = [];
      for (const path of paths) {
        const ext = path.split(".").pop()?.toLowerCase() ?? "";
        if (imageExts.includes(ext)) {
          const dataUrl = await readImageAsDataUrl(path);
          if (dataUrl) droppedImages.push(dataUrl);
        } else if (docExts.includes(ext)) {
          await stageDocument(path);
        }
      }
      addImageDataUrls(droppedImages);
    },
    [stageDocument, addImageDataUrls],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const off = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "drop") {
            void handleDroppedPaths(event.payload.paths);
          }
        });
        if (disposed) off();
        else unlisten = off;
      } catch (error) {
        console.warn("拖拽文件监听初始化失败:", error);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [handleDroppedPaths]);

  /** Load the enabled skills for the composer picker (自定义技能). */
  const refreshSkills = async () => {
    try {
      const all = await listSkills();
      setAvailableSkills(all.filter((skill) => skill.enabled));
    } catch (error) {
      console.warn("加载技能列表失败:", error);
    }
  };

  const toggleSkill = (skill: SkillView) => {
    setActiveSkills((prev) =>
      prev.some((s) => s.id === skill.id)
        ? prev.filter((s) => s.id !== skill.id)
        : [...prev, skill],
    );
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
    if ((!value && images.length === 0 && docs.length === 0) || streaming) return;

    // Fold staged documents into the prompt as 【附件：…】 blocks (P1-8).
    const attachmentText = docs.length > 0 ? buildAttachmentBlocks(docs) : "";
    const content = attachmentText
      ? value
        ? `${attachmentText}\n\n${value}`
        : attachmentText
      : value;
    const attachmentMeta = docs.map((doc) => ({ name: doc.name, chars: doc.chars }));

    setText("");
    setImages([]);
    setDocs([]);
    setDocNotice(null);
    setWebSearch(false); // Reset after send (one-shot toggle like ChatGPT).
    setEnableTools(defaultEnableTools);
    const imgs = images;
    // Read the live toggle state via ref so the callback never captures a
    // stale value (bug fix: toggling tools then sending used the old value).
    if (comparing) {
      // Multi-model comparison (P1-6): text only, no agent tools.
      void sendMulti(
        content,
        compareTargets,
        webSearch,
        enableThinkingRef.current,
        thinkingEffortRef.current,
        activeSkills.map((skill) => skill.id),
      );
      return;
    }
    void send(
      content,
      imgs.length > 0 ? imgs : undefined,
      webSearch,
      enableToolsRef.current,
      enableThinkingRef.current,
      thinkingEffortRef.current,
      attachmentMeta.length > 0 ? attachmentMeta : undefined,
      activeSkills.map((skill) => skill.id),
    );
  }, [
    text,
    images,
    docs,
    streaming,
    send,
    sendMulti,
    comparing,
    compareTargets,
    webSearch,
    defaultEnableTools,
    activeSkills,
  ]);

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

  const canSend = (text.trim().length > 0 || images.length > 0 || docs.length > 0) && !streaming;

  return (
    <div className="cf-print-hide relative shrink-0 border-t border-line px-3 py-2.5">
      {/* Selected text captured by the hotkey (P1-5).  One compact row: the
          text itself already sits in the input box below, so repeating it (or
          a hint line) would only eat the little vertical space the floating
          window has. */}
      {selection && (
        <div
          className="mb-2 flex flex-wrap items-center gap-1.5 rounded-btn border border-line bg-panel-2 px-2.5 py-1.5"
          title="文字已追加到输入框，可直接编辑发送；选择动作会套用对应指令（回答将写回剪贴板）。"
        >
          <Sparkles size={12} className="shrink-0 text-accent" />
          <span className="shrink-0 text-[11px] text-ink">
            已获取选中文本 · {selection.length} 字
          </span>
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={() => runSelectionAction(action)}
              className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink transition-colors hover:bg-panel"
            >
              {action.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setSelection(null)}
            title="关闭"
            className="ml-auto grid h-4 w-4 shrink-0 place-items-center rounded text-ink-2 transition-colors hover:text-ink"
          >
            <X size={11} />
          </button>
        </div>
      )}

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

      {/* Agent tools panel: floats above the composer instead of pushing it,
          so opening it can never squeeze the input (or its send button) out
          of the small floating window. */}
      {toolsOpen && (
        <div className="absolute bottom-full left-0 right-0 z-30 mb-1.5 px-3">
          <ToolsPanel
            enabled={enableTools}
            onToggle={(v) => setEnableTools(v)}
            onClose={() => setToolsOpen(false)}
          />
        </div>
      )}

      {/* Multi-model comparison targets (P1-6) */}
      {comparing && (
        <div className="mb-2 flex items-center gap-1.5 rounded-btn border border-line bg-panel-2 px-2 py-1">
          <span className="shrink-0 text-[11px] text-ink-2">对比</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink" title={compareLabel}>
            {compareLabel}
          </span>
          <button
            type="button"
            onClick={() => setCompareTargets([])}
            title="退出对比模式"
            className="grid h-4 w-4 shrink-0 place-items-center rounded text-ink-2 transition-colors hover:bg-panel hover:text-ink"
          >
            <X size={11} />
          </button>
        </div>
      )}

      {/* Manually activated skills: stay active for this conversation until
          removed (自定义技能). */}
      {activeSkills.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {activeSkills.map((skill) => (
            <span
              key={skill.id}
              className="flex items-center gap-1.5 rounded-btn border border-line bg-panel-2 px-2 py-1 text-[11px] text-ink"
              title={skill.description || skill.name}
            >
              <SkillAvatar name={skill.name} size={14} />
              <span className="max-w-[10rem] truncate">{skill.name}</span>
              <button
                type="button"
                onClick={() => toggleSkill(skill)}
                title="取消激活"
                className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded text-ink-2 transition-colors hover:text-danger"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Document attachments (P1-8) */}
      {docs.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {docs.map((doc, idx) => (
            <span
              key={`${doc.name}-${idx}`}
              className="flex items-center gap-1.5 rounded-btn border border-line bg-panel-2 px-2 py-1 text-[11px] text-ink"
              title={doc.name}
            >
              <FileText size={11} className="shrink-0 text-ink-2" />
              <span className="max-w-[11rem] truncate">{doc.name}</span>
              <span className="shrink-0 text-ink-2">{formatChars(doc.chars)}</span>
              <button
                type="button"
                onClick={() => removeDocument(idx)}
                title="移除附件"
                className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded text-ink-2 transition-colors hover:text-danger"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      {docNotice && (
        <p
          className={`mb-2 text-[11px] ${docNotice.ok ? "text-ink-2" : "text-danger"}`}
        >
          {docNotice.text}
        </p>
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

      <div className="rounded-input border border-line bg-panel-2 px-3 py-2 focus-within:border-[var(--cf-text-2)]">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          disabled={comparing}
          onChange={(e) => {
            if (e.target.files) addImages(e.target.files);
            e.target.value = "";
          }}
        />
        {/* Input on top, controls in a toolbar row below (web-app layout). */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          placeholder="输入问题，Enter 发送，Shift+Enter 换行，Esc 隐藏"
          className="max-h-[112px] w-full resize-none bg-transparent text-sm leading-5 text-ink outline-none placeholder:text-ink-2"
        />
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {/* Model selector (对话级模型): binds to the current conversation */}
            <ModelPicker />
            {/* Thinking toggle and effort picker */}
            <div className="relative flex shrink-0 items-center">
          <div
            className={`flex h-7 shrink-0 items-center rounded-full border text-[11px] transition-colors ${
              enableThinking
                ? "border-[color-mix(in_srgb,var(--cf-accent)_45%,transparent)] bg-accent/10 text-accent"
                : "border-line text-ink-2 hover:bg-panel hover:text-ink"
            }`}
          >
            <button
              type="button"
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
              className="flex h-full items-center gap-1 rounded-l-full pl-2.5 pr-1 disabled:opacity-30"
            >
              <Brain size={13} />
              深度思考
            </button>
            <button
              type="button"
              onClick={() => setThinkingMenuOpen((open) => !open)}
              disabled={streaming || !enableThinking}
              title="选择思考等级"
              aria-label="选择思考等级"
              aria-expanded={thinkingMenuOpen}
              className="grid h-full w-5 place-items-center rounded-r-full pr-1.5 disabled:opacity-30"
            >
              <ChevronUp size={12} className={thinkingMenuOpen ? "" : "rotate-180 transition-transform"} />
            </button>
          </div>
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
        {/* Web search toggle */}
        <button
          onClick={() => setWebSearch(!webSearch)}
          disabled={streaming}
          title={webSearch ? "关闭联网搜索" : "开启联网搜索（回答前先搜索网络）"}
          aria-pressed={webSearch}
          className={`flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[11px] transition-colors disabled:opacity-30 ${
            webSearch
              ? "border-[color-mix(in_srgb,var(--cf-accent)_45%,transparent)] bg-accent/10 text-accent"
              : "border-line text-ink-2 hover:bg-panel hover:text-ink"
          }`}
        >
          <Globe size={13} />
          联网搜索
        </button>
        {/* Attachments: one button opening a small menu (图片 / 文档). */}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setAttachMenuOpen((open) => !open)}
            title="添加附件：图片或文档（也可以直接把文件拖进窗口）"
            aria-expanded={attachMenuOpen}
            disabled={comparing}
            className={`grid h-7 w-7 place-items-center rounded-md transition-colors disabled:opacity-30 ${
              attachMenuOpen ? "bg-panel text-ink" : "text-ink-2 hover:bg-panel hover:text-ink"
            }`}
          >
            {docBusy ? <Loader2 size={15} className="animate-spin" /> : <Paperclip size={15} />}
          </button>
          {attachMenuOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setAttachMenuOpen(false)} />
              <div className="absolute bottom-8 left-0 z-40 w-36 overflow-hidden rounded-btn border border-line bg-panel p-1 shadow-lg">
                <button
                  type="button"
                  disabled={images.length >= MAX_IMAGES}
                  onClick={() => {
                    setAttachMenuOpen(false);
                    fileRef.current?.click();
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
                >
                  <ImageIcon size={13} className="shrink-0 text-ink-2" />
                  添加图片
                  {images.length > 0 && (
                    <span className="ml-auto text-[10px] text-ink-2">
                      {images.length}/{MAX_IMAGES}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  disabled={streaming || docBusy}
                  onClick={() => {
                    setAttachMenuOpen(false);
                    void addDocument();
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
                >
                  <FileText size={13} className="shrink-0 text-ink-2" />
                  添加文档
                </button>
              </div>
            </>
          )}
        </div>

        {/* Skill picker (自定义技能): selected skills stay active for this
            conversation until removed. */}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => {
              const next = !skillsOpen;
              setSkillsOpen(next);
              if (next) void refreshSkills();
            }}
            title="选择技能：选中的技能对当前对话持续生效"
            aria-expanded={skillsOpen}
            className={`flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[11px] transition-colors ${
              activeSkills.length > 0
                ? "border-[color-mix(in_srgb,var(--cf-accent)_45%,transparent)] bg-accent/10 text-accent"
                : "border-line text-ink-2 hover:bg-panel hover:text-ink"
            }`}
          >
            <Wrench size={12} />
            技能{activeSkills.length > 0 ? ` ${activeSkills.length}` : ""}
          </button>
          {skillsOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setSkillsOpen(false)} />
              <div className="absolute bottom-8 left-0 z-40 w-72 overflow-hidden rounded-btn border border-line bg-panel shadow-lg">
                <div className="border-b border-line p-1.5">
                  <input
                    autoFocus
                    value={skillQuery}
                    onChange={(e) => setSkillQuery(e.target.value)}
                    placeholder="搜索技能"
                    spellCheck={false}
                    className="w-full rounded-md border border-line bg-panel-2 px-2 py-1 text-[11px] text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-[var(--cf-text-2)]"
                  />
                </div>
                <div className="max-h-60 overflow-y-auto p-1">
                  {availableSkills
                    .filter((skill) => {
                      const query = skillQuery.trim().toLowerCase();
                      if (!query) return true;
                      return (
                        skill.name.toLowerCase().includes(query) ||
                        skill.description.toLowerCase().includes(query)
                      );
                    })
                    .map((skill) => {
                      const active = activeSkills.some((s) => s.id === skill.id);
                      return (
                        <button
                          key={skill.id}
                          type="button"
                          onClick={() => toggleSkill(skill)}
                          className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                            active ? "bg-accent/10" : "hover:bg-panel-2"
                          }`}
                        >
                          <SkillAvatar name={skill.name} />
                          <span className="min-w-0 flex-1">
                            <span
                              className={`block truncate text-xs ${active ? "font-medium text-accent" : "text-ink"}`}
                            >
                              {skill.name}
                            </span>
                            {skill.description && (
                              <span className="mt-0.5 line-clamp-2 block text-[10px] leading-4 text-ink-2">
                                {skill.description}
                              </span>
                            )}
                          </span>
                          {active && (
                            <Check size={12} className="mt-0.5 shrink-0 text-accent" />
                          )}
                        </button>
                      );
                    })}
                  {availableSkills.length === 0 && (
                    <p className="px-2 py-3 text-center text-[11px] text-ink-2">
                      还没有技能，先导入或创建一个
                    </p>
                  )}
                </div>
                <div className="border-t border-line">
                  <button
                    type="button"
                    onClick={() => {
                      setSkillsOpen(false);
                      useWindowStore.getState().openSettings("skills");
                    }}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-[11px] text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink"
                  >
                    <SettingsIcon size={12} />
                    管理技能（导入 / 新建）
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
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
          </div>
          {/* Right side: agent tools + send */}
          <div className="flex shrink-0 items-center gap-0.5">
          <button
            onClick={() => setEnableTools((value) => !value)}
            disabled={streaming || comparing}
            title={
              comparing
                ? "对比模式下不启用 Agent 工具"
                : enableTools
                  ? "关闭 Agent 工具"
                  : "开启 Agent 工具"
            }
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
    <div className="mb-1.5 max-h-[min(288px,58vh)] overflow-y-auto rounded-btn border border-line bg-panel p-2 shadow-lg">
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

/** Avatar colors for the skill picker (hash-assigned, first letter shown). */
const SKILL_AVATAR_COLORS = [
  "#f97316",
  "#8b5cf6",
  "#ec4899",
  "#6366f1",
  "#10b981",
  "#0ea5e9",
  "#f59e0b",
  "#ef4444",
];

/** First-letter avatar for a skill (skills carry no icon field). */
function SkillAvatar({ name, size = 20 }: { name: string; size?: number }) {
  const letter = name.trim().charAt(0).toUpperCase() || "技";
  let hash = 0;
  for (const ch of name) hash = (hash + ch.charCodeAt(0)) % 997;
  const color = SKILL_AVATAR_COLORS[hash % SKILL_AVATAR_COLORS.length];
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        background: color,
        fontSize: Math.round(size * 0.55),
      }}
    >
      {letter}
    </span>
  );
}

/** Read a local image into a data URL (used by native drag & drop). */
async function readImageAsDataUrl(path: string): Promise<string | null> {
  try {
    const bytes = await readFile(path);
    const ext = path.split(".").pop()?.toLowerCase() ?? "png";
    const mime =
      ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "webp"
          ? "image/webp"
          : ext === "gif"
            ? "image/gif"
            : ext === "bmp"
              ? "image/bmp"
              : "image/png";
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return `data:${mime};base64,${btoa(binary)}`;
  } catch (error) {
    console.error("读取拖入的图片失败:", path, error);
    return null;
  }
}
