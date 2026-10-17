import { create } from "zustand";
import * as api from "../services/tasks-api";
import type { Task, TaskDraft } from "../services/tasks-api";

interface TasksState {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  save: (draft: TaskDraft) => Promise<Task>;
  setCompleted: (id: string, completed: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
}
let revision = 0;
let maintenanceEpoch = 0;
let writeAllowed: () => boolean = () => true;
const pendingWrites = new Set<Promise<unknown>>();

/** Register synchronously at app/store bootstrap. true means writes are allowed.
 * Injection avoids a tasks-store -> chat-store -> tasks-store import cycle. */
export function setTaskWriteGuard(guard: () => boolean): void {
  writeAllowed = guard;
}

function taskWrite<T>(operation: (epoch: number) => Promise<T>): Promise<T> {
  if (!writeAllowed()) return Promise.reject(new Error("正在导入备份，暂时不能修改待办"));
  const epoch = maintenanceEpoch;
  // Track synchronously, before invoking asynchronous IPC: a caller which sets
  // the import lock immediately afterwards must still drain this operation.
  const promise = Promise.resolve().then(() => operation(epoch));
  pendingWrites.add(promise);
  void promise.then(() => pendingWrites.delete(promise), () => pendingWrites.delete(promise));
  return promise;
}

/** Caller MUST set the external import lock first and hold it through restore.
 * Drain successes and failures, and invalidate pre-maintenance loads/mutations
 * so their late results cannot repopulate the restored UI. */
export async function settleTaskWrites(): Promise<void> {
  ++maintenanceEpoch;
  ++revision;
  useTasksStore.setState({ loading: false, error: null });
  while (pendingWrites.size) await Promise.allSettled([...pendingWrites]);
  ++revision;
}

/** Reminder dismissal is a database mutation too; never bypass the barrier. */
export function acknowledgeTaskReminder(id: string, notifiedAt: number): Promise<void> {
  return taskWrite(() => api.ackTaskReminder(id, notifiedAt));
}

/** Complete only the claim represented by this reminder, not a newer schedule. */
export function completeTaskReminder(id: string, notifiedAt: number): Promise<Task | null> {
  return taskWrite(async (epoch) => {
    const task = await api.completeTaskReminder(id, notifiedAt);
    if (task && epoch === maintenanceEpoch) {
      ++revision;
      useTasksStore.setState((state) => ({
        tasks: state.tasks.map((item) => item.id === id ? task : item),
        loading: false, error: null,
      }));
    }
    return task;
  });
}

export const useTasksStore = create<TasksState>((set, get) => ({
  tasks: [], loading: false, error: null,
  load: async () => {
    if (!writeAllowed()) return;
    const current = ++revision;
    set({ loading: true, error: null });
    try {
      const tasks = await api.listTasks();
      if (current === revision) set({ tasks, loading: false });
    } catch (error) {
      if (current === revision) set({ error: String(error), loading: false });
    }
  },
  save: (draft) => taskWrite(async (epoch) => {
    try {
      const task = await api.upsertTask(draft);
      if (epoch === maintenanceEpoch) {
        ++revision;
        set({ tasks: [...get().tasks.filter((item) => item.id !== task.id), task], loading: false, error: null });
      }
      return task;
    } catch (error) { if (epoch === maintenanceEpoch) set({ error: String(error) }); throw error; }
  }),
  setCompleted: (id, completed) => taskWrite(async (epoch) => {
    try {
      const task = await api.setTaskCompleted(id, completed);
      if (epoch === maintenanceEpoch) {
        ++revision;
        set({ tasks: get().tasks.map((item) => item.id === id ? task : item), loading: false, error: null });
      }
    } catch (error) { if (epoch === maintenanceEpoch) set({ error: String(error) }); throw error; }
  }),
  remove: (id) => taskWrite(async (epoch) => {
    try {
      await api.deleteTask(id);
      if (epoch === maintenanceEpoch) {
        ++revision;
        set({ tasks: get().tasks.filter((item) => item.id !== id), loading: false, error: null });
      }
    } catch (error) { if (epoch === maintenanceEpoch) set({ error: String(error) }); throw error; }
  }),
}));
