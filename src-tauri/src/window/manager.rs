//! Floating window show/hide/toggle behavior, including keeping the window
//! on-screen after monitor changes (plan §9).

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{Emitter, Manager, PhysicalPosition, WebviewWindow, Wry};

use crate::storage::config::ConfigStore;

/// How long to wait for the webview's exit animation before hiding anyway.
/// A dismissal that lingers feels broken; keep this tight, but still long
/// enough to cover one missed frame.
const HIDE_GRACE_MS: u64 = 320;

pub fn main_window(app: &impl Manager<Wry>) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

/// Show the window and give it focus, pulling it back onto the screen if it
/// somehow ended up off-screen (e.g. a monitor was unplugged).
///
/// The window itself is never resized or moved for the animation — the
/// renderer drives everything with transform/opacity so the whole thing stays
/// on the compositor.  We only place the window and tell the frontend to play.
pub fn show_and_focus(window: &WebviewWindow) {
    #[cfg(target_os = "windows")]
    force_rounded_corners(window);

    let final_pos = resolve_position(window);
    let _ = window.set_position(final_pos);
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    // The frontend uses this to suppress the blur event that fires right
    // after a programmatic show (tray / hotkey), which would otherwise
    // trigger hide-on-blur instantly, and to start the entry animation.
    let _ = window.emit("window-shown", true);
}

/// Hotkey / tray semantics: visible + focused → hide; otherwise → show.
pub fn toggle(app: &impl Manager<Wry>) {
    let Some(window) = main_window(app) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);

    if visible && focused {
        // The frontend saves on its own hide paths; do it here too so the
        // "remember position" setting also survives a hotkey / tray toggle.
        save_position(&window);
        // Hand the hide over to the webview so it can play its exit
        // animation; it calls `finish_hide` once the springs settle.
        let _ = window.emit("window-prepare-hide", true);
        arm_hide_fallback(&window);
    } else {
        show_and_focus(&window);
    }
}

/// Hide the window if the exit animation never reports back.  Without this a
/// busy or crashed renderer would leave an undismissable window on screen.
fn arm_hide_fallback(window: &WebviewWindow) {
    use crate::commands::window::HIDE_PENDING;

    HIDE_PENDING.store(true, Ordering::SeqCst);
    let handle = window.app_handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(HIDE_GRACE_MS));
        if !HIDE_PENDING.swap(false, Ordering::SeqCst) {
            return;
        }
        let inner = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if let Some(win) = inner.get_webview_window("main") {
                let _ = win.hide();
            }
        });
    });
}

/// Explicitly request rounded corners after removing the window shadow.
/// Windows 11 normally rounds undecorated transparent windows, but disabling
/// the shadow can strip that rounding; this attribute restores it.
#[cfg(target_os = "windows")]
pub fn force_rounded_corners(window: &WebviewWindow) {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };

    let Ok(hwnd) = window.hwnd() else { return };
    let preference = DWMWCP_ROUND;
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &preference as *const _ as *const _,
            std::mem::size_of_val(&preference) as u32,
        );
    }
}

/// Persist the current position when "remember window position" is enabled.
fn save_position(window: &WebviewWindow) {
    let Ok(pos) = window.outer_position() else { return };
    if let Some(store) = window.app_handle().try_state::<ConfigStore>() {
        let _ = store.update(|cfg| {
            if cfg.remember_window_position {
                cfg.window_x = Some(pos.x);
                cfg.window_y = Some(pos.y);
            }
            Ok(())
        });
    }
}

/// Where the window should rest when shown:
/// - the saved position, when "remember position" is on and it is still on a
///   visible monitor;
/// - otherwise its current position, wherever the user last dragged it;
/// - re-centred only when it ended up mostly off-screen.
///
/// The target is *computed* rather than read back after `set_position`: that
/// call is asynchronous, so `outer_position()` immediately afterwards still
/// reports the old value — which made the wake animation fly back to the
/// pre-restore position and look like the window never moved.
fn resolve_position(window: &WebviewWindow) -> PhysicalPosition<i32> {
    let current = window
        .outer_position()
        .unwrap_or(PhysicalPosition::new(0, 0));

    let saved = window
        .app_handle()
        .try_state::<ConfigStore>()
        .and_then(|c| {
            c.read(|cfg| {
                if cfg.remember_window_position {
                    cfg.window_x.zip(cfg.window_y)
                } else {
                    None
                }
            })
        });

    if let Some((x, y)) = saved {
        if is_position_visible(window, x, y) {
            return PhysicalPosition::new(x, y);
        }
    }

    // Mostly outside its monitor → re-centre, per the product spec the
    // quick-ask window sits centred horizontally and a third from the top.
    if mostly_off_screen(window, current) {
        if let (Ok(Some(monitor)), Ok(size)) = (window.current_monitor(), window.outer_size()) {
            let m_pos = monitor.position();
            let m_size = monitor.size();
            return PhysicalPosition::new(
                m_pos.x + (m_size.width as i32 - size.width as i32) / 2,
                m_pos.y + (m_size.height as i32 - size.height as i32) / 3,
            );
        }
    }

    current
}

/// Check whether the given position keeps the window mostly on-screen.
fn is_position_visible(window: &WebviewWindow, x: i32, y: i32) -> bool {
    !mostly_off_screen(window, PhysicalPosition::new(x, y))
}

/// True when a window placed at `pos` would sit mostly outside its monitor.
fn mostly_off_screen(window: &WebviewWindow, pos: PhysicalPosition<i32>) -> bool {
    let (Ok(Some(monitor)), Ok(win_size)) = (window.current_monitor(), window.outer_size()) else {
        return false;
    };
    let mon_pos = monitor.position();
    let mon_size = monitor.size();
    let (sw, sh) = (mon_size.width as i32, mon_size.height as i32);
    let (ww, wh) = (win_size.width as i32, win_size.height as i32);

    pos.x + ww < mon_pos.x + 48
        || pos.x > mon_pos.x + sw - 48
        || pos.y + wh < mon_pos.y + 48
        || pos.y > mon_pos.y + sh - 48
}
