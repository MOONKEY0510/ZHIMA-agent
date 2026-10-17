import { invoke } from "@tauri-apps/api/core";

/** Unix-millisecond timestamps; local user-confirmed data, never a model tool. */
export interface Task {
  id: string;
  title: string;
  dueAt: number | null;
  completed: boolean;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  notifiedAt: number | null;
  createdAt: number;
  updatedAt: number;
  reminderPending: boolean;
}
export interface TaskDraft {
  id?: string | null;
  title: string;
  dueAt: number | null;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
}
export const listTasks = () => invoke<Task[]>("tasks_list");
export const upsertTask = (draft: TaskDraft) => invoke<Task>("tasks_upsert", { draft });
export const setTaskCompleted = (id: string, completed: boolean) => invoke<Task>("tasks_set_completed", { id, completed });
export const deleteTask = (id: string) => invoke<void>("tasks_delete", { id });
export const claimDueTasks = () => invoke<Task[]>("tasks_claim_due");
export const ackTaskReminder = (id: string, notifiedAt: number) => invoke<void>("tasks_ack_reminder", { id, notifiedAt });
export const completeTaskReminder = (id: string, notifiedAt: number) => invoke<Task | null>("tasks_complete_reminder", { id, notifiedAt });
export const taskRemindersReady = () => invoke<void>("tasks_reminders_ready");
