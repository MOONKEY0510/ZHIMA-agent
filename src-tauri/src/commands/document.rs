//! Document parsing for composer attachments (P1-8).
//!
//! The frontend picks a file with the native dialog and hands the path here;
//! the extracted text is folded into the message content by the frontend (so
//! exports, search and persistence keep working unchanged) and only the
//! metadata is stored on the message row.

use serde::Serialize;

use crate::tools::document_parse::{
    extract, is_supported, truncate_chars, MAX_DOCUMENT_BYTES, MAX_TEXT_CHARS,
};

/// Characters taken from one attachment.  Longer documents are cut here — the
/// agent's `read_document` tool can read the full text on demand.
const MAX_ATTACHMENT_CHARS: usize = 30_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPreview {
    pub name: String,
    /// Characters actually returned (after truncation).
    pub chars: usize,
    /// Characters in the whole document (before truncation).
    pub total_chars: usize,
    pub truncated: bool,
    pub text: String,
}

/// Parse a document the user attached in the composer.
#[tauri::command]
pub async fn parse_document_preview(path: String) -> Result<DocumentPreview, String> {
    let path = std::path::PathBuf::from(path.trim());
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document")
        .to_string();
    if !is_supported(&name) {
        return Err(format!("暂不支持该文件类型：{name}"));
    }

    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("读取文件信息失败：{e}"))?;
    if !metadata.is_file() {
        return Err("选择的路径不是文件".into());
    }
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err("文档不能超过 20 MiB".into());
    }

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("读取文件失败：{e}"))?;
    let name_for_parse = name.clone();
    // Parsing is CPU-bound: keep it off the async worker.
    let full = tokio::task::spawn_blocking(move || extract(&name_for_parse, &bytes))
        .await
        .map_err(|e| format!("文档解析失败：{e}"))??;

    if full.trim().is_empty() {
        return Err("未能从文档中提取到文字（可能是扫描件或纯图片文档）".into());
    }

    let total_chars = full.chars().count();
    // Attachment budget is smaller than the tool's; keep the head of the doc.
    let (text, truncated) = truncate_chars(&full, MAX_ATTACHMENT_CHARS.min(MAX_TEXT_CHARS));

    Ok(DocumentPreview {
        name,
        chars: text.chars().count(),
        total_chars,
        truncated,
        text,
    })
}
