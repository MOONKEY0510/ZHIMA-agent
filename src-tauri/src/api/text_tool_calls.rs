//! Recognize tool calls that some models print as plain text.
//!
//! Several OpenAI-compatible models (StepFun `step-*`, MiniMax, some
//! Qwen-derived relays) do not use the native `tool_calls` field.  They write
//! an XML-ish block into `content` instead:
//!
//! ```text
//! <tool_call>
//! <function=web_search>
//! <parameter=query>今天的新闻</parameter>
//! </function>
//! </tool_call>
//! ```
//!
//! Without this filter the markup leaks into the answer as literal text and no
//! tool ever runs.  [`TextToolCallFilter`] buffers streamed content, holds back
//! anything that could still turn into a `<tool_call>` marker, and returns the
//! remaining text together with any tool calls it completed.

use serde_json::{json, Map, Value};

/// Index base for text-parsed calls.  Native `tool_calls` indices are small
/// (0, 1, 2, …), so a high base keeps the two index spaces from colliding.
const INDEX_BASE: usize = 10_000;

const OPEN_TAG: &str = "<tool_call>";
const CLOSE_TAG: &str = "</tool_call>";
const ID_PREFIX: &str = "text-call-";

/// One tool call parsed out of streamed text.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedToolCall {
    /// Synthetic stream index (never collides with a native index).
    pub index: usize,
    pub name: String,
    /// Arguments object.  `<parameter>` values stay strings here; the tool
    /// registry coerces them to the types its schema declares.
    pub arguments: Value,
}

/// Stable id for a text-parsed call, used as the `tool_call_id`.
pub fn call_id(index: usize) -> String {
    format!("{ID_PREFIX}{index}")
}

/// Whether `id` was produced by [`call_id`], i.e. the call came from text
/// rather than from the provider's native `tool_calls` field.
pub fn is_text_call_id(id: &str) -> bool {
    id.starts_with(ID_PREFIX)
}

/// Streaming filter turning `<tool_call>` blocks into real tool calls.
#[derive(Default)]
pub struct TextToolCallFilter {
    buffer: String,
    emitted: usize,
}

impl TextToolCallFilter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one content delta; returns the text that is safe to show plus any
    /// tool calls completed by this delta.
    pub fn process(&mut self, text: &str) -> (String, Vec<ParsedToolCall>) {
        self.buffer.push_str(text);
        self.drain(false)
    }

    /// Flush at end of stream.  An unterminated `<tool_call>` block is still
    /// parsed on a best-effort basis so the markup never reaches the user.
    pub fn flush(&mut self) -> (String, Vec<ParsedToolCall>) {
        self.drain(true)
    }

    fn drain(&mut self, end_of_stream: bool) -> (String, Vec<ParsedToolCall>) {
        let mut visible = String::new();
        let mut calls = Vec::new();

        loop {
            let Some(start) = self.buffer.find(OPEN_TAG) else {
                // Hold back a trailing fragment that may still become a marker.
                let safe = if end_of_stream {
                    self.buffer.len()
                } else {
                    safe_end(&self.buffer, OPEN_TAG)
                };
                visible.push_str(&self.buffer[..safe]);
                self.buffer = self.buffer[safe..].to_string();
                break;
            };

            visible.push_str(&self.buffer[..start]);
            let body_start = start + OPEN_TAG.len();
            let (body_end, next_start) = match self.buffer[body_start..].find(CLOSE_TAG) {
                Some(pos) => {
                    let close_start = body_start + pos;
                    (close_start, close_start + CLOSE_TAG.len())
                }
                None if end_of_stream => (self.buffer.len(), self.buffer.len()),
                None => {
                    // Incomplete block: keep it buffered until the rest arrives.
                    self.buffer = self.buffer[start..].to_string();
                    break;
                }
            };

            let body = self.buffer[body_start..body_end].to_string();
            if let Some((name, arguments)) = parse_block(&body) {
                let index = INDEX_BASE + self.emitted;
                self.emitted += 1;
                calls.push(ParsedToolCall {
                    index,
                    name,
                    arguments,
                });
            }
            self.buffer = self.buffer[next_start..].to_string();
        }

        (visible, calls)
    }
}

/// Largest index up to which `text` cannot be the beginning of `tag`.
///
/// Keeps a trailing partial marker (`…<tool`) in the buffer so it is never
/// shown to the user and can still be completed by the next delta.
fn safe_end(text: &str, tag: &str) -> usize {
    for i in (1..=tag.len().min(text.len())).rev() {
        if text.ends_with(&tag[..i]) {
            return text.len() - i;
        }
    }
    text.len()
}

/// Parse the body between `<tool_call>` and `</tool_call>`.
///
/// Two shapes are supported:
/// - `<function=NAME><parameter=KEY>VALUE</parameter>…</function>`
/// - a JSON payload: `{"name": "NAME", "arguments": {…}}`
fn parse_block(body: &str) -> Option<(String, Value)> {
    let text = body.trim();
    if text.is_empty() {
        return None;
    }

    // JSON payload (Qwen / Hermes style).
    if text.starts_with('{') {
        if let Ok(value) = serde_json::from_str::<Value>(text) {
            if let Some(name) = value.get("name").and_then(Value::as_str) {
                let arguments = value
                    .get("arguments")
                    .or_else(|| value.get("parameters"))
                    .map(arguments_value)
                    .unwrap_or_else(|| json!({}));
                return Some((name.trim().to_string(), arguments));
            }
        }
    }

    // `<function=…>` style.
    let (_, after_marker) = text.split_once("<function=")?;
    let (name, after_name) = after_marker.split_once('>')?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let inner = after_name.split("</function>").next().unwrap_or(after_name);

    let mut parameters = Map::new();
    let mut cursor = inner;
    while let Some((_, after_key_marker)) = cursor.split_once("<parameter=") {
        let Some((key, after_key)) = after_key_marker.split_once('>') else {
            break;
        };
        let key = key.trim();
        let (raw, rest) = match after_key.split_once("</parameter>") {
            Some((value, rest)) => (value, rest),
            None => (after_key, ""),
        };
        if !key.is_empty() {
            parameters.insert(key.to_string(), Value::String(raw.trim().to_string()));
        }
        cursor = rest;
    }

    if parameters.is_empty() {
        // Tolerate `<function=NAME>{"query": "…"}</function>`.
        if let Ok(Value::Object(object)) = serde_json::from_str::<Value>(inner.trim()) {
            return Some((name.to_string(), Value::Object(object)));
        }
    }

    Some((name.to_string(), Value::Object(parameters)))
}

