//! `search_knowledge` — BM25 retrieval over the user's local knowledge base
//! (P1-9).  Local material, so it is classified `LocalSensitive`: the data
//! flows into the answer, and the existing pipeline marks the run as sensitive
//! (later network tools then need an explicit confirmation).

use super::ToolDefinition;
use crate::tools::registry::{DataAccess, ToolContext};
use serde_json::{json, Value};

pub fn definition() -> ToolDefinition {
    ToolDefinition {
        name: "search_knowledge".into(),
        description:
            "在用户本地知识库中检索与问题相关的资料片段。当问题可能涉及用户已导入的文档、笔记或网页时使用；返回带来源编号的片段，回答时请标注来源。"
                .into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "检索关键词或问题" },
                "top_k": {
                    "type": "integer",
                    "description": "返回片段数，默认 5，范围 1-8",
                    "minimum": 1,
                    "maximum": 8
                }
            },
            "required": ["query"]
        }),
        risk_level: "sensitive_read".into(),
        // The user explicitly imported this material; a per-call prompt would
        // make the tool useless.  It never leaves the machine except as part
        // of the answer.
        requires_confirmation: false,
        timeout_ms: 10_000,
        max_result_bytes: 200_000,
        data_access: DataAccess::LocalSensitive,
        network_access: false,
    }
}

pub async fn run(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, String> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if query.is_empty() {
        return Err("检索关键词不能为空".into());
    }
    let top_k = args
        .get("top_k")
        .and_then(Value::as_u64)
        .unwrap_or(5)
        .clamp(1, crate::agent::knowledge::MAX_TOP_K as u64) as usize;

    let hits = ctx.db.kb_search(&query, top_k)?;
    let results: Vec<Value> = hits
        .iter()
        .map(|hit| {
            json!({
                "title": hit.title,
                "documentId": hit.document_id,
                "chunk": hit.seq,
                "snippet": hit.snippet,
            })
        })
        .collect();

    Ok(json!({
        "query": query,
        "count": results.len(),
        "results": results,
    }))
}
