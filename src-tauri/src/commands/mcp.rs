//! MCP server management (P1-10): CRUD, connection test, and the discovered
//! tool list.

use serde::Serialize;
use tauri::{Manager, State};

use crate::mcp::McpToolInfo;
use crate::state::AppState;
use crate::storage::config::{ConfigStore, McpServerConfig};

/// One server plus its live state, as shown in the settings panel.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerView {
    #[serde(flatten)]
    pub config: McpServerConfig,
    /// Ready-to-display command line (`npx -y …`).
    pub command_line: String,
    /// Tools discovered on the last refresh.
    pub tools: Vec<McpToolInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpView {
    pub servers: Vec<McpServerView>,
}

fn build_view(config: &ConfigStore, state: &AppState) -> McpView {
    let servers = config.read(|cfg| cfg.mcp_servers.clone());
    let discovered = state.mcp.cached_tools();
    McpView {
        servers: servers
            .into_iter()
            .map(|server| McpServerView {
                tools: discovered
                    .iter()
                    .filter(|tool| tool.server_id == server.id)
                    .cloned()
                    .collect(),
                command_line: server.command_line(),
                config: server,
            })
            .collect(),
    }
}

#[tauri::command]
pub fn list_mcp_servers(
    config: State<'_, ConfigStore>,
    state: State<'_, AppState>,
) -> Result<McpView, String> {
    Ok(build_view(&config, &state))
}

/// Create (empty id) or update a server, then refresh the tool list.
#[tauri::command]
pub async fn upsert_mcp_server(
    config: State<'_, ConfigStore>,
    state: State<'_, AppState>,
    server: McpServerConfig,
) -> Result<McpView, String> {
    let mut server = server;
    server.name = server.name.trim().to_string();
    server.command = server.command.trim().to_string();
    if server.name.is_empty() {
        return Err("请填写服务器名称".into());
    }
    if server.command.is_empty() {
        return Err("请填写启动命令（例如 npx / uvx / 绝对路径）".into());
    }
    if server.id.trim().is_empty() {
        server.id = new_server_id();
    }

    config.update(|cfg| {
        match cfg
            .mcp_servers
            .iter_mut()
            .find(|existing| existing.id == server.id)
        {
            Some(existing) => *existing = server.clone(),
            None => cfg.mcp_servers.push(server.clone()),
        }
        Ok(())
    })?;

    let servers = config.read(|cfg| cfg.mcp_servers.clone());
    let errors = state.mcp.refresh(&servers).await;
    if !errors.is_empty() {
        // The server is saved; surface why discovery failed.
        return Err(errors.join("\n"));
    }
    Ok(build_view(&config, &state))
}

#[tauri::command]
pub async fn delete_mcp_server(
    config: State<'_, ConfigStore>,
    state: State<'_, AppState>,
    id: String,
) -> Result<McpView, String> {
    config.update(|cfg| {
        cfg.mcp_servers.retain(|server| server.id != id);
        Ok(())
    })?;
    let servers = config.read(|cfg| cfg.mcp_servers.clone());
    state.mcp.refresh(&servers).await;
    Ok(build_view(&config, &state))
}

/// Start the server, handshake, and report the tools it exposes.
#[tauri::command]
pub async fn test_mcp_server(
    config: State<'_, ConfigStore>,
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<McpToolInfo>, String> {
    let servers = config.read(|cfg| cfg.mcp_servers.clone());
    let server = servers
        .iter()
        .find(|server| server.id == id)
        .ok_or_else(|| "服务器不存在".to_string())?;
    if !server.enabled {
        return Err("该服务器处于禁用状态".into());
    }

    let errors = state.mcp.refresh(&servers).await;
    let tools: Vec<McpToolInfo> = state
        .mcp
        .cached_tools()
        .into_iter()
        .filter(|tool| tool.server_id == id)
        .collect();

    if tools.is_empty() {
        return Err(if errors.is_empty() {
            format!("「{}」未返回任何工具", server.name)
        } else {
            errors.join("\n")
        });
    }
    Ok(tools)
}

/// Enable / disable without touching the rest of the configuration.
#[tauri::command]
pub async fn set_mcp_server_enabled(
    config: State<'_, ConfigStore>,
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<McpView, String> {
    config.update(|cfg| {
        if let Some(server) = cfg.mcp_servers.iter_mut().find(|s| s.id == id) {
            server.enabled = enabled;
        }
        Ok(())
    })?;
    let servers = config.read(|cfg| cfg.mcp_servers.clone());
    let errors = state.mcp.refresh(&servers).await;
    if !errors.is_empty() {
        return Err(errors.join("\n"));
    }
    Ok(build_view(&config, &state))
}

/// Best-effort refresh used for the post-launch idle warm-up.
pub async fn refresh_from_config(config: &ConfigStore, state: &AppState) {
    let servers = config.read(|cfg| cfg.mcp_servers.clone());
    if servers.iter().any(|server| server.enabled) {
        state.mcp.ensure_warm(&servers).await;
    }
}

/// Start enabled MCP servers in the background (never blocks the caller).
///
/// Servers are no longer launched at app start: a cold start should not pay for
/// child processes the user may never touch. This is the on-demand trigger —
/// used when the settings panel opens and when a chat turn is sent — so a
/// server added mid-session becomes available without a restart. The current
/// turn keeps running with whatever is already cached.
pub fn warm_in_background(window: &tauri::Window) {
    let handle = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let config = handle.state::<ConfigStore>();
        let state = handle.state::<AppState>();
        let servers = config.read(|cfg| cfg.mcp_servers.clone());
        if servers.iter().any(|server| server.enabled) {
            state.mcp.ensure_warm(&servers).await;
        }
    });
}

/// Frontend trigger: warm the servers when the MCP panel is opened.
#[tauri::command]
pub async fn warm_mcp_servers(
    config: State<'_, ConfigStore>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let servers = config.read(|cfg| cfg.mcp_servers.clone());
    if !servers.iter().any(|server| server.enabled) {
        return Ok(());
    }
    state.mcp.ensure_warm(&servers).await;
    Ok(())
}

fn new_server_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("mcp-{millis:x}-{:x}", SEQ.fetch_add(1, Ordering::Relaxed))
}

/// Re-export for the settings UI's "JSON 快捷粘贴" helper.
#[tauri::command]
pub fn parse_mcp_json(json: String) -> Result<McpServerConfig, String> {
    let value: serde_json::Value = serde_json::from_str(json.trim())
        .map_err(|_| "JSON 解析失败，请检查是否复制完整".to_string())?;

    let command = value
        .get("command")
        .and_then(|c| c.as_str())
        .ok_or("缺少 command 字段")?;
    let args = value
        .get("args")
        .and_then(|a| a.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let env = value
        .get("env")
        .and_then(|e| e.as_object())
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| value.as_str().map(|v| (key.clone(), v.to_string())))
                .collect()
        })
        .unwrap_or_default();

    Ok(McpServerConfig {
        id: String::new(),
        name: value
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("MCP 服务器")
            .to_string(),
        command: command.to_string(),
        args,
        env,
        enabled: true,
    })
}
