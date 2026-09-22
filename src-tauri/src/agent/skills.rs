//! Skill injection (自定义技能).
//!
//! Skills reach the model in two stages so token usage stays bounded:
//! 1. the **catalog** — name + description + trigger hint of every enabled
//!    skill — is always present, so the model knows what is available;
//! 2. a skill's **full instruction body** is injected only when its trigger
//!    words appear in the latest user message (a skill without triggers is
//!    always active).
//!
//! The block is appended to the system prompt the same way the memory and
//! knowledge-base blocks are (see `commands::chat`).

use crate::storage::skills::Skill;

/// Char cap for the catalog section; keeps a large skill collection from
/// crowding out the conversation.
const MAX_CATALOG_CHARS: usize = 2_400;
/// Char cap for the active-instructions section.
const MAX_ACTIVE_CHARS: usize = 8_000;

/// Build the skills block appended to the system prompt.
///
/// `user_message` is the latest user message; triggers are matched against it
/// case-insensitively.  `forced_ids` name skills the user activated manually
/// in the composer: they are always active regardless of trigger-word
/// matching, while automatic matching still applies to the rest.  Returns
/// `None` when no skill is enabled.
pub fn build_skills_block_with_forced(
    skills: &[Skill],
    user_message: &str,
    forced_ids: &[String],
) -> Option<String> {
    let enabled: Vec<&Skill> = skills
        .iter()
        .filter(|s| s.enabled && !s.name.trim().is_empty() && !s.content.trim().is_empty())
        .collect();
    if enabled.is_empty() {
        return None;
    }

    let mut catalog = String::from("【可用技能】\n");
    let mut active = String::new();
    for skill in &enabled {
        let hints: Vec<&str> = skill
            .triggers
            .iter()
            .map(|t| t.trim())
            .filter(|t| !t.is_empty())
            .collect();
        let description = skill.description.trim();
        let label = if hints.is_empty() {
            skill.name.trim().to_string()
        } else {
            format!("{}（触发词：{}）", skill.name.trim(), hints.join("、"))
        };
        if description.is_empty() {
            catalog.push_str(&format!("- {label}\n"));
        } else {
            catalog.push_str(&format!("- {label}：{description}\n"));
        }

        let forced = forced_ids.iter().any(|id| id.trim() == skill.id);
        if forced || skill.is_active_for(user_message) {
            if !active.is_empty() {
                active.push('\n');
            }
            active.push_str(&format!(
                "【技能：{}】\n{}\n",
                skill.name.trim(),
                skill.content.trim()
            ));
        }
    }

    let mut block = truncate_chars(&catalog, MAX_CATALOG_CHARS);
    if !active.trim().is_empty() {
        block.push_str("\n当用户请求与上述技能匹配时，请严格遵循对应技能的说明执行：\n");
        block.push_str(&truncate_chars(&active, MAX_ACTIVE_CHARS));
    }
    Some(block.trim_end().to_string())
}

