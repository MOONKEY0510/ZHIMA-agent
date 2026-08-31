//! `web_search` — DuckDuckGo search as a tool (reuses the existing adapter).

use serde_json::{json, Value};

use crate::api::web_search;

use super::ToolDefinition;
use crate::tools::registry::DataAccess;

pub fn definition() -> ToolDefinition {
    ToolDefinition {
        name: "web_search".into(),
        description:
            "在互联网上搜索给定关键词，返回标题、链接和摘要列表。当回答需要最新或非已知信息时使用。"
                .into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "搜索关键词" },
                "max_results": {
                    "type": "integer",
                    "description": "最大返回条数，默认 5，范围 1-10",
                    "minimum": 1,
                    "maximum": 10
                }
            },
            "required": ["query"]
        }),
        risk_level: "external_read".into(),
        requires_confirmation: false,
        timeout_ms: 20_000,
        max_result_bytes: 262_144,
        data_access: DataAccess::Public,
        network_access: true,
    }
}

pub async fn run(client: &reqwest::Client, args: &Value) -> Result<Value, String> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if query.is_empty() {
        return Err("搜索关键词不能为空".into());
    }
    let max = args
        .get("max_results")
        .and_then(|v| v.as_u64())
        .unwrap_or(5)
        .clamp(1, 10) as usize;

    let results = web_search::search(client, &query, max).await?;
    Ok(json!({
        "query": query,
        "results": results,
        "count": results.len(),
    }))
}
