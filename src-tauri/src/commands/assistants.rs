//! Assistant presets (P1-7).
//!
//! Built-in assistants are seeded into SQLite at startup and can be edited but
//! not deleted; user-created ones are minted with an id here so the frontend
//! never has to invent identifiers.

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::State;

use crate::storage::assistants::Assistant;
use crate::storage::database::Database;

static ASSISTANT_SEQ: AtomicU64 = AtomicU64::new(0);

/// Mint an id for a user-created assistant.
fn new_assistant_id() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = ASSISTANT_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("assistant-{millis:x}-{seq:x}")
}

#[tauri::command]
pub fn list_assistants(db: State<'_, Database>) -> Result<Vec<Assistant>, String> {
    db.list_assistants()
}

/// Create (empty id) or update an assistant.
#[tauri::command]
pub fn upsert_assistant(
    db: State<'_, Database>,
    assistant: Assistant,
) -> Result<Assistant, String> {
    let mut assistant = assistant;
    if assistant.id.trim().is_empty() {
        assistant.id = new_assistant_id();
    }
    db.upsert_assistant(&assistant)
}

#[tauri::command]
pub fn delete_assistant(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_assistant(&id)
}

/// Restore a built-in assistant to its shipped definition.
#[tauri::command]
pub fn reset_builtin_assistant(db: State<'_, Database>, id: String) -> Result<Assistant, String> {
    db.reset_builtin_assistant(&id)
}
