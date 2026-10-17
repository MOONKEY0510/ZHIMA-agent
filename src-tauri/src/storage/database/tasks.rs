//! User-confirmed tasks. All timestamps are Unix milliseconds.
use super::{now_ms, Database};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

pub const MIGRATION_SQL: &str = "CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 500),
    due_at INTEGER,
    completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
    source_conversation_id TEXT,
    source_message_id TEXT,
    notified_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    reminder_pending INTEGER NOT NULL DEFAULT 0 CHECK(reminder_pending IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(completed, due_at, notified_at);";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub due_at: Option<i64>,
    pub completed: bool,
    pub source_conversation_id: Option<String>,
    pub source_message_id: Option<String>,
    pub notified_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub reminder_pending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDraft {
    pub id: Option<String>,
    pub title: String,
    pub due_at: Option<i64>,
    pub source_conversation_id: Option<String>,
    pub source_message_id: Option<String>,
}

const COLUMNS: &str = "id,title,due_at,completed,source_conversation_id,source_message_id,notified_at,created_at,updated_at,reminder_pending";
fn row_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        title: row.get(1)?,
        due_at: row.get(2)?,
        completed: row.get(3)?,
        source_conversation_id: row.get(4)?,
        source_message_id: row.get(5)?,
        notified_at: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        reminder_pending: row.get(9)?,
    })
}

