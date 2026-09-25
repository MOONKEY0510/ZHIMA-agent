//! Minimal MCP (Model Context Protocol) client over stdio (P1-10).
//!
//! Implements the subset an assistant needs — `initialize`, `tools/list` and
//! `tools/call` — spoken as newline-delimited JSON-RPC 2.0 on the child
//! process's stdin/stdout.  Written by hand (~300 lines) instead of pulling in
//! a full SDK, to keep the binary small and the trust boundary obvious:
//! every MCP tool is registered as *needs confirmation* and never runs
//! without the existing approval flow.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::storage::config::McpServerConfig;
use crate::tools::registry::{DataAccess, ToolDefinition};

/// How long the handshake may take.
const INIT_TIMEOUT: Duration = Duration::from_secs(10);
/// Per-call ceiling.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// A session idle for this long is killed (the next call respawns it).
const IDLE_TIMEOUT: Duration = Duration::from_secs(600);
/// Characters of a tool result handed to the model.
const MAX_RESULT_CHARS: usize = 100_000;

/// One tool discovered from an MCP server.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub server_id: String,
    pub server_name: String,
    /// Tool name as the server calls it (used in `tools/call`).
    pub tool_name: String,
    /// Registry name, `mcp_<server>_<tool>` — what the model sees.
    pub qualified: String,
    pub description: String,
    pub schema: Value,
}

struct Session {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
    last_used: Instant,
}

/// Owns the child processes and the discovered tool list.
///
/// A session is either parked in `sessions` (idle) or checked out in `busy`
/// (a request is in flight).  Checkout/checkin keeps the async paths free of
/// held locks, so the futures stay `Send` and two concurrent calls to the same
/// server cannot drive one stdin stream at the same time.
#[derive(Default)]
pub struct McpManager {
    sessions: Mutex<HashMap<String, Session>>,
    busy: Mutex<std::collections::HashSet<String>>,
    tools: Mutex<Vec<McpToolInfo>>,
    /// Guards [`McpManager::ensure_warm`] against overlapping warm-ups.
    warming: AtomicBool,
}

