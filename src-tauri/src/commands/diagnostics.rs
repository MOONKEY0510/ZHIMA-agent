//! Diagnostics commands (v2.0 phase 5).
//!
//! Exposes the redacted agent-run traces so users can see what the agent did
//! (model, status, error code, duration) and clear them.  No credentials or
//! message bodies are ever returned.

use tauri::State;

use crate::storage::database::Database;

#[tauri::command]
pub fn list_runs(
    db: State<'_, Database>,
    limit: Option<u32>,
) -> Result<Vec<serde_json::Value>, String> {
    db.list_runs(limit.unwrap_or(50))
}

#[tauri::command]
pub fn clear_runs(db: State<'_, Database>) -> Result<(), String> {
    db.clear_runs()
}
