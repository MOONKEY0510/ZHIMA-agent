import { useEffect, useState } from "react";
import { Bell, Check, Clock } from "lucide-react";
import { Button } from "../../components/ui";
import { listen } from "@tauri-apps/api/event";
import { taskRemindersReady, type Task } from "./services/tasks-api";
import { acknowledgeTaskReminder, completeTaskReminder } from "./stores/tasks-store";

/** Mount once outside tabs/settings. Rust owns the clock, not a hidden-webview timer. */
export function TaskReminders() {
  const [pending, setPending] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<Task[]>("tasks:due", (event) => {
      if (!disposed) setPending(event.payload);
    }).then(async (stop) => {
      if (disposed) { stop(); return; }
      unlisten = stop;
      // Register the listener before enabling Rust delivery.
      await taskRemindersReady();
    }).catch((cause) => { if (!disposed) setError(`提醒初始化失败：${String(cause)}`); });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const dismiss = async (task: Task, completed: boolean) => {
    setBusy(true); setError(null);
    try {
      if (task.notifiedAt !== null) {
        if (completed) await completeTaskReminder(task.id, task.notifiedAt);
        else await acknowledgeTaskReminder(task.id, task.notifiedAt);
      }
      setPending((items) => items.filter((item) => item.id !== task.id || item.notifiedAt !== task.notifiedAt));
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  if (!pending.length && !error) return null;
  return <aside aria-label="待办到期提醒" className="fixed bottom-4 right-4 z-[90] flex max-h-[70dvh] w-80 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-input border border-line bg-panel text-ui text-ink shadow-menu">
    <header className="flex shrink-0 items-center gap-2.5 border-b border-line px-4 py-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-btn bg-panel-2 text-accent"><Bell size={16} aria-hidden="true" /></span>
      <div><h2 className="text-ui font-semibold">待办到期提醒</h2><p className="text-meta text-ink-2">应用内提醒 · 不是系统通知</p></div>
    </header>
    <div className="min-h-0 overflow-y-auto overscroll-contain px-4">
      {error && <p role="alert" className="my-3 break-words rounded-btn border border-line bg-panel-2 px-3 py-2 text-ui text-danger">{error}</p>}
      <ul aria-live="polite" className="divide-y divide-line">{pending.map((task) => <li key={`${task.id}-${task.notifiedAt}`} className="py-3">
        <p className="whitespace-pre-wrap break-words font-medium">{task.title}</p>
        {task.dueAt !== null && <p className="mt-1 flex items-center gap-1.5 text-meta text-ink-2"><Clock size={12} aria-hidden="true" />{new Date(task.dueAt).toLocaleString()}</p>}
        <div className="mt-3 flex flex-wrap justify-end gap-2"><Button size="sm" disabled={busy} onClick={() => void dismiss(task, false)}>知道了</Button><Button size="sm" variant="primary" disabled={busy} onClick={() => void dismiss(task, true)}><Check size={13} aria-hidden="true" />标记完成</Button></div>
      </li>)}</ul>
    </div>
  </aside>;
}
