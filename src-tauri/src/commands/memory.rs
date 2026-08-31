//! Long-term memory commands (v2.0 phase 4).
//!
//! Memories are user-confirmed, locally stored and fully user-controllable:
//! list, create, edit, enable/disable, delete and clear-all are exposed as
//! Tauri commands.  Sensitive content (passwords, keys) is refused at write
//! time by `agent::memory::is_sensitive_content`.

use tauri::State;

use crate::agent::memory::is_sensitive_content;
use crate::storage::database::{Database, Memory};

#[tauri::command]
pub fn list_memories(db: State<'_, Database>) -> Result<Vec<Memory>, String> {
    db.list_memories()
}

/// Create a memory.  `id` is generated on the frontend (unique) or backend.
/// Sensitive content is rejected.  `source_conversation_id` /
/// `source_message_id` record where the memory came from when the user saved
/// it inline from a conversation (对话内记忆确认).
#[tauri::command]
pub fn create_memory(
    db: State<'_, Database>,
    id: String,
    category: String,
    content: String,
    source_conversation_id: Option<String>,
    source_message_id: Option<String>,
) -> Result<Memory, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("记忆内容不能为空".into());
    }
    if content.chars().count() > 500 {
        return Err("记忆内容过长（最多 500 字）".into());
    }
    if is_sensitive_content(content) {
        return Err("检测到疑似敏感信息（密码、密钥、证件号等），为避免泄露已拒绝保存。".into());
    }
    let category = if category.trim().is_empty() {
        "custom".to_string()
    } else {
        category.trim().to_string()
    };
    let now = chrono::Utc::now().timestamp_millis();
    let mem = Memory {
        id: if id.trim().is_empty() {
            uuid()
        } else {
            id.trim().to_string()
        },
        category,
        content: content.to_string(),
        keywords_json: None,
        sensitivity: "normal".into(),
        source_conversation_id,
        source_message_id,
        enabled: true,
        created_at: now,
        updated_at: now,
        last_used_at: None,
        use_count: 0,
    };
    db.create_memory(&mem)?;
    Ok(mem)
}

#[tauri::command]
pub fn update_memory(
    db: State<'_, Database>,
    id: String,
    content: String,
    category: String,
) -> Result<(), String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("记忆内容不能为空".into());
    }
    if is_sensitive_content(content) {
        return Err("检测到疑似敏感信息（密码、密钥、证件号等），为避免泄露已拒绝保存。".into());
    }
    let category = if category.trim().is_empty() {
        "custom".to_string()
    } else {
        category.trim().to_string()
    };
    db.update_memory(&id, content, &category)
}

#[tauri::command]
pub fn set_memory_enabled(
    db: State<'_, Database>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    db.set_memory_enabled(&id, enabled)
}

#[tauri::command]
pub fn delete_memory(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_memory(&id)
}

#[tauri::command]
pub fn clear_memories(db: State<'_, Database>) -> Result<(), String> {
    db.clear_memories()
}

fn uuid() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("mem-{millis:x}")
}
