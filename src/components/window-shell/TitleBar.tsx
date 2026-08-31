import { useState } from "react";
import { Download, ImageIcon, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Settings, X, Palette, Minus } from "lucide-react";
import { useChatStore } from "../../stores/chat-store";
import { useWindowStore } from "../../stores/window-store";
import { useSettingsStore } from "../../stores/settings-store";
import { minimizeWindow, requestHide } from "../../lib/window";
import { exportMessagesToMarkdown } from "../../lib/export";
import { ModelPicker } from "../model-picker/ModelPicker";
import type { ThemeMode } from "../../types";

const THEMES: { value: ThemeMode; label: string; preview: string[] }[] = [
  { value: "system", label: "系统", preview: ["#f7f7f8", "#171717"] },
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
 */
export function TitleBar() {
  const view = useWindowStore((s) => s.view);
  const fullMode = useWindowStore((s) => s.fullMode);
  const toggleFullMode = useWindowStore((s) => s.toggleFullMode);
  const openSettings = useWindowStore((s) => s.openSettings);
  const closeSettings = useWindowStore((s) => s.closeSettings);
  const switchToImage = useWindowStore((s) => s.switchToImage);
  const switchToChat = useWindowStore((s) => s.switchToChat);
  const clearConversation = useChatStore((s) => s.clearConversation);
  const streaming = useChatStore((s) => s.streamingRequestId !== null);
  const clearImageGen = () => {
    window.dispatchEvent(new CustomEvent("imagegen-new"));
  };

  const messages = useChatStore((s) => s.messages);

  const exportChat = async () => {
    const done = messages.filter((m) => m.content.length > 0);
    if (done.length === 0) return;
    await exportMessagesToMarkdown(done);
  };

  const isMainView = view === "chat" || view === "image";
  const btn =
    "grid h-6 w-6 place-items-center rounded-md text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink";

  return (
    <div className="relative z-50 flex h-9 shrink-0 items-center justify-between pl-3 pr-2">
      <div data-tauri-drag-region aria-hidden="true" className="absolute inset-0" />
      <div className="relative z-10">
        {view === "settings" ? (
          <button
            onClick={closeSettings}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink"
          >
            返回对话
          </button>
        ) : (
          <ModelPicker />
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
                if (streaming) return;
                clearConversation();
              } else {
                clearImageGen();
              }
            }}
          >
            <Plus size={14} />
          </button>
        )}

        {/* Full mode (history sidebar) toggle */}
        {isMainView && (
          <button
            className={btn}
            title={fullMode ? "退出完整会话模式" : "展开完整会话（含历史记录）"}
            onClick={toggleFullMode}
          >
            {fullMode ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
          </button>
        )}

        {/* Export conversation to Markdown */}
        {view === "chat" && messages.some((m) => m.content.length > 0) && (
          <button
            className={btn}
            title="导出对话为 Markdown"
            onClick={() => void exportChat()}
          >
            <Download size={13} />
          </button>
        )}

        <ThemeButton />

        {/* Mode switch: chat <-> image */}
        {view === "chat" ? (
          <button className={btn} title="文生图模式" onClick={switchToImage}>
            <ImageIcon size={13} />
          </button>
        ) : (
          view === "image" && (
            <button className={btn} title="对话模式" onClick={switchToChat}>
              <MessageSquare size={13} />
            </button>
          )
        )}

        {/* Settings */}
        {isMainView && (
          <button className={btn} title="设置" onClick={openSettings}>
            <Settings size={13} />
          </button>
        )}

        <button
          className={btn}
          title="最小化"
          onClick={() => void minimizeWindow()}
        >
          <Minus size={14} />
        </button>
        <button
          className={btn}
          title={view === "settings" ? "关闭设置" : "隐藏窗口（Esc）"}
          onClick={() => {
            if (view === "settings") closeSettings();
            else void hideWindow();
          }}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

/** Compact theme switcher that lives in the title bar. */
function ThemeButton() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-7 z-50 flex gap-1.5 rounded-btn border border-line bg-panel p-2 shadow-lg">
            {THEMES.map((t) => (
              <button
                key={t.value}
                onClick={() => {
                  void setTheme(t.value);
                  setOpen(false);
                }}
                title={t.label}
                className={`flex flex-col items-center gap-1 rounded-btn px-2 py-1.5 transition-colors hover:bg-panel-2 ${
                  theme === t.value ? "ring-1 ring-[var(--cf-accent)]" : ""
                }`}
              >
                <span className="flex h-5 w-5 overflow-hidden rounded-full border border-line">
                  <span className="flex-1" style={{ backgroundColor: t.preview[0] }} />
                  <span className="flex-1" style={{ backgroundColor: t.preview[1] }} />
                </span>
                <span className="text-[9px] text-ink-2">{t.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <button
        onClick={() => setOpen(!open)}
        title="切换主题"
        className="grid h-6 w-6 place-items-center rounded-md text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink"
      >
        <Palette size={13} />
      </button>
    </div>
  );
}
