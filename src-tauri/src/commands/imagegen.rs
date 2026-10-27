//! Image generation and reference-image editing via OpenAI-compatible APIs.
//!
//! Also manages persisted generation history (`image_generations` table).

use base64::Engine;
use reqwest::multipart::{Form, Part};
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
const MAX_REFERENCE_IMAGE_BYTES: usize = 10 * 1024 * 1024;

/// Reference protocols are selected explicitly, never guessed from model names
/// or retried as text-only generation when an image request fails.
#[derive(Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ReferenceImageMode {
    #[default]
    Edits,
    Generations,
}

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
    #[serde(default)]
    pub reference_image_mode: ReferenceImageMode,
}

fn default_image_size() -> String {
    "1024x1024".into()
}

struct ReferenceImage {
    data_url: String,
    bytes: Vec<u8>,
    mime: &'static str,
    extension: &'static str,
}

fn parse_reference_images(refs: &[String]) -> Result<Vec<ReferenceImage>, String> {
    if refs.len() > MAX_REFERENCE_IMAGES {
        return Err(format!(
            "一次最多支持 {MAX_REFERENCE_IMAGES} 张参考图（当前 {} 张）",
            refs.len()
        ));
    }
    refs.iter()
        .enumerate()
        .map(|(index, value)| {
            let invalid = || {
                format!(
                    "参考图 {} 无效，请重新上传 PNG、JPEG 或 WebP 图片",
                    index + 1
                )
            };
            let (header, data) = value.split_once(',').ok_or_else(invalid)?;
            let (mime, extension) = match header {
                "data:image/png;base64" => ("image/png", "png"),
                "data:image/jpeg;base64" => ("image/jpeg", "jpg"),
                "data:image/webp;base64" => ("image/webp", "webp"),
                _ => return Err(invalid()),
            };
            if data.len() > MAX_REFERENCE_IMAGE_BYTES.div_ceil(3) * 4 {
                return Err(format!("参考图 {} 超过 10 MB", index + 1));
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|_| invalid())?;
            if bytes.is_empty() {
                return Err(invalid());
            }
            if bytes.len() > MAX_REFERENCE_IMAGE_BYTES {
                return Err(format!("参考图 {} 超过 10 MB", index + 1));
            }
            Ok(ReferenceImage {
                data_url: value.clone(),
                bytes,
                mime,
                extension,
            })
        })
        .collect()
}

/// Pure request construction shared by the command and wire-level regression tests.
fn image_request(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    request: &GenerateImageRequest,
) -> Result<reqwest::RequestBuilder, String> {
    if request.prompt.trim().is_empty() {
        return Err("请输入图像描述".into());
    }
    let refs = parse_reference_images(request.reference_images.as_deref().unwrap_or_default())?;
    let base = base_url.trim_end_matches('/');
    let mut body = serde_json::json!({
        "model": request.model_key,
        "prompt": request.prompt.trim(),
        "n": 1,
        "response_format": "b64_json",
    });
    match (request.width, request.height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => {
            body["width"] = w.into();
            body["height"] = h.into();
        }
        (None, None) => {
            body["size"] = request.size.clone().into();
        }
        _ => return Err("自定义宽度和高度必须同时设置且大于 0".into()),
    }

    // Native GPT Image APIs always return base64 and reject response_format.
    // This is a documented protocol exception, not a guess about optional
    // quality/background/moderation capabilities on compatible providers.
    if request.model_key.starts_with("gpt-image-") {
        body.as_object_mut().unwrap().remove("response_format");
    }

    if !refs.is_empty() && request.reference_image_mode == ReferenceImageMode::Edits {
        let mut form = Form::new();
        for (key, value) in body.as_object().unwrap() {
            let value = value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string());
            form = form.text(key.clone(), value);
        }
        let field = if refs.len() == 1 { "image" } else { "image[]" };
        for (index, image) in refs.into_iter().enumerate() {
            let part = Part::bytes(image.bytes)
                .file_name(format!("reference-{}.{}", index + 1, image.extension))
                .mime_str(image.mime)
                .map_err(|e| format!("构造参考图失败: {e}"))?;
            form = form.part(field, part);
        }
        return Ok(client
            .post(format!("{base}/images/edits"))
            .bearer_auth(api_key)
            .multipart(form));
    }

    if !refs.is_empty() {
        // JSON reference providers require complete data URLs, including MIME.
        body["image"] = if refs.len() == 1 {
            refs[0].data_url.clone().into()
        } else {
            refs.into_iter()
                .map(|image| image.data_url)
                .collect::<Vec<_>>()
                .into()
        };
    }
    Ok(client
        .post(format!("{base}/images/generations"))
        .bearer_auth(api_key)
        .json(&body))
}

fn image_response(text: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("解析图像响应失败: {e}"))?;
    let b64 = value
        .get("data")
        .and_then(|d| d.get(0))
        .and_then(|d| d.get("b64_json"))
        .and_then(|b| b.as_str())
        .filter(|b| !b.is_empty())
        .ok_or_else(|| {
            "图像生成未返回有效的 base64 图片数据，请确认服务商支持当前图像接口".to_string()
        })?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|_| "图像响应包含无效的 base64 数据".to_string())?;
    let mime = match image::guess_format(&bytes) {
        Ok(image::ImageFormat::Png) => "image/png",
        Ok(image::ImageFormat::Jpeg) => "image/jpeg",
        Ok(image::ImageFormat::WebP) => "image/webp",
        _ => return Err("图像响应不是支持的 PNG、JPEG 或 WebP 图片".into()),
    };
    Ok(format!("data:{mime};base64,{b64}"))
}