/// Normalize the `arguments` field of a JSON-style block: it may already be an
/// object or a JSON string that still has to be decoded.
fn arguments_value(value: &Value) -> Value {
    match value {
        Value::String(text) => serde_json::from_str::<Value>(text).unwrap_or_else(|_| json!({})),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(calls: &[ParsedToolCall]) -> Vec<&str> {
        calls.iter().map(|c| c.name.as_str()).collect()
    }

    #[test]
    fn parses_function_style_block() {
        // The exact shape reported from step-3.7-flash.
        let raw = "我来为您搜索。 <tool_call> <function=WebSearch> <parameter=query> 百度 2024 最新动态 文心一言 </parameter> <parameter=topk> 10 </parameter> </function> </tool_call>";
        let mut filter = TextToolCallFilter::new();
        let (visible, calls) = filter.process(raw);

        assert_eq!(visible, "我来为您搜索。 ");
        assert_eq!(names(&calls), vec!["WebSearch"]);
        assert_eq!(
            calls[0].arguments["query"],
            json!("百度 2024 最新动态 文心一言")
        );
        assert_eq!(calls[0].arguments["topk"], json!("10"));
    }

    #[test]
    fn holds_back_partial_marker_until_complete() {
        let mut filter = TextToolCallFilter::new();
        let (visible, calls) = filter.process("结果如下 <tool_");
        assert_eq!(visible, "结果如下 ");
        assert!(calls.is_empty());

        let (visible, calls) = filter.process("call><function=web_search><parameter=query>天");
        assert_eq!(visible, "");
        assert!(calls.is_empty());

        let (visible, calls) = filter.process("气</parameter></function></tool_call> 完毕");
        assert_eq!(visible, " 完毕");
        assert_eq!(names(&calls), vec!["web_search"]);
        assert_eq!(calls[0].arguments["query"], json!("天气"));
    }

    #[test]
    fn plain_text_is_untouched() {
        let mut filter = TextToolCallFilter::new();
        let (visible, calls) = filter.process("普通回答，没有工具调用");
        assert_eq!(visible, "普通回答，没有工具调用");
        assert!(calls.is_empty());
        let (tail, calls) = filter.flush();
        assert_eq!(tail, "");
        assert!(calls.is_empty());
    }

    #[test]
    fn parses_json_style_block() {
        let mut filter = TextToolCallFilter::new();
        let (visible, calls) = filter.process(
            "<tool_call>{\"name\": \"web_search\", \"arguments\": {\"query\": \"新闻\"}}</tool_call>",
        );
        assert_eq!(visible, "");
        assert_eq!(names(&calls), vec!["web_search"]);
        assert_eq!(calls[0].arguments["query"], json!("新闻"));
    }

    #[test]
    fn parses_json_arguments_sent_as_string() {
        let mut filter = TextToolCallFilter::new();
        let (_, calls) = filter.process(
            r#"<tool_call>{"name": "calculate", "arguments": "{\"expression\": \"1+1\"}"}</tool_call>"#,
        );
        assert_eq!(names(&calls), vec!["calculate"]);
        assert_eq!(calls[0].arguments["expression"], json!("1+1"));
    }

    #[test]
    fn unterminated_block_is_still_parsed_at_flush() {
        let mut filter = TextToolCallFilter::new();
        let (visible, calls) = filter.process(
            "<tool_call><function=web_search><parameter=query>天气</parameter></function>",
        );
        assert_eq!(visible, "");
        assert!(calls.is_empty());

        let (visible, calls) = filter.flush();
        assert_eq!(visible, "");
        assert_eq!(names(&calls), vec!["web_search"]);
    }

    #[test]
    fn multiple_calls_in_one_delta() {
        let mut filter = TextToolCallFilter::new();
        let (_, calls) = filter.process(
            "<tool_call><function=a><parameter=x>1</parameter></function></tool_call><tool_call><function=b></function></tool_call>",
        );
        assert_eq!(names(&calls), vec!["a", "b"]);
    }

    #[test]
    fn indices_are_unique_and_identifiable() {
        let mut filter = TextToolCallFilter::new();
        let (_, first) = filter.process("<tool_call><function=a></function></tool_call>");
        let (_, second) = filter.process("<tool_call><function=b></function></tool_call>");
        assert_ne!(first[0].index, second[0].index);
        assert!(is_text_call_id(&call_id(first[0].index)));
        assert!(!is_text_call_id("call_abc123"));
    }

    #[test]
    fn unparseable_block_is_dropped_from_visible_text() {
        let mut filter = TextToolCallFilter::new();
        let (visible, calls) = filter.process("前<tool_call>这不是工具调用</tool_call>后");
        assert_eq!(visible, "前后");
        assert!(calls.is_empty());
    }
}
