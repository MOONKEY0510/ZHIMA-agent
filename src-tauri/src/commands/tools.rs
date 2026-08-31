//! Tool metadata exposed to the frontend.

use serde_json::json;
use tauri::State;

use crate::storage::config::{ConfigStore, ToolPolicy};

/// Return the builtin tool definitions for the UI's tool panel, merged with
/// the user's per-tool policy.
///
/// The frontend renders every tool's name, description, risk level and
/// whether it requires per-call confirmation. This keeps a single source of
/// truth in Rust; the UI never hard-codes the registry.
#[tauri::command]
pub fn list_tools(config: State<'_, ConfigStore>) -> Vec<serde_json::Value> {
    let policies = config.read(|cfg| cfg.tool_policies.clone());
    crate::tools::ToolRegistry::builtin()
        .all()
        .iter()
        .map(|t| {
            let policy = policies.get(&t.name).copied().unwrap_or_default();
            json!({
                "name": t.name,
                "description": t.description,
                "riskLevel": t.risk_level,
                "requiresConfirmation": t.requires_confirmation,
                "policy": policy.as_str(),
            })
        })
        .collect()
}

/// Update the per-tool usage policy. `policy` is one of
/// `allow` / `confirm` / `disabled`.
#[tauri::command]
pub fn set_tool_policy(
    config: State<'_, ConfigStore>,
    name: String,
    policy: String,
) -> Result<(), String> {
    let parsed = ToolPolicy::parse(&policy).ok_or_else(|| "无效的工具策略".to_string())?;
    if crate::tools::ToolRegistry::builtin().find(&name).is_none() {
        return Err(format!("未知工具: {name}"));
    }
    config.update(|cfg| {
        if parsed == ToolPolicy::Allow {
            cfg.tool_policies.remove(&name);
        } else {
            cfg.tool_policies.insert(name.clone(), parsed);
        }
        Ok(())
    })
}

/// Read the current clipboard text.  Unlike the agent tool, this is an
/// explicit user action (clipboard quick actions) so it never prompts for
/// confirmation.
#[tauri::command]
pub fn read_clipboard_text() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("无法访问剪贴板: {e}"))?;
    clipboard
        .get_text()
        .map_err(|e| format!("剪贴板中无可用文本: {e}"))
}

/// Write text to the clipboard.  Explicit user action (clipboard quick
/// actions), no confirmation prompt.
#[tauri::command]
pub fn write_clipboard_text(text: String) -> Result<(), String> {
    if text.len() > 65_536 {
        return Err("写入剪贴板的文本不能超过 64 KiB".into());
    }
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("无法访问剪贴板: {e}"))?;
    clipboard
        .set_text(&text)
        .map_err(|e| format!("写入剪贴板失败: {e}"))
}
