import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SaveTaskButton } from "../SaveTaskButton";
import { TasksPanel } from "../TasksPanel";
import { TaskReminders } from "../TaskReminders";
import { acknowledgeTaskReminder, completeTaskReminder, setTaskWriteGuard, settleTaskWrites, useTasksStore } from "../stores/tasks-store";
import { useChatStore } from "../../../stores/chat-store";
import { useHistoryStore } from "../../../services/history-store";
import * as api from "../services/tasks-api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const task: api.Task = { id: "t", title: "确认后的条目", dueAt: 1000, completed: false, sourceConversationId: "c", sourceMessageId: "m", notifiedAt: null, createdAt: 1, updatedAt: 1, reminderPending: false };
beforeEach(() => {
  setTaskWriteGuard(() => true);
  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockReset();
  useTasksStore.setState({ tasks: [], error: null, loading: false });
});

describe("task confirmation", () => {
  it("uses shared modal chrome and consumes Escape without persisting", () => {
    const view = render(<SaveTaskButton content="建议" sourceConversationId={null} sourceMessageId="m" />);
    const trigger = screen.getByRole("button", { name: "保存待办" });
    trigger.focus(); fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "保存待办" });
    expect(view.container.contains(dialog)).toBe(false);
    expect(dialog.querySelector("header")).toBeTruthy();
    expect(dialog.querySelector("footer")).toContainElement(screen.getByRole("button", { name: "确认保存" }));
    expect(screen.getByLabelText("待办内容")).toHaveFocus();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not persist until manual confirmation and preserves source IDs", async () => {
    vi.mocked(invoke).mockResolvedValue(task);
    render(<SaveTaskButton content="模型提出的建议" sourceConversationId="c" sourceMessageId="m" />);
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存待办" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("待办内容"), { target: { value: "确认后的条目" } });
    fireEvent.change(screen.getByLabelText("提醒时间（可选）"), { target: { value: "2026-10-20T09:30" } });
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("tasks_upsert", { draft: { title: "确认后的条目", dueAt: new Date("2026-10-20T09:30").getTime(), sourceConversationId: "c", sourceMessageId: "m" } }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("cancel never writes and failed writes keep the editable dialog", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("磁盘已满"));
    render(<SaveTaskButton content="建议" sourceConversationId={null} sourceMessageId="m" />);
    fireEvent.click(screen.getByRole("button", { name: "保存待办" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存待办" }));
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("磁盘已满");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("task store and API", () => {
  it("exposes the command contract and does not hide failed mutations", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await api.claimDueTasks();
    await api.ackTaskReminder("t", 123);
    expect(invoke).toHaveBeenCalledWith("tasks_claim_due");
    expect(invoke).toHaveBeenCalledWith("tasks_ack_reminder", { id: "t", notifiedAt: 123 });
    useTasksStore.setState({ tasks: [task] });
    vi.mocked(invoke).mockRejectedValue("failed");
    await expect(useTasksStore.getState().remove("t")).rejects.toBe("failed");
    expect(useTasksStore.getState().tasks).toEqual([task]);
    expect(useTasksStore.getState().error).toBe("failed");
  });
  it("stale loads cannot overwrite a saved task", async () => {
    let resolve!: (items: api.Task[]) => void;
    vi.mocked(invoke).mockImplementation((command) => command === "tasks_list" ? new Promise((done) => { resolve = done as typeof resolve; }) : Promise.resolve(task));
    const loading = useTasksStore.getState().load();
    await useTasksStore.getState().save({ title: task.title, dueAt: null, sourceConversationId: null, sourceMessageId: null });
    resolve([]); await loading;
    expect(useTasksStore.getState().tasks).toEqual([task]);
  });
});

describe("backup maintenance write barrier", () => {
  const draft: api.TaskDraft = { title: "late write", dueAt: null, sourceConversationId: null, sourceMessageId: null };
  it("rejects save, completion, removal and reminder ack while locked without IPC", async () => {
    setTaskWriteGuard(() => false);
    await expect(useTasksStore.getState().save(draft)).rejects.toThrow("正在导入备份");
    await expect(useTasksStore.getState().setCompleted("t", true)).rejects.toThrow("正在导入备份");
    await expect(useTasksStore.getState().remove("t")).rejects.toThrow("正在导入备份");
    await expect(acknowledgeTaskReminder("t", 20)).rejects.toThrow("正在导入备份");
    await expect(completeTaskReminder("t", 20)).rejects.toThrow("正在导入备份");
    await useTasksStore.getState().load();
    expect(invoke).not.toHaveBeenCalled();
  });
  it("drains all in-flight mutations including failed ack and invalidates their late UI results", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const rejecters: Array<(reason: unknown) => void> = [];
    vi.mocked(invoke).mockImplementation(() => new Promise((resolve, reject) => {
      resolvers.push(resolve as (value: unknown) => void); rejecters.push(reject);
    }));
    useTasksStore.setState({ tasks: [task] });
    const writes = [useTasksStore.getState().save(draft), useTasksStore.getState().setCompleted("t", true), useTasksStore.getState().remove("t"), acknowledgeTaskReminder("t", 20)];
    // No await before lock: operations queued in this same JS turn count too.
    setTaskWriteGuard(() => false);
    let settled = false;
    const barrier = settleTaskWrites().then(() => { settled = true; });
    const outcomes = Promise.allSettled(writes);
    await Promise.resolve();
    expect(resolvers).toHaveLength(4);
    resolvers[0]({ ...task, title: "late save" });
    resolvers[1]({ ...task, completed: true });
    resolvers[2](undefined);
    await Promise.resolve();
    expect(settled).toBe(false);
    rejecters[3](new Error("ack failed"));
    await barrier; await outcomes;
    expect(settled).toBe(true);
    expect(useTasksStore.getState().tasks).toEqual([task]);
    expect(useTasksStore.getState().error).toBeNull();
    setTaskWriteGuard(() => true);
    vi.mocked(invoke).mockResolvedValue([{ ...task, title: "restored" }]);
    await useTasksStore.getState().load();
    expect(useTasksStore.getState().tasks[0].title).toBe("restored");
  });
  it("real chat-store import waits for task writes and blocks reminder writes until restore completes", async () => {
    setTaskWriteGuard(() => !useChatStore.getState().importingBackup);
    useChatStore.setState({ importingBackup: false, streams: {}, backgroundMessages: {}, messages: [] });
    useHistoryStore.setState({ activeId: null });
    let finishWrite!: (value: api.Task) => void;
    let finishImport!: (value: unknown) => void;
    const restored = { ...task, title: "restored from backup" };
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "tasks_upsert") return new Promise((resolve) => { finishWrite = resolve as typeof finishWrite; });
      if (command === "import_data") return new Promise((resolve) => { finishImport = resolve as typeof finishImport; });
      if (command === "tasks_list") return Promise.resolve([restored]);
      return Promise.resolve([]);
    });
    try {
      const write = useTasksStore.getState().save(draft);
      const importing = useChatStore.getState().importBackup("mock-backup.json", "replace");
      expect(useChatStore.getState().importingBackup).toBe(true);
      await Promise.resolve();
      expect(invoke).not.toHaveBeenCalledWith("import_data", expect.anything());
      await expect(acknowledgeTaskReminder("t", 20)).rejects.toThrow("正在导入备份");
      await expect(completeTaskReminder("t", 20)).rejects.toThrow("正在导入备份");
      expect(invoke).not.toHaveBeenCalledWith("tasks_ack_reminder", expect.anything());
      finishWrite(task);
      await write;
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("import_data", { path: "mock-backup.json", strategy: "replace" }));
      expect(useChatStore.getState().importingBackup).toBe(true);
      finishImport({ conversations: 0, messages: 0, memories: 0, images: 0, skills: 0, tasks: 1, skipped: 0 });
      await importing;
      expect(useChatStore.getState().importingBackup).toBe(false);
      expect(useTasksStore.getState().tasks).toEqual([restored]);
    } finally {
      useChatStore.setState({ importingBackup: false });
      setTaskWriteGuard(() => true);
    }
  });
  it("invalidates a pre-import list response after the restore has loaded", async () => {
    let finishOld!: (value: api.Task[]) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve as typeof finishOld; }));
    const old = useTasksStore.getState().load();
    setTaskWriteGuard(() => false);
    await settleTaskWrites();
    setTaskWriteGuard(() => true);
    vi.mocked(invoke).mockResolvedValue([{ ...task, title: "restored" }]);
    await useTasksStore.getState().load();
    finishOld([task]); await old;
    expect(useTasksStore.getState().tasks[0].title).toBe("restored");
  });
});

