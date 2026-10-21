//! Commands used by the show / hide animations.
//!
//! The animations themselves live in the renderer (react-spring drives
//! transform + opacity only); these commands are the thin channel the webview
//! uses to finish a hide once its exit animation has settled.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;
use tauri::{AppHandle, Manager, PhysicalSize};

/// One keyframe of a window-geometry animation: physical pixels at `ms`
/// milliseconds after the animation starts. Sizes are linearly interpolated
/// between frames; the final frame is held from its timestamp on.
#[derive(Clone, Deserialize)]
pub struct SizeKeyframe {
    pub width: u32,
    pub height: u32,
    pub ms: u32,
}

/// Drive a window resize through a keyframe timeline from a dedicated thread.
///
/// Doing it here instead of one IPC round-trip per `requestAnimationFrame`
/// removes IPC jitter from the pacing — and WebView2 compositor reallocations
/// land on a stable cadence instead of whatever the busy renderer can spare.
/// A short delay before each frame lets the previous frame's set_size settle
/// on the main thread before the next request arrives.
#[tauri::command]
pub fn animate_size(app: AppHandle, frames: Vec<SizeKeyframe>) {
    if frames.is_empty() {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        let start = std::time::Instant::now();
        let mut prev = frames[0].clone();
        for frame in &frames[1..] {
            if frame.ms > 0 {
                let elapsed = start.elapsed().as_millis() as u32;
                if frame.ms > elapsed {
                    std::thread::sleep(std::time::Duration::from_millis(
                        (frame.ms - elapsed) as u64,
                    ));
                }
            }
            let span = frame.ms.saturating_sub(prev.ms).max(1);
            let t = (start.elapsed().as_millis() as u32)
                .saturating_sub(prev.ms)
                .min(span) as f32
                / span as f32;
            let width = prev.width as f32 + (frame.width as f32 - prev.width as f32) * t;
            let height = prev.height as f32 + (frame.height as f32 - prev.height as f32) * t;
            let inner = handle.clone();
            let size = PhysicalSize::new(width.round() as u32, height.round() as u32);
            let _ = handle.run_on_main_thread(move || {
                if let Some(win) = inner.get_webview_window("main") {
                    let _ = win.set_size(size);
                }
            });
            // Yield so the main thread can apply this frame before the next
            // one is queued — otherwise frames bunch up at the end.
            std::thread::sleep(std::time::Duration::from_millis(4));
            prev = frame.clone();
        }
    });
}

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
