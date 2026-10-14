import { useEffect, useRef, useState } from "react";
import { Download, ImageIcon, MessageSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plus, Settings, X, Minus } from "lucide-react";
import { useChatStore } from "../../stores/chat-store";
import { useHistoryStore } from "../../services/history-store";
import { useWindowStore } from "../../stores/window-store";
import { useSettingsStore } from "../../stores/settings-store";
import { minimizeWindow, requestHide } from "../../lib/window";
import { exportMessagesToMarkdown } from "../../lib/export";
import { exportNodeAsImage } from "../../lib/export-image";
import { printConversation, withExpandedList } from "../../lib/print";
import type { ThemeMode } from "../../types";

const THEMES: { value: ThemeMode; label: string; preview: string[] }[] = [
  { value: "system", label: "跟随系统", preview: ["#f7f7f8", "#171717"] },
  { value: "paper", label: "纸感", preview: ["#faf9f5", "#c96442"] },
  { value: "paper-dark", label: "纸感·深色", preview: ["#262624", "#d97757"] },
  { value: "light", label: "浅色", preview: ["#ffffff", "#e5e7eb"] },
  { value: "dark", label: "深色", preview: ["#212121", "#3a3a3a"] },
  { value: "warm", label: "暖色", preview: ["#fffaf3", "#8b5e3c"] },
  { value: "rose", label: "玫瑰", preview: ["#fffafc", "#c2185b"] },
  { value: "spring", label: "春日", preview: ["#f8fbff", "#78bceb"] },
];

/**
 * Custom drag region + window controls for the frameless window.
 * Buttons remain clickable inside the drag region because only elements
 * carrying `data-tauri-drag-region` participate in dragging.
 *
 * The right side was eight icon buttons in a row; the redesign folds the
 * second-order actions (export, theme, mode switch, settings) into one
 * overflow menu so the chrome reads as quiet as the content below it.
 */
