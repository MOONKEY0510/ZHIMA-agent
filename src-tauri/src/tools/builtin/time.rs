//! `get_current_time` — return the current local date/time.

use serde_json::{json, Value};

use super::ToolDefinition;
use crate::tools::registry::DataAccess;

pub fn definition() -> ToolDefinition {
    ToolDefinition {
        name: "get_current_time".into(),
        description: "获取当前本地日期和时间（含时区），用于需要时间信息的问题。".into(),
        parameters: json!({ "type": "object", "properties": {} }),
        risk_level: "low".into(),
        requires_confirmation: false,
        timeout_ms: 5_000,
        max_result_bytes: 4_096,
        data_access: DataAccess::None,
        network_access: false,
    }
}

pub fn run(_args: &Value) -> Result<Value, String> {
    use chrono::Local;
    let now = Local::now();
    Ok(json!({
        "datetime": now.format("%Y-%m-%d %H:%M:%S %z").to_string(),
        "date": now.format("%Y-%m-%d").to_string(),
        "time": now.format("%H:%M:%S").to_string(),
        "timezone": now.format("%z").to_string(),
        "weekday": now.format("%A").to_string(),
    }))
}