impl McpManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Tool list from the last refresh (no I/O) — what the registry uses.
    pub fn cached_tools(&self) -> Vec<McpToolInfo> {
        self.tools.lock().unwrap().clone()
    }

    /// Warm the tool cache once, without blocking the caller and without
    /// starting a second warm-up while one is in flight.
    ///
    /// Servers are launched on demand rather than at app start, so every
    /// trigger — first send, opening the settings panel, the post-launch
    /// idle moment — goes through here. An empty cache plus a concurrent
    /// trigger would otherwise spawn every server twice.
    pub async fn ensure_warm(&self, servers: &[McpServerConfig]) {
        if !self.cached_tools().is_empty() {
            return;
        }
        if self.warming.swap(true, Ordering::SeqCst) {
            return;
        }
        let errors = self.refresh(servers).await;
        self.warming.store(false, Ordering::SeqCst);
        for error in errors {
            eprintln!("MCP 服务器启动失败：{error}");
        }
    }

    /// Spawn/refresh every enabled server and cache the discovered tools.
    /// Returns one human-readable error per server that failed.
    pub async fn refresh(&self, servers: &[McpServerConfig]) -> Vec<String> {
        let enabled: Vec<McpServerConfig> = servers.iter().filter(|s| s.enabled).cloned().collect();
        let keep: Vec<String> = enabled.iter().map(|s| s.id.clone()).collect();

        // Stop sessions whose server was disabled or removed.
        {
            let mut sessions = self.sessions.lock().unwrap();
            let stale: Vec<String> = sessions
                .keys()
                .filter(|id| !keep.contains(id))
                .cloned()
                .collect();
            for id in stale {
                if let Some(mut session) = sessions.remove(&id) {
                    let _ = session.child.start_kill();
                }
            }
        }

        let mut errors: Vec<String> = Vec::new();
        let mut discovered: Vec<McpToolInfo> = Vec::new();
        for server in &enabled {
            match self.server_tools(server).await {
                Ok(mut tools) => discovered.append(&mut tools),
                Err(err) => errors.push(format!("{}: {err}", server.name)),
            }
        }
        *self.tools.lock().unwrap() = discovered;
        errors
    }

    /// Take a session out of the pool (no lock is held while it is in use).
    async fn checkout(&self, server_id: &str) -> Result<Session, String> {
        for _ in 0..400 {
            {
                let mut sessions = self.sessions.lock().unwrap();
                if let Some(session) = sessions.remove(server_id) {
                    self.busy.lock().unwrap().insert(server_id.to_string());
                    return Ok(session);
                }
            }
            if self.busy.lock().unwrap().contains(server_id) {
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
            return Err("会话未就绪".into());
        }
        Err("该 MCP 服务器正忙，请稍后重试".into())
    }

    /// Return a session to the pool.
    fn checkin(&self, server_id: &str, session: Session) {
        self.busy.lock().unwrap().remove(server_id);
        self.sessions
            .lock()
            .unwrap()
            .insert(server_id.to_string(), session);
    }

    /// Ensure a session exists, run the handshake when it is new, and list
    /// the server's tools.
    async fn server_tools(&self, server: &McpServerConfig) -> Result<Vec<McpToolInfo>, String> {
        self.ensure_session(server).await?;

        let mut session = self.checkout(&server.id).await?;
        let result = request(&mut session, "tools/list", json!({}), INIT_TIMEOUT).await;
        session.last_used = Instant::now();
        self.checkin(&server.id, session);
        let result = result?;

        let tools = result
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(tools
            .into_iter()
            .filter_map(|tool| {
                let name = tool.get("name").and_then(Value::as_str)?.to_string();
                Some(McpToolInfo {
                    server_id: server.id.clone(),
                    server_name: server.name.clone(),
                    qualified: qualify(&server.id, &name),
                    tool_name: name,
                    description: tool
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    schema: tool
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
                })
            })
            .collect())
    }

    /// Call one tool and return its text content.
    pub async fn call(
        &self,
        servers: &[McpServerConfig],
        server_id: &str,
        tool_name: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        let server = servers
            .iter()
            .find(|s| s.id == server_id)
            .ok_or_else(|| "MCP 服务器不存在或已删除".to_string())?;
        if !server.enabled {
            return Err(format!("MCP 服务器「{}」已禁用", server.name));
        }

        self.ensure_session(server).await?;

        let mut session = self.checkout(server_id).await?;
        let result = request(
            &mut session,
            "tools/call",
            json!({ "name": tool_name, "arguments": arguments }),
            CALL_TIMEOUT,
        )
        .await;
        session.last_used = Instant::now();
        // A failed call usually means the process died; `ensure_session` drops
        // the session on the next attempt because `try_wait` reports the exit.
        self.checkin(server_id, session);
        let result = result?;

        let text = extract_text(&result);
        if result
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Err(if text.is_empty() {
                "MCP 工具返回错误".to_string()
            } else {
                text
            });
        }

        // Bound what reaches the model, mirroring the builtin tools' cap.
        let (text, truncated) =
            crate::tools::document_parse::truncate_chars(&text, MAX_RESULT_CHARS);
        Ok(json!({ "tool": tool_name, "text": text, "truncated": truncated }))
    }

    /// Kill every session (app exit / tests).
    pub fn shutdown_all(&self) {
        self.busy.lock().unwrap().clear();
        let mut sessions = self.sessions.lock().unwrap();
        for (_, mut session) in sessions.drain() {
            let _ = session.child.start_kill();
        }
    }

    /// Drop sessions that have been idle for too long.
    pub fn reap_idle(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        let idle: Vec<String> = sessions
            .iter()
            .filter(|(_, s)| s.last_used.elapsed() > IDLE_TIMEOUT)
            .map(|(id, _)| id.clone())
            .collect();
        for id in idle {
            if let Some(mut session) = sessions.remove(&id) {
                let _ = session.child.start_kill();
            }
        }
    }

    /// Reuse a live session, otherwise spawn and handshake a new one.
    async fn ensure_session(&self, server: &McpServerConfig) -> Result<(), String> {
        let alive = {
            let mut sessions = self.sessions.lock().unwrap();
            match sessions.get_mut(&server.id) {
                // `try_wait` returns Some(..) once the child exited.
                Some(session) => match session.child.try_wait() {
                    Ok(None) => {
                        session.last_used = Instant::now();
                        true
                    }
                    _ => {
                        sessions.remove(&server.id);
                        false
                    }
                },
                None => false,
            }
        };
        if alive {
            return Ok(());
        }

        let mut session = spawn(server)?;
        initialize(&mut session).await?;
        self.sessions
            .lock()
            .unwrap()
            .insert(server.id.clone(), session);
        Ok(())
    }
}

impl Drop for McpManager {
    fn drop(&mut self) {
        self.shutdown_all();
    }
}

/* ---------------- protocol helpers ---------------- */

/// `mcp_<server>_<tool>` with everything non-alphanumeric folded to `_`, so the
/// name stays a valid function name for every provider.
pub fn qualify(server_id: &str, tool_name: &str) -> String {
    let sanitize = |input: &str| -> String {
        input
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect()
    };
    format!("mcp_{}_{}", sanitize(server_id), sanitize(tool_name))
}

/// Join the text parts of a `tools/call` result.
fn extract_text(result: &Value) -> String {
    let Some(items) = result.get("content").and_then(Value::as_array) else {
        return String::new();
    };
    let mut out = String::new();
    for item in items {
        let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "text" {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(text);
            }
        }
    }
    out
}

