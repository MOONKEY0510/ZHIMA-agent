//! Avatar image management: read / save custom avatar PNGs for AI and user.
//!
//! Avatars are stored as PNG files in the app config directory. The frontend
//! reads them via the `convertFileSrc` protocol so no base64 round-trip is
//! needed for display.

use std::fs;
use std::io::Cursor;
use std::path::PathBuf;

use base64::Engine;
use tauri::Manager;

const AI_AVATAR_FILE: &str = "avatar-ai.png";
const USER_AVATAR_FILE: &str = "avatar-user.png";
const BACKGROUND_IMAGE_FILE: &str = "background.png";

/// Upper bound on the base64 payload accepted for an avatar.  Avatars are
/// small; anything larger is almost certainly a mistake or an attack.
const MAX_AVATAR_BASE64: usize = 2 * 1024 * 1024; // 2 MB
/// Upper bound on decoded pixel count (e.g. ~4000x4000).  Checked before a
/// full decode so a tiny compressed image cannot balloon into a huge bitmap.
const MAX_AVATAR_PIXELS: u64 = 16_000_000;

fn avatars_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法解析配置目录: {e}"))?;
    let avatar_dir = dir.join("avatars");
    fs::create_dir_all(&avatar_dir).map_err(|e| format!("无法创建头像目录: {e}"))?;
    Ok(avatar_dir)
}

/// Save a base64-encoded image as the AI or user avatar PNG.
/// `kind` must be `"ai"` or `"user"`.
/// `data` is a raw base64 string (no data-URI prefix).
#[tauri::command]
pub fn save_avatar(app: tauri::AppHandle, kind: String, data: String) -> Result<String, String> {
    let dir = avatars_dir(&app)?;
    let filename = match kind.as_str() {
        "ai" => AI_AVATAR_FILE,
        "user" => USER_AVATAR_FILE,
        "background" => BACKGROUND_IMAGE_FILE,
        _ => return Err("无效的图片类型".into()),
    };
    let path = dir.join(filename);

    // Bound the base64 payload before decoding.
    if data.len() > MAX_AVATAR_BASE64 {
        return Err(format!(
            "头像图片过大（超过 {} MB）",
            MAX_AVATAR_BASE64 / 1024 / 1024
        ));
    }

    // Decode base64 → image bytes → re-encode as PNG (normalise format).
    let raw = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("base64 解码失败: {e}"))?;

    // Check dimensions BEFORE a full decode so a decompression bomb cannot
    // allocate a huge bitmap in memory.
    let reader = image::ImageReader::new(Cursor::new(&raw))
        .with_guessed_format()
        .map_err(|e| format!("图片格式识别失败: {e}"))?;
    let (w, h) = reader
        .into_dimensions()
        .map_err(|e| format!("图片解析失败: {e}"))?;
    if (w as u64) * (h as u64) > MAX_AVATAR_PIXELS {
        return Err("头像图片像素过大".into());
    }

    let img = image::load_from_memory(&raw).map_err(|e| format!("图片解析失败: {e}"))?;
    // Use DynamicImage::save so we don't fight with ExtendedColorType APIs.
    img.save(&path).map_err(|e| format!("保存头像失败: {e}"))?;

    path.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "路径编码失败".into())
}

/// Delete the AI or user avatar, reverting to the default (shape + color).
#[tauri::command]
pub fn delete_avatar(app: tauri::AppHandle, kind: String) -> Result<(), String> {
    let dir = avatars_dir(&app)?;
    let filename = match kind.as_str() {
        "ai" => AI_AVATAR_FILE,
        "user" => USER_AVATAR_FILE,
        "background" => BACKGROUND_IMAGE_FILE,
        _ => return Err("无效的图片类型".into()),
    };
    let path = dir.join(filename);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除头像失败: {e}"))?;
    }
    Ok(())
}

/// Return the filesystem path to the avatar file (or empty string if it
/// doesn't exist). The frontend uses `convertFileSrc` to display it.
#[tauri::command]
pub fn get_avatar_path(app: tauri::AppHandle, kind: String) -> Result<String, String> {
    let dir = avatars_dir(&app)?;
    let filename = match kind.as_str() {
        "ai" => AI_AVATAR_FILE,
        "user" => USER_AVATAR_FILE,
        "background" => BACKGROUND_IMAGE_FILE,
        _ => return Err("无效的图片类型".into()),
    };
    let path = dir.join(filename);
    if path.exists() {
        Ok(path.to_string_lossy().to_string())
    } else {
        Ok(String::new())
    }
}
