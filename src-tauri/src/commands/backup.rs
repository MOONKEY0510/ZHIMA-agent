//! Data backup: export / import of conversations, memories and images (P0-4).
//!
//! The frontend picks the file path with the native dialog (`plugin-dialog`);
//! these commands do the file I/O and the database work.  API keys are **not**
//! part of a backup — they live in the Windows Credential Manager and must be
//! re-entered on a new machine.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::storage::database::{
    BackupFile, Database, ImportReport, ImportStrategy, BACKUP_APP_MARKER, BACKUP_FORMAT_VERSION,
};

/// Export options chosen in the settings panel.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    /// Generated images are base64 payloads and can make the file large.
    #[serde(default)]
    pub include_images: bool,
    #[serde(default = "default_true")]
    pub include_memories: bool,
}

fn default_true() -> bool {
    true
}

/// What an export produced.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub path: String,
    pub conversations: usize,
    pub messages: usize,
    pub memories: usize,
    pub images: usize,
    pub skills: usize,
    pub bytes: u64,
}

/// Write a backup file to `path` (chosen via the native save dialog).
#[tauri::command]
pub fn export_data(
    db: State<'_, Database>,
    path: String,
    options: ExportOptions,
) -> Result<ExportReport, String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("请选择导出文件位置".into());
    }

    let mut backup = db.export_backup(options.include_images)?;
    if !options.include_memories {
        backup.memories.clear();
    }

    let json =
        serde_json::to_string_pretty(&backup).map_err(|e| format!("生成备份内容失败：{e}"))?;
    std::fs::write(&path, json.as_bytes()).map_err(|e| format!("写入备份文件失败：{e}"))?;

    Ok(ExportReport {
        path,
        conversations: backup.conversations.len(),
        messages: backup.conversations.iter().map(|c| c.messages.len()).sum(),
        memories: backup.memories.len(),
        images: backup.image_generations.len(),
        skills: backup.skills.len(),
        bytes: json.len() as u64,
    })
}

/// Summary shown to the user before an import is confirmed.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreview {
    pub exported_at: i64,
    pub format_version: u32,
    pub conversations: usize,
    pub messages: usize,
    pub memories: usize,
    pub images: usize,
    pub skills: usize,
}

/// Read + validate a backup file (shared by preview and import).
fn read_backup(path: &str) -> Result<BackupFile, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("请选择备份文件".into());
    }
    let raw = std::fs::read_to_string(path).map_err(|e| format!("读取备份文件失败：{e}"))?;
    let backup: BackupFile = serde_json::from_str(&raw)
        .map_err(|_| "无法解析备份文件（不是有效的芝麻备份）".to_string())?;

    if backup.app != BACKUP_APP_MARKER {
        return Err("这不是芝麻的备份文件".into());
    }
    if backup.format_version > BACKUP_FORMAT_VERSION {
        return Err(format!(
            "备份文件版本（v{}）高于当前应用支持的版本（v{BACKUP_FORMAT_VERSION}），请先升级应用",
            backup.format_version
        ));
    }
    Ok(backup)
}

#[tauri::command]
pub fn preview_backup(path: String) -> Result<BackupPreview, String> {
    let backup = read_backup(&path)?;
    Ok(BackupPreview {
        exported_at: backup.exported_at,
        format_version: backup.format_version,
        conversations: backup.conversations.len(),
        messages: backup.conversations.iter().map(|c| c.messages.len()).sum(),
        memories: backup.memories.len(),
        images: backup.image_generations.len(),
        skills: backup.skills.len(),
    })
}

/// Import a backup file.  `strategy` is `merge` or `replace`.
#[tauri::command]
pub fn import_data(
    db: State<'_, Database>,
    path: String,
    strategy: String,
) -> Result<ImportReport, String> {
    let strategy = ImportStrategy::parse(&strategy).ok_or_else(|| "无效的导入方式".to_string())?;
    let backup = read_backup(&path)?;
    db.import_backup(&backup, strategy)
}
