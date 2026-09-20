//! User-mediated document reading (P1-8): Word / Excel / PowerPoint / PDF /
//! plain text.  Like `read_pdf`, the path always comes from a file picker — the
//! model can never name a path itself.

use super::ToolDefinition;
use crate::tools::document_parse::{self, MAX_DOCUMENT_BYTES, MAX_TEXT_CHARS};
use crate::tools::registry::DataAccess;
use serde_json::{json, Value};
use std::path::PathBuf;

/// Extensions offered in the picker (and accepted by the parser).
const DOCUMENT_EXTENSIONS: &[&str] = &[
    "docx", "xlsx", "xlsm", "pptx", "pdf", "txt", "md", "csv", "json", "log",
];

pub fn definition() -> ToolDefinition {
    ToolDefinition {
        name: "read_document".into(),
        description:
            "打开文件选择器，让用户选择一个文档（Word / Excel / PowerPoint / PDF / 文本）并提取其中的文字，用于总结或问答。表格按制表符分列，幻灯片按页分隔，不做 OCR。"
                .into(),
        parameters: json!({ "type": "object", "properties": {} }),
        risk_level: "sensitive_read".into(),
        requires_confirmation: true,
        timeout_ms: 30_000,
        max_result_bytes: 400_000,
        data_access: DataAccess::LocalSensitive,
        network_access: false,
    }
}

pub async fn run() -> Result<Value, String> {
    let path: Option<PathBuf> = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择要读取的文档")
            .add_filter("文档", DOCUMENT_EXTENSIONS)
            .add_filter("所有文件", &["*"])
            .pick_file()
    })
    .await
    .map_err(|e| format!("文档选择失败: {e}"))?;
    let path = path.ok_or("用户取消了文档选择")?;

    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document")
        .to_string();
    if !document_parse::is_supported(&name) {
        return Err(format!("暂不支持该文件类型：{name}"));
    }

    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("读取文件信息失败: {e}"))?;
    if !metadata.is_file() {
        return Err("选择的路径不是文件".into());
    }
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err("文档不能超过 20 MiB".into());
    }

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("读取文件失败: {e}"))?;
    let name_for_parse = name.clone();
    let text =
        tokio::task::spawn_blocking(move || document_parse::extract(&name_for_parse, &bytes))
            .await
            .map_err(|e| format!("文档解析失败: {e}"))??;

    let (text, truncated) = document_parse::truncate_chars(&text, MAX_TEXT_CHARS);
    if text.trim().is_empty() {
        return Err("未能从文档中提取到文字（可能是扫描件或纯图片文档）".into());
    }

    Ok(json!({
        "name": name,
        "path": path.to_string_lossy(),
        "chars": text.chars().count(),
        "truncated": truncated,
        "text": text,
    }))
}