export function TitleBar() {
  const view = useWindowStore((s) => s.view);
  const fullMode = useWindowStore((s) => s.fullMode);
  const toggleFullMode = useWindowStore((s) => s.toggleFullMode);
  const openSettings = useWindowStore((s) => s.openSettings);
  const closeSettings = useWindowStore((s) => s.closeSettings);
  const switchToImage = useWindowStore((s) => s.switchToImage);
  const switchToChat = useWindowStore((s) => s.switchToChat);
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const activeConversationId = useHistoryStore((s) => s.activeId);
  const activeTitle = useHistoryStore(
    (s) => s.conversations.find((c) => c.id === activeConversationId)?.title ?? null,
  );
  const clearImageGen = () => {
    window.dispatchEvent(new CustomEvent("imagegen-new"));
  };

  const messages = useChatStore((s) => s.messages);

  // Overflow menu state: export actions, theme picker, mode switch, settings.
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  const runExport = async (action: () => void | Promise<unknown>) => {
    setMenuOpen(false);
    setExportError(null);
    setExportBusy(true);
    try {
      await action();
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
      window.setTimeout(() => setExportError(null), 6000);
    } finally {
      setExportBusy(false);
    }
  };

  const exportChat = async () => {
    const done = messages.filter((m) => m.content.length > 0);
    if (done.length === 0) return;
    await exportMessagesToMarkdown(done);
  };

  /** Snapshot the message pane (every message rendered, not just visible). */
  const exportImage = async () => {
    const node = document.querySelector<HTMLElement>("[data-export-root]");
    if (!node) throw new Error("找不到对话内容区域");
    await withExpandedList(() => exportNodeAsImage(node));
  };

  const isMainView = view === "chat" || view === "image";
  const btn =
    "grid h-7 w-7 place-items-center rounded-btn text-ink-2 transition-colors hover:bg-hover hover:text-ink";
  const menuItemCls =
    "flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-left text-ui text-ink transition-colors hover:bg-hover";
  const menuLabelCls = "px-2 pb-0.5 pt-1.5 text-meta text-ink-2";

  return (
    // Print stylesheet hides this bar so only the conversation reaches paper.
    <div className="cf-print-hide relative z-50 flex h-9 shrink-0 items-center justify-between pl-3 pr-2">
      <div data-tauri-drag-region aria-hidden="true" className="absolute inset-0" />
      <div className="relative z-10 min-w-0">
        {view === "settings" ? (
          <button
            onClick={closeSettings}
            className="flex items-center gap-1 rounded-btn px-1.5 py-0.5 text-ui text-ink-2 transition-colors hover:bg-hover hover:text-ink"
          >
            返回对话
          </button>
        ) : view === "chat" ? (
          // The conversation title lives here now; the model selector moved
          // into the composer (对话级模型).
          <span
            className="block max-w-[40vw] truncate px-1.5 text-ui text-ink-2"
            title={activeTitle ?? "新对话"}
          >
            {activeTitle ?? "新对话"}
          </span>
        ) : (
          <span className="px-1.5 text-ui text-ink-2">图像生成</span>
        )}
      </div>

      <div className="relative z-10 flex items-center gap-0.5">
        {/* New conversation / new image button */}
        {isMainView && (
          <button
            className={btn}
            title={view === "chat" ? "新对话" : "新图片"}
            onClick={() => {
              if (view === "chat") {
                // Multi-conversation: starting a new chat never cancels or
                // waits for generations running elsewhere.
                startNewConversation();
              } else {
                clearImageGen();
              }
            }}
          >
            <Plus size={15} />
          </button>
        )}

        {/* Full mode (history sidebar) toggle */}
        {isMainView && (
          <button
            className={btn}
            title={fullMode ? "退出完整会话模式" : "展开完整会话（含历史记录）"}
            onClick={toggleFullMode}
          >
            {fullMode ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </button>
        )}

        {/* Overflow menu: export, theme, mode switch, settings. */}
        <div className="relative" ref={menuRef}>
          <button
            className={btn}
            title={exportBusy ? "正在导出…" : "更多"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <MoreHorizontal size={15} className={exportBusy ? "animate-pulse" : undefined} />
          </button>
          {menuOpen && (
            <div className="cf-menu-pop absolute right-0 top-8 z-50 w-56 overflow-hidden rounded-menu border border-line bg-panel p-1 shadow-menu">
              {view === "chat" && messages.some((m) => m.content.length > 0) && (
                <>
                  <p className={menuLabelCls}>导出</p>
                  <button
                    className={menuItemCls}
                    onClick={() => void runExport(() => exportChat())}
                  >
                    <Download size={13} className="shrink-0 text-ink-2" />
                    导出为 Markdown
                  </button>
                  <button
                    className={menuItemCls}
                    onClick={() => void runExport(exportImage)}
                  >
                    <Download size={13} className="shrink-0 text-ink-2" />
                    导出为图片（PNG）
                  </button>
                  <button
                    className={menuItemCls}
                    onClick={() => void runExport(() => printConversation())}
                  >
                    <Download size={13} className="shrink-0 text-ink-2" />
                    打印 / 另存为 PDF
                  </button>
                  <div className="my-1 h-px bg-line" />
                </>
              )}

              <p className={menuLabelCls}>主题</p>
              <div className="grid grid-cols-4 gap-1 px-1 pb-1">
                {THEMES.map((t) => (
                  <ThemeSwatch key={t.value} theme={t} />
                ))}
              </div>
              <div className="my-1 h-px bg-line" />

              {view === "chat" ? (
                <button
                  className={menuItemCls}
                  onClick={() => {
                    setMenuOpen(false);
                    switchToImage();
                  }}
                >
                  <ImageIcon size={13} className="shrink-0 text-ink-2" />
                  文生图模式
                </button>
              ) : view === "image" ? (
                <button
                  className={menuItemCls}
                  onClick={() => {
                    setMenuOpen(false);
                    switchToChat();
                  }}
                >
                  <MessageSquare size={13} className="shrink-0 text-ink-2" />
                  对话模式
                </button>
              ) : null}

              {isMainView && (
                <button
                  className={menuItemCls}
                  onClick={() => {
                    setMenuOpen(false);
                    openSettings();
                  }}
                >
                  <Settings size={13} className="shrink-0 text-ink-2" />
                  设置
                </button>
              )}
            </div>
          )}
          {exportError && (
            <p className="absolute right-0 top-8 z-50 mt-24 w-56 rounded-menu border border-line bg-panel px-2 py-1 text-ui text-danger shadow-menu">
              {exportError}
            </p>
          )}
        </div>

        <button
          className={btn}
          title="最小化"
          onClick={() => void minimizeWindow()}
        >
          <Minus size={15} />
        </button>
        <button
          className={btn}
          title={view === "settings" ? "关闭设置" : "隐藏窗口（Esc）"}
          onClick={() => {
            if (view === "settings") closeSettings();
            else requestHide();
          }}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}

/** One theme swatch inside the overflow menu. */
function ThemeSwatch({ theme: t }: { theme: (typeof THEMES)[number] }) {
  const current = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);

  return (
    <button
      onClick={() => void setTheme(t.value)}
      title={t.label}
      className={`flex min-w-0 flex-col items-center gap-1 rounded-btn px-1 py-1.5 transition-colors hover:bg-hover ${
        current === t.value ? "ring-1 ring-[var(--cf-accent)]" : ""
      }`}
    >
      <span className="flex h-5 w-5 overflow-hidden rounded-full border border-line">
        <span className="flex-1" style={{ backgroundColor: t.preview[0] }} />
        <span className="flex-1" style={{ backgroundColor: t.preview[1] }} />
      </span>
      <span className="w-full truncate text-center text-meta text-ink-2">{t.label}</span>
    </button>
  );
}
