//! Clipboard tools.

use super::ToolDefinition;
use crate::tools::registry::DataAccess;
use serde_json::{json, Value};

pub fn definition() -> ToolDefinition {
    ToolDefinition {
        name: "read_clipboard".into(),
        description: "读取当前系统剪贴板中的文本内容。".into(),
        parameters: json!({ "type": "object", "properties": {} }),
        risk_level: "sensitive_read".into(),
        requires_confirmation: true,
        timeout_ms: 5_000,
        max_result_bytes: 65_536,
        data_access: DataAccess::LocalSensitive,
        network_access: false,
    }
}

pub fn write_definition() -> ToolDefinition {
    ToolDefinition {
        name: "write_clipboard".into(),
        description: "将文本写入系统剪贴板。适合用户要求复制或写回生成内容时使用。".into(),
        parameters: json!({
            "type": "object",
            "properties": { "text": { "type": "string", "maxLength": 65536 } },
            "required": ["text"]
        }),
        risk_level: "external_action".into(),
        requires_confirmation: true,
        timeout_ms: 5_000,
        max_result_bytes: 2_048,
        data_access: DataAccess::None,
        network_access: false,
    }
}

pub async fn run(_args: &Value) -> Result<Value, String> {
    let text = tokio::task::spawn_blocking(|| -> Result<String, String> {
        let mut clipboard =
            arboard::Clipboard::new().map_err(|e| format!("无法访问剪贴板: {e}"))?;
        clipboard
            .get_text()
            .map_err(|e| format!("剪贴板中无可用文本: {e}"))
    })
    .await
    .map_err(|e| format!("读取剪贴板失败: {e}"))??;
    Ok(json!({ "text": text }))
}

pub async fn write(args: &Value) -> Result<Value, String> {
    let text = args
        .get("text")
        .and_then(Value::as_str)
        .ok_or("text 参数不能为空")?;
    if text.len() > 65_536 {
        return Err("写入剪贴板的文本不能超过 64 KiB".into());
    }
    let text = text.to_string();
    tokio::task::spawn_blocking(move || {
        let mut clipboard =
            arboard::Clipboard::new().map_err(|e| format!("无法访问剪贴板: {e}"))?;
        clipboard
            .set_text(&text)
            .map_err(|e| format!("写入剪贴板失败: {e}"))?;
        Ok::<_, String>(json!({ "written": true, "length": text.len() }))
    })
    .await
    .map_err(|e| format!("写入剪贴板失败: {e}"))?
}
