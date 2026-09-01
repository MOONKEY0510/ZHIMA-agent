mod agent;
mod api;
mod commands;
mod errors;
mod models;
mod state;
mod storage;
mod tools;
mod window;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch just re-focuses the existing floating window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                window::manager::show_and_focus(&w);
            }
        }))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        window::manager::toggle(app);
                    }
                })
                .build(),
        )
        .manage(state::AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::chat::chat_send,
            commands::chat::chat_cancel,
            commands::chat::chat_approve_tool,
            commands::chat::describe_image,
            commands::imagegen::generate_image,
            commands::imagegen::save_image_generation,
            commands::imagegen::list_image_generations,
            commands::imagegen::delete_image_generation,
            commands::imagegen::clear_image_generations,
            commands::settings::app_info,
            commands::settings::get_shortcut,
            commands::settings::set_shortcut,
            commands::providers::get_providers_state,
            commands::providers::upsert_provider,
            commands::providers::delete_provider,
            commands::providers::set_default,
            commands::providers::add_model,
            commands::providers::remove_model,
            commands::providers::toggle_favorite,
            commands::providers::toggle_vision,
            commands::providers::set_vision_model,
            commands::providers::set_image_model,
            commands::providers::add_models,
            commands::providers::fetch_models,
            commands::providers::test_endpoint,
            commands::providers::set_generation,
            commands::providers::set_default_system_prompt,
            commands::providers::set_remember_window_position,
            commands::providers::save_window_position,
            commands::providers::get_remember_window_position,
            commands::providers::set_proxy,
            commands::tools::list_tools,
            commands::tools::set_tool_policy,
            commands::tools::read_clipboard_text,
            commands::tools::write_clipboard_text,
            commands::window::finish_hide,
            commands::history::list_conversations,
            commands::history::get_conversation,
            commands::history::create_conversation,
            commands::history::begin_chat_turn,
            commands::history::save_message,
            commands::history::touch_conversation,
            commands::history::rename_conversation,
            commands::history::set_conversation_system_prompt,
            commands::history::delete_conversation,
            commands::history::clear_all_history,
            commands::memory::list_memories,
            commands::memory::create_memory,
            commands::memory::update_memory,
            commands::memory::set_memory_enabled,
            commands::memory::delete_memory,
            commands::memory::clear_memories,
            commands::diagnostics::list_runs,
            commands::diagnostics::clear_runs,
            commands::avatar::save_avatar,
            commands::avatar::delete_avatar,
            commands::avatar::get_avatar_path,
        ])
        .setup(|app| {
            // Provider configuration lives in the app config dir; keys are
            // in the system credential store (see storage::secrets).
            let config_dir = app
                .path()
                .app_config_dir()
                .map_err(|e| format!("cannot resolve config dir: {e}"))?;
            std::fs::create_dir_all(&config_dir)
                .map_err(|e| format!("cannot create config dir: {e}"))?;
            let config_store =
                storage::config::ConfigStore::load(config_dir.join("providers.json"));
            // Apply the persisted proxy settings to the shared HTTP client.
            let (proxy_url, use_system_proxy) =
                config_store.read(|cfg| (cfg.proxy_url.clone(), cfg.use_system_proxy));
            if proxy_url.is_some() || use_system_proxy {
                app.state::<state::AppState>()
                    .rebuild_http_client(proxy_url.as_deref(), use_system_proxy);
            }
            app.manage(config_store);

            // Conversation history database (migrations + crash recovery run
            // inside `open`).
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("cannot resolve data dir: {e}"))?;
            let db = storage::database::Database::open(&data_dir.join("chatfloat.db"))
                .map_err(|e| format!("database init failed: {e}"))?;
            app.manage(db);

            window::tray::create(app)?;
            window::shortcuts::register(app)?;

            // The wake animation flies the full-size (mostly transparent)
            // window in from the tray; a drop shadow would give away its true
            // size and read as a flicker.  We remove the shadow and explicitly
            // ask Windows 11 to keep the rounded corners.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_shadow(false);
                #[cfg(target_os = "windows")]
                window::manager::force_rounded_corners(&w);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Zhima");
}
