//! Builtin tools shipped with the registry.

pub mod calculator;
pub mod capture_screen;
pub mod clipboard;
pub mod fetch_webpage;
pub mod file;
pub mod open_resource;
pub mod pdf;
pub mod time;
pub mod web_search;

use super::ToolDefinition;
use serde_json::Value;

pub fn definitions() -> Vec<ToolDefinition> {
    vec![
        time::definition(),
        calculator::definition(),
        clipboard::definition(),
        clipboard::write_definition(),
        web_search::definition(),
        fetch_webpage::definition(),
        file::definition(),
        pdf::definition(),
        capture_screen::definition(),
        open_resource::definition(),
    ]
}

pub async fn execute(client: &reqwest::Client, name: &str, args: Value) -> Result<Value, String> {
    match name {
        "get_current_time" => time::run(&args),
        "calculate" => calculator::run(&args),
        "read_clipboard" => clipboard::run(&args).await,
        "write_clipboard" => clipboard::write(&args).await,
        "web_search" => web_search::run(client, &args).await,
        "fetch_webpage" => fetch_webpage::run(client, &args).await,
        "select_and_read_text_file" => file::run().await,
        "read_pdf" => pdf::run().await,
        "capture_screen" => capture_screen::run(&args).await,
        "open_resource" => open_resource::run(&args).await,
        _ => Err(format!("未知工具: {name}")),
    }
}