/// Turn a discovered tool into a registry entry.  MCP tools always need an
/// explicit confirmation and are treated as local-sensitive (the server runs
/// on this machine and may touch anything the user can).
pub fn to_tool_definition(info: &McpToolInfo) -> ToolDefinition {
    ToolDefinition {
        name: info.qualified.clone(),
        description: format!("[MCP · {}] {}", info.server_name, info.description),
        parameters: normalize_schema(&info.schema),
        risk_level: "medium".into(),
        requires_confirmation: true,
        timeout_ms: 60_000,
        max_result_bytes: 300_000,
        data_access: DataAccess::LocalSensitive,
        network_access: false,
    }
}

/// Make sure the schema is an object schema the validator accepts.
fn normalize_schema(schema: &Value) -> Value {
    let is_object = schema.get("type").and_then(Value::as_str) == Some("object");
    if is_object && schema.get("properties").is_some() {
        return schema.clone();
    }
    json!({ "type": "object", "properties": {} })
}

fn spawn(server: &McpServerConfig) -> Result<Session, String> {
    let mut command = Command::new(&server.command);
    command
        .args(&server.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (key, value) in &server.env {
        command.env(key, value);
    }

    #[cfg(windows)]
    {
        // No console window for the child process (tokio's own helper).
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动（{}）：{e}", server.command))?;
    let stdin = child.stdin.take().ok_or("进程缺少 stdin")?;
    let stdout = child.stdout.take().ok_or("进程缺少 stdout")?;

    Ok(Session {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        next_id: 1,
        last_used: Instant::now(),
    })
}

/// `initialize` handshake plus the `notifications/initialized` notice.
async fn initialize(session: &mut Session) -> Result<(), String> {
    request(
        session,
        "initialize",
        json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "zhima", "version": env!("CARGO_PKG_VERSION") },
        }),
        INIT_TIMEOUT,
    )
    .await?;

    let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    let mut line = serde_json::to_string(&note).map_err(|e| e.to_string())?;
    line.push('\n');
    session
        .stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("发送初始化通知失败：{e}"))?;
    session
        .stdin
        .flush()
        .await
        .map_err(|e| format!("发送初始化通知失败：{e}"))?;
    Ok(())
}

/// Send one JSON-RPC request and wait for its response (notifications and
/// non-JSON log lines on stdout are skipped).
async fn request(
    session: &mut Session,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let id = session.next_id;
    session.next_id += 1;

    let payload = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    let mut line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    line.push('\n');
    session
        .stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("发送 {method} 失败：{e}"))?;
    session
        .stdin
        .flush()
        .await
        .map_err(|e| format!("发送 {method} 失败：{e}"))?;

    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let mut buffer = String::new();
        let read = tokio::time::timeout_at(deadline, session.stdout.read_line(&mut buffer))
            .await
            .map_err(|_| format!("{method} 超时（{}s）", timeout.as_secs()))?
            .map_err(|e| format!("读取响应失败：{e}"))?;
        if read == 0 {
            return Err("MCP 进程已退出".into());
        }

        let trimmed = buffer.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue; // stdout may carry log lines
        };
        if value.get("id").and_then(Value::as_i64) != Some(id) {
            continue; // a notification or a response to another request
        }
        if let Some(error) = value.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("未知错误");
            return Err(format!("{method} 失败：{message}"));
        }
        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qualified_names_are_sanitized() {
        assert_eq!(qualify("mcp-1", "read/file"), "mcp_mcp_1_read_file");
        assert_eq!(qualify("srv", "list"), "mcp_srv_list");
    }

    #[test]
    fn tool_result_text_is_joined() {
        let result = json!({
            "content": [
                { "type": "text", "text": "第一段" },
                { "type": "image", "data": "..." },
                { "type": "text", "text": "第二段" }
            ]
        });
        assert_eq!(extract_text(&result), "第一段\n第二段");
        assert_eq!(extract_text(&json!({})), "");
    }

    #[test]
    fn mcp_tools_always_require_confirmation() {
        let info = McpToolInfo {
            server_id: "s1".into(),
            server_name: "filesystem".into(),
            tool_name: "read_file".into(),
            qualified: qualify("s1", "read_file"),
            description: "读文件".into(),
            schema: json!({ "type": "object", "properties": { "path": { "type": "string" } } }),
        };
        let definition = to_tool_definition(&info);
        assert_eq!(definition.name, "mcp_s1_read_file");
        assert!(definition.requires_confirmation);
        assert_eq!(definition.data_access, DataAccess::LocalSensitive);
        assert!(definition.description.contains("[MCP · filesystem]"));
        assert!(definition.description.contains("读文件"));
    }

    #[test]
    fn malformed_schemas_fall_back_to_an_object() {
        assert_eq!(
            normalize_schema(&json!({ "type": "string" })),
            json!({ "type": "object", "properties": {} })
        );
        assert_eq!(
            normalize_schema(&json!({})),
            json!({ "type": "object", "properties": {} })
        );
    }

    #[test]
    fn cached_tools_start_empty_and_shutdown_is_safe() {
        let manager = McpManager::new();
        assert!(manager.cached_tools().is_empty());
        manager.reap_idle();
        manager.shutdown_all();
    }
}
