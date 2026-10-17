//! Text-to-image generation via OpenAI-compatible `/v1/images/generations`.
//!
//! Also manages persisted generation history (`image_generations` table).

use serde::Deserialize;
use tauri::State;

use crate::errors::{brief, read_body_capped};
use crate::state::AppState;
use crate::storage::database::{Database, ImageGeneration};
use crate::storage::{config::ConfigStore, secrets};

/// Upper bound on a generated image response (base64 data URL).  Generated
/// images are typically a few MB; anything larger is treated as an error.
const MAX_IMAGE_RESPONSE_BYTES: usize = 20 * 1024 * 1024; // 20 MB
/// Upper bound on the base64 `image_data` accepted when persisting history.
const MAX_IMAGE_DATA_BYTES: usize = 20 * 1024 * 1024; // 20 MB
/// Upper bound on reference images per request (mirrors the image workbench
/// composer, which caps the attached chips at three).
const MAX_REFERENCE_IMAGES: usize = 3;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateImageRequest {
    pub provider_id: String,
    pub model_key: String,
    pub prompt: String,
    /// One of "1024x1024", "1024x1792", "1792x1024" (DALL·E 3 style).
    #[serde(default = "default_image_size")]
    pub size: String,
    /// Custom pixel dimensions (supported by many OpenAI-compatible image
    /// APIs, e.g. SDXL / CogView). When both are present they override `size`.
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    /// Reference images as base64 data URLs (image-to-image / reference generation).
    #[serde(default)]
    pub reference_images: Option<Vec<String>>,
}

fn default_image_size() -> String {
    "1024x1024".into()
}

/// Build the `image` field carrying the reference images.
///
/// A single reference keeps the plain-string shape, which every compatible API
/// understands. Several references are sent as an array instead of dropping all
/// but the first, which is the shape multi-reference providers expect.
/// `Ok(None)` means there is no usable reference and the field stays unset.
fn reference_image_value(refs: Vec<String>) -> Result<Option<serde_json::Value>, String> {
    let images: Vec<String> = refs
        .into_iter()
        .map(strip_data_url_prefix)
        .filter(|data| !data.is_empty())
        .collect();
    if images.len() > MAX_REFERENCE_IMAGES {
        return Err(format!(
            "一次最多支持 {MAX_REFERENCE_IMAGES} 张参考图（当前 {} 张）",
            images.len()
        ));
    }
    match images.len() {
        0 => Ok(None),
        1 => Ok(Some(serde_json::Value::String(
            images.into_iter().next().unwrap_or_default(),
        ))),
        _ => Ok(Some(serde_json::Value::Array(
            images.into_iter().map(serde_json::Value::String).collect(),
        ))),
    }
}

/// Drop the `data:image/png;base64,` prefix so only the payload is sent.
fn strip_data_url_prefix(value: String) -> String {
    value
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(',').map(|(_, data)| data.to_string()))
        .unwrap_or(value)
}

/// Generate an image and return it as a base64-encoded PNG/JPEG data URL.
#[tauri::command]
pub async fn generate_image(
    state: State<'_, AppState>,
    config: State<'_, ConfigStore>,
    request: GenerateImageRequest,
) -> Result<String, String> {
    // Resolve provider + API key + base URL.
    let (url, api_key, model) = config.read(|cfg| {
        let provider = cfg
            .providers
            .iter()
            .find(|p| p.id == request.provider_id)
            .ok_or_else(|| "图像模型服务商不存在".to_string())?;
        let key = secrets::get_api_key(&provider.id)?
            .ok_or_else(|| "图像模型服务商未配置 API Key".to_string())?;
        let base = provider.base_url.trim_end_matches('/').to_string();
        let url = format!("{base}/images/generations");
        Ok::<_, String>((url, key, request.model_key.clone()))
    })?;

    if request.prompt.trim().is_empty() {
        return Err("请输入图像描述".into());
    }

    // Build the request body. Reference images are sent as base64 in the
    // `image` field — the de facto convention used by most OpenAI-compatible
    // Chinese image APIs (CogView, Wanxiang, Spark, Seedream, etc.).
    let mut body = serde_json::json!({
        "model": model,
        "prompt": request.prompt.trim(),
        "n": 1,
        "response_format": "b64_json",
    });

    if let Some(refs) = request.reference_images {
        if let Some(value) = reference_image_value(refs)? {
            body["image"] = value;
        }
    }

    // Custom dimensions take precedence over the preset `size` string.
    // Many OpenAI-compatible image APIs (SDXL, CogView, …) accept
    // width/height directly; DALL·E 3 only understands the `size` string.
    match (request.width, request.height) {
        (Some(w), Some(h)) => {
            body["width"] = serde_json::Value::Number(serde_json::Number::from(w));
            body["height"] = serde_json::Value::Number(serde_json::Number::from(h));
        }
        _ => {
            body["size"] = serde_json::Value::String(request.size);
        }
    }

    let client = state.http.lock().unwrap().clone();
    let resp = client
        .post(&url)
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("图像生成请求失败: {}", brief(&e)))?;

    let status = resp.status().as_u16();
    let text = read_body_capped(resp, MAX_IMAGE_RESPONSE_BYTES).await?;
    if status != 200 {
        let (_, message, _) = crate::api::openai_chat::map_http_error(status, &text);
        return Err(message);
    }

    // Extract base64 from `{ data: [{ b64_json: "..." }] }`.
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析图像响应失败: {e}"))?;
    let b64 = v
        .get("data")
        .and_then(|d| d.get(0))
        .and_then(|d| d.get("b64_json"))
        .and_then(|b| b.as_str())
        .ok_or_else(|| "图像生成未返回有效数据".to_string())?;

    Ok(format!("data:image/png;base64,{b64}"))
}

