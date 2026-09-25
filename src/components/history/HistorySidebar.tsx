import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, CheckSquare, ChevronDown, FileText, Loader2, MessageSquare, Pencil, Pin, PinOff, Plus, Search, Square, Trash2, X, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useHistoryStore } from "../../services/history-store";
import {
  searchMessages,
  setConversationSystemPrompt,
  type MessageHit,
} from "../../services/history-api";
import { useChatStore } from "../../stores/chat-store";
import { sortedAssistants, useAssistantsStore } from "../../stores/assistants-store";
import { relativeTime } from "../../lib/time";
import { AssistantIcon } from "../assistant/AssistantIcon";

/** Minimum query length before the backend full-text search is consulted. */
const MIN_SEARCH_CHARS = 2;

/**
 * Conversation history sidebar for the full conversation mode (plan §3.2):
 * full-text message search, title filter, switch, rename, delete, batch
 * select & batch delete.
 *
 * Multi-conversation: switching is never blocked by running generations.  A
 * row shows a spinner while its conversation generates, and a dot once it
 * finished in the background (the dot clears when the row is opened).
 */
export function HistorySidebar() {
  const conversations = useHistoryStore((s) => s.conversations);
  const activeId = useHistoryStore((s) => s.activeId);
  const remove = useHistoryStore((s) => s.remove);
  const rename = useHistoryStore((s) => s.rename);
  const setPinned = useHistoryStore((s) => s.setPinned);
  const loadConversation = useChatStore((s) => s.loadConversation);
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const streams = useChatStore((s) => s.streams);
  const unreadDone = useChatStore((s) => s.unreadDone);
  const assistants = useAssistantsStore((s) => s.assistants);
  const assistantId = useAssistantsStore((s) => s.activeId);
  const setAssistant = useAssistantsStore((s) => s.setActive);

  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [promptId, setPromptId] = useState<string | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [promptSaved, setPromptSaved] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const activeAssistant = assistants.find((a) => a.id === assistantId) ?? null;

  // Esc closes the assistant picker like any other transient popover.
  useEffect(() => {
    if (!pickerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPickerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickerOpen]);

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
  const listRef = useRef<HTMLDivElement>(null);

  // Full-text search over message content (debounced).
  const [hits, setHits] = useState<MessageHit[]>([]);
  const [searching, setSearching] = useState(false);
  const trimmedQuery = query.trim();
  const searchActive = trimmedQuery.length >= MIN_SEARCH_CHARS;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? conversations.filter((c) => c.title.toLowerCase().includes(q))
      : conversations;
  }, [conversations, query]);

  useEffect(() => {
    if (!searchActive) {
      setHits([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      searchMessages(trimmedQuery, 30)
        .then((results) => {
          if (!cancelled) setHits(results);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [trimmedQuery, searchActive]);

  /** Open a hit: load its conversation (if needed) and reveal the message. */
  const openHit = async (hit: MessageHit) => {
    if (hit.conversationId !== activeId) {
      await loadConversation(hit.conversationId);
    }
    useChatStore.getState().focusMessage(hit.messageId);
  };

  useEffect(() => {
    if (!activeId || collapsed) return;
    const frame = window.requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-conversation-id="${activeId}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeId, conversations, collapsed]);

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

  /** New chat.  Generations in other conversations keep running. */
  const newConversation = () => {
    startNewConversation();
  };

  return (
    <aside
      className={`cf-print-hide flex shrink-0 flex-col border-r border-line bg-panel-2 transition-all duration-200 ease-out ${
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
          {/* Assistant picker (P1-7): binds the next new conversation. Hidden
              while batch-selecting to keep the list uncluttered. */}
          {!batchMode && assistants.length > 0 && (
            <div className="relative px-3 pb-1.5 pt-3">
              <button
                type="button"
                onClick={() => setPickerOpen((open) => !open)}
                aria-haspopup="listbox"
                aria-expanded={pickerOpen}
                title={activeAssistant?.description ?? "选择助手"}
                className="flex w-full items-center gap-1.5 rounded-btn border border-line bg-panel px-2 py-1 text-xs text-ink transition-colors hover:bg-panel-2"
              >
                {activeAssistant ? (
                  <AssistantIcon
                    icon={activeAssistant.icon}
                    size={13}
                    className="shrink-0"
                  />
                ) : (
                  <MessageSquare size={13} className="shrink-0 text-ink-2" />
                )}
                <span className="min-w-0 flex-1 truncate text-left">
                  {activeAssistant?.name ?? "默认助手"}
                </span>
                <ChevronDown
                  size={13}
                  className={`shrink-0 text-ink-2 transition-transform ${pickerOpen ? "rotate-180" : ""}`}
                />
              </button>

              {pickerOpen && (
                <>
                  {/* Click-away layer so any outside click closes the list. */}
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setPickerOpen(false)}
                  />
                  <div
                    role="listbox"
                    aria-label="选择助手"
                    className="absolute left-3 right-3 z-50 mt-1 max-h-72 overflow-y-auto rounded-btn border border-line bg-panel py-1 shadow-lg"
                  >
                    <AssistantOption
                      selected={assistantId === null}
                      icon={<MessageSquare size={13} className="shrink-0 text-ink-2" />}
                      name="默认助手"
                      description="不使用助手：跟随全局默认提示词与模型"
                      onSelect={() => {
                        setAssistant(null);
                        setPickerOpen(false);
                      }}
                    />
                    <div className="my-1 border-t border-line" />
                    {sortedAssistants(assistants).map((a) => (
                      <AssistantOption
                        key={a.id}
                        selected={assistantId === a.id}
                        icon={
                          <AssistantIcon icon={a.icon} size={13} className="shrink-0" />
                        }
                        name={a.name}
                        description={a.description ?? ""}
                        onSelect={() => {
                          setAssistant(a.id);
                          setPickerOpen(false);
                        }}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          <div className={`flex items-center gap-2 px-3 pb-2 ${batchMode || assistants.length === 0 ? "pt-3" : ""}`}>
            <div className="flex flex-1 items-center gap-1.5 rounded-btn border border-line bg-panel px-2 py-1">
              <Search size={12} className="shrink-0 text-ink-2" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索会话或消息内容…"
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

      <div ref={listRef} className="flex-1 overflow-y-auto px-2 pb-2">
        {/* Full-text hits over message content (P0-2) */}
        {searchActive && !batchMode && (
          <div className="mb-1">
            <p className="px-2 pb-1 pt-2 text-[10px] uppercase tracking-wide text-ink-2">
              {/* The backend query is capped at 30 hits; show it so a full list
                  is not mistaken for "no more matches exist". */}
              消息内容 {searching ? "· 搜索中…" : `· ${hits.length}/30`}
            </p>
            {!searching && hits.length === 0 && (
              <p className="px-2 py-2 text-[11px] text-ink-2">没有匹配的消息</p>
            )}
            {hits.map((hit) => (
              <button
                key={hit.messageId}
                type="button"
                onClick={() => void openHit(hit)}
                title={hit.conversationTitle}
                className="mb-0.5 block w-full rounded-btn px-2 py-1.5 text-left transition-colors hover:bg-panel disabled:opacity-50"
              >
                <span className="flex items-center gap-1.5">
                  <MessageSquare size={10} className="shrink-0 text-ink-2" />
                  <span className="truncate text-[10px] text-ink-2">
                    {hit.conversationTitle || "新会话"}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-ink-2">
                    {relativeTime(hit.createdAt)}
                  </span>
                </span>
                <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-ink">
                  {hit.snippet}
                </span>
              </button>
            ))}
          </div>
        )}

        {searchActive && !batchMode && filtered.length > 0 && (
          <p className="px-2 pb-1 pt-1 text-[10px] uppercase tracking-wide text-ink-2">会话</p>
        )}

        {filtered.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-ink-2">
            {conversations.length === 0 ? "暂无会话记录" : "没有匹配的会话"}
          </p>
        )}

        {filtered.map((c, index) => {
          const active = c.id === activeId;
          const renaming = renamingId === c.id;
          const isSelected = selected.has(c.id);
          // Multi-conversation state: is this row's conversation generating,
          // and did it finish while the user was elsewhere?
          const isGenerating = Object.values(streams).some(
            (stream) => stream.conversationId === c.id,
          );
          const hasUnread = Boolean(unreadDone[c.id]);
          // Pinned conversations come first; a thin rule separates the two
          // groups once the list leaves them behind (P1-11.1).
          const startsUnpinned = !c.pinned && index > 0 && filtered[index - 1].pinned;

          return (
            <Fragment key={c.id}>
              {startsUnpinned && <div className="mx-2 my-1 border-t border-line" />}
            <div
              data-conversation-id={c.id}
              onClick={() => {
                if (batchMode) {
                  toggleSelect(c.id);
                  return;
                }
                // Switching is never blocked by running generations.
                if (renaming || c.id === activeId) return;
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
                    {/* 生成中：转圈；后台完成：圆点（打开后消失） */}
                    {!batchMode && isGenerating && (
                      <Loader2
                        size={11}
                        className="shrink-0 animate-spin text-accent"
                        aria-label="正在生成"
                      />
                    )}
                    {!batchMode && !isGenerating && hasUnread && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                        title="对话已完成，点击查看"
                        aria-label="对话已完成"
                      />
                    )}
                    {c.pinned && !batchMode && (
                      <Pin
                        size={10}
                        className="shrink-0 text-accent group-hover:hidden"
                        aria-label="已置顶"
                      />
                    )}
                    {!batchMode && (
                      <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void setPinned(c.id, !c.pinned);
                          }}
                          title={c.pinned ? "取消置顶" : "置顶会话"}
                          className="grid h-5 w-5 place-items-center rounded text-ink-2 hover:text-ink"
                        >
                          {c.pinned ? <PinOff size={11} /> : <Pin size={11} />}
                        </button>
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
            </Fragment>
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

/** One row inside the assistant picker list (select shows a check mark). */
function AssistantOption({
  selected,
  icon,
  name,
  description,
  onSelect,
}: {
  selected: boolean;
  icon: ReactNode;
  name: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={`flex w-full items-start gap-2 px-2.5 py-1.5 text-left transition-colors ${
        selected ? "bg-accent/15" : "hover:bg-panel-2"
      }`}
    >
      <span className="mt-0.5">{icon}</span>
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-xs ${
            selected ? "font-medium text-accent" : "text-ink"
          }`}
        >
          {name}
        </span>
        {description && (
          <span className="mt-0.5 line-clamp-2 block text-[10px] leading-4 text-ink-2">
            {description}
          </span>
        )}
      </span>
      {selected && <Check size={12} className="mt-0.5 shrink-0 text-accent" />}
    </button>
  );
}