impl Database {
    pub fn list_tasks(&self) -> Result<Vec<Task>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM tasks ORDER BY completed, due_at IS NULL, due_at, created_at DESC")).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], row_task).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())
    }

    pub fn upsert_task(&self, draft: TaskDraft) -> Result<Task, String> {
        let title = draft.title.trim();
        if title.is_empty() || title.chars().count() > 500 {
            return Err("待办内容须为 1–500 字".into());
        }
        if draft
            .due_at
            .is_some_and(|n| !(0..=8_640_000_000_000_000).contains(&n))
        {
            return Err("提醒时间无效".into());
        }
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let now = now_ms();
        let id = if let Some(id) = draft.id {
            let count = tx
                .execute(
                    "UPDATE tasks SET title=?2,due_at=?3,
                notified_at=CASE WHEN due_at IS NOT ?3 THEN NULL ELSE notified_at END,
                reminder_pending=CASE WHEN due_at IS NOT ?3 THEN 0 ELSE reminder_pending END,
                updated_at=?4 WHERE id=?1",
                    params![id, title, draft.due_at, now],
                )
                .map_err(|e| e.to_string())?;
            if count == 0 {
                return Err("待办不存在或已被删除".into());
            }
            id
        } else {
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let id = format!("task-{now:x}-{:x}", SEQ.fetch_add(1, Ordering::Relaxed));
            tx.execute("INSERT INTO tasks (id,title,due_at,source_conversation_id,source_message_id,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)",
                params![id, title, draft.due_at, draft.source_conversation_id, draft.source_message_id, now]).map_err(|e| e.to_string())?;
            id
        };
        let task = tx
            .query_row(
                &format!("SELECT {COLUMNS} FROM tasks WHERE id=?1"),
                [&id],
                row_task,
            )
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(task)
    }

    pub fn set_task_completed(&self, id: &str, completed: bool) -> Result<Task, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("UPDATE tasks SET completed=?2, reminder_pending=CASE WHEN ?2 THEN 0 ELSE reminder_pending END, updated_at=?3 WHERE id=?1", params![id, completed, now_ms()]).map_err(|e| e.to_string())?;
        conn.query_row(
            &format!("SELECT {COLUMNS} FROM tasks WHERE id=?1"),
            [id],
            row_task,
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "待办不存在或已被删除".into())
    }

    /// Reminder snapshots may outlive a reschedule. Compare the claim token in
    /// the same SQL write so an old button cannot complete the new schedule.
    pub fn complete_task_reminder(
        &self,
        id: &str,
        notified_at: i64,
    ) -> Result<Option<Task>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            &format!(
                "UPDATE tasks SET completed=1, reminder_pending=0, updated_at=?3
                WHERE id=?1 AND notified_at=?2 AND reminder_pending=1 AND completed=0
                RETURNING {COLUMNS}"
            ),
            params![id, notified_at, now_ms()],
            row_task,
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn delete_task(&self, id: &str) -> Result<(), String> {
        self.conn
            .lock()
            .map_err(|e| e.to_string())?
            .execute("DELETE FROM tasks WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Atomic durable claim: only newly due rows are returned. Delivery failure
    /// does not lose them: pending rows remain until the UI acknowledges them.
    pub fn claim_due_tasks(&self, now: i64) -> Result<Vec<Task>, String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let tasks = {
            let mut stmt = tx.prepare(&format!("UPDATE tasks SET notified_at=?1, reminder_pending=1 WHERE completed=0 AND due_at<=?1 AND notified_at IS NULL RETURNING {COLUMNS}")).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([now], row_task).map_err(|e| e.to_string())?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?
        };
        tx.commit().map_err(|e| e.to_string())?;
        Ok(tasks)
    }

    pub fn pending_task_reminders(&self) -> Result<Vec<Task>, String> {
        Ok(self
            .list_tasks()?
            .into_iter()
            .filter(|task| task.reminder_pending && !task.completed)
            .collect())
    }

    /// Match the claim token so a stale dismissal cannot consume a rescheduled reminder.
    pub fn ack_task_reminder(&self, id: &str, notified_at: i64) -> Result<(), String> {
        self.conn
            .lock()
            .map_err(|e| e.to_string())?
            .execute(
                "UPDATE tasks SET reminder_pending=0 WHERE id=?1 AND notified_at=?2",
                params![id, notified_at],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Database {
        let db = Database::in_memory();
        db.conn
            .lock()
            .unwrap()
            .execute_batch(MIGRATION_SQL)
            .unwrap();
        db
    }
    fn draft(due_at: Option<i64>) -> TaskDraft {
        TaskDraft {
            id: None,
            title: " 用户确认的待办 ".into(),
            due_at,
            source_conversation_id: Some("conversation".into()),
            source_message_id: Some("answer".into()),
        }
    }
    #[test]
    fn crud_validation_and_sources() {
        let db = db();
        let task = db.upsert_task(draft(Some(10))).unwrap();
        assert_eq!(task.title, "用户确认的待办");
        assert_eq!(task.source_message_id.as_deref(), Some("answer"));
        assert!(db
            .upsert_task(TaskDraft {
                title: " ".into(),
                ..draft(None)
            })
            .is_err());
        assert!(db.upsert_task(draft(Some(-1))).is_err());
        assert!(db.set_task_completed(&task.id, true).unwrap().completed);
        db.delete_task(&task.id).unwrap();
        assert!(db.list_tasks().unwrap().is_empty());
        assert!(db
            .upsert_task(TaskDraft {
                id: Some(task.id),
                ..draft(None)
            })
            .is_err());
    }
    #[test]
    fn stale_reminder_cannot_complete_rescheduled_task() {
        let db = db();
        let task = db.upsert_task(draft(Some(10))).unwrap();
        db.claim_due_tasks(20).unwrap();
        db.upsert_task(TaskDraft {
            id: Some(task.id.clone()),
            ..draft(Some(30))
        })
        .unwrap();
        assert!(db.complete_task_reminder(&task.id, 20).unwrap().is_none());
        assert!(!db.list_tasks().unwrap()[0].completed);
        db.claim_due_tasks(40).unwrap();
        assert!(db.complete_task_reminder(&task.id, 20).unwrap().is_none());
        let current = &db.list_tasks().unwrap()[0];
        assert!(!current.completed);
        assert_eq!(current.notified_at, Some(40));
        assert!(current.reminder_pending);
        let completed = db.complete_task_reminder(&task.id, 40).unwrap().unwrap();
        assert!(completed.completed);
        assert!(!completed.reminder_pending);
        assert!(db.complete_task_reminder(&task.id, 40).unwrap().is_none());
        // Reopening from management must not make an old event actionable again.
        db.set_task_completed(&task.id, false).unwrap();
        assert!(db.complete_task_reminder(&task.id, 40).unwrap().is_none());
        assert!(!db.list_tasks().unwrap()[0].completed);
    }
    #[test]
    fn claims_are_atomic_and_delivery_survives_failure_until_ack() {
        let db = std::sync::Arc::new(db());
        db.upsert_task(draft(Some(10))).unwrap();
        db.upsert_task(draft(None)).unwrap();
        db.upsert_task(draft(Some(100))).unwrap();
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let db = db.clone();
                std::thread::spawn(move || db.claim_due_tasks(20).unwrap().len())
            })
            .collect();
        assert_eq!(
            workers
                .into_iter()
                .map(|w| w.join().unwrap())
                .sum::<usize>(),
            1
        );
        let pending = db.pending_task_reminders().unwrap();
        assert_eq!(pending.len(), 1);
        // Simulate a failed emit/restarted delivery loop: still pending, not reclaimed.
        assert!(db.claim_due_tasks(30).unwrap().is_empty());
        assert_eq!(db.pending_task_reminders().unwrap(), pending);
        db.ack_task_reminder(&pending[0].id, 19).unwrap();
        assert_eq!(db.pending_task_reminders().unwrap().len(), 1);
        db.ack_task_reminder(&pending[0].id, 20).unwrap();
        assert!(db.pending_task_reminders().unwrap().is_empty());
    }
    #[test]
    fn only_due_changes_reset_notification() {
        let db = db();
        let task = db.upsert_task(draft(Some(10))).unwrap();
        db.claim_due_tasks(20).unwrap();
        db.set_task_completed(&task.id, true).unwrap();
        db.set_task_completed(&task.id, false).unwrap();
        let edit = TaskDraft {
            id: Some(task.id.clone()),
            title: "改标题".into(),
            ..draft(Some(10))
        };
        assert_eq!(db.upsert_task(edit.clone()).unwrap().notified_at, Some(20));
        assert!(db.claim_due_tasks(30).unwrap().is_empty());
        assert_eq!(
            db.upsert_task(TaskDraft {
                due_at: Some(25),
                ..edit
            })
            .unwrap()
            .notified_at,
            None
        );
        assert_eq!(db.claim_due_tasks(30).unwrap().len(), 1);
        db.ack_task_reminder(&task.id, 20).unwrap();
        assert_eq!(db.pending_task_reminders().unwrap().len(), 1);
    }
    #[test]
    fn completed_and_unscheduled_tasks_do_not_remind() {
        let db = db();
        let task = db.upsert_task(draft(Some(10))).unwrap();
        db.set_task_completed(&task.id, true).unwrap();
        db.upsert_task(draft(None)).unwrap();
        assert!(db.claim_due_tasks(100).unwrap().is_empty());
        db.set_task_completed(&task.id, false).unwrap();
        assert_eq!(db.claim_due_tasks(100).unwrap().len(), 1);
        db.upsert_task(TaskDraft {
            id: Some(task.id),
            ..draft(None)
        })
        .unwrap();
        assert!(db.pending_task_reminders().unwrap().is_empty());
        assert!(db.claim_due_tasks(200).unwrap().is_empty());
    }
    #[test]
    fn outbox_and_unclaimed_overdue_survive_database_instance_restart() {
        let first = db();
        first.upsert_task(draft(Some(10))).unwrap();
        first.claim_due_tasks(20).unwrap();
        first.upsert_task(draft(Some(30))).unwrap();
        // Reconstruct the owner around the real in-memory SQLite connection:
        // notification delivery must depend on persisted rows, not Rust state.
        let restarted = Database {
            conn: first.conn,
            summary_generation: std::sync::atomic::AtomicU64::new(0),
        };
        assert_eq!(restarted.claim_due_tasks(100).unwrap().len(), 1);
        assert_eq!(restarted.pending_task_reminders().unwrap().len(), 2);
    }
    #[test]
    fn overdue_restart_and_camel_case() {
        let db = db();
        let task = db.upsert_task(draft(Some(1))).unwrap();
        let json = serde_json::to_value(&task).unwrap();
        assert!(json.get("dueAt").is_some());
        assert!(json.get("sourceConversationId").is_some());
        assert_eq!(db.claim_due_tasks(1_000).unwrap().len(), 1);
    }
}
