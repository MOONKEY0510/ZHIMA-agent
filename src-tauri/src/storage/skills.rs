//! User skills (自定义技能).
//!
//! A skill is a reusable instruction package the user writes once and the
//! assistant applies whenever it matches the request — a saved workflow such
//! as "把零散记录整理成周报" or "审查代码并给出修改建议".
//!
//! Injection is two-stage to keep token usage bounded (see
//! [`crate::agent::skills`]):
//! - every enabled skill contributes name + description to a prompt catalog;
//! - a skill's full `content` is injected only when its `triggers` appear in
//!   the latest user message, or when it has no triggers at all.
//!
//! Payloads are deliberately tolerant on deserialization (`#[serde(default)]`)
//! so a skill imported from an older or hand-written JSON file still loads.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

static SKILL_ID_SEQ: AtomicU64 = AtomicU64::new(0);

/// Mint an id for a user-created (or imported) skill.
pub fn new_skill_id() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = SKILL_ID_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("skill-{millis:x}-{seq:x}")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// The instruction body applied when the skill is active.
    #[serde(default)]
    pub content: String,
    /// Keywords that activate the skill, matched case-insensitively against
    /// the user message.  Empty = the skill is always active.
    #[serde(default)]
    pub triggers: Vec<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

fn default_enabled() -> bool {
    true
}

impl Skill {
    /// Whether this skill is active for `message` (the raw user message;
    /// matching is case-insensitive).  A skill without triggers is always
    /// active.
    pub fn is_active_for(&self, message: &str) -> bool {
        let message = message.to_lowercase();
        let triggers: Vec<String> = self
            .triggers
            .iter()
            .map(|t| t.trim().to_lowercase())
            .filter(|t| !t.is_empty())
            .collect();
        if triggers.is_empty() {
            return true;
        }
        triggers.iter().any(|t| message.contains(t.as_str()))
    }
}

/// A skill parsed from an imported file, before it becomes a stored row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillDraft {
    pub name: String,
    pub description: String,
    pub triggers: Vec<String>,
    pub content: String,
}

/// Parse a `SKILL.md`-style document into a skill draft.
///
/// Follows the Claude-Skills layout: an optional YAML frontmatter block with
/// `name`, `description` and `triggers`, followed by the instruction body.
/// `triggers` accepts either a comma-separated string
/// (`triggers: 周报, weekly`) or a `- item` list.
///
/// Without frontmatter, the file name (`fallback_name`) is used, and a
/// leading `# Title` line overrides it when present.
pub fn parse_skill_markdown(text: &str, fallback_name: &str) -> SkillDraft {
    let (frontmatter, body) = split_frontmatter(text);
    let mut name = fallback_name.trim().to_string();
    let mut description = String::new();
    let mut triggers: Vec<String> = Vec::new();

    if let Some(fm) = frontmatter {
        for (key, value) in frontmatter_fields(fm) {
            match key.as_str() {
                "name" if !value.is_empty() => name = value,
                "description" => description = value,
                "triggers" | "trigger" | "keywords" => triggers = split_triggers(&value),
                _ => {}
            }
        }
    } else if let Some(title) = body
        .lines()
        .find(|l| !l.trim().is_empty())
        .and_then(|l| l.trim().strip_prefix("# "))
    {
        if !title.trim().is_empty() {
            name = title.trim().to_string();
        }
    }

    SkillDraft {
        name,
        description,
        triggers,
        content: body.trim().to_string(),
    }
}

/// Split a free-form trigger string (`"周报，weekly; 汇报"`) into keywords.
pub fn split_triggers(value: &str) -> Vec<String> {
    value
        .split([',', '，', '、', ';', '；', '\n'])
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect()
}

/// Split a document into `(frontmatter, body)` when it opens with a `---`
/// block; otherwise `(None, text)`.  A UTF-8 BOM is tolerated.
fn split_frontmatter(text: &str) -> (Option<&str>, &str) {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Some(first_line_end) = text.find('\n') else {
        return (None, text);
    };
    if text[..first_line_end].trim() != "---" {
        return (None, text);
    }
    let rest = &text[first_line_end + 1..];
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim() == "---" {
            return (Some(&rest[..offset]), &rest[offset + line.len()..]);
        }
        offset += line.len();
    }
    // Unterminated frontmatter: treat the whole document as body.
    (None, text)
}

