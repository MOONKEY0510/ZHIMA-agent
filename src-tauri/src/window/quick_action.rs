//! Selected-text capture for the quick-action hotkey (P1-5).
//!
//! Windows has no supported "read the selection" API, so the established
//! technique (uTools, Snipaste, …) is: remember the clipboard, synthesize
//! Ctrl+C, poll the clipboard for the copy, then restore what was there.
//!
//! Known limitation: synthesised keystrokes do not reach elevated (UAC)
//! windows — Windows blocks `SendInput` from a normal-integrity process to a
//! higher-integrity one.  The error message says so instead of failing silently.

use std::time::Duration;

use tauri::Emitter;

/// How long we wait for the copy to land in the clipboard.
const POLL_TIMEOUT: Duration = Duration::from_millis(800);
const POLL_INTERVAL: Duration = Duration::from_millis(40);

/// Hotkey entry point: wake the window, capture the selection in the
/// background and emit the result.
///
/// The window is shown immediately (so the user sees feedback right away) and
/// the captured text arrives as `quick-action` a moment later; failures come
/// back as `quick-action-error`.
pub fn trigger(app: &tauri::AppHandle) {
    let Some(window) = crate::window::manager::main_window(app) else {
        return;
    };
    crate::window::manager::show_and_focus(&window);

    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (event, payload) = match capture_selection() {
            Ok(text) => ("quick-action", text),
            Err(error) => ("quick-action-error", error),
        };
        if let Some(window) = crate::window::manager::main_window(&handle) {
            let _ = window.emit(event, payload);
        }
    });
}

/// Capture the current selection.  Blocking (clipboard + sleeps), so call it
/// from a blocking task.
pub fn capture_selection() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("无法访问剪贴板：{e}"))?;
    let previous = clipboard.get_text().ok();

    send_copy()?;

    let deadline = std::time::Instant::now() + POLL_TIMEOUT;
    while std::time::Instant::now() < deadline {
        std::thread::sleep(POLL_INTERVAL);
        let Ok(text) = clipboard.get_text() else {
            continue;
        };
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Unchanged content means the copy never happened (nothing selected,
        // or the target window is elevated).
        if Some(&text) == previous.as_ref() {
            continue;
        }
        restore(&mut clipboard, previous);
        return Ok(trimmed.to_string());
    }

    restore(&mut clipboard, previous);
    Err("未能获取选中文本：请先在目标程序里选中文本，或改用「复制后按热键」（管理员权限窗口无法通过热键取词）".into())
}

/// Put the clipboard back the way we found it (best effort).
fn restore(clipboard: &mut arboard::Clipboard, previous: Option<String>) {
    if let Some(text) = previous {
        let _ = clipboard.set_text(text);
    }
}

#[cfg(windows)]
fn send_copy() -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VIRTUAL_KEY, VK_C, VK_CONTROL,
    };

    fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: if up {
                        KEYEVENTF_KEYUP
                    } else {
                        KEYBD_EVENT_FLAGS(0)
                    },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    let inputs = [
        key(VK_CONTROL, false),
        key(VK_C, false),
        key(VK_C, true),
        key(VK_CONTROL, true),
    ];
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent == 0 {
        return Err("模拟复制按键失败（目标窗口可能是管理员权限）".into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn send_copy() -> Result<(), String> {
    Err("当前平台暂不支持划词取词".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn quick_action_module_compiles() {
        // The capture path needs a real desktop session, so only the
        // non-interactive pieces are covered here.
        assert!(super::POLL_TIMEOUT.as_millis() >= 500);
    }
}
