//! User-mediated local text file selection and reading.

use super::ToolDefinition;
use crate::tools::registry::DataAccess;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const MAX_FILE_BYTES: u64 = 1_048_576;

pub fn definition() -> ToolDefinition {
    ToolDefinition {
        name: "select_and_read_text_file".into(),
        description:
            "打开文件选择器，让用户选择一个文本文件并读取其内容。不能读取模型自行指定的任意路径。"
                .into(),
        parameters: json!({ "type": "object", "properties": {} }),
        risk_level: "sensitive_read".into(),
        requires_confirmation: true,
        timeout_ms: 10_000,
        max_result_bytes: 1_100_000,
        data_access: DataAccess::LocalSensitive,
        network_access: false,
    }
}

fn allowed_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "txt"
            | "md"
            | "markdown"
            | "json"
            | "yaml"
            | "yml"
            | "toml"
            | "xml"
            | "csv"
            | "log"
            | "rs"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "css"
            | "html"
            | "vue"
            | "py"
            | "java"
            | "c"
            | "cpp"
            | "h"
            | "hpp"
            | "sql"
            | "env"
    )
}

pub async fn run() -> Result<Value, String> {
    let path: Option<PathBuf> = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择要读取的文本文件")
            .pick_file()
    })
    .await
    .map_err(|e| format!("文件选择失败: {e}"))?;
    let path = path.ok_or("用户取消了文件选择")?;
    if !allowed_extension(&path) {
        return Err("只支持常见文本、代码、配置和日志文件".into());
    }
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("读取文件信息失败: {e}"))?;
    if !metadata.is_file() {
        return Err("选择的路径不是文件".into());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("文件不能超过 1 MiB".into());
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("读取文件失败: {e}"))?;
    let text = String::from_utf8(bytes).map_err(|_| "文件不是有效的 UTF-8 文本".to_string())?;
    Ok(
        json!({ "name": path.file_name().and_then(|n| n.to_str()).unwrap_or("file"), "path": path.to_string_lossy(), "text": text }),
    )
}
