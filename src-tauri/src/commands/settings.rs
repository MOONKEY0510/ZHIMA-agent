//! App info and global shortcut commands. Provider connectivity testing
//! moved to `providers::test_endpoint` in v0.2.

use tauri::{AppHandle, State};

use crate::models::config::AppInfo;
use crate::storage::config::ConfigStore;
use crate::window::shortcuts;

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[tauri::command]
pub fn get_shortcut(config: State<'_, ConfigStore>) -> String {
    config
        .read(|c| c.shortcut.clone())
        .unwrap_or_else(|| shortcuts::DEFAULT_SHORTCUT.to_string())
}

/// Validate, (re)register and persist a custom wake shortcut.
#[tauri::command]
pub fn set_shortcut(
    app: AppHandle,
    config: State<'_, ConfigStore>,
    value: String,
) -> Result<String, String> {
    let value = value.trim().to_string();
    // Throws before we touch anything if the accelerator is malformed.
    shortcuts::parse_shortcut(&value)?;
    // Throws (and notifies the window) if another program holds the chord.
    shortcuts::register_value(&app, &value)?;
    config.update(|c| {
        c.shortcut = Some(value.clone());
        Ok(())
    })?;
    Ok(value)
}
