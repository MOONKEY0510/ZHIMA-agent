import { useMemo, useState } from "react";
import { Check, CheckSquare, FileText, Pencil, Plus, Search, Square, Trash2, X, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useHistoryStore } from "../../services/history-store";
import { setConversationSystemPrompt } from "../../services/history-api";
import { useChatStore } from "../../stores/chat-store";
import { relativeTime } from "../../lib/time";

/**
 * Conversation history sidebar for the full conversation mode (plan §3.2):
 * search, switch, rename, delete, batch select & batch delete. Switching is
 * blocked while generating.
 */
export function HistorySidebar() {
  const conversations = useHistoryStore((s) => s.conversations);
  const activeId = useHistoryStore((s) => s.activeId);
  const remove = useHistoryStore((s) => s.remove);
  const rename = useHistoryStore((s) => s.rename);
  const loadConversation = useChatStore((s) => s.loadConversation);
  const clearConversation = useChatStore((s) => s.clearConversation);

  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [promptId, setPromptId] = useState<string | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [promptSaved, setPromptSaved] = useState(false);

  const openPromptEditor = (id: string, current: string | null) => {
    setPromptId(id);
    setPromptValue(current ?? "");
    setPromptSaved(false);
    setConfirmingId(null);
  };

  const savePrompt = async () => {
    if (!promptId) return;
    const trimmed = promptValue.trim();
    await setConversationSystemPrompt(promptId, trimmed || null);
    // Refresh so the sidebar's cached prompt matches what's stored.
    await useHistoryStore.getState().refreshList();
    setPromptSaved(true);
    setTimeout(() => {
      setPromptId(null);
      setPromptSaved(false);
    }, 1200);
  };

  // Batch selection state
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchConfirming, setBatchConfirming] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const streaming = useChatStore((s) => s.streamingRequestId !== null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? conversations.filter((c) => c.title.toLowerCase().includes(q))
      : conversations;
  }, [conversations, query]);

  const startRename = (id: string, current: string) => {
    setRenamingId(id);
    setRenameValue(current);
    setConfirmingId(null);
  };

  const commitRename = async () => {
    if (renamingId && renameValue.trim()) {
      await rename(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(filtered.map((c) => c.id)));

  const deselectAll = () => setSelected(new Set());

  const exitBatch = () => {
    setBatchMode(false);
    setSelected(new Set());
    setBatchConfirming(false);
  };

  const batchDelete = async () => {
    for (const id of selected) {
      await remove(id);
    }
    exitBatch();
  };

  const newConversation = () => {
    if (streaming) return;
    clearConversation();
  };

  return (
    <aside
      className={`flex shrink-0 flex-col border-r border-line bg-panel-2 transition-all duration-200 ease-out ${
        collapsed ? "w-10 items-center" : "w-56"
      }`}
    >
      {collapsed ? (
        <div className="flex flex-col items-center gap-2 py-3">
          <button
            onClick={() => setCollapsed(false)}
            title="展开历史记录"
            className="grid h-6 w-6 place-items-center rounded-btn border border-line bg-panel text-ink-2 transition-colors hover:text-ink"
          >
            <PanelLeftOpen size={13} />
          </button>
          <button
            onClick={newConversation}
            title="新对话"
            className="grid h-6 w-6 place-items-center rounded-btn border border-line bg-panel text-ink-2 transition-colors hover:text-ink"
          >
            <Plus size={13} />
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 px-3 pb-2 pt-3">
            <div className="flex flex-1 items-center gap-1.5 rounded-btn border border-line bg-panel px-2 py-1">
              <Search size={12} className="shrink-0 text-ink-2" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索会话…"
                className="w-full bg-transparent text-xs text-ink outline-none placeholder:text-ink-2"
              />
            </div>
            {batchMode ? (
              <button
                onClick={exitBatch}
                title="退出批量选择"
                className="grid h-6 w-6 shrink-0 place-items-center rounded-btn border border-line bg-panel text-ink-2 transition-colors hover:text-ink"
              >
                <X size={13} />
              </button>
            ) : (
              <>
                <button
                  onClick={newConversation}
                  title="新对话"
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-btn border border-line bg-panel text-ink-2 transition-colors hover:text-ink"
                >
                  <Plus size={13} />
                </button>
                <button
                  onClick={() => setBatchMode(true)}
                  title="批量选择"
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-btn border border-line bg-panel text-ink-2 transition-colors hover:text-ink"
                >
                  <CheckSquare size={13} />
                </button>
                <button
                  onClick={() => setCollapsed(true)}
                  title="收起历史记录"
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-btn border border-line bg-panel text-ink-2 transition-colors hover:text-ink"
                >
                  <PanelLeftClose size={13} />
                </button>
              </>
            )}
          </div>

      {/* Batch selection toolbar */}
      {batchMode && (
        <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11px] text-ink-2">
          <span className="shrink-0">已选 {selected.size}</span>
          <button onClick={selectAll} className="text-ink hover:underline">
            全选
          </button>
          <button onClick={deselectAll} className="text-ink hover:underline">
           取消
          </button>
          <span className="ml-auto">
            {batchConfirming ? (
              <span className="flex items-center gap-1">
                <button
                  onClick={() => void batchDelete()}
                  className="rounded bg-danger px-1.5 py-0.5 text-[11px] text-white"
                >
                  确认删除
                </button>
                <button
                  onClick={() => setBatchConfirming(false)}
                  className="text-ink hover:underline"
                >
                  取消
                </button>
              </span>
            ) : (
              <button
                onClick={() => selected.size > 0 && setBatchConfirming(true)}
                disabled={selected.size === 0}
                className="flex items-center gap-1 text-danger disabled:opacity-30"
              >
                <Trash2 size={11} /> 删除
              </button>
            )}
          </span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {filtered.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-ink-2">
            {conversations.length === 0 ? "暂无会话记录" : "没有匹配的会话"}
          </p>
        )}

        {filtered.map((c) => {
          const active = c.id === activeId;
          const renaming = renamingId === c.id;
          const isSelected = selected.has(c.id);

          return (
            <div
              key={c.id}
              onClick={() => {
                if (batchMode) {
                  toggleSelect(c.id);
                  return;
                }
                if (streaming || renaming || c.id === activeId) return;
                void loadConversation(c.id);
              }}
              className={`group mb-0.5 flex items-center gap-1.5 rounded-btn px-2 py-1.5 transition-colors ${
                batchMode
                  ? "cursor-pointer"
                  : "cursor-pointer"
              } ${
                batchMode && isSelected
                  ? "bg-panel shadow-sm ring-1 ring-[var(--cf-accent)]"
                  : active
                    ? "bg-panel shadow-sm"
                    : "hover:bg-panel"
              }`}
            >
              {batchMode && (
                <span className="shrink-0">
                  {isSelected ? (
                    <CheckSquare size={13} className="text-[var(--cf-accent)]" />
                  ) : (
                    <Square size={13} className="text-ink-2" />
                  )}
                </span>
              )}

              {renaming ? (
                <div className="flex flex-1 items-center gap-1">
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename();
                      if (e.key === "Escape") {
                        // Claim the key: Esc here cancels the rename, it must
                        // not also dismiss the window.
                        e.preventDefault();
                        setRenamingId(null);
                      }
                    }}
                    className="w-full rounded border border-line bg-panel-2 px-1 py-0.5 text-xs text-ink outline-none"
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void commitRename();
                    }}
                    className="shrink-0 text-success"
                  >
                    <Check size={12} />
                  </button>
                </div>
              ) : (
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <p
                      className={`flex-1 truncate text-xs ${
                        active ? "text-ink" : "text-ink-2"
                      }`}
                    >
                      {c.title || "新会话"}
                    </p>
                    {!batchMode && (
                      <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(c.id, c.title);
                          }}
                          title="重命名"
                          className="grid h-5 w-5 place-items-center rounded text-ink-2 hover:text-ink"
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openPromptEditor(c.id, c.systemPrompt);
                          }}
                          title="会话提示词"
                          className="grid h-5 w-5 place-items-center rounded text-ink-2 hover:text-ink"
                        >
                          <FileText size={11} />
                        </button>
                        {confirmingId === c.id ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void remove(c.id).catch(() => undefined);
                              setConfirmingId(null);
                            }}
                            title="确认删除"
                            className="grid h-5 w-5 place-items-center rounded text-danger"
                          >
                            <Check size={11} />
                          </button>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmingId(c.id);
                            }}
                            title="删除"
                            className="grid h-5 w-5 place-items-center rounded text-ink-2 hover:text-danger"
                          >
                            <Trash2 size={11} />
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[10px] text-ink-2">
                    {relativeTime(c.updatedAt)}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!collapsed && !batchMode && confirmingId && (
        <div className="border-t border-line px-3 py-2 text-[11px] text-ink-2">
          再次点击 ✓ 确认删除该会话
          <button
            onClick={() => setConfirmingId(null)}
            className="ml-2 text-ink hover:underline"
          >
            取消
          </button>
        </div>
      )}

      {/* Per-conversation system prompt editor */}
      {!collapsed && promptId && (
        <div className="border-t border-line px-3 py-2.5">
          <p className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-ink">
            <FileText size={12} className="text-accent" />
            会话提示词
          </p>
          <textarea
            value={promptValue}
            onChange={(e) => setPromptValue(e.target.value)}
            rows={4}
            placeholder="此会话专属的 AI 角色设定，留空则使用全局默认系统提示词。"
            className="w-full resize-none rounded-btn border border-line bg-panel-2 px-2 py-1.5 text-[11px] leading-4 text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-[var(--cf-text-2)]"
          />
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              onClick={() => void savePrompt()}
              className="flex items-center gap-1 rounded-btn bg-accent px-2 py-1 text-[11px] font-medium text-accent-fg transition-colors hover:opacity-90"
            >
              {promptSaved && <Check size={11} />}
              {promptSaved ? "已保存" : "保存"}
            </button>
            <button
              onClick={() => setPromptId(null)}
              className="rounded-btn border border-line px-2 py-1 text-[11px] text-ink-2 transition-colors hover:bg-panel-2"
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </>
  )}
</aside>
  );
}