/// Truncate to a char budget, appending a marker when content was cut.
fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(max_chars).collect();
    cut.push_str("…（内容过长已截断）");
    cut
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Auto-matching only (no manually activated skills).
    fn build_skills_block(skills: &[Skill], message: &str) -> Option<String> {
        build_skills_block_with_forced(skills, message, &[])
    }

    fn skill(id: &str, name: &str, triggers: &[&str], content: &str) -> Skill {
        Skill {
            id: id.into(),
            name: name.into(),
            description: format!("{name}的描述"),
            content: content.into(),
            triggers: triggers.iter().map(|t| (*t).to_string()).collect(),
            enabled: true,
            sort_order: 0,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn no_skills_yields_none() {
        assert!(build_skills_block(&[], "你好").is_none());
    }

    #[test]
    fn disabled_skills_are_skipped() {
        let mut s = skill("s1", "周报助手", &["周报"], "整理周报");
        s.enabled = false;
        assert!(build_skills_block(&[s], "帮我写周报").is_none());
    }

    #[test]
    fn catalog_lists_name_description_and_triggers() {
        let block =
            build_skills_block(&[skill("s1", "周报助手", &["周报"], "x")], "今天天气如何").unwrap();
        assert!(block.contains("【可用技能】"));
        assert!(block.contains("- 周报助手（触发词：周报）：周报助手的描述"));
        // Not triggered: the body is absent.
        assert!(!block.contains("【技能：周报助手】"));
    }

    #[test]
    fn triggered_skill_injects_full_content() {
        let block = build_skills_block(
            &[
                skill("s1", "周报助手", &["周报"], "按 议题-结论-待办 结构输出"),
                skill("s2", "翻译助手", &["翻译"], "中英互译，保留格式"),
            ],
            "帮我把这些记录整理成周报",
        )
        .unwrap();
        assert!(block.contains("当用户请求与上述技能匹配时"));
        assert!(block.contains("【技能：周报助手】"));
        assert!(block.contains("按 议题-结论-待办 结构输出"));
        // The untriggered skill stays catalog-only.
        assert!(!block.contains("【技能：翻译助手】"));
    }

    #[test]
    fn skill_without_triggers_is_always_active() {
        let block = build_skills_block(
            &[skill("s1", "常驻规则", &[], "始终用简体中文")],
            "随便说点什么",
        )
        .unwrap();
        assert!(block.contains("【技能：常驻规则】"));
        assert!(block.contains("始终用简体中文"));
        // No trigger hint in the catalog line.
        assert!(block.contains("- 常驻规则：常驻规则的描述"));
    }

    #[test]
    fn trigger_match_is_case_insensitive() {
        let skills = vec![skill("s1", "Review", &["Code Review"], "be thorough")];
        assert!(build_skills_block(&skills, "please do a CODE review now")
            .unwrap()
            .contains("【技能：Review】"));
        assert!(!build_skills_block(&skills, "nothing relevant")
            .unwrap()
            .contains("【技能：Review】"));
    }

    #[test]
    fn forced_skill_is_injected_without_trigger_match() {
        let skills = vec![
            skill("s1", "周报助手", &["周报"], "整理周报的规则"),
            skill("s2", "翻译助手", &["翻译"], "翻译规则"),
        ];
        // No trigger in the message, but s2 is manually activated by id.
        let block = build_skills_block_with_forced(&skills, "今天天气如何", &["s2".to_string()])
            .expect("forced skill keeps the block alive");
        assert!(block.contains("【技能：翻译助手】"));
        assert!(block.contains("翻译规则"));
        assert!(!block.contains("【技能：周报助手】"));
    }

    #[test]
    fn forced_ids_are_trimmed_and_unknown_ids_ignored() {
        let skills = vec![skill("s1", "A", &["a"], "content A")];
        let block = build_skills_block_with_forced(
            &skills,
            "nothing relevant",
            &["  s1  ".to_string(), "missing".to_string()],
        )
        .unwrap();
        assert!(block.contains("【技能：A】"));
    }

    #[test]
    fn disabled_skill_cannot_be_forced() {
        let mut s = skill("s1", "禁用技能", &["x"], "不应注入");
        s.enabled = false;
        assert!(build_skills_block_with_forced(&[s], "任何内容", &["s1".into()]).is_none());
    }

    #[test]
    fn empty_content_skills_are_ignored() {
        let mut s = skill("s1", "空技能", &["空"], "   ");
        s.content = "   ".into();
        assert!(build_skills_block(&[s], "空的").is_none());
    }

    #[test]
    fn oversized_content_is_truncated() {
        let long = "很长的说明".repeat(3000);
        let block = build_skills_block(&[skill("s1", "长技能", &[], &long)], "你好").unwrap();
        assert!(block.contains("…（内容过长已截断）"));
        assert!(block.chars().count() < 12_000);
    }
}
