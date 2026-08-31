//! OpenAI-compatible Chat Completions adapter (`POST /v1/chat/completions`,
//! `stream: true`). Vendor-specific quirks are normalized here so the rest
//! of the app only sees [`crate::models::response::ChatEvent`] values.

use serde_json::{json, Value};

use crate::models::request::ChatMessage;

/// Validate and normalize a Base URL: non-empty, parseable, http/https only,
/// trailing slashes stripped. Returns the normalized URL.
pub fn validate_base_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Base URL 不能为空".into());
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| "Base URL 格式不正确".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Base URL 仅支持 http / https".into());
    }
    Ok(trimmed.to_string())
}

/// Normalize the configured Base URL and resolve the completions endpoint.
///
/// Rules (plan §8):
/// - only `http`/`https` are accepted;
/// - trailing slashes are stripped;
/// - if the URL already ends with `/chat/completions` it is used verbatim,
///   otherwise `/chat/completions` is appended (covers `/v1` bases and
///   plain-domain bases alike).
pub fn chat_completions_url(base_url: &str) -> Result<String, String> {
    let trimmed = validate_base_url(base_url)?;
    if trimmed.ends_with("/chat/completions") {
        Ok(trimmed)
    } else {
        Ok(format!("{trimmed}/chat/completions"))
    }
}

/// Convert frontend `ChatMessage`s plus an optional system prompt into the
/// OpenAI `messages` array. Images become a multipart content array (OpenAI
/// vision format) instead of a plain string.
pub fn messages_to_openai(messages: &[ChatMessage], system_prompt: Option<&str>) -> Vec<Value> {
    let mut out_messages: Vec<Value> = Vec::with_capacity(messages.len() + 1);

    // Prepend the system message if a prompt is provided.
    if let Some(sp) = system_prompt {
        let sp = sp.trim();
        if !sp.is_empty() {
            out_messages.push(json!({ "role": "system", "content": sp }));
        }
    }

    out_messages.extend(messages.iter().map(|m| {
        if m.images.is_empty() {
            json!({ "role": m.role, "content": m.content })
        } else {
            let mut parts: Vec<Value> = vec![];
            if !m.content.is_empty() {
                parts.push(json!({ "type": "text", "text": m.content }));
            }
            for img in &m.images {
                parts.push(json!({
                    "type": "image_url",
                    "image_url": { "url": img }
                }));
            }
            json!({ "role": m.role, "content": parts })
        }
    }));

    out_messages
}

/// Build the request body from an already-formatted OpenAI `messages` array.
/// Used by the agent loop, which appends `assistant` tool_calls and `tool`
/// result messages between rounds.
pub fn build_body_from_values(
    model: &str,
    messages: &[Value],
    temperature: Option<f32>,
    max_tokens: Option<u32>,
    tools: Option<&[Value]>,
    enable_thinking: bool,
    thinking_effort: &str,
) -> Value {
    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": true,
        // OpenAI deliberately omits `usage` from streaming responses unless it
        // is asked for. Without this the trailing usage payload never arrives
        // and the UI has no token counts to show.
        "stream_options": { "include_usage": true },
    });
    if let Some(t) = temperature {
        body["temperature"] = json!(t);
    }
    if let Some(mt) = max_tokens {
        body["max_tokens"] = json!(mt);
    }
    if let Some(tools) = tools {
        if !tools.is_empty() {
            body["tools"] = json!(tools);
            body["tool_choice"] = json!("auto");
        }
    }
    // Use the maximum reasoning level when thinking is enabled. The fields
    // follow common OpenAI-compatible relay conventions; providers that do
    // not implement reasoning controls ignore them and retain normal output.
    if enable_thinking {
        body["thinking"] = json!({ "type": "enabled" });
        body["enable_thinking"] = json!(true);
        body["reasoning_effort"] = json!(thinking_effort);
        body["reasoning"] = json!({ "enabled": true, "effort": thinking_effort });
    } else {
        body["thinking"] = json!({ "type": "disabled" });
        body["enable_thinking"] = json!(false);
        body["reasoning"] = json!({ "enabled": false });
    }
    body
}

