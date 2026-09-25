//! User skills CRUD + import (自定义技能, v20).
//!
//! Thin wrappers over [`Database`]; ids for user-created skills are minted
//! here so the frontend never has to invent identifiers (same pattern as
//! [`super::assistants`]).
//!
//! Import accepts the standard `SKILL.md` layout (YAML frontmatter with
//! `name` / `description` / `triggers`), plain Markdown, JSON (single object,
//! array, or a backup payload with a `skills` array) and `.zip` packages
//! containing a `SKILL.md`.

use serde::Serialize;
use tauri::State;

use crate::storage::database::Database;
use crate::storage::skills::{new_skill_id, parse_skill_markdown, Skill, SkillDraft};

/// Caps for a `.zip` skill package: one Markdown instruction file is all a
/// skill needs, so anything larger is refused instead of being decompressed.
const MAX_SKILL_ZIP_ENTRIES: usize = 256;
const MAX_SKILL_ENTRY_BYTES: u64 = 2 * 1024 * 1024; // 2 MiB
const MAX_SKILL_TOTAL_BYTES: u64 = 8 * 1024 * 1024; // 8 MiB

#[tauri::command]
pub fn list_skills(db: State<'_, Database>) -> Result<Vec<Skill>, String> {
    db.list_skills()
}

/// Create (empty id) or update a skill; returns the stored row.
#[tauri::command]
pub fn upsert_skill(db: State<'_, Database>, skill: Skill) -> Result<Skill, String> {
    let mut skill = skill;
    if skill.id.trim().is_empty() {
        skill.id = new_skill_id();
    }
    db.upsert_skill(&skill)
}

#[tauri::command]
pub fn delete_skill(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_skill(&id)
}

/// Outcome of one import batch.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSkillsReport {
    /// Skills created from the imported files.
    pub created: usize,
    /// Existing skills updated because the file carried the same name.
    pub updated: usize,
    /// Per-file failures rendered as `path: reason`.
    pub failed: Vec<String>,
}

/// Import skills from files chosen in the native dialog.
#[tauri::command]
pub fn import_skill_files(
    db: State<'_, Database>,
    paths: Vec<String>,
) -> Result<ImportSkillsReport, String> {
    if paths.is_empty() {
        return Err("请选择要导入的技能文件".into());
    }

    let mut report = ImportSkillsReport::default();
    for path in &paths {
        let drafts = match read_drafts(path) {
            Ok(drafts) => drafts,
            Err(err) => {
                report.failed.push(format!("{}：{err}", file_label(path)));
                continue;
            }
        };
        if drafts.is_empty() {
            report
                .failed
                .push(format!("{}：未找到有效的技能定义", file_label(path)));
            continue;
        }
        for draft in drafts {
            match db.import_skill(&draft) {
                Ok(true) => report.created += 1,
                Ok(false) => report.updated += 1,
                Err(err) => report.failed.push(format!("{}：{err}", file_label(path))),
            }
        }
    }
    Ok(report)
}

/// Parse all skill drafts carried by one file (dispatched by extension).
fn read_drafts(path: &str) -> Result<Vec<SkillDraft>, String> {
    let lower = path.trim().to_ascii_lowercase();
    if lower.ends_with(".json") {
        read_json_skills(path)
    } else if lower.ends_with(".zip") {
        read_zip_skill(path)
    } else if lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".txt") {
        let text = std::fs::read_to_string(path).map_err(|e| format!("读取文件失败：{e}"))?;
        Ok(vec![parse_skill_markdown(&text, &file_stem(path))])
    } else {
        Err("仅支持 .md / .markdown / .txt / .json / .zip 文件".into())
    }
}

