use serde::Serialize;
use serde_json::{json, Value};

use crate::tools::builtin;

/// What kind of local data a tool accesses.  Drives the data-flow approval
/// policy: once a tool with `LocalSensitive` access has produced a result,
/// the agent context is considered "tainted", and any subsequent tool with
/// `network_access` must be confirmed again before it can send that data out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DataAccess {
    /// No local data involved (time, calculator, open_resource).
    None,
    /// Only reads public (web) data.
    Public,
    /// Reads local sensitive data: clipboard, files, PDFs, screen, etc.
    LocalSensitive,
}

/// Unified tool definition (protocol 2.0).
#[derive(Debug, Clone, Serialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub risk_level: String,
    pub requires_confirmation: bool,
    pub timeout_ms: u64,
    pub max_result_bytes: usize,
    /// v2.0: what local data this tool accesses.
    pub data_access: DataAccess,
    /// v2.0: whether this tool sends data to an external network endpoint
    /// (e.g. web search, webpage fetch).  When the context contains local
    /// sensitive data, network tools are subject to a second confirmation.
    pub network_access: bool,
}

#[derive(Default)]
pub struct ToolRegistry {
    tools: Vec<ToolDefinition>,
}

impl ToolRegistry {
    pub fn builtin() -> Self {
        Self {
            tools: builtin::definitions(),
        }
    }

    pub fn all(&self) -> &[ToolDefinition] {
        &self.tools
    }

    /// Serialize tool definitions as OpenAI function tools, keeping only the
    /// tools for which `enabled` returns `true`.
    pub fn to_openai_tools_filtered(
        &self,
        enabled: impl Fn(&ToolDefinition) -> bool,
    ) -> Vec<Value> {
        self.tools
            .iter()
            .filter(|t| enabled(t))
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    }
                })
            })
            .collect()
    }

    pub fn find(&self, name: &str) -> Option<&ToolDefinition> {
        self.tools.iter().find(|t| t.name == name)
    }

    pub async fn execute(
        &self,
        client: &reqwest::Client,
        name: &str,
        args: Value,
    ) -> Result<Value, String> {
        let definition = self.find(name).ok_or_else(|| format!("未知工具: {name}"))?;
        // Validate arguments against the JSON Schema before touching the tool.
        validate_args(&definition.parameters, &args)?;
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(definition.timeout_ms),
            builtin::execute(client, name, args),
        )
        .await
        .map_err(|_| format!("工具执行超时: {name}"))??;
        limit_result(result, definition.max_result_bytes)
    }
}

/// Lightweight JSON Schema validation executed before every tool call.
///
/// Enforces the parts of the schema that matter for safety and correctness:
/// - `required` fields must be present;
/// - field types must match (`string` / `integer` / `number` / `boolean`);
/// - string `maxLength` and numeric `minimum` / `maximum` bounds;
/// - `additionalProperties: false` rejects unknown keys.
///
/// This is intentionally small (no external schema crate): the schemas we
/// ship are simple object schemas, and the cost of a full validator is not
/// justified.  Unknown fields that do not violate a schema are allowed.
pub fn validate_args(schema: &Value, args: &Value) -> Result<(), String> {
    if !schema.is_object() {
        return Ok(());
    }
    if let Some(props) = schema.get("properties").and_then(|p| p.as_object()) {
        // Check type & bounds for each present field.
        for (key, def) in props {
            if let Some(value) = args.get(key) {
                validate_field(key, def, value)?;
            }
        }
        // Check required fields.
        if let Some(required) = schema.get("required").and_then(|r| r.as_array()) {
            for key in required {
                if let Some(k) = key.as_str() {
                    if args.get(k).is_none() {
                        return Err(format!("缺少必需参数: {k}"));
                    }
                }
            }
        }
        // additionalProperties: false -> reject unknown top-level keys.
        if schema.get("additionalProperties").and_then(|v| v.as_bool()) == Some(false) {
            if let Some(obj) = args.as_object() {
                for key in obj.keys() {
                    if !props.contains_key(key) {
                        return Err(format!("未知参数: {key}"));
                    }
                }
            }
        }
    }
    Ok(())
}

