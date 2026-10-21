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

/// Selected-text hotkey settings (P1-5).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickActionView {
    pub enabled: bool,
    pub shortcut: String,
}

#[tauri::command]
pub fn get_quick_action(config: State<'_, ConfigStore>) -> QuickActionView {
    config.read(|c| QuickActionView {
        enabled: c.quick_action_enabled,
        shortcut: c
            .quick_action_shortcut
            .clone()
            .unwrap_or_else(|| shortcuts::DEFAULT_QUICK_ACTION_SHORTCUT.to_string()),
    })
}

/// Validate, (re)register and persist the selected-text hotkey.
#[tauri::command]
pub fn set_quick_action(
    app: AppHandle,
    config: State<'_, ConfigStore>,
    enabled: bool,
    value: String,
) -> Result<QuickActionView, String> {
    let value = value.trim().to_string();
    shortcuts::parse_shortcut(&value)?;
    shortcuts::register_quick_action(&app, enabled, &value)?;
    config.update(|c| {
        c.quick_action_enabled = enabled;
        c.quick_action_shortcut = Some(value.clone());
        Ok(())
    })?;
    Ok(QuickActionView {
        enabled,
        shortcut: value,
    })
}

/// Full-conversation-mode hotkey settings.
#[tauri::command]
pub fn get_full_mode_shortcut(config: State<'_, ConfigStore>) -> String {
    config
        .read(|c| c.full_mode_shortcut.clone())
        .unwrap_or_else(|| shortcuts::DEFAULT_FULL_MODE_SHORTCUT.to_string())
}

/// Validate, (re)register and persist the full-mode hotkey.  An empty value
/// unbinds it (the feature stays reachable from the title bar).
#[tauri::command]
pub fn set_full_mode_shortcut(
    app: AppHandle,
    config: State<'_, ConfigStore>,
    value: String,
) -> Result<String, String> {
    let value = value.trim().to_string();
    if !value.is_empty() {
        // Throws before we touch anything if the accelerator is malformed.
        shortcuts::parse_shortcut(&value)?;
        // Throws (and notifies the window) if another program holds the chord.
        shortcuts::register_full_mode(&app, &value)?;
    } else {
        shortcuts::register_full_mode(&app, "")?;
    }
    config.update(|c| {
        c.full_mode_shortcut = Some(value.clone());
        Ok(())
    })?;
    Ok(value)
}
