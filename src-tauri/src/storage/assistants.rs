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
///
/// `icon` is a **vector-icon key** resolved by the frontend `AssistantIcon`
/// map (see `src/components/assistant/AssistantIcon.tsx`).  Legacy emoji
/// values from older databases are still rendered as text, and migration v18
/// rewrites the shipped emoji to these keys.
struct BuiltinDef {
    id: &'static str,
    name: &'static str,
    icon: &'static str,
    description: &'static str,
    system_prompt: &'static str,
    tools: &'static [(&'static str, &'static str)],
}

/// The shipped assistant set — one per universally common usage pattern of a
/// desktop assistant (everyday Q&A, translation, writing, coding, digesting
/// long content, web research).  Keep the set small and generic: personal or
/// niche workflows belong in user-created assistants.
const BUILTINS: &[BuiltinDef] = &[
    BuiltinDef {
        id: "default",
        name: "通用助手",
        icon: "sparkles",
        description: "日常问答：解释概念、给建议、查信息、草拟内容，什么都能问。",
        system_prompt:
            "你是一个通用、可靠的桌面助手。用中文回答，默认简洁直给：先给结论，再给必要的原因与步骤。问题含糊时先问一个关键澄清问题；不确定时明确说明，不编造事实。复杂任务按步骤或清单组织，能举例就举例。",
        tools: &[
            ("get_current_time", "allow"),
            ("calculate", "allow"),
            ("web_search", "confirm"),
        ],
    },
    BuiltinDef {
        id: "translator",
        name: "翻译助手",
        icon: "languages",
        description: "中英互译（及其他语种），保留格式与语气，适合粘贴原文直接翻译。",
        system_prompt:
            "你是一个翻译助手，负责在中文与英文之间互译（用户指定其他语言时按指定语言）。要求：忠实传达原意，不增删信息；保留原文的段落、列表与 Markdown 格式；术语按行业惯例处理，专有名词首次出现可在括号内附原文；直译生硬时给出自然表达。除用户要求外，不添加解释与评论。",
        tools: &[("read_clipboard", "allow"), ("write_clipboard", "allow")],
    },
    BuiltinDef {
        id: "writer",
        name: "写作助手",
        icon: "pen-line",
        description: "起草与润色：邮件、通知、方案、汇报、文案与长文改写。",
        system_prompt:
            "你是一个中文写作助手，擅长起草与打磨各类文字：邮件、通知、方案、汇报、文案。要求：默认使用规范书面语，逻辑清楚、用词准确；改写润色时保持原意与事实不变，只调整表达；需要时提供两种风格（如简洁版、正式版）供选择；缺少关键信息（对象、目的、场合、篇幅）时先问一句；不虚构数据与引用。",
        tools: &[("read_clipboard", "confirm"), ("write_clipboard", "confirm")],
    },
    BuiltinDef {
        id: "coder",
        name: "编程助手",
        icon: "code",
        description: "写代码、读代码、排查报错、解释技术概念。",
        system_prompt:
            "你是一个编程助手，擅长写代码、读代码、排查报错与解释技术概念，回答保持严谨：先给思路，再给可直接运行的代码；说明语言、版本与依赖假设；指出边界条件与常见陷阱；改动代码时给出最小必要修改并说明原因；调试问题时若缺少报错信息或环境信息，先索取；解释用中文，代码保持简洁可读。",
        tools: &[
            ("calculate", "allow"),
            ("read_clipboard", "confirm"),
            ("select_and_read_text_file", "confirm"),
        ],
    },
    BuiltinDef {
        id: "summarizer",
        name: "总结助手",
        icon: "book-open",
        description: "长文、文档、会议记录一键提炼：要点、结论与待办。",
        system_prompt:
            "你是一个信息提炼助手，把长文本压缩成可用的结论。输出结构：一句话结论 → 关键要点（分点） → 行动项（原文含待办、决议或期限时） → 关键数据（原文含数字时）。只依据原文，不添加原文没有的结论；要点按重要性排序；会议、访谈或聊天记录整理为『议题 - 结论 - 待办（负责人 / 期限）』；用户要求更长或更短时按需调整详略。",
        tools: &[("read_clipboard", "allow"), ("search_knowledge", "allow")],
    },
    BuiltinDef {
        id: "researcher",
        name: "研究助手",
        icon: "search",
        description: "联网检索、汇总资料、标注来源，适合需要最新信息的提问。",
        system_prompt:
            "你是一个研究助手，擅长联网检索与资料汇总。要求：涉及最新信息、价格、版本、政策等问题时优先联网搜索；标注信息来源，区分事实与推断；输出结构：核心结论 → 分点论据 → 来源 → 不确定或存在争议之处；多来源冲突时并列说明，不擅自取舍；无法核实的说法明确标注。",
        tools: &[
            ("web_search", "allow"),
            ("fetch_webpage", "confirm"),
            ("get_current_time", "allow"),
        ],
    },
];