/// Build the JSON body. Parameters left on "auto" are simply not sent.
///
/// If a message carries `images`, it is sent as a multipart content array
/// (OpenAI vision format) instead of a plain string.
///
/// When `system_prompt` is non-empty, it is prepended as a `system` message.
///
/// The agent loop uses `messages_to_openai` + `build_body_from_values`
/// instead; this convenience wrapper is kept for tests and the vision path.
#[cfg_attr(not(test), allow(dead_code))]
pub fn build_body(
    model: &str,
    messages: &[ChatMessage],
    temperature: Option<f32>,
    max_tokens: Option<u32>,
    system_prompt: Option<&str>,
) -> Value {
    let out_messages = messages_to_openai(messages, system_prompt);
    build_body_from_values(model, &out_messages, temperature, max_tokens, None, true, "medium")
}

/// Build a **non-streaming** vision request body for `describe_image`.
pub fn build_vision_body(model: &str, image_data_url: &str, prompt: &str) -> Value {
    json!({
        "model": model,
        "stream": false,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": prompt },
                { "type": "image_url", "image_url": { "url": image_data_url } }
            ]
        }]
    })
}

/// Extract assistant text from a non-streaming OpenAI-compatible response.
///
/// Besides the canonical `choices[0].message.content` string, tolerate the
/// common `choices[0].text`, content-part arrays and top-level `output_text`
/// variants used by compatibility relays.
pub fn extract_completion_text(body: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("解析模型响应失败: {e}"))?;
    if let Some(err) = v.get("error") {
        let message = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("模型返回了错误");
        return Err(message.chars().take(300).collect());
    }

    let choice = v.get("choices").and_then(|c| c.get(0));
    let content = choice
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"));
    let text = content
        .and_then(content_value_to_text)
        .or_else(|| choice.and_then(|c| c.get("text")).and_then(Value::as_str).map(str::to_string))
        .or_else(|| v.get("output_text").and_then(Value::as_str).map(str::to_string))
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "模型未返回有效文本内容".to_string())?;
    Ok(text)
}

/// Normalize either a content string or an array of text content parts.
fn content_value_to_text(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    let parts = content.as_array()?;
    let text = parts
        .iter()
        .filter_map(|part| {
            part.get("text")
                .and_then(Value::as_str)
                .or_else(|| part.get("content").and_then(Value::as_str))
        })
        .collect::<String>();
    (!text.is_empty()).then_some(text)
}

/// Map a non-2xx HTTP response to `(code, user_message, retryable)`.
pub fn map_http_error(status: u16, body_text: &str) -> (String, String, bool) {
    let detail = extract_error_detail(body_text);
    let with_detail = |prefix: String| {
        if detail.is_empty() {
            prefix
        } else {
            format!("{prefix}（{detail}）")
        }
    };

    match status {
        401 => (
            "auth_failed".into(),
            with_detail("鉴权失败（401）：请检查 API Key 是否正确".into()),
            false,
        ),
        403 => (
            "forbidden".into(),
            with_detail("拒绝访问（403）：可能无权使用该服务或模型".into()),
            false,
        ),
        404 => (
            "not_found".into(),
            with_detail("接口或模型不存在（404）：请检查 Base URL 与模型名".into()),
            false,
        ),
        429 => (
            "rate_limited".into(),
            with_detail("请求过于频繁或额度不足（429）".into()),
            true,
        ),
        500..=599 => (
            "server_error".into(),
            with_detail(format!("服务端异常（{status}），请稍后重试")),
            true,
        ),
        s => (
            "http_error".into(),
            with_detail(format!("请求失败（HTTP {s}）")),
            false,
        ),
    }
}

/// Try to pull an error description out of a JSON error body.
fn extract_error_detail(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        let msg = v
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .or_else(|| v.get("message").and_then(|m| m.as_str()));
        if let Some(m) = msg {
            return m.chars().take(300).collect();
        }
    }
    body.trim().chars().take(200).collect()
}