fn validate_field(key: &str, def: &Value, value: &Value) -> Result<(), String> {
    let want = def.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match want {
        "string" => {
            if !value.is_string() {
                return Err(format!("参数 {key} 必须是字符串"));
            }
            if let Some(max) = def.get("maxLength").and_then(|m| m.as_u64()) {
                if value.as_str().unwrap().len() as u64 > max {
                    return Err(format!("参数 {key} 超过长度限制 {max}"));
                }
            }
        }
        "integer" => {
            let Some(n) = value.as_i64() else {
                return Err(format!("参数 {key} 必须是整数"));
            };
            if let Some(min) = def.get("minimum").and_then(|m| m.as_i64()) {
                if n < min {
                    return Err(format!("参数 {key} 不能小于 {min}"));
                }
            }
            if let Some(max) = def.get("maximum").and_then(|m| m.as_i64()) {
                if n > max {
                    return Err(format!("参数 {key} 不能大于 {max}"));
                }
            }
        }
        "number" => {
            if !value.is_number() {
                return Err(format!("参数 {key} 必须是数字"));
            }
        }
        "boolean" if !value.is_boolean() => {
            return Err(format!("参数 {key} 必须是布尔值"));
        }
        _ => {}
    }
    Ok(())
}

fn limit_result(value: Value, max_bytes: usize) -> Result<Value, String> {
    let encoded = value.to_string();
    if encoded.len() <= max_bytes {
        return Ok(value);
    }
    // Find the nearest UTF-8 char boundary at or before max_bytes to avoid
    // panicking on multi-byte characters (e.g. Chinese text where a 3-byte
    // sequence may straddle the cut point).  String::truncate requires the
    // index to be on a char boundary; calling it with an arbitrary byte
    // offset will panic, and release builds use panic = "abort".
    let mut end = max_bytes;
    while end > 0 && !encoded.is_char_boundary(end) {
        end -= 1;
    }
    let truncated = encoded[..end].to_string();
    Ok(json!({ "truncated": true, "content": truncated }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filtered_tools_excludes_disabled() {
        let registry = ToolRegistry::builtin();
        let all: Vec<String> = registry.all().iter().map(|t| t.name.clone()).collect();
        let filtered = registry.to_openai_tools_filtered(|t| t.name != "read_clipboard");
        assert_eq!(filtered.len(), all.len() - 1);
        let names: Vec<String> = filtered
            .iter()
            .filter_map(|t| t["function"]["name"].as_str().map(|s| s.to_string()))
            .collect();
        assert!(!names.contains(&"read_clipboard".to_string()));
        assert!(names.contains(&"calculate".to_string()));
    }

    #[test]
    fn filtered_tools_keeps_everything_when_all_enabled() {
        let registry = ToolRegistry::builtin();
        let all = registry.all().len();
        let filtered = registry.to_openai_tools_filtered(|_| true);
        assert_eq!(filtered.len(), all);
    }

    #[test]
    fn limit_result_truncates_at_char_boundary() {
        // Chinese characters are 3 bytes each in UTF-8.  A max_bytes that
        // lands in the middle of a character must not panic.
        let value = json!({ "content": "你好世界你好世界你好世界" });
        let result = limit_result(value, 10).unwrap();
        assert_eq!(result["truncated"], json!(true));
        // The truncated content must be valid UTF-8 and shorter than 10 bytes.
        let content = result["content"].as_str().unwrap();
        assert!(content.len() <= 10);
        // Should contain at least one complete character.
        assert!(!content.is_empty());
    }

    #[test]
    fn limit_result_passes_small_values_through() {
        let value = json!({ "content": "hi" });
        let result = limit_result(value, 100).unwrap();
        assert!(result.get("truncated").is_none());
        assert_eq!(result["content"], json!("hi"));
    }

    #[test]
    fn validate_requires_required_fields() {
        let schema = json!({
            "type": "object",
            "properties": { "query": { "type": "string" } },
            "required": ["query"]
        });
        assert!(validate_args(&schema, &json!({})).is_err());
        assert!(validate_args(&schema, &json!({ "query": "x" })).is_ok());
    }

    #[test]
    fn validate_checks_types_and_bounds() {
        let schema = json!({
            "type": "object",
            "properties": {
                "count": { "type": "integer", "minimum": 1, "maximum": 10 }
            }
        });
        assert!(validate_args(&schema, &json!({ "count": "5" })).is_err());
        assert!(validate_args(&schema, &json!({ "count": 0 })).is_err());
        assert!(validate_args(&schema, &json!({ "count": 11 })).is_err());
        assert!(validate_args(&schema, &json!({ "count": 5 })).is_ok());
    }

    #[test]
    fn validate_rejects_unknown_keys_when_requested() {
        let schema = json!({
            "type": "object",
            "properties": { "a": { "type": "string" } },
            "additionalProperties": false
        });
        assert!(validate_args(&schema, &json!({ "a": "1", "b": "2" })).is_err());
        assert!(validate_args(&schema, &json!({ "a": "1" })).is_ok());
    }
}
