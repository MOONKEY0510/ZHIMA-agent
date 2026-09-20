//! Global shortcut registration (P1-5 / plan §9).
//!
//! Two chords are supported:
//! - the wake key (default `Alt+Space`) that shows/hides the window,
//! - the selected-text key (default `Alt+Q`) that captures the current
//!   selection and hands it to the window.
//!
//! The press handler itself lives in the plugin builder (see `lib.rs`); here
//! we register the configured chords and report conflicts to the frontend
//! instead of failing silently.

use tauri::{Emitter, Manager, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::storage::config::ConfigStore;

pub const DEFAULT_SHORTCUT: &str = "Alt+Space";
pub const DEFAULT_QUICK_ACTION_SHORTCUT: &str = "Alt+Q";

pub fn parse_shortcut(value: &str) -> Result<Shortcut, String> {
    value
        .trim()
        .parse::<Shortcut>()
        .map_err(|_| format!("快捷键格式不正确：{value}"))
}

/// The chords the configuration asks for: `(wake, selected-text?)`.
pub fn configured(app: &impl Manager<Wry>) -> (String, Option<String>) {
    let Some(store) = app.try_state::<ConfigStore>() else {
        return (DEFAULT_SHORTCUT.to_string(), None);
    };
    let wake = store
        .read(|cfg| cfg.shortcut.clone())
        .unwrap_or_else(|| DEFAULT_SHORTCUT.to_string());
    let quick = store.read(|cfg| {
        if cfg.quick_action_enabled {
            Some(
                cfg.quick_action_shortcut
                    .clone()
                    .unwrap_or_else(|| DEFAULT_QUICK_ACTION_SHORTCUT.to_string()),
            )
        } else {
            None
        }
    });
    (wake, quick)
}

/// Register the chords stored in config (or the defaults on first run).
pub fn register(app: &impl Manager<Wry>) -> tauri::Result<()> {
    let (wake, quick) = configured(app);
    for error in register_all(app, &wake, quick.as_deref()) {
        eprintln!("{error}");
    }
    Ok(())
}

/// (Re)register both chords; returns one message per failure and notifies the
/// window so the settings panel can show the conflict.
pub fn register_all(app: &impl Manager<Wry>, wake: &str, quick: Option<&str>) -> Vec<String> {
    let global = app.global_shortcut();
    // Replace whatever is currently registered.
    let _ = global.unregister_all();

    let mut errors = Vec::new();
    for value in std::iter::once(wake).chain(quick) {
        match parse_shortcut(value) {
            Ok(shortcut) => {
                if let Err(e) = global.register(shortcut) {
                    errors.push(format!(
                        "全局快捷键 {value} 注册失败，可能被其他程序占用：{e}"
                    ));
                }
            }
            Err(error) => errors.push(error),
        }
    }

    for error in &errors {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit("shortcut-error", error.clone());
        }
    }
    errors
}

/// (Re)register the wake chord, keeping the selected-text chord as-is.
/// Returns the wake chord's own error so the settings panel can reject it.
pub fn register_value(app: &impl Manager<Wry>, value: &str) -> Result<(), String> {
    let (_, quick) = configured(app);
    let errors = register_all(app, value, quick.as_deref());
    match errors.iter().find(|error| error.contains(value)) {
        Some(error) => Err(error.clone()),
        None => Ok(()),
    }
}

/// (Re)register the selected-text chord (enabled/disabled), keeping the wake key.
pub fn register_quick_action(
    app: &impl Manager<Wry>,
    enabled: bool,
    value: &str,
) -> Result<(), String> {
    let (wake, _) = configured(app);
    let quick = if enabled { Some(value) } else { None };
    let errors = register_all(app, &wake, quick);
    match errors.iter().find(|error| error.contains(value)) {
        Some(error) => Err(error.clone()),
        None => Ok(()),
    }
}

/// Does `pressed` belong to the selected-text hotkey?
pub fn is_quick_action(app: &impl Manager<Wry>, pressed: &Shortcut) -> bool {
    let (_, quick) = configured(app);
    quick
        .and_then(|value| parse_shortcut(&value).ok())
        .is_some_and(|configured| configured == *pressed)
}
