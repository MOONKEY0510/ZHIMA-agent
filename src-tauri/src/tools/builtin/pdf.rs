//! User-mediated PDF text extraction.

use super::ToolDefinition;
use crate::tools::registry::DataAccess;
use serde_json::{json, Value};
use std::path::PathBuf;

const MAX_PDF_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

pub fn definition() -> ToolDefinition {
    ToolDefinition {
        name: "read_pdf".into(),
        description:
            "打开文件选择器，让用户选择一个 PDF 并提取其中的文本，用于总结或问答。当前不执行 OCR。"
                .into(),
        parameters: json!({ "type": "object", "properties": {} }),
        risk_level: "sensitive_read".into(),
        requires_confirmation: true,
        timeout_ms: 30_000,
        max_result_bytes: MAX_TEXT_BYTES,
        data_access: DataAccess::LocalSensitive,
        network_access: false,
    }
}

pub async fn run() -> Result<Value, String> {
    let path: Option<PathBuf> = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择要读取的 PDF")
            .add_filter("PDF 文件", &["pdf"])
            .pick_file()
    })
    .await
    .map_err(|e| format!("PDF 文件选择失败: {e}"))?;
    let path = path.ok_or("用户取消了 PDF 选择")?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("读取 PDF 信息失败: {e}"))?;
    if !metadata.is_file() {
        return Err("选择的路径不是文件".into());
    }
    if metadata.len() > MAX_PDF_BYTES {
        return Err("PDF 不能超过 20 MiB".into());
    }
    let path_for_extract = path.clone();
    let text = tokio::task::spawn_blocking(move || {
        pdf_extract::extract_text(&path_for_extract).map_err(|e| format!("PDF 文本提取失败: {e}"))
    })
    .await
    .map_err(|e| format!("PDF 文本提取失败: {e}"))??;
    let text = if text.len() > MAX_TEXT_BYTES {
        // Find the nearest UTF-8 char boundary at or before MAX_TEXT_BYTES
        // to avoid panicking on multi-byte characters (e.g. Chinese text).
        let mut end = MAX_TEXT_BYTES;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}\n\n[文本已截断]", &text[..end])
    } else {
        text
    };
    Ok(json!({
        "name": path.file_name().and_then(|n| n.to_str()).unwrap_or("document.pdf"),
        "path": path.to_string_lossy(),
        "text": text,
    }))
}
