//! Portable data backups, not system images. Configuration restoration is a
//! separate explicit operation: never claim atomicity across SQLite and JSON.
use crate::storage::config::ConfigStore;
use crate::storage::database::backup_config::PortableConfig;
use crate::storage::database::backup_files::{self, RestorePoint};
use crate::storage::database::{BackupFile, Database, ImportReport, ImportStrategy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use tauri::{Manager, State};

const EXCLUDED: &[&str] = &[
    "API Key、凭据管理器与代理认证",
    "MCP 启动命令、参数、环境变量与自动执行授权",
    "头像/背景二进制与本地图片路径",
    "窗口位置、快捷键与其他机器专属配置",
    "诊断运行日志",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    #[serde(default = "default_true")]
    pub include_images: bool,
    #[serde(default = "default_true")]
    pub include_memories: bool,
    #[serde(default)]
    pub include_config: bool,
    #[serde(default)]
    pub ui_preferences: Option<Value>,
}
fn default_true() -> bool {
    true
}

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
    pub assistants: usize,
    pub documents: usize,
    pub chunks: usize,
    pub summaries: usize,
    pub tasks: usize,
    pub has_config: bool,
    pub excluded: Vec<String>,
}
impl BackupPreview {
    fn of(backup: &BackupFile) -> Self {
        Self {
            exported_at: backup.exported_at,
            format_version: backup.format_version,
            conversations: backup.conversations.len(),
            messages: backup.conversations.iter().map(|c| c.messages.len()).sum(),
            memories: backup.memories.len(),
            images: backup.image_generations.len(),
            skills: backup.skills.len(),
            assistants: backup.assistants.len(),
            documents: backup.documents.len(),
            chunks: backup.chunks.len(),
            summaries: backup.summaries.len(),
            tasks: backup.tasks.len(),
            has_config: backup.config.is_some(),
            excluded: EXCLUDED.iter().map(|s| (*s).into()).collect(),
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub path: String,
    pub bytes: u64,
    #[serde(flatten)]
    pub manifest: BackupPreview,
}

#[tauri::command]
pub fn export_data(
    db: State<'_, Database>,
    config: State<'_, ConfigStore>,
    path: String,
    options: ExportOptions,
) -> Result<ExportReport, String> {
    let mut backup = db.export_backup(options.include_images)?;
    if !options.include_memories {
        backup.memories.clear();
    }
    if options.include_config {
        backup.config =
            Some(config.read(|cfg| PortableConfig::from_config(cfg, options.ui_preferences))?);
    }
    let bytes = backup_files::write_backup(Path::new(&path), &backup, true)?;
    Ok(ExportReport {
        path,
        bytes,
        manifest: BackupPreview::of(&backup),
    })
}

#[tauri::command]
pub fn preview_backup(path: String) -> Result<BackupPreview, String> {
    let backup = backup_files::read_backup(Path::new(&path))?;
    Ok(BackupPreview::of(&backup))
}

#[tauri::command]
pub fn import_data(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    config: State<'_, ConfigStore>,
    path: String,
    strategy: String,
) -> Result<ImportReport, String> {
    let strategy = ImportStrategy::parse(&strategy).ok_or("无效的导入方式")?;
    let backup = backup_files::read_backup(Path::new(&path))?;
    // Config is only offered back to the UI; DB success never silently writes it.
    // A pre-replace checkpoint failure is fatal. Automatic checkpoints do not
    // include UI preferences (owned by the frontend), explicitly disclosed there.
    let checkpoint_config = if strategy == ImportStrategy::Replace {
        Some(config.read(|cfg| PortableConfig::from_config(cfg, None))?)
    } else {
        None
    };
    db.import_backup_with_checkpoint(&backup, strategy, |snapshot| {
        let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let dir = backup_files::snapshots_dir(&root)?;
        let mut snapshot = snapshot.clone();
        snapshot.config = checkpoint_config;
        backup_files::create(&dir, &snapshot)?;
        Ok(())
    })
}

#[tauri::command]
pub fn create_restore_point(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    config: State<'_, ConfigStore>,
    options: Option<ExportOptions>,
) -> Result<RestorePoint, String> {
    let mut backup = db.export_backup(true)?;
    let prefs = options.and_then(|o| o.ui_preferences);
    backup.config = Some(config.read(|cfg| PortableConfig::from_config(cfg, prefs))?);
    let dir = backup_files::snapshots_dir(&app.path().app_data_dir().map_err(|e| e.to_string())?)?;
    backup_files::create(&dir, &backup)
}

#[tauri::command]
pub fn list_restore_points(app: tauri::AppHandle) -> Result<Vec<RestorePoint>, String> {
    let dir = backup_files::snapshots_dir(&app.path().app_data_dir().map_err(|e| e.to_string())?)?;
    backup_files::list(&dir)
}

#[tauri::command]
pub fn restore_backup_config(
    store: State<'_, ConfigStore>,
    config: PortableConfig,
) -> Result<Option<Value>, String> {
    config.restore(&store)
}
