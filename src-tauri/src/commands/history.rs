//! Conversation history commands (v0.3).
//!
//! The frontend drives persistence explicitly: user messages and assistant
//! placeholders are saved when a request starts, and the final content is
//! upserted once the stream settles. When history recording is disabled in
//! settings the frontend simply never calls these commands.

use tauri::State;

use crate::storage::database::{Conversation, Database, Message};

/// Sidebar payload: recent conversations, newest first.
#[tauri::command]
pub fn list_conversations(db: State<'_, Database>) -> Result<Vec<Conversation>, String> {
    db.list_conversations(200)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDetail {
    pub conversation: Conversation,
    pub messages: Vec<Message>,
}

#[tauri::command]
pub fn get_conversation(db: State<'_, Database>, id: String) -> Result<ConversationDetail, String> {
    let conversation = db
        .get_conversation(&id)?
        .ok_or_else(|| "会话不存在".to_string())?;
    let messages = db.list_messages(&id)?;
    Ok(ConversationDetail {
        conversation,
        messages,
    })
}

#[tauri::command]
pub fn create_conversation(
    db: State<'_, Database>,
    conv: Conversation,
) -> Result<Conversation, String> {
    if conv.id.trim().is_empty() || conv.title.trim().is_empty() {
        return Err("会话参数不完整".into());
    }
    db.create_conversation(&conv)?;
    Ok(conv)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginChatTurnArgs {
    pub conversation: Option<Conversation>,
    pub user_message: Message,
    pub assistant_message: Message,
    pub updated_at: i64,
    pub provider_id: Option<String>,
    pub model_key: Option<String>,
}

#[tauri::command]
pub fn begin_chat_turn(db: State<'_, Database>, args: BeginChatTurnArgs) -> Result<(), String> {
    if args.user_message.conversation_id.trim().is_empty()
        || args.user_message.conversation_id != args.assistant_message.conversation_id
    {
        return Err("聊天轮次参数不完整".into());
    }
    db.begin_chat_turn(
        args.conversation.as_ref(),
        &args.user_message,
        &args.assistant_message,
        args.updated_at,
        args.provider_id.as_deref(),
        args.model_key.as_deref(),
    )
}

#[tauri::command]
pub fn save_message(db: State<'_, Database>, msg: Message) -> Result<(), String> {
    if msg.conversation_id.trim().is_empty() {
        return Err("消息缺少会话 ID".into());
    }
    db.save_message(&msg)
}

#[tauri::command]
pub fn touch_conversation(
    db: State<'_, Database>,
    id: String,
    updated_at: i64,
    provider_id: Option<String>,
    model_key: Option<String>,
) -> Result<(), String> {
    db.touch_conversation(
        &id,
        updated_at,
        provider_id.as_deref(),
        model_key.as_deref(),
    )
}

#[tauri::command]
pub fn rename_conversation(
    db: State<'_, Database>,
    id: String,
    title: String,
) -> Result<(), String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("标题不能为空".into());
    }
    db.rename_conversation(&id, &title)
}

#[tauri::command]
pub fn delete_conversation(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_conversation(&id)
}

/// Set (or clear, when `system_prompt` is empty/null) the system prompt for a
/// single conversation.  This takes effect on the next chat turn in that
/// conversation.
#[tauri::command]
pub fn set_conversation_system_prompt(
    db: State<'_, Database>,
    id: String,
    system_prompt: Option<String>,
) -> Result<(), String> {
    let prompt = system_prompt
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    db.set_conversation_system_prompt(&id, prompt.as_deref())
}

#[tauri::command]
pub fn clear_all_history(db: State<'_, Database>) -> Result<(), String> {
    db.clear_all()
}