/// Prompt prefixes of **previously shipped** built-in definitions, keyed by
/// assistant id.
///
/// On startup a built-in row is rewritten to the current shipped definition
/// only when its prompt still starts with one of these prefixes — i.e. the
/// user never edited it.  Append the outgoing prefix whenever a shipped prompt
/// changes; this list is append-only history and must never match the current
/// [`BUILTINS`] text (a test guards that).
pub const LEGACY_BUILTIN_PROMPTS: &[(&str, &str)] = &[
    ("assistant.builtin.default", "你是一个轻量可靠的桌面助手"),
    ("assistant.builtin.researcher", "你是一个专业的研究助手"),
    ("assistant.builtin.writer", "你是一个资深的中文写作助手"),
    ("assistant.builtin.coder", "你是一个严谨的编程助手"),
    ("assistant.builtin.translator", "你是一个专业的翻译助手"),
];

/// Built-ins that were shipped earlier but are **no longer part of the set**,
/// with the prompt prefix of their shipped definition.  A row still carrying
/// that prefix is removed on startup (its conversations fall back to the
/// global default); an edited row is kept as user data.
pub const RETIRED_BUILTINS: &[(&str, &str)] =
    &[("assistant.builtin.meeting", "你是一个高效的会议记录助手")];

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
        let ids: Vec<&str> = list.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "assistant.builtin.default",
                "assistant.builtin.translator",
                "assistant.builtin.writer",
                "assistant.builtin.coder",
                "assistant.builtin.summarizer",
                "assistant.builtin.researcher",
            ]
        );
        // Display order follows the shipped definition order.
        for (index, a) in list.iter().enumerate() {
            assert_eq!(a.sort_order, index as i64);
        }
        assert!(list.iter().all(|a| !a.system_prompt.trim().is_empty()));
        assert!(list
            .iter()
            .all(|a| !a.description.as_deref().unwrap_or("").trim().is_empty()));
    }

    #[test]
    fn builtin_icons_are_vector_keys() {
        // Keys must stay in sync with the frontend `AssistantIcon` map; an
        // unknown key would silently fall back to the default glyph.
        let expected = [
            "sparkles",
            "languages",
            "pen-line",
            "code",
            "book-open",
            "search",
        ];
        let icons: Vec<String> = builtin_assistants(0)
            .into_iter()
            .map(|a| a.icon.expect("builtin icons are always set"))
            .collect();
        assert_eq!(icons, expected);
    }

    #[test]
    fn legacy_prompt_prefixes_never_match_the_current_shipped_text() {
        // A stale prefix that still matched the shipped prompt would make the
        // startup refresh rewrite the row on every launch.
        for (id, prefix) in LEGACY_BUILTIN_PROMPTS {
            if let Some(current) = builtin_assistants(0).into_iter().find(|a| a.id == *id) {
                assert!(
                    !current.system_prompt.starts_with(prefix),
                    "legacy prefix for {id} still matches the shipped prompt"
                );
            }
        }
        for (id, prefix) in RETIRED_BUILTINS {
            assert!(
                builtin_by_id(id, 0).is_none(),
                "{id} is listed as retired but still shipped"
            );
            assert!(!prefix.trim().is_empty());
        }
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
