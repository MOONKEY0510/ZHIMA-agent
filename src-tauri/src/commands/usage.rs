//! Model usage statistics (v17).
//!
//! Exposes the aggregate view over the per-message token counters that
//! `save_message` persists, so the settings panel can chart cumulative
//! usage and the per-model breakdown.  Nothing here leaves the machine.

use tauri::State;

use crate::storage::database::{Database, UsageStats};

#[tauri::command]
pub fn get_usage_stats(db: State<'_, Database>) -> Result<UsageStats, String> {
    db.usage_stats()
}
