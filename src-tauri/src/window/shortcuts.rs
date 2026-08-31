//! Global shortcut registration (default: Alt+Space, user-customizable).
//!
//! The press handler itself lives in the plugin builder (see `lib.rs`); here
//! we register the configured chord and report conflicts to the frontend
//! instead of failing silently (plan §9).

use tauri::{Emitter, Manager, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

pub const DEFAULT_SHORTCUT: &str = "Alt+Space";

pub fn parse_shortcut(value: &str) -> Result<Shortcut, String> {
    value
        .trim()
        .parse::<Shortcut>()
        .map_err(|_| format!("快捷键格式不正确：{value}"))
}

/// Register the shortcut stored in config (or the default on first run).
pub fn register(app: &impl Manager<Wry>) -> tauri::Result<()> {
    let stored = app
        .try_state::<crate::storage::config::ConfigStore>()
        .and_then(|c| c.read(|cfg| cfg.shortcut.clone()));

    let value = stored.unwrap_or_else(|| DEFAULT_SHORTCUT.to_string());
    let _ = register_value(app, &value);
    Ok(())
}

/// (Re)register `value`, emitting `shortcut-error` to the window on conflict.
pub fn register_value(app: &impl Manager<Wry>, value: &str) -> Result<(), String> {
    let shortcut = parse_shortcut(value)?;
    let gs = app.global_shortcut();
    // Replace whatever is currently registered.
    let _ = gs.unregister_all();
    match gs.register(shortcut) {
        Ok(()) => Ok(()),
        Err(e) => {
            let msg = format!("全局快捷键 {value} 注册失败，可能被其他程序占用：{e}");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("shortcut-error", msg.clone());
            }
            eprintln!("{msg}");
            Err(msg)
        }
    }
}