/// Generate an image and return it as a base64-encoded PNG/JPEG data URL.
#[tauri::command]
pub async fn generate_image(
    state: State<'_, AppState>,
    config: State<'_, ConfigStore>,
    request: GenerateImageRequest,
) -> Result<String, String> {
    let (base_url, api_key) = config.read(|cfg| {
        let provider = cfg
            .providers
            .iter()
            .find(|p| p.id == request.provider_id)
            .ok_or_else(|| "图像模型服务商不存在".to_string())?;
        let key = secrets::get_api_key(&provider.id)?
            .ok_or_else(|| "图像模型服务商未配置 API Key".to_string())?;
        Ok::<_, String>((provider.base_url.clone(), key))
    })?;

    let client = state.http.lock().unwrap().clone();
    let resp = image_request(&client, &base_url, &api_key, &request)?
        .send()
        .await
        .map_err(|e| format!("图像生成请求失败: {}", brief(&e)))?;

    let status = resp.status().as_u16();
    let text = read_body_capped(resp, MAX_IMAGE_RESPONSE_BYTES).await?;
    if !(200..300).contains(&status) {
        let (_, message, _) = crate::api::openai_chat::map_http_error(status, &text);
        return Err(message);
    }

    image_response(&text)
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

    if let Some(json) = &request.reference_images_json {
        let max_json_bytes =
            MAX_REFERENCE_IMAGES * (MAX_REFERENCE_IMAGE_BYTES.div_ceil(3) * 4 + 64);
        if json.len() > max_json_bytes {
            return Err("参考图数据过大".into());
        }
        let refs: Vec<String> =
            serde_json::from_str(json).map_err(|_| "参考图历史数据格式无效".to_string())?;
        parse_reference_images(&refs)?;
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
    use http_body_util::BodyExt;

    const PNG_REFERENCE: &str = "data:image/png;base64,iVBORw0KGgo=";
    const JPEG_REFERENCE: &str = "data:image/jpeg;base64,/9j/";

    fn request(refs: Vec<&str>, mode: ReferenceImageMode) -> GenerateImageRequest {
        GenerateImageRequest {
            provider_id: "fixture".into(),
            model_key: "gpt-image-1".into(),
            prompt: "改成蓝色背景".into(),
            size: "1024x1024".into(),
            width: None,
            height: None,
            reference_images: Some(refs.into_iter().map(str::to_owned).collect()),
            reference_image_mode: mode,
        }
    }

    fn build(request: &GenerateImageRequest) -> reqwest::Request {
        image_request(
            &reqwest::Client::new(),
            "https://fixture.invalid/v1/",
            "secret",
            request,
        )
        .unwrap()
        .build()
        .unwrap()
    }

    fn json_body(request: &reqwest::Request) -> serde_json::Value {
        serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap()
    }

    async fn body_bytes(mut request: reqwest::Request) -> Vec<u8> {
        request
            .body_mut()
            .take()
            .unwrap()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec()
    }

    #[test]
    fn generations_json_contains_every_reference_as_complete_data_url() {
        let request = build(&request(
            vec![PNG_REFERENCE, JPEG_REFERENCE],
            ReferenceImageMode::Generations,
        ));
        assert_eq!(request.url().path(), "/v1/images/generations");
        let body = json_body(&request);
        assert_eq!(
            body["image"],
            serde_json::json!([PNG_REFERENCE, JPEG_REFERENCE])
        );
        assert_eq!(body["prompt"], "改成蓝色背景");
    }

    #[test]
    fn generations_json_keeps_single_reference_shape() {
        let request = build(&request(
            vec![PNG_REFERENCE],
            ReferenceImageMode::Generations,
        ));
        assert_eq!(json_body(&request)["image"], PNG_REFERENCE);
    }

    #[test]
    fn no_reference_stays_on_generations_without_image_field() {
        let request = build(&request(Vec::new(), ReferenceImageMode::Edits));
        assert_eq!(request.url().path(), "/v1/images/generations");
        assert!(json_body(&request).get("image").is_none());
    }

    #[tokio::test]
    async fn edits_multipart_uploads_the_actual_image_bytes() {
        let request = build(&request(vec![PNG_REFERENCE], ReferenceImageMode::Edits));
        assert_eq!(request.url().path(), "/v1/images/edits");
        assert!(request.headers()[reqwest::header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("multipart/form-data; boundary="));
        let body = body_bytes(request).await;
        let text = String::from_utf8_lossy(&body);
        assert_eq!(text.matches("name=\"image\"").count(), 1);
        assert!(text.contains("filename=\"reference-1.png\""));
        assert!(text.contains("name=\"prompt\""));
        assert!(text.contains("改成蓝色背景"));
        assert!(body.windows(8).any(|bytes| bytes == b"\x89PNG\r\n\x1a\n"));
    }

    #[tokio::test]
    async fn edits_multipart_uploads_all_images_with_array_fields() {
        let request = build(&request(
            vec![PNG_REFERENCE, JPEG_REFERENCE],
            ReferenceImageMode::Edits,
        ));
        let body = body_bytes(request).await;
        let text = String::from_utf8_lossy(&body);
        assert_eq!(text.matches("name=\"image[]\"").count(), 2);
        assert!(text.contains("filename=\"reference-1.png\""));
        assert!(text.contains("filename=\"reference-2.jpg\""));
        assert!(body.windows(2).any(|bytes| bytes == b"\xff\xd8"));
    }

    #[test]
    fn malformed_reference_is_rejected_instead_of_falling_back_to_text_only() {
        let result = image_request(
            &reqwest::Client::new(),
            "https://fixture.invalid/v1",
            "secret",
            &request(vec!["not-a-data-url"], ReferenceImageMode::Edits),
        );
        assert!(result.is_err());
    }
}
