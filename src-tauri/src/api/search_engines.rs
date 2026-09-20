//! Alternative web-search backends (P0-3): Tavily, Bocha and SearXNG.
//!
//! Every adapter normalizes its vendor payload into the shared
//! [`SearchResult`] shape, so the tool, the chat pipeline and the UI stay
//! engine-agnostic.  Response parsing is split from the HTTP call so it can
//! be unit-tested against recorded payloads.

use serde_json::Value;

use crate::errors::{brief, read_body_capped};

use super::web_search::SearchResult;

/// Upper bound on a search response body (shared by all engines).
const MAX_SEARCH_RESPONSE_BYTES: usize = 512 * 1024;

/// Read a JSON response body with the shared size cap.
async fn read_json(resp: reqwest::Response, engine: &str) -> Result<Value, String> {
    let status = resp.status();
    let body = read_body_capped(resp, MAX_SEARCH_RESPONSE_BYTES)
        .await
        .map_err(|e| format!("读取{engine}结果失败: {e}"))?;
    if !status.is_success() {
        let detail: String = body.trim().chars().take(180).collect();
        return Err(format!(
            "{engine}返回错误（HTTP {}）{}{detail}",
            status.as_u16(),
            if detail.is_empty() { "" } else { "：" }
        ));
    }
    serde_json::from_str(&body).map_err(|_| format!("{engine}返回了无法解析的内容"))
}

/// Tavily — `POST https://api.tavily.com/search`.
pub async fn tavily(
    client: &reqwest::Client,
    api_key: &str,
    query: &str,
    max_results: usize,
) -> Result<Vec<SearchResult>, String> {
    let resp = client
        .post("https://api.tavily.com/search")
        .json(&serde_json::json!({
            "api_key": api_key,
            "query": query,
            "max_results": max_results,
            "search_depth": "basic",
        }))
        .send()
        .await
        .map_err(|e| format!("搜索请求失败: {}", brief(&e)))?;
    let body = read_json(resp, "Tavily").await?;
    Ok(parse_tavily(&body, max_results))
}

/// Bocha (博查) — `POST https://api.bochaai.com/v1/web-search`.
pub async fn bocha(
    client: &reqwest::Client,
    api_key: &str,
    query: &str,
    max_results: usize,
) -> Result<Vec<SearchResult>, String> {
    let resp = client
        .post("https://api.bochaai.com/v1/web-search")
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&serde_json::json!({
            "query": query,
            "count": max_results,
            "summary": true,
        }))
        .send()
        .await
        .map_err(|e| format!("搜索请求失败: {}", brief(&e)))?;
    let body = read_json(resp, "博查").await?;

    // Bocha reports failures inside a 200 response via a business code.
    if let Some(code) = body.get("code").and_then(|c| c.as_i64()) {
        if code != 200 {
            let msg = body
                .get("msg")
                .or_else(|| body.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("未知错误");
            return Err(format!("博查返回错误（code {code}）：{msg}"));
        }
    }
    Ok(parse_bocha(&body, max_results))
}

/// SearXNG — `GET {base}/search?q=…&format=json` (self-hosted instances).
pub async fn searxng(
    client: &reqwest::Client,
    base_url: &str,
    query: &str,
    max_results: usize,
) -> Result<Vec<SearchResult>, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("未配置 SearXNG 实例地址，请在设置 → 联网搜索中填写".into());
    }
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("SearXNG 实例地址必须以 http:// 或 https:// 开头".into());
    }

    let url = format!(
        "{base}/search?q={}&format=json&language=zh-CN",
        urlencoding::encode(query)
    );
    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("搜索请求失败: {}", brief(&e)))?;
    let body = read_json(resp, "SearXNG").await?;
    Ok(parse_searxng(&body, max_results))
}

/* ---------------- response parsing (unit-tested) ---------------- */

/// Tavily: `{ "results": [ { "title", "url", "content" } ] }`.
pub fn parse_tavily(body: &Value, max_results: usize) -> Vec<SearchResult> {
    body.get("results")
        .and_then(|r| r.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let url = item.get("url").and_then(|u| u.as_str())?.trim();
                    if url.is_empty() {
                        return None;
                    }
                    Some(SearchResult {
                        title: item
                            .get("title")
                            .and_then(|t| t.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string(),
                        url: url.to_string(),
                        snippet: item
                            .get("content")
                            .and_then(|c| c.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string(),
                    })
                })
                .take(max_results)
                .collect()
        })
        .unwrap_or_default()
}

/// Bocha: `{ "data": { "webPages": { "value": [ { "name", "url", "snippet" } ] } } }`.
pub fn parse_bocha(body: &Value, max_results: usize) -> Vec<SearchResult> {
    body.get("data")
        .and_then(|d| d.get("webPages"))
        .and_then(|w| w.get("value"))
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let url = item.get("url").and_then(|u| u.as_str())?.trim();
                    if url.is_empty() {
                        return None;
                    }
                    let snippet = item
                        .get("snippet")
                        .or_else(|| item.get("summary"))
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    Some(SearchResult {
                        title: item
                            .get("name")
                            .or_else(|| item.get("title"))
                            .and_then(|t| t.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string(),
                        url: url.to_string(),
                        snippet,
                    })
                })
                .take(max_results)
                .collect()
        })
        .unwrap_or_default()
}

/// SearXNG: `{ "results": [ { "title", "url", "content" } ] }`.
pub fn parse_searxng(body: &Value, max_results: usize) -> Vec<SearchResult> {
    body.get("results")
        .and_then(|r| r.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let url = item.get("url").and_then(|u| u.as_str())?.trim();
                    if url.is_empty() {
                        return None;
                    }
                    Some(SearchResult {
                        title: item
                            .get("title")
                            .and_then(|t| t.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string(),
                        url: url.to_string(),
                        snippet: item
                            .get("content")
                            .and_then(|c| c.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string(),
                    })
                })
                .take(max_results)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_tavily_maps_title_url_content() {
        let body = json!({
            "results": [
                { "title": "示例", "url": "https://example.com", "content": "摘要一" },
                { "title": "测试", "url": "https://test.org", "content": "摘要二" },
                { "title": "空链接", "url": "", "content": "跳过" }
            ]
        });
        let results = parse_tavily(&body, 5);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "示例");
        assert_eq!(results[0].url, "https://example.com");
        assert_eq!(results[0].snippet, "摘要一");
    }

    #[test]
    fn parse_bocha_reads_nested_web_pages() {
        let body = json!({
            "code": 200,
            "data": {
                "webPages": {
                    "value": [
                        { "name": "博查结果", "url": "https://bocha.example", "snippet": "片段" },
                        { "name": "无摘要", "url": "https://b.example", "summary": "来自 summary" }
                    ]
                }
            }
        });
        let results = parse_bocha(&body, 5);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "博查结果");
        assert_eq!(results[0].snippet, "片段");
        assert_eq!(results[1].snippet, "来自 summary");
    }

    #[test]
    fn parse_searxng_respects_max_and_skips_malformed() {
        let body = json!({
            "results": [
                { "title": "A", "url": "https://a.com", "content": "a" },
                { "title": "B", "url": "https://b.com", "content": "b" },
                { "content": "no url" }
            ]
        });
        let results = parse_searxng(&body, 1);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].url, "https://a.com");
    }

    #[test]
    fn parsers_tolerate_missing_fields() {
        assert!(parse_tavily(&json!({}), 5).is_empty());
        assert!(parse_bocha(&json!({ "data": {} }), 5).is_empty());
        assert!(parse_searxng(&json!({ "results": [] }), 5).is_empty());
    }
}
