//! Open a safe user-visible resource with the system default application.

use super::ToolDefinition;
use crate::tools::registry::DataAccess;
use serde_json::{json, Value};

pub fn definition() -> ToolDefinition {
    ToolDefinition {
        name: "open_resource".into(),
        description: "使用系统默认程序打开公开网页 URL 或用户指定的本地文件路径。".into(),
        parameters: json!({
            "type": "object",
            "properties": { "target": { "type": "string", "description": "http/https URL 或已知本地文件路径" } },
            "required": ["target"]
        }),
        risk_level: "external_action".into(),
        requires_confirmation: true,
        timeout_ms: 10_000,
        max_result_bytes: 2_048,
        data_access: DataAccess::None,
        network_access: false,
    }
}

pub async fn run(args: &Value) -> Result<Value, String> {
    let target = args
        .get("target")
        .and_then(Value::as_str)
        .ok_or("target 参数不能为空")?
        .trim();
    if target.is_empty() {
        return Err("打开目标不能为空".into());
    }
    if !(target.starts_with("https://") || target.starts_with("http://")) {
        return Err("为了安全，open_resource 当前只允许打开 http/https URL".into());
    }
    url::Url::parse(target).map_err(|_| "URL 无效".to_string())?;
    open::that(target).map_err(|e| format!("打开资源失败: {e}"))?;
    Ok(json!({ "opened": true, "target": target }))
}