/// What one SSE `data:` payload turned into.
pub enum ParsedChunk {
    /// `[DONE]` sentinel.
    Done,
    /// Normal chat chunk parts (any subset may be present).
    Parts(ChunkParts),
    /// The payload carried an error object.
    Error(String),
    /// Empty/unparseable payload — ignore without crashing.
    Skip,
}

/// One streaming delta of a tool call. `id`/`name` appear only on the first
/// fragment; `arguments` arrives as incremental JSON string pieces that must
/// be concatenated across chunks.
#[derive(Debug, Clone, Default)]
pub struct ToolCallDelta {
    pub index: usize,
    pub id: Option<String>,
    pub name: Option<String>,
    pub arguments: Option<String>,
}

#[derive(Default)]
pub struct ChunkParts {
    pub content: String,
    pub reasoning: String,
    pub finish_reason: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub tool_calls: Vec<ToolCallDelta>,
}

/// Read one usage counter, tolerating both the OpenAI and the Anthropic-style
/// spellings as well as values that arrive as JSON floats instead of integers.
fn usage_number(usage: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .filter_map(|key| usage.get(*key))
        .find_map(|value| value.as_u64().or_else(|| value.as_f64().map(|f| f as u64)))
}

/// Parse one SSE `data` payload into normalized chunk parts.
pub fn parse_stream_chunk(data: &str) -> ParsedChunk {
    let data = data.trim();
    if data.is_empty() {
        return ParsedChunk::Skip;
    }
    if data == "[DONE]" {
        return ParsedChunk::Done;
    }

    let Ok(v) = serde_json::from_str::<Value>(data) else {
        return ParsedChunk::Skip;
    };

    // Some providers report errors mid-stream as JSON instead of HTTP codes.
    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("流式响应中返回了错误");
        return ParsedChunk::Error(msg.chars().take(300).collect());
    }

    let mut parts = ChunkParts::default();

    if let Some(choices) = v.get("choices").and_then(|c| c.as_array()) {
        for choice in choices {
            let delta = choice.get("delta");
            if let Some(text) = delta
                .and_then(|d| d.get("content"))
                .and_then(content_value_to_text)
                .or_else(|| {
                    choice
                        .get("message")
                        .and_then(|m| m.get("content"))
                        .and_then(content_value_to_text)
                })
                .or_else(|| choice.get("text").and_then(Value::as_str).map(str::to_string))
            {
                parts.content.push_str(&text);
            }
            // DeepSeek and most OpenAI-compatible providers use
            // `reasoning_content`; some use `reasoning` instead.
            if let Some(text) = delta
                .and_then(|d| d.get("reasoning_content"))
                .and_then(|c| c.as_str())
            {
                parts.reasoning.push_str(text);
            }
            if let Some(text) = delta
                .and_then(|d| d.get("reasoning"))
                .and_then(|c| c.as_str())
            {
                parts.reasoning.push_str(text);
            }
            // Compatibility relays sometimes emit `finish_reason: ""` on
            // every token. An empty value means "not finished" and must not
            // terminate the stream after its first chunk.
            if let Some(reason) = choice
                .get("finish_reason")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|reason| !reason.is_empty())
            {
                parts.finish_reason = Some(reason.to_string());
            }
            // Streaming tool calls arrive as incremental deltas:
            // { "index": 0, "id": "call_1", "function": { "name": "x", "arguments": "..." } }
            if let Some(calls) = delta
                .and_then(|d| d.get("tool_calls"))
                .and_then(|c| c.as_array())
            {
                for call in calls {
                    let index = call.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                    let function = call.get("function");
                    parts.tool_calls.push(ToolCallDelta {
                        index,
                        id: call.get("id").and_then(|v| v.as_str()).map(str::to_string),
                        name: function
                            .and_then(|f| f.get("name"))
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                        arguments: function
                            .and_then(|f| f.get("arguments"))
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                    });
                }
            }
        }
    }

    // Token usage. Only present when the request asked for it (see
    // `stream_options` above), and relays disagree on the field names, so
    // accept the common spellings.
    if let Some(usage) = v.get("usage") {
        parts.input_tokens = usage_number(usage, &["prompt_tokens", "input_tokens"]);
        parts.output_tokens = usage_number(usage, &["completion_tokens", "output_tokens"]);
    }

    if parts.content.is_empty()
        && parts.reasoning.is_empty()
        && parts.finish_reason.is_none()
        && parts.input_tokens.is_none()
        && parts.output_tokens.is_none()
        && parts.tool_calls.is_empty()
    {
        ParsedChunk::Skip
    } else {
        ParsedChunk::Parts(parts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_appends_completions_path() {
        assert_eq!(
            chat_completions_url("https://api.example.com/v1/").unwrap(),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("http://localhost:11434/v1").unwrap(),
            "http://localhost:11434/v1/chat/completions"
        );
    }

    #[test]
    fn url_keeps_explicit_completions_path() {
        assert_eq!(
            chat_completions_url("https://relay.example.com/api/v1/chat/completions").unwrap(),
            "https://relay.example.com/api/v1/chat/completions"
        );
    }

    #[test]
    fn url_rejects_bad_schemes() {
        assert!(chat_completions_url("ftp://example.com").is_err());
        assert!(chat_completions_url("   ").is_err());
        assert!(chat_completions_url("not a url").is_err());
    }

    #[test]
    fn body_omits_auto_params() {
        let body = build_body("m", &[], None, None, None);
        assert_eq!(body["stream"], json!(true));
        assert!(body.get("temperature").is_none());
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn body_configures_max_or_disabled_thinking() {
        let msgs = [json!({ "role": "user", "content": "hi" })];
        let on = build_body_from_values("m", &msgs, None, None, None, true, "high");
        assert_eq!(on["thinking"]["type"], json!("enabled"));
        assert_eq!(on["enable_thinking"], json!(true));
        assert_eq!(on["reasoning_effort"], json!("high"));
        assert_eq!(on["reasoning"]["effort"], json!("high"));

        let off = build_body_from_values("m", &msgs, None, None, None, false, "max");
        assert_eq!(off["thinking"]["type"], json!("disabled"));
        assert_eq!(off["enable_thinking"], json!(false));
    }

    #[test]
    fn body_includes_explicit_params() {
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: "hi".into(),
            images: vec![],
        }];
        let body = build_body("m", &msgs, Some(0.5), Some(1024), None);
        assert_eq!(body["temperature"], json!(0.5));
        assert_eq!(body["max_tokens"], json!(1024));
        assert_eq!(body["messages"][0]["content"], json!("hi"));
    }

    #[test]
    fn body_prepends_system_prompt() {
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: "hi".into(),
            images: vec![],
        }];
        let body = build_body("m", &msgs, None, None, Some("你是一个翻译助手"));
        assert_eq!(body["messages"][0]["role"], json!("system"));
        assert_eq!(body["messages"][0]["content"], json!("你是一个翻译助手"));
        assert_eq!(body["messages"][1]["role"], json!("user"));
    }

    #[test]
    fn body_ignores_empty_system_prompt() {
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: "hi".into(),
            images: vec![],
        }];
        let body = build_body("m", &msgs, None, None, Some("   "));
        // No system message should be prepended.
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(body["messages"][0]["role"], json!("user"));
    }

    #[test]
    fn validate_base_url_rules() {
        assert_eq!(
            validate_base_url("https://api.example.com/v1/").unwrap(),
            "https://api.example.com/v1"
        );
        assert!(validate_base_url("ftp://example.com").is_err());
        assert!(validate_base_url("   ").is_err());
    }

    #[test]
    fn http_401_maps_to_auth_error() {
        let (code, msg, retryable) = map_http_error(401, r#"{"error":{"message":"bad key"}}"#);
        assert_eq!(code, "auth_failed");
        assert!(!retryable);
        assert!(msg.contains("bad key"));
    }

    #[test]
    fn http_429_is_retryable() {
        let (code, _, retryable) = map_http_error(429, "");
        assert_eq!(code, "rate_limited");
        assert!(retryable);
    }

    #[test]
    fn parses_content_delta() {
        match parse_stream_chunk(
            r#"{"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}"#,
        ) {
            ParsedChunk::Parts(p) => assert_eq!(p.content, "你好"),
            _ => panic!("expected Parts"),
        }
    }

    #[test]
    fn parses_streaming_tool_calls() {
        // First fragment: id + name, plus the start of arguments.
        match parse_stream_chunk(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"web_search","arguments":"{\"query\":"}}]},"finish_reason":null}]}"#,
        ) {
            ParsedChunk::Parts(p) => {
                assert_eq!(p.tool_calls.len(), 1);
                assert_eq!(p.tool_calls[0].index, 0);
                assert_eq!(p.tool_calls[0].id.as_deref(), Some("call_1"));
                assert_eq!(p.tool_calls[0].name.as_deref(), Some("web_search"));
                assert_eq!(p.tool_calls[0].arguments.as_deref(), Some("{\"query\":"));
            }
            _ => panic!("expected Parts"),
        }
        // Second fragment: only arguments delta.
        match parse_stream_chunk(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"hello\"}"}}]},"finish_reason":null}]}"#,
        ) {
            ParsedChunk::Parts(p) => {
                assert_eq!(p.tool_calls.len(), 1);
                assert!(p.tool_calls[0].id.is_none());
                assert!(p.tool_calls[0].name.is_none());
                assert_eq!(p.tool_calls[0].arguments.as_deref(), Some("\"hello\"}"));
            }
            _ => panic!("expected Parts"),
        }
    }

    #[test]
    fn ignores_empty_finish_reason_from_compatibility_relays() {
        match parse_stream_chunk(
            r#"{"choices":[{"delta":{"reasoning_content":"用户"},"finish_reason":""}]}"#,
        ) {
            ParsedChunk::Parts(p) => {
                assert_eq!(p.reasoning, "用户");
                assert_eq!(p.finish_reason, None);
            }
            _ => panic!("expected Parts"),
        }
    }

    #[test]
    fn parses_message_content_and_content_parts() {
        match parse_stream_chunk(
            r#"{"choices":[{"message":{"content":"完整回答"},"finish_reason":"stop"}]}"#,
        ) {
            ParsedChunk::Parts(p) => assert_eq!(p.content, "完整回答"),
            _ => panic!("expected Parts"),
        }
        match parse_stream_chunk(
            r#"{"choices":[{"delta":{"content":[{"type":"text","text":"分段"},{"type":"text","text":"回答"}]}}]}"#,
        ) {
            ParsedChunk::Parts(p) => assert_eq!(p.content, "分段回答"),
            _ => panic!("expected Parts"),
        }
    }

    #[test]
    fn extracts_non_streaming_compatibility_shapes() {
        assert_eq!(
            extract_completion_text(r#"{"choices":[{"text":"普通 JSON 回答"}]}"#).unwrap(),
            "普通 JSON 回答"
        );
        assert_eq!(
            extract_completion_text(
                r#"{"choices":[{"message":{"content":[{"type":"text","text":"数组回答"}]}}]}"#
            )
            .unwrap(),
            "数组回答"
        );
    }

    #[test]
    fn parses_done_and_skip() {
        assert!(matches!(parse_stream_chunk("[DONE]"), ParsedChunk::Done));
        assert!(matches!(parse_stream_chunk(""), ParsedChunk::Skip));
        assert!(matches!(parse_stream_chunk("nonsense"), ParsedChunk::Skip));
    }

    #[test]
    fn parses_mid_stream_error_object() {
        match parse_stream_chunk(r#"{"error":{"message":"boom"}}"#) {
            ParsedChunk::Error(m) => assert_eq!(m, "boom"),
            _ => panic!("expected Error"),
        }
    }
}
