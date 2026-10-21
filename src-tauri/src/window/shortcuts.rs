//! Global shortcut registration (P1-5 / plan §9).
//!
//! Three chords are supported:
//! - the wake key (default `Alt+Space`) that shows/hides the window,
//! - the selected-text key (default `Alt+Q`) that captures the current
//!   selection and hands it to the window,
//! - the full-mode key (default `Alt+M`) that switches the window into the
//!   full conversation layout, and back out of it.
//!
//! The press handler itself lives in the plugin builder (see `lib.rs`); here
//! we register the configured chords and report conflicts to the frontend
//! instead of failing silently.

use tauri::{Emitter, Manager, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::storage::config::ConfigStore;

pub const DEFAULT_SHORTCUT: &str = "Alt+Space";
pub const DEFAULT_QUICK_ACTION_SHORTCUT: &str = "Alt+Q";
pub const DEFAULT_FULL_MODE_SHORTCUT: &str = "Alt+M";

pub fn parse_shortcut(value: &str) -> Result<Shortcut, String> {
    value
        .trim()
        .parse::<Shortcut>()
        .map_err(|_| format!("快捷键格式不正确：{value}"))
}

/// The chords the configuration asks for.  `None` means "not registered":
/// the quick-action key is disabled, or the chord is left blank.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Configured {
    pub wake: String,
    pub quick: Option<String>,
    pub full: Option<String>,
}

fn normalize(value: Option<&String>, fallback: &str) -> Option<String> {
    match value.map(|v| v.trim().to_string()) {
        // An explicitly empty string means "unbound".
        Some(v) if v.is_empty() => None,
        Some(v) => Some(v),
        None => Some(fallback.to_string()),
    }
}

/// Read the chords the configuration asks for.
pub fn configured(app: &impl Manager<Wry>) -> Configured {
    let Some(store) = app.try_state::<ConfigStore>() else {
        return Configured {
            wake: DEFAULT_SHORTCUT.to_string(),
            quick: None,
            full: Some(DEFAULT_FULL_MODE_SHORTCUT.to_string()),
        };
    };
    store.read(|cfg| Configured {
        wake: cfg
            .shortcut
            .clone()
            .unwrap_or_else(|| DEFAULT_SHORTCUT.to_string()),
        quick: if cfg.quick_action_enabled {
            normalize(
                cfg.quick_action_shortcut.as_ref(),
                DEFAULT_QUICK_ACTION_SHORTCUT,
            )
        } else {
            None
        },
        full: normalize(cfg.full_mode_shortcut.as_ref(), DEFAULT_FULL_MODE_SHORTCUT),
    })
}

/// Register the chords stored in config (or the defaults on first run).
pub fn register(app: &impl Manager<Wry>) -> tauri::Result<()> {
    let chords = configured(app);
    for error in register_all(app, &chords) {
        eprintln!("{error}");
    }
    Ok(())
}

/// (Re)register every chord; returns one message per failure and notifies the
/// window so the settings panel can show the conflict.
pub fn register_all(app: &impl Manager<Wry>, chords: &Configured) -> Vec<String> {
    let global = app.global_shortcut();
    // Replace whatever is currently registered.
    let _ = global.unregister_all();

    let mut errors = Vec::new();
    for value in std::iter::once(&chords.wake)
        .chain(chords.quick.iter())
        .chain(chords.full.iter())
    {
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

/// Pick the failure that belongs to `value` so the caller can reject that one
/// chord while the others stay registered.  An empty `value` is "not bound"
/// and therefore never fails on its own — an empty needle would otherwise
/// match every message.
fn error_for<'a>(errors: &'a [String], value: &str) -> Option<&'a String> {
    if value.is_empty() {
        return None;
    }
    errors.iter().find(|error| error.contains(value))
}

/// (Re)register the wake chord, keeping the other chords as-is.
/// Returns the wake chord's own error so the settings panel can reject it.
pub fn register_value(app: &impl Manager<Wry>, value: &str) -> Result<(), String> {
    let mut chords = configured(app);
    chords.wake = value.to_string();
    let errors = register_all(app, &chords);
    match error_for(&errors, value) {
        Some(error) => Err(error.clone()),
        None => Ok(()),
    }
}

/// (Re)register the selected-text chord (enabled/disabled), keeping the others.
pub fn register_quick_action(
    app: &impl Manager<Wry>,
    enabled: bool,
    value: &str,
) -> Result<(), String> {
    let mut chords = configured(app);
    chords.quick = enabled.then(|| value.to_string());
    let errors = register_all(app, &chords);
    match error_for(&errors, value) {
        Some(error) => Err(error.clone()),
        None => Ok(()),
    }
}

/// (Re)register the full-mode chord, keeping the other chords as-is.
pub fn register_full_mode(app: &impl Manager<Wry>, value: &str) -> Result<(), String> {
    let mut chords = configured(app);
    chords.full = (!value.is_empty()).then(|| value.to_string());
    let errors = register_all(app, &chords);
    match error_for(&errors, value) {
        Some(error) => Err(error.clone()),
        None => Ok(()),
    }
}

/// Does `pressed` belong to the selected-text hotkey?
pub fn is_quick_action(app: &impl Manager<Wry>, pressed: &Shortcut) -> bool {
    matches_chord(app, pressed, |chords| chords.quick.as_deref())
}

/// Does `pressed` belong to the full-mode hotkey?
pub fn is_full_mode(app: &impl Manager<Wry>, pressed: &Shortcut) -> bool {
    matches_chord(app, pressed, |chords| chords.full.as_deref())
}

fn matches_chord<F>(app: &impl Manager<Wry>, pressed: &Shortcut, pick: F) -> bool
where
    F: FnOnce(&Configured) -> Option<&str>,
{
    let chords = configured(app);
    pick(&chords)
        .and_then(|value| parse_shortcut(value).ok())
        .is_some_and(|configured| configured == *pressed)
}
