import { useEffect, useState } from "react";
import { Check, Clock, ExternalLink, LoaderCircle, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "../../components/ui";
import { useChatStore } from "../../stores/chat-store";
import { useHistoryStore } from "../../services/history-store";
import { useTasksStore } from "./stores/tasks-store";
import type { Task } from "./services/tasks-api";
import { SettingsSection } from "../settings/ui";

function localDateTime(value: number | null) {
  if (value === null) return "";
  const date = new Date(value);
  return new Date(value - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function TasksPanel({ onOpenSource }: { onOpenSource?: () => void }) {
  const { tasks, loading, error, load, save, setCompleted, remove } = useTasksStore();
  const [editing, setEditing] = useState<Task | null>(null);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  useEffect(() => { void load(); }, [load]);
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true); setLocalError(null);
    try { await operation(); } catch (cause) { setLocalError(String(cause)); }
    finally { setBusy(false); }
  };
  const openSource = async (task: Task) => {
    if (!task.sourceConversationId) throw new Error("来源会话未保存或已不可用");
    await useChatStore.getState().loadConversation(task.sourceConversationId);
    if (useHistoryStore.getState().activeId !== task.sourceConversationId) throw new Error("来源会话已删除或无法打开");
    if (task.sourceMessageId) {
      if (!useChatStore.getState().messages.some((message) => message.id === task.sourceMessageId)) throw new Error("来源消息已删除或无法打开");
      useChatStore.getState().focusMessage(task.sourceMessageId);
    }
    onOpenSource?.();
  };
  return <SettingsSection title="待办" ariaLabel="待办管理"
    description="手动确认的本地待办，不会自动执行。"
    action={<Button size="sm" disabled={loading || busy} onClick={() => void load()}><RefreshCw size={13} className={loading ? "animate-spin" : ""} aria-hidden="true" />刷新</Button>}>
    <div className="space-y-3 text-ui text-ink">
    <details className="rounded-input border border-line bg-panel-2 px-3 py-2 text-meta text-ink-2"><summary className="cursor-pointer font-medium text-ink">提醒方式与运行条件</summary><p className="mt-2">应用运行（含隐藏窗口）时每 15 秒检查；退出后不提醒，下次启动补查。提醒显示在应用内，并非系统通知。</p></details>
    {(localError || error) && <p role="alert" className="break-words rounded-btn border border-line bg-panel-2 px-3 py-2 text-danger">{localError || error}</p>}
    {loading && <p role="status" className="flex items-center gap-2 rounded-btn border border-line bg-panel-2 px-3 py-2 text-ink-2"><LoaderCircle size={14} className="animate-spin" aria-hidden="true" />加载中…</p>}
    {!loading && tasks.length === 0 && <p className="cf-settings-empty">暂无待办，可从回答的“保存待办”创建。</p>}
    <ul className="space-y-2">{[...tasks].sort((a, b) => Number(a.completed) - Number(b.completed) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || b.createdAt - a.createdAt).map((task) => <li key={task.id} className="cf-settings-action-card">
      <label className="flex cursor-pointer items-start gap-2.5"><input type="checkbox" className="cf-checkbox mt-0.5" aria-label={`完成待办：${task.title}`} checked={task.completed} disabled={busy} onChange={(event) => void run(() => setCompleted(task.id, event.target.checked))} /><span className={`min-w-0 whitespace-pre-wrap break-words font-medium ${task.completed ? "line-through text-ink-2" : "text-ink"}`}>{task.title}</span></label>
      <p className="my-2 flex items-center gap-1.5 text-meta text-ink-2"><Clock size={12} className="shrink-0" aria-hidden="true" />{task.dueAt === null ? "无提醒时间" : new Date(task.dueAt).toLocaleString()}</p>
      <div className="cf-settings-actions"><Button size="sm" disabled={busy} onClick={() => { setEditing(task); setTitle(task.title); setDue(localDateTime(task.dueAt)); }}><Pencil size={12} aria-hidden="true" />编辑</Button>
        <Button size="sm" variant="ghost" disabled={busy || !task.sourceConversationId} onClick={() => void run(() => openSource(task))}><ExternalLink size={12} aria-hidden="true" />查看来源</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleting(task.id)}><Trash2 size={12} aria-hidden="true" />删除</Button></div>
      {deleting === task.id && <div className="mt-3 space-y-2 border-t border-line pt-3"><p className="text-ui text-ink">确认删除此待办？</p><div className="cf-settings-actions"><Button size="sm" variant="danger" disabled={busy} onClick={() => void run(async () => { await remove(task.id); setDeleting(null); })}><Trash2 size={12} aria-hidden="true" />确认删除</Button><Button size="sm" variant="ghost" onClick={() => setDeleting(null)}>取消删除</Button></div></div>}
      {editing?.id === task.id && <form className="cf-settings-editor mt-3 space-y-3" onSubmit={(event) => { event.preventDefault(); void run(async () => {
        // A title-only edit must preserve original seconds/milliseconds, or
        // formatting datetime-local to minutes would accidentally re-arm it.
        const dueAt = due === localDateTime(task.dueAt) ? task.dueAt : due ? new Date(due).getTime() : null;
        if (dueAt !== null && !Number.isFinite(dueAt)) throw new Error("提醒时间无效");
        await save({ id: task.id, title, dueAt, sourceConversationId: task.sourceConversationId, sourceMessageId: task.sourceMessageId });
        setEditing(null);
      }); }}>
        <label className="cf-settings-field">待办内容<input required maxLength={500} value={title} onChange={(event) => setTitle(event.target.value)} className="cf-input" /></label>
        <label className="cf-settings-field">提醒时间<input type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} className="cf-input" /></label>
        <p className="text-meta text-ink-2">只有更改提醒时间才会重新提醒；修改标题或重新打开待办不会重置通知。</p>
        <div className="cf-settings-actions"><Button size="sm" type="submit" variant="primary" disabled={busy || !title.trim()}><Check size={13} aria-hidden="true" />保存修改</Button><Button size="sm" disabled={busy} onClick={() => setEditing(null)}>取消编辑</Button></div>
      </form>}
    </li>)}</ul>
    </div>
  </SettingsSection>;
}