describe("task management", () => {
  it("edits, completes and deletes with explicit delete confirmation", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "tasks_list") return [task];
      if (command === "tasks_upsert") return { ...task, title: "编辑条目" };
      if (command === "tasks_set_completed") return { ...task, completed: (args as { completed: boolean }).completed };
      return undefined;
    });
    render(<TasksPanel />);
    await screen.findByText(task.title);
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("待办内容"), { target: { value: "编辑条目" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByText("编辑条目");
    expect(invoke).toHaveBeenCalledWith("tasks_upsert", { draft: expect.objectContaining({ dueAt: task.dueAt }) });
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("tasks_set_completed", { id: "t", completed: true }));
    await waitFor(() => expect(screen.getByRole("button", { name: "删除" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(invoke).not.toHaveBeenCalledWith("tasks_delete", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("tasks_delete", { id: "t" }));
  });
  it("returns to the source using existing store navigation and focuses its message", async () => {
    const original = useChatStore.getState().loadConversation;
    const loadConversation = vi.fn(async () => { useHistoryStore.setState({ activeId: "c" }); useChatStore.setState({ messages: [{ id: "m", role: "assistant", content: "来源", status: "done" }] }); });
    useChatStore.setState({ loadConversation });
    vi.mocked(invoke).mockResolvedValue([task]);
    const onOpenSource = vi.fn();
    try {
      render(<TasksPanel onOpenSource={onOpenSource} />);
      fireEvent.click(await screen.findByRole("button", { name: "查看来源" }));
      await waitFor(() => expect(onOpenSource).toHaveBeenCalled());
      expect(loadConversation).toHaveBeenCalledWith("c");
      expect(useChatStore.getState().focusMessageId).toBe("m");
    } finally { useChatStore.setState({ loadConversation: original }); }
  });
});

describe("resident reminder delivery", () => {
  it("sends the snapshot claim token for completion and leaves a rescheduled task untouched", async () => {
    let receive!: (event: { payload: api.Task[] }) => void;
    vi.mocked(listen).mockImplementation(async (_name, callback) => { receive = callback as typeof receive; return vi.fn(); });
    vi.mocked(invoke).mockImplementation(async (command) => command === "tasks_complete_reminder" ? null : undefined);
    const rescheduled = { ...task, dueAt: 9000, notifiedAt: null, reminderPending: false };
    useTasksStore.setState({ tasks: [rescheduled] });
    render(<TaskReminders />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("tasks_reminders_ready"));
    act(() => receive({ payload: [{ ...task, notifiedAt: 2000, reminderPending: true }] }));
    fireEvent.click(screen.getByRole("button", { name: "标记完成" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("tasks_complete_reminder", { id: "t", notifiedAt: 2000 }));
    expect(invoke).not.toHaveBeenCalledWith("tasks_set_completed", expect.anything());
    await waitFor(() => expect(screen.queryByText(task.title)).not.toBeInTheDocument());
    expect(useTasksStore.getState().tasks).toEqual([rescheduled]);
  });
  it("listens before ready, deduplicates repeated snapshots, and acks only after dismissal", async () => {
    let receive!: (event: { payload: api.Task[] }) => void;
    const stop = vi.fn();
    vi.mocked(listen).mockImplementation(async (_name, callback) => { receive = callback as typeof receive; return stop; });
    vi.mocked(invoke).mockResolvedValue(undefined);
    const view = render(<TaskReminders />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("tasks_reminders_ready"));
    expect(listen).toHaveBeenCalledWith("tasks:due", expect.any(Function));
    const pending = { ...task, notifiedAt: 2000, reminderPending: true };
    act(() => { receive({ payload: [pending] }); receive({ payload: [pending] }); });
    expect(screen.getAllByText(task.title)).toHaveLength(1);
    expect(screen.getByRole("complementary", { name: "待办到期提醒" }).querySelector("header")).toBeTruthy();
    expect(screen.getByRole("button", { name: "标记完成" })).toHaveClass("bg-accent", "text-accent-fg");
    expect(screen.getByRole("button", { name: "知道了" })).toHaveClass("border-line", "text-ink");
    expect(invoke).not.toHaveBeenCalledWith("tasks_ack_reminder", expect.anything());
    vi.mocked(invoke).mockRejectedValueOnce("ack failed");
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ack failed");
    expect(screen.getByText(task.title)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    await waitFor(() => expect(screen.queryByText(task.title)).not.toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith("tasks_ack_reminder", { id: "t", notifiedAt: 2000 });
    view.unmount(); expect(stop).toHaveBeenCalled();
  });
});
