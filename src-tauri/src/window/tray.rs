//! System tray icon and menu (plan §3.1 A).

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

use crate::window::manager;
use crate::window::shortcuts;

/// Embedded tray icon source PNG.
const TRAY_PNG: &[u8] = include_bytes!("../../icons/tray.png");

fn tray_icon() -> tauri::image::Image<'static> {
    let img = image::load_from_memory(TRAY_PNG).expect("decode embedded tray icon");
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    tauri::image::Image::new_owned(rgba.into_raw(), w, h)
}

pub fn create(app: &tauri::App) -> tauri::Result<()> {
    let shortcut_label = app
        .try_state::<crate::storage::config::ConfigStore>()
        .and_then(|c| c.read(|cfg| cfg.shortcut.clone()))
        .unwrap_or_else(|| shortcuts::DEFAULT_SHORTCUT.to_string());

    let toggle_item =
        MenuItemBuilder::with_id("toggle", format!("显示 / 隐藏（{shortcut_label}）"))
            .build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "退出芝麻").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&toggle_item, &quit_item])
        .build()?;

    TrayIconBuilder::with_id("main-tray")
        .icon(tray_icon())
        .icon_as_template(false)
        .tooltip("芝麻 · 桌面 AI 助手")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => manager::toggle(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left button only: right-click must just open the menu, and the
            // menu taking focus must not bounce the window via hide-on-blur.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                manager::toggle(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}
