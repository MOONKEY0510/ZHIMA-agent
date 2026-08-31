//! Commands used by the show / hide animations.
//!
//! The animations themselves live in the renderer (react-spring drives
//! transform + opacity only); these commands are the thin channel the webview
//! uses to finish a hide once its exit animation has settled.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

/// Set while an exit animation is expected to be running.  The fallback timer
/// in `window::manager` hides the window if the webview never reports back.
pub static HIDE_PENDING: AtomicBool = AtomicBool::new(false);

/// Hide the window once its exit animation has finished playing.
#[tauri::command]
pub fn finish_hide(app: AppHandle) {
    HIDE_PENDING.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}
