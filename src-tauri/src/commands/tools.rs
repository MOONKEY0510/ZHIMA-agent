//! Tool metadata exposed to the frontend.

use serde_json::json;
use tauri::State;

use crate::state::AppState;
use crate::storage::config::{ConfigStore, ToolPolicy};

/// Return every tool the model can currently call for the UI's tool panel,
/// merged with the user's per-tool policy: the built-in registry plus the
/// tools discovered from connected MCP servers (they are offered during chat,
/// so the panel must show them as well).
///
/// The frontend renders every tool's name, description, risk level and
/// whether it requires per-call confirmation. This keeps a single source of
/// truth in Rust; the UI never hard-codes the registry.
#[tauri::command]
pub fn list_tools(
    config: State<'_, ConfigStore>,
    state: State<'_, AppState>,
) -> Vec<serde_json::Value> {
    let policies = config.read(|cfg| cfg.tool_policies.clone());
    let mut tools: Vec<serde_json::Value> = crate::tools::ToolRegistry::builtin()
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
        .collect();

    for tool in state.mcp.cached_tools() {
        let policy = policies.get(&tool.qualified).copied().unwrap_or_default();
        tools.push(json!({
            "name": tool.qualified,
            "description": format!("[MCP · {}] {}", tool.server_name, tool.description),
            "riskLevel": "mcp",
            "requiresConfirmation": true,
            "policy": policy.as_str(),
        }));
    }
    tools
}

/// Update the per-tool usage policy. `always_allow` explicitly waives
/// ordinary tool confirmation, not approval to send local data externally.
///
/// MCP tools always require confirmation per call (`can_remember: false` in
/// the agent loop), so `always_allow` is refused for them instead of being
/// stored and silently ignored.
#[tauri::command]
pub fn set_tool_policy(
    config: State<'_, ConfigStore>,
    state: State<'_, AppState>,
    name: String,
    policy: String,
) -> Result<(), String> {
    let parsed = ToolPolicy::parse(&policy).ok_or_else(|| "无效的工具策略".to_string())?;
    let is_mcp_tool = state
        .mcp
        .cached_tools()
        .iter()
        .any(|tool| tool.qualified == name);
    if is_mcp_tool && parsed == ToolPolicy::AlwaysAllow {
        return Err("MCP 工具不支持永久允许，请选择每次确认或禁用".into());
    }
    if !is_mcp_tool && crate::tools::ToolRegistry::builtin().find(&name).is_none() {
        return Err(format!("未知工具: {name}"));
    }
    config.update(|cfg| {
        if parsed == ToolPolicy::Allow {
            cfg.tool_policies.remove(&name);
        } else {
            cfg.tool_policies.insert(name.clone(), parsed);
        }
        Ok(())
    })?;
    state
        .session_tool_approvals
        .lock()
        .unwrap()
        .retain(|(_, tool)| tool != &name);
    Ok(())
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
