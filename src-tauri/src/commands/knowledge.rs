//! Local knowledge base (P1-9): ingest files / web pages / pasted text, list
//! and delete documents, run retrieval tests, and toggle auto-injection.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::State;

use crate::storage::config::ConfigStore;
use crate::storage::database::{Database, KbDocument, KbHit};
use crate::tools::document_parse::{extract, html_to_text, is_supported, MAX_DOCUMENT_BYTES};
use crate::tools::safe_http::SafeHttpFetcher;

static KB_SEQ: AtomicU64 = AtomicU64::new(0);

fn new_kb_id() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = KB_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("kb-{millis:x}-{seq:x}")
}

/// Settings + size summary for the knowledge-base panel.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeView {
    pub auto_inject: bool,
    pub max_chunks: u32,
    pub documents: usize,
    pub chunks: i64,
}

#[tauri::command]
pub fn get_knowledge_config(
    db: State<'_, Database>,
    config: State<'_, ConfigStore>,
) -> Result<KnowledgeView, String> {
    let knowledge = config.read(|c| c.knowledge.clone());
    let (documents, chunks) = db.kb_stats()?;
    Ok(KnowledgeView {
        auto_inject: knowledge.auto_inject,
        max_chunks: knowledge.max_chunks,
        documents: documents as usize,
        chunks,
    })
}

#[tauri::command]
pub fn set_knowledge_config(
    config: State<'_, ConfigStore>,
    auto_inject: bool,
    max_chunks: u32,
) -> Result<(), String> {
    let max_chunks = max_chunks.clamp(1, crate::agent::knowledge::MAX_TOP_K as u32);
    config.update(|c| {
        c.knowledge.auto_inject = auto_inject;
        c.knowledge.max_chunks = max_chunks;
        Ok(())
    })
}

#[tauri::command]
pub fn list_kb_documents(db: State<'_, Database>) -> Result<Vec<KbDocument>, String> {
    db.kb_list_documents()
}

#[tauri::command]
pub fn delete_kb_document(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.kb_delete_document(&id)
}

/// Add a document file (Word / Excel / PPT / PDF / text) to the knowledge base.
#[tauri::command]
pub async fn add_kb_file(db: State<'_, Database>, path: String) -> Result<KbDocument, String> {
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
    let text = tokio::task::spawn_blocking(move || extract(&name_for_parse, &bytes))
        .await
        .map_err(|e| format!("文档解析失败：{e}"))??;
    if text.trim().is_empty() {
        return Err("未能从文档中提取到文字（可能是扫描件）".into());
    }

    db.kb_ingest(
        &new_kb_id(),
        &name,
        "file",
        Some(&path.to_string_lossy()),
        &text,
    )
}

/// Add a web page: fetched through the SSRF-guarded fetcher, tags stripped.
#[tauri::command]
pub async fn add_kb_url(db: State<'_, Database>, url: String) -> Result<KbDocument, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("网址不能为空".into());
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("网址必须以 http:// 或 https:// 开头".into());
    }

    let fetcher = SafeHttpFetcher::new();
    let page = fetcher.fetch_text(&url, 1_000_000).await?;
    let html = page
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or_default();
    let text = html_to_text(html);
    if text.trim().is_empty() {
        return Err("未能从网页中提取到正文".into());
    }

    db.kb_ingest(&new_kb_id(), &url, "url", Some(&url), &text)
}

/// Add pasted text.
#[tauri::command]
pub fn add_kb_text(
    db: State<'_, Database>,
    title: String,
    text: String,
) -> Result<KbDocument, String> {
    let title = title.trim();
    let text = text.trim();
    if title.is_empty() {
        return Err("请填写资料标题".into());
    }
    if text.is_empty() {
        return Err("资料内容不能为空".into());
    }
    db.kb_ingest(&new_kb_id(), title, "text", None, text)
}

/// Retrieval test used by the settings panel ("检查资料与召回").
#[tauri::command]
pub fn search_kb(
    db: State<'_, Database>,
    query: String,
    top_k: Option<usize>,
) -> Result<Vec<KbHit>, String> {
    db.kb_search(&query, top_k.unwrap_or(5))
}