/// Save a generated image into history.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveImageGenerationRequest {
    pub id: String,
    pub prompt: String,
    pub image_data: String,
    #[serde(default)]
    pub size_label: Option<String>,
    #[serde(default)]
    pub reference_images_json: Option<String>,
}

#[tauri::command]
pub fn save_image_generation(
    db: State<'_, Database>,
    request: SaveImageGenerationRequest,
) -> Result<ImageGeneration, String> {
    // Bound the persisted image payload so the database cannot be ballooned
    // by an oversized or malformed data URL.
    if request.image_data.len() > MAX_IMAGE_DATA_BYTES {
        return Err(format!(
            "图片数据过大（超过 {} MB）",
            MAX_IMAGE_DATA_BYTES / 1024 / 1024
        ));
    }

    // The frontend generates the id (same convention as conversation ids).
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let gen = ImageGeneration {
        id: request.id,
        prompt: request.prompt,
        image_data: request.image_data,
        size_label: request.size_label,
        reference_images_json: request.reference_images_json,
        created_at: now,
    };
    db.save_image_generation(&gen)?;
    Ok(gen)
}

/// List image generation history, newest first.
#[tauri::command]
pub fn list_image_generations(db: State<'_, Database>) -> Result<Vec<ImageGeneration>, String> {
    db.list_image_generations(200)
}

/// Delete one image generation.
#[tauri::command]
pub fn delete_image_generation(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_image_generation(&id)
}

/// Clear all image generation history.
#[tauri::command]
pub fn clear_image_generations(db: State<'_, Database>) -> Result<(), String> {
    db.clear_image_generations()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &str = "data:image/png;base64,AAAA";
    const JPG: &str = "data:image/jpeg;base64,BBBB";

    #[test]
    fn no_usable_reference_leaves_field_unset() {
        assert!(reference_image_value(Vec::new()).unwrap().is_none());
        assert!(reference_image_value(vec![String::new()])
            .unwrap()
            .is_none());
    }

    #[test]
    fn single_reference_keeps_string_shape() {
        let value = reference_image_value(vec![PNG.to_string()])
            .unwrap()
            .unwrap();
        assert_eq!(value, serde_json::json!("AAAA"));
    }

    #[test]
    fn multiple_references_use_array_shape() {
        let value = reference_image_value(vec![PNG.to_string(), JPG.to_string()])
            .unwrap()
            .unwrap();
        assert_eq!(value, serde_json::json!(["AAAA", "BBBB"]));
    }

    #[test]
    fn raw_base64_passes_through() {
        let value = reference_image_value(vec!["CCCC".to_string()])
            .unwrap()
            .unwrap();
        assert_eq!(value, serde_json::json!("CCCC"));
    }

    #[test]
    fn references_beyond_cap_are_rejected() {
        let refs = vec![PNG.to_string(); MAX_REFERENCE_IMAGES + 1];
        let err = reference_image_value(refs).unwrap_err();
        assert!(err.contains(&format!("最多支持 {MAX_REFERENCE_IMAGES} 张参考图")));
    }
}
