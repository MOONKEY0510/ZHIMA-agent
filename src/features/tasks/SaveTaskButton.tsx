import { useId, useState } from "react";
import { CalendarPlus, Check, LoaderCircle } from "lucide-react";
import { Button } from "../../components/ui";
import { Modal } from "../settings/ui";
import { useTasksStore } from "./stores/tasks-store";

export interface SaveTaskButtonProps {
  content: string;
  sourceConversationId: string | null;
  sourceMessageId: string;
}

/** Explicit confirmation only: this component never infers or executes a task. */
export function SaveTaskButton({ content, sourceConversationId, sourceMessageId }: SaveTaskButtonProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(content.trim().slice(0, 500));
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();
  const save = useTasksStore((state) => state.save);
  const submit = async () => {
    if (!title.trim()) return;
    const dueAt = due ? new Date(due).getTime() : null;
    if (dueAt !== null && !Number.isFinite(dueAt)) { setError("提醒时间无效"); return; }
    setSaving(true);
    setError(null);
    try {
      await save({ title: title.trim(), dueAt, sourceConversationId, sourceMessageId });
      setOpen(false);
    } catch (cause) { setError(String(cause)); }
    finally { setSaving(false); }
  };
  return <>
    <Button size="sm" variant="ghost" onClick={() => { setTitle(content.trim().slice(0, 500)); setDue(""); setError(null); setOpen(true); }} aria-label="保存待办" aria-haspopup="dialog" title="保存待办">
      <CalendarPlus size={14} aria-hidden="true" />保存待办
    </Button>
    {open && <Modal title="保存待办" subtitle="核对内容，按需设置本地提醒" icon={<CalendarPlus size={17} />} onClose={() => setOpen(false)} closeDisabled={saving}
      footer={<div className="flex justify-end gap-2"><Button disabled={saving} onClick={() => setOpen(false)}>取消</Button><Button type="submit" form={formId} variant="primary" disabled={saving || !title.trim()}>{saving ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}{saving ? "保存中…" : "确认保存"}</Button></div>}>
      <form id={formId} onSubmit={(event) => { event.preventDefault(); void submit(); }} className="space-y-4">
        <label className="cf-settings-field">待办内容
          <textarea autoFocus required maxLength={500} value={title} onChange={(event) => setTitle(event.target.value)} className="cf-input min-h-24 w-full resize-y !text-ui" />
        </label>
        <label className="cf-settings-field">提醒时间（可选）
          <input type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} className="cf-input min-w-0 w-full !text-ui" />
        </label>
        <div className="rounded-input border border-line bg-panel-2 px-3 py-2.5 text-meta text-ink-2">
          <p>请核对内容和本地时间。仅保存待办，不会自动执行任务。</p>
          <p className="mt-1">应用运行时通过窗口内提醒，不是系统通知。</p>
        </div>
        {error && <p role="alert" className="break-words rounded-btn border border-line bg-panel-2 px-3 py-2 text-ui text-danger">{error}</p>}
      </form>
    </Modal>}
  </>;
}