/// Minimal frontmatter reader: `key: value` pairs plus `- item` list entries
/// directly under a key.  Enough for `name` / `description` / `triggers`;
/// anything else (nested maps, comments) is ignored rather than erroring.
fn frontmatter_fields(text: &str) -> Vec<(String, String)> {
    let mut fields: Vec<(String, String)> = Vec::new();
    let mut current: Option<usize> = None;

    for raw in text.lines() {
        let line = raw.trim_end();
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        // List item belonging to the current key.
        if let Some(item) = line.trim().strip_prefix("- ") {
            if let Some(index) = current {
                let value = &mut fields[index].1;
                if !value.is_empty() {
                    value.push(',');
                }
                value.push_str(item.trim());
            }
            continue;
        }
        // Continuation lines (indented) are not supported.
        if line.starts_with(' ') || line.starts_with('\t') {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            let value = value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
            fields.push((key.trim().to_lowercase(), value));
            current = Some(fields.len() - 1);
        }
    }

    fields
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(triggers: &[&str]) -> Skill {
        Skill {
            id: "skill-1".into(),
            name: "周报助手".into(),
            description: "整理周报".into(),
            content: "把零散记录整理为结构化周报".into(),
            triggers: triggers.iter().map(|t| (*t).to_string()).collect(),
            enabled: true,
            sort_order: 0,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn deserialization_defaults_missing_fields() {
        // Minimal JSON (e.g. hand-written import) must load with safe values.
        let parsed: Skill =
            serde_json::from_str(r#"{"id":"s1","name":"x","createdAt":0,"updatedAt":0}"#).unwrap();
        assert!(parsed.enabled, "skills default to enabled");
        assert!(parsed.triggers.is_empty());
        assert_eq!(parsed.content, "");
    }

    #[test]
    fn serialization_uses_camel_case() {
        let json = serde_json::to_string(&skill(&["周报"])).unwrap();
        assert!(json.contains("\"sortOrder\""));
        assert!(json.contains("\"createdAt\""));
    }

    #[test]
    fn trigger_matching_is_substring_case_insensitive() {
        let s = skill(&["Weekly Report", "周报"]);
        assert!(s.is_active_for("帮我写个周报"));
        assert!(s.is_active_for("generate WEEKLY report please"));
        assert!(!s.is_active_for("帮我写个日报"));
    }

    #[test]
    fn skill_without_triggers_is_always_active() {
        assert!(skill(&[]).is_active_for("随便什么内容"));
        // Whitespace-only triggers behave like "no triggers".
        assert!(skill(&["  ", ""]).is_active_for("随便什么内容"));
    }

    #[test]
    fn partial_trigger_words_do_not_match() {
        let s = skill(&["代码审查"]);
        assert!(!s.is_active_for("审查一下这段代码"));
    }

    /* ---------------- SKILL.md parsing ---------------- */

    #[test]
    fn parses_claude_style_skill_markdown() {
        let text = "---\nname: pdf-processing\ndescription: 从 PDF 中提取文本与表格\ntriggers: pdf, 提取表格\n---\n\n# PDF 处理\n\n按以下步骤操作……\n";
        let draft = parse_skill_markdown(text, "fallback");
        assert_eq!(draft.name, "pdf-processing");
        assert_eq!(draft.description, "从 PDF 中提取文本与表格");
        assert_eq!(draft.triggers, vec!["pdf", "提取表格"]);
        assert!(draft.content.starts_with("# PDF 处理"));
        assert!(!draft.content.contains("---"));
    }

    #[test]
    fn parses_yaml_list_triggers() {
        let text = "---\nname: n\ntriggers:\n  - 周报\n  - weekly\n---\n正文";
        let draft = parse_skill_markdown(text, "fallback");
        assert_eq!(draft.triggers, vec!["周报", "weekly"]);
        assert_eq!(draft.content, "正文");
    }

    #[test]
    fn quoted_values_and_comments_are_handled() {
        let text = "---\n# 说明注释\nname: \"引号名称\"\ndescription: '单引号描述'\n---\nbody";
        let draft = parse_skill_markdown(text, "fallback");
        assert_eq!(draft.name, "引号名称");
        assert_eq!(draft.description, "单引号描述");
    }

    #[test]
    fn markdown_without_frontmatter_uses_heading_then_filename() {
        let with_heading = parse_skill_markdown("# 周报助手\n\n整理周报", "文件名");
        assert_eq!(with_heading.name, "周报助手");
        assert_eq!(with_heading.content, "# 周报助手\n\n整理周报");

        let plain = parse_skill_markdown("没有任何标题的正文", "文件名");
        assert_eq!(plain.name, "文件名");
        assert_eq!(plain.content, "没有任何标题的正文");
    }

    #[test]
    fn unterminated_frontmatter_is_treated_as_body() {
        let text = "---\nname: broken\n没有结束标记";
        let draft = parse_skill_markdown(text, "文件名");
        assert_eq!(draft.name, "文件名");
        assert!(draft.content.contains("name: broken"));
    }

    #[test]
    fn bom_and_crlf_frontmatter_parse() {
        let text = "\u{feff}---\r\nname: win\r\n\r\n---\r\n正文";
        let draft = parse_skill_markdown(text, "fallback");
        assert_eq!(draft.name, "win");
        assert_eq!(draft.content, "正文");
    }

    #[test]
    fn split_triggers_handles_mixed_separators() {
        assert_eq!(
            split_triggers("周报，weekly; 汇报、日报"),
            vec!["周报", "weekly", "汇报", "日报"]
        );
        assert!(split_triggers("   ").is_empty());
    }
}
