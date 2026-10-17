//! Local tasks and an in-process reminder loop (not an OS notification service).
use crate::storage::database::{
    tasks::{Task, TaskDraft},
    Database,
};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager, State};

#[derive(Default)]
pub struct TaskReminderState {
    ready: AtomicBool,
}

#[tauri::command]
pub fn tasks_list(db: State<'_, Database>) -> Result<Vec<Task>, String> {
    db.list_tasks()
}
#[tauri::command]
pub fn tasks_upsert(db: State<'_, Database>, draft: TaskDraft) -> Result<Task, String> {
    db.upsert_task(draft)
}
#[tauri::command]
pub fn tasks_set_completed(
    db: State<'_, Database>,
    id: String,
    completed: bool,
) -> Result<Task, String> {
    db.set_task_completed(&id, completed)
}
#[tauri::command]
pub fn tasks_complete_reminder(
    db: State<'_, Database>,
    id: String,
    notified_at: i64,
) -> Result<Option<Task>, String> {
    db.complete_task_reminder(&id, notified_at)
}
#[tauri::command]
pub fn tasks_delete(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_task(&id)
}
#[tauri::command]
pub fn tasks_claim_due(db: State<'_, Database>) -> Result<Vec<Task>, String> {
    db.claim_due_tasks(chrono::Utc::now().timestamp_millis())
}
#[tauri::command]
pub fn tasks_ack_reminder(
    db: State<'_, Database>,
    id: String,
    notified_at: i64,
) -> Result<(), String> {
    db.ack_task_reminder(&id, notified_at)
}
#[tauri::command]
pub fn tasks_reminders_ready(state: State<'_, TaskReminderState>) {
    state.ready.store(true, Ordering::Release);
}

/// Call ONCE in setup, after app.manage(db). Rust timers keep ticking when the
/// webview is hidden. Closing/quitting the process stops reminders; next launch
/// catches up overdue tasks. The UI must listen to `tasks:due` before ready.
/// A persisted outbox is cleared ONLY by explicit UI dismissal/completion.
/// emit/show failures, webview reloads, and process crashes therefore retry.
pub fn start_task_reminders(app: tauri::AppHandle) {
    app.manage(TaskReminderState::default());
    tauri::async_runtime::spawn(async move {
        let mut shown = std::collections::HashSet::new();
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
        loop {
            interval.tick().await;
            if !app
                .state::<TaskReminderState>()
                .ready
                .load(Ordering::Acquire)
            {
                continue;
            }
            let db = app.state::<Database>();
            if let Err(error) = db.claim_due_tasks(chrono::Utc::now().timestamp_millis()) {
                eprintln!("task reminder claim failed: {error}");
                continue;
            }
            let pending = match db.pending_task_reminders() {
                Ok(tasks) => tasks,
                Err(error) => {
                    eprintln!("task reminder read failed: {error}");
                    continue;
                }
            };
            shown.retain(|token| {
                pending
                    .iter()
                    .any(|task| token == &(task.id.clone(), task.notified_at))
            });
            let Some(window) = app.get_webview_window("main") else {
                continue;
            };
            let unseen = pending
                .iter()
                .any(|task| !shown.contains(&(task.id.clone(), task.notified_at)));
            if unseen {
                // Use the app's show path: unminimize, restore onscreen position,
                // and emit window-shown so the UI exits its hidden animation.
                crate::window::manager::show_and_focus(&window);
                if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(true) {
                    continue;
                }
            }
            // Re-emit pending items even if previously shown: the webview may
            // have reloaded, or a previous emit reached no live listener.
            if let Err(error) = window.emit("tasks:due", &pending) {
                eprintln!("task reminder delivery failed: {error}");
                continue;
            }
            shown.extend(
                pending
                    .iter()
                    .map(|task| (task.id.clone(), task.notified_at)),
            );
        }
    });
}
