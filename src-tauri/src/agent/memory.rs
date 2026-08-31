//! Long-term memory retrieval and prompt injection.
//!
//! Memories are stored per-user (not per-conversation) in SQLite (v6) and are
//! only ever written after explicit user confirmation.  This module:
//!
//! - detects obviously sensitive content (passwords, keys, tokens) so it can
//!   be refused before saving;
//! - loads a bounded set of enabled memories (most-used first) for prompt
//!   injection;
//! - renders them into a clearly-labelled system-prompt block;
//! - records which memories were actually injected so the UI can surface
//!   "used N memories in this answer".

use crate::storage::database::{Database, Memory};

/// How many enabled memories are injected into a single request at most.
pub const MAX_MEMORIES_PER_REQUEST: usize = 10;

/// Patterns that make a memory candidate unacceptable to persist.
/// Covers credentials and secrets; the check is intentionally coarse — a
/// false positive is safer than silently storing a secret.
pub fn is_sensitive_content(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "password",
        "api_key",
        "apikey",
        "authorization",
        "secret",
        "private key",
        "token",
        "密码",
        "密钥",
        "api 密钥",
        "账号密码",
        "身份证",
        "银行卡",
        "验证码",
    ]
    .iter()
    .any(|pat| lower.contains(pat))
}

/// Load enabled memories (most-used first, bounded) for prompt injection.
pub fn load_for_prompt(db: &Database) -> Vec<Memory> {
    db.list_enabled_memories(MAX_MEMORIES_PER_REQUEST as u32)
        .unwrap_or_default()
}

/// Render memories into a system-prompt block.  Empty when there is nothing
/// to inject.  The block is explicitly labelled as background material.
pub fn format_memories(memories: &[Memory]) -> String {
    if memories.is_empty() {
        return String::new();
    }
    let mut out =
        String::from("【长期记忆（用户确认保存的个人信息，仅作参考，不得擅自修改或遗忘）】\n");
    for m in memories {
        out.push_str(&format!("- [{}] {}\n", m.category, m.content.trim()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitive_detection_catches_secrets() {
        assert!(is_sensitive_content("我的密码是 abc123"));
        assert!(is_sensitive_content("api_key = sk-xxxx"));
        assert!(is_sensitive_content("Authorization: Bearer abc"));
        assert!(is_sensitive_content("银行卡号 6222 0000 0000 0000"));
    }

    #[test]
    fn sensitive_detection_allows_benign_text() {
        assert!(!is_sensitive_content("我喜欢简洁的回答"));
        assert!(!is_sensitive_content("我住在北京，从事软件行业"));
    }

    #[test]
    fn format_memories_is_empty_when_none() {
        assert_eq!(format_memories(&[]), "");
    }

    #[test]
    fn format_memories_lists_entries() {
        let mem = Memory {
            id: "m1".into(),
            category: "preference".into(),
            content: "回答要简洁".into(),
            keywords_json: None,
            sensitivity: "normal".into(),
            source_conversation_id: None,
            source_message_id: None,
            enabled: true,
            created_at: 0,
            updated_at: 0,
            last_used_at: None,
            use_count: 0,
        };
        let text = format_memories(&[mem]);
        assert!(text.contains("[preference] 回答要简洁"));
        assert!(text.contains("长期记忆"));
    }
}
