//! Screen capture tool.

use super::ToolDefinition;
use crate::tools::registry::DataAccess;
use base64::Engine;
use serde_json::{json, Value};

pub fn definition() -> ToolDefinition {
    ToolDefinition {
        name: "capture_screen".into(),
        description: "截取用户选择的显示器画面并返回图片，用于分析界面、错误提示或屏幕文字。"
            .into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "display": { "type": "integer", "description": "显示器序号，从 0 开始，默认 0", "minimum": 0 }
            }
        }),
        risk_level: "sensitive_read".into(),
        requires_confirmation: true,
        timeout_ms: 15_000,
        max_result_bytes: 8 * 1024 * 1024,
        data_access: DataAccess::LocalSensitive,
        network_access: false,
    }
}

pub async fn run(args: &Value) -> Result<Value, String> {
    let display = args.get("display").and_then(Value::as_u64).unwrap_or(0) as usize;
    let captured = tokio::task::spawn_blocking(move || {
        let screens = screenshots::Screen::all().map_err(|e| format!("获取显示器失败: {e}"))?;
        let screen = screens
            .get(display)
            .ok_or_else(|| format!("显示器序号不存在: {display}"))?;
        let image = screen.capture().map_err(|e| format!("截图失败: {e}"))?;
        let width = image.width();
        let height = image.height();
        let mut png = Vec::new();
        {
            use image::ImageEncoder as _;
            let encoder = image::codecs::png::PngEncoder::new(&mut png);
            encoder
                .write_image(
                    image.as_raw(),
                    width,
                    height,
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|e| format!("编码截图失败: {e}"))?;
        }
        Ok::<_, String>((width, height, png))
    })
    .await
    .map_err(|e| format!("截图失败: {e}"))??;
    let (width, height, png) = captured;
    let data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    );
    Ok(json!({ "display": display, "width": width, "height": height, "image_data_url": data_url }))
}