/// Skills from a JSON file: a single object, an array of objects, or a
/// backup payload carrying a `skills` array.
fn read_json_skills(path: &str) -> Result<Vec<SkillDraft>, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("读取文件失败：{e}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "JSON 解析失败".to_string())?;

    let items: Vec<serde_json::Value> = match value {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(mut map) => match map.remove("skills") {
            Some(serde_json::Value::Array(items)) => items,
            _ => vec![serde_json::Value::Object(map)],
        },
        _ => return Err("JSON 内容不是技能对象".into()),
    };

    Ok(items
        .iter()
        .filter_map(|item| {
            let name = item.get("name")?.as_str()?.trim();
            if name.is_empty() {
                return None;
            }
            Some(SkillDraft {
                name: name.to_string(),
                description: item
                    .get("description")
                    .and_then(|d| d.as_str())
                    .unwrap_or("")
                    .to_string(),
                triggers: item
                    .get("triggers")
                    .and_then(|t| t.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str())
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                            .collect()
                    })
                    .unwrap_or_default(),
                content: item
                    .get("content")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect())
}

/// Skill from a `.zip` package (Claude-Skills style): the first `SKILL.md`
/// inside, or the first Markdown file when none carries that name.
fn read_zip_skill(path: &str) -> Result<Vec<SkillDraft>, String> {
    use std::io::Read;

    let file = std::fs::File::open(path).map_err(|e| format!("打开压缩包失败：{e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|_| "不是有效的 zip 压缩包".to_string())?;

    if archive.len() > MAX_SKILL_ZIP_ENTRIES {
        return Err("压缩包内文件过多，无法作为技能导入".into());
    }

    let mut skill_md: Option<String> = None;
    let mut first_md: Option<String> = None;
    let mut total_bytes: u64 = 0;
    for index in 0..archive.len() {
        let Ok(mut entry) = archive.by_index(index) else {
            continue;
        };
        if !entry.is_file() {
            continue;
        }
        let entry_name = entry.name().to_string();
        let lower = entry_name.to_ascii_lowercase();
        if !(lower.ends_with(".md") || lower.ends_with(".markdown")) {
            continue;
        }
        // Skip oversized parts (declared or actual) instead of decompressing.
        if entry.size() > MAX_SKILL_ENTRY_BYTES {
            continue;
        }

        // Non-UTF-8 content degrades gracefully rather than failing the file.
        let mut bytes = Vec::new();
        if entry
            .by_ref()
            .take(MAX_SKILL_ENTRY_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() as u64 > MAX_SKILL_ENTRY_BYTES
        {
            continue;
        }
        total_bytes += bytes.len() as u64;
        if total_bytes > MAX_SKILL_TOTAL_BYTES {
            return Err("压缩包解压后过大，无法作为技能导入".into());
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();

        let file_name = entry_name.rsplit('/').next().unwrap_or("");
        if file_name.eq_ignore_ascii_case("skill.md") {
            skill_md = Some(text);
            break;
        }
        if first_md.is_none() {
            first_md = Some(text);
        }
    }

    let text = skill_md
        .or(first_md)
        .ok_or_else(|| "压缩包中没有 Markdown 技能文件".to_string())?;
    Ok(vec![parse_skill_markdown(&text, &file_stem(path))])
}

/// File name without directories or extension (used as the fallback name).
fn file_stem(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("导入的技能")
        .to_string()
}

/// File name for messages (full path is noisy in the UI).
fn file_label(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Write `content` to a temp file and return its path.
    fn temp_file(name: &str, content: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("cf-skill-import-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn reads_markdown_with_frontmatter() {
        let path = temp_file(
            "weekly.md",
            "---\nname: 周报助手\ntriggers: 周报, weekly\n---\n整理周报".as_bytes(),
        );
        let drafts = read_drafts(path.to_str().unwrap()).unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].name, "周报助手");
        assert_eq!(drafts[0].triggers, vec!["周报", "weekly"]);
        assert_eq!(drafts[0].content, "整理周报");
    }

    #[test]
    fn reads_plain_markdown_with_filename_fallback() {
        let path = temp_file("日报助手.md", "# 日报助手\n按项目分组".as_bytes());
        let drafts = read_drafts(path.to_str().unwrap()).unwrap();
        assert_eq!(drafts[0].name, "日报助手");
    }

    #[test]
    fn reads_json_array_and_backup_payload() {
        let array = temp_file(
            "skills.json",
            br#"[{"name":"A","content":"a","triggers":["x"]},{"name":"B","content":"b"}]"#,
        );
        let drafts = read_drafts(array.to_str().unwrap()).unwrap();
        assert_eq!(drafts.len(), 2);
        assert_eq!(drafts[0].name, "A");
        assert_eq!(drafts[0].triggers, vec!["x"]);

        let backup = temp_file(
            "backup.json",
            br#"{"app":"zhima","formatVersion":2,"skills":[{"name":"C","content":"c"}]}"#,
        );
        let drafts = read_drafts(backup.to_str().unwrap()).unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].name, "C");
    }

    #[test]
    fn reads_zip_with_skill_md_in_subdirectory() {
        use std::io::Write;

        let mut buf = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let options = zip::write::SimpleFileOptions::default();
            writer.start_file("my-skill/SKILL.md", options).unwrap();
            writer
                .write_all("---\nname: 压缩包技能\n---\n来自 zip".as_bytes())
                .unwrap();
            writer.finish().unwrap();
        }

        let path = temp_file("bundle.zip", &buf);
        let drafts = read_drafts(path.to_str().unwrap()).unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].name, "压缩包技能");
        assert_eq!(drafts[0].content, "来自 zip");
    }

    #[test]
    fn unsupported_extension_is_rejected() {
        let path = temp_file("skill.exe", b"nope");
        let err = read_drafts(path.to_str().unwrap()).unwrap_err();
        assert!(err.contains("仅支持"));
    }
}
