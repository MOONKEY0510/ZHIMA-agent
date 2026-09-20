//! Assistants (P1-7).
//!
//! An assistant bundles a role: a system prompt, an optional model binding and
//! suggested tool policies.  Built-ins ship with the app and are seeded into
//! SQLite on startup (id-prefixed, undeletable, restorable); users can edit
//! them or create their own.

use serde::{Deserialize, Serialize};

/// Prefix of a built-in assistant id.  Built-ins cannot be deleted, only
/// reset to their shipped definition.
pub const BUILTIN_PREFIX: &str = "assistant.builtin.";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assistant {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub system_prompt: String,
    /// Pinned provider/model; `None` follows the global default selection.
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model_key: Option<String>,
    /// Suggested tool policies (JSON object: tool name -> "allow" | "confirm").
    #[serde(default)]
    pub tool_policies_json: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Assistant {
    pub fn is_builtin(&self) -> bool {
        self.id.starts_with(BUILTIN_PREFIX)
    }
}

/// One built-in definition (id suffix, name, icon, description, prompt, tool
/// suggestions as `(tool, policy)` pairs).
struct BuiltinDef {
    id: &'static str,
    name: &'static str,
    icon: &'static str,
    description: &'static str,
    system_prompt: &'static str,
    tools: &'static [(&'static str, &'static str)],
}

const BUILTINS: &[BuiltinDef] = &[
    BuiltinDef {
        id: "default",
        name: "通用助手",
        icon: "💬",
        description: "平衡、简洁的日常问答助手，适合大多数场景。",
        system_prompt:
            "你是一个轻量可靠的桌面助手，用中文回答，默认简洁，避免冗长。回答时给出结论、理由和必要的操作步骤。",
        tools: &[
            ("get_current_time", "allow"),
            ("calculate", "allow"),
            ("web_search", "confirm"),
        ],
    },
    BuiltinDef {
        id: "researcher",
        name: "研究助手",
        icon: "🔍",
        description: "擅长联网检索、汇总资料、整理来源，适合调研类任务。",
        system_prompt:
            "你是一个专业的研究助手。回答问题时优先使用联网搜索获取最新信息，标注信息来源，区分事实与推断。输出结构：核心结论 → 分点论据 → 信息来源 → 局限说明。保持客观。",
        tools: &[
            ("web_search", "allow"),
            ("fetch_webpage", "confirm"),
            ("get_current_time", "allow"),
        ],
    },
    BuiltinDef {
        id: "writer",
        name: "写作助手",
        icon: "✍️",
        description: "擅长改写润色、文案创作、邮件和长文起草。",
        system_prompt:
            "你是一个资深的中文写作助手。根据用户需求提供高质量文案：中文书面语，逻辑清晰，用词准确。需要改写时保持原意，可同时提供『正式版』与『口语版』两种风格。",
        tools: &[("write_clipboard", "confirm"), ("read_clipboard", "confirm")],
    },
    BuiltinDef {
        id: "coder",
        name: "编程助手",
        icon: "👨‍💻",
        description: "代码解释、调试、重构建议与示例代码。",
        system_prompt:
            "你是一个严谨的编程助手。回答代码问题时：先给出思路，再给出可直接运行的代码片段；说明关键点；指出潜在边界条件和常见错误。保持代码简洁，使用中文注释。",
        tools: &[("calculate", "allow")],
    },
    BuiltinDef {
        id: "translator",
        name: "翻译助手",
        icon: "🌐",
        description: "中英互译，保留格式，适合粘贴原文翻译。",
        system_prompt:
            "你是一个专业的翻译助手。将用户内容翻译成指定语言（默认简体中文），忠实传达原意，保留原文结构与格式。术语准确，专有名词按惯例处理并可在括号内附原文。",
        tools: &[("read_clipboard", "allow"), ("write_clipboard", "allow")],
    },
    BuiltinDef {
        id: "meeting",
        name: "会议纪要",
        icon: "📋",
        description: "整理会议要点、待办事项与结论。",
        system_prompt:
            "你是一个高效的会议记录助手。将会议内容整理为结构化纪要：会议主题 → 关键讨论 → 决议结论 → 待办事项（负责人与期限）→ 下次跟进。条目化，避免冗余。",
        tools: &[("get_current_time", "allow")],
    },
];

/// The shipped assistants, stamped with `now` (used when seeding a fresh
/// database).
pub fn builtin_assistants(now: i64) -> Vec<Assistant> {
    BUILTINS
        .iter()
        .enumerate()
        .map(|(index, def)| Assistant {
            id: format!("{BUILTIN_PREFIX}{}", def.id),
            name: def.name.to_string(),
            icon: Some(def.icon.to_string()),
            description: Some(def.description.to_string()),
            system_prompt: def.system_prompt.to_string(),
            provider_id: None,
            model_key: None,
            tool_policies_json: tool_suggestions_json(def.tools),
            sort_order: index as i64,
            created_at: now,
            updated_at: now,
        })
        .collect()
}

/// The shipped definition of one built-in, if the id names a built-in.
pub fn builtin_by_id(id: &str, now: i64) -> Option<Assistant> {
    builtin_assistants(now).into_iter().find(|a| a.id == id)
}

/// Serialize tool suggestions as a JSON object, or `None` when empty.
fn tool_suggestions_json(tools: &[(&str, &str)]) -> Option<String> {
    if tools.is_empty() {
        return None;
    }
    let map: serde_json::Map<String, serde_json::Value> = tools
        .iter()
        .map(|(name, policy)| ((*name).to_string(), serde_json::json!(policy)))
        .collect();
    Some(serde_json::Value::Object(map).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtins_are_prefixed_and_ordered() {
        let list = builtin_assistants(0);
        assert_eq!(list.len(), 6);
        assert!(list.iter().all(|a| a.is_builtin()));
        assert_eq!(list[0].id, "assistant.builtin.default");
        assert_eq!(list[0].sort_order, 0);
        assert_eq!(list[5].sort_order, 5);
        assert!(list.iter().all(|a| !a.system_prompt.trim().is_empty()));
    }

    #[test]
    fn tool_suggestions_serialize_as_json_object() {
        let list = builtin_assistants(0);
        let default = &list[0];
        let json = default.tool_policies_json.as_deref().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(parsed["web_search"], serde_json::json!("confirm"));
        assert_eq!(parsed["calculate"], serde_json::json!("allow"));
    }

    #[test]
    fn builtin_lookup_by_id() {
        assert!(builtin_by_id("assistant.builtin.coder", 1).is_some());
        assert!(builtin_by_id("assistant-123", 1).is_none());
        assert!(!builtin_assistants(0)[0].id.starts_with("assistant-"));
    }
}
