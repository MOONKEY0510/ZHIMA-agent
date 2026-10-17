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

/// Exact launch identity; intentionally not Debug/Serialize (env may contain secrets).
#[derive(Clone, PartialEq, Eq)]
struct LaunchConfig {
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
}

impl From<&McpServerConfig> for LaunchConfig {
    fn from(server: &McpServerConfig) -> Self {
        Self {
            command: server.command.clone(),
            args: server.args.clone(),
            env: server.env.clone(),
        }
    }
}

/// Keep lease contention distinct from protocol/spawn failures: only the former
/// permits discovery to retain a healthy same-generation cache.
#[derive(Debug)]
enum SessionError {
    Busy,
    Failed(String),
}

impl From<String> for SessionError {
    fn from(error: String) -> Self {
        Self::Failed(error)
    }
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy => f.write_str("该 MCP 服务器正忙，请稍后重试"),
            Self::Failed(error) => f.write_str(error),
        }
    }
}

struct ServerVersion {
    launch: LaunchConfig,
    generation: u64,
}

#[derive(Default)]
struct Pool {
    configured: bool,
    serial: u64,
    refresh: u64,
    warming: Option<u64>,
    servers: HashMap<String, ServerVersion>,
    sessions: HashMap<String, Session>,
    busy: HashMap<String, u64>,
    tools: Vec<McpToolInfo>,
}

impl Pool {
    fn next_serial(&mut self) -> u64 {
        self.serial = self.serial.checked_add(1).expect("MCP generation overflow");
        self.serial
    }

    fn is_current(&self, id: &str, generation: u64) -> bool {
        self.servers
            .get(id)
            .is_some_and(|v| v.generation == generation)
    }
}

/// Pool state, configuration generations and cache publication share one short
/// lock. No lock is held over process I/O. Old generations may finish in flight,
/// but can neither re-enter the pool nor clear a newer generation's busy slot.
#[derive(Default)]
pub struct McpManager {
    pool: Mutex<Pool>,
    #[cfg(test)]
    lease_attempts: Option<usize>,
}

/// Captured synchronously while the caller still holds the config read lock.
/// Discovery may complete out of order; only the latest ticket may publish.
pub(crate) struct Refresh {
    revision: u64,
    servers: Vec<(McpServerConfig, u64)>,
}

/// Also reserves the slot during initialize. Dropping a cancelled/failed lease
/// clears only its own reservation and kills its process via kill_on_drop.
struct Lease<'a> {
    manager: &'a McpManager,
    id: String,
    generation: u64,
    session: Option<Session>,
}

impl Lease<'_> {
    fn checkin(mut self) {
        let mut pool = self.manager.pool.lock().unwrap();
        if pool.is_current(&self.id, self.generation) {
            if let Some(session) = self.session.take() {
                pool.sessions.insert(self.id.clone(), session);
            }
        }
    }
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        let mut pool = self.manager.pool.lock().unwrap();
        if pool.busy.get(&self.id) == Some(&self.generation) {
            pool.busy.remove(&self.id);
        }
    }
}

impl McpManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Tool list from the last refresh (no I/O) — what the registry uses.
    pub fn cached_tools(&self) -> Vec<McpToolInfo> {
        self.pool.lock().unwrap().tools.clone()
    }

    /// Warm the tool cache once, without blocking the caller and without
    /// starting a second warm-up while one is in flight.
    ///
    /// Servers are launched on demand rather than at app start, so every
    /// trigger — first send, opening the settings panel, the post-launch
    /// idle moment — goes through here. An empty cache plus a concurrent
    /// trigger would otherwise spawn every server twice.
    pub(crate) fn prepare_warm(&self, servers: &[McpServerConfig]) -> Option<Refresh> {
        // Reconcile even with a populated cache or an overlapping warm-up.
        // A configuration change must invalidate old work immediately.
        self.prepare(servers, true)
    }

    pub(crate) async fn finish_warm(&self, refresh: Refresh) {
        struct Reset<'a>(&'a McpManager, u64);
        impl Drop for Reset<'_> {
            fn drop(&mut self) {
                let mut pool = self.0.pool.lock().unwrap();
                if pool.warming == Some(self.1) {
                    pool.warming = None;
                }
            }
        }
        let _reset = Reset(self, refresh.revision);
        for error in self.finish_refresh(refresh).await {
            eprintln!("MCP 服务器启动失败：{error}");
        }
    }

    pub(crate) fn prepare_refresh(&self, servers: &[McpServerConfig]) -> Refresh {
        self.prepare(servers, false).unwrap()
    }

    fn prepare(&self, servers: &[McpServerConfig], warm: bool) -> Option<Refresh> {
        let mut pool = self.pool.lock().unwrap();
        pool.configured = true;
        let mut versions = HashMap::new();
        let mut enabled = Vec::new();
        for server in servers.iter().filter(|s| s.enabled) {
            let launch = LaunchConfig::from(server);
            let generation = match pool.servers.get(&server.id) {
                Some(old) if old.launch == launch => old.generation,
                _ => pool.next_serial(),
            };
            versions.insert(server.id.clone(), ServerVersion { launch, generation });
            enabled.push((server.clone(), generation));
        }
        let changed = pool.servers.len() != versions.len()
            || versions
                .iter()
                .any(|(id, v)| !pool.is_current(id, v.generation));
        let stale: Vec<_> = pool
            .servers
            .iter()
            .filter(|(id, old)| {
                versions
                    .get(*id)
                    .is_none_or(|new| new.generation != old.generation)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            pool.sessions.remove(&id);
            pool.busy.remove(&id);
            pool.tools.retain(|tool| tool.server_id != id);
        }
        pool.servers = versions;
        if warm {
            if !changed && !pool.tools.is_empty() {
                return None;
            }
            // Changed configurations must get a discovery even if the previous
            // warm-up is still in flight. Its ticket is already invalidated.
            if pool.warming.is_some() && !changed {
                return None;
            }
        }
        pool.refresh = pool.next_serial();
        if warm {
            pool.warming = Some(pool.refresh);
        }
        Some(Refresh {
            revision: pool.refresh,
            servers: enabled,
        })
    }

    /// Spawn/refresh enabled servers. The synchronous prepare step is also used
    /// by commands under ConfigStore::read to preserve configuration ordering.
    #[cfg(test)]
    async fn refresh(&self, servers: &[McpServerConfig]) -> Vec<String> {
        self.finish_refresh(self.prepare_refresh(servers)).await
    }

    pub(crate) async fn finish_refresh(&self, refresh: Refresh) -> Vec<String> {
        let mut errors = Vec::new();
        let mut discovered = Vec::new();
        for (server, generation) in &refresh.servers {
            if self.pool.lock().unwrap().refresh != refresh.revision {
                break;
            }
            match self.server_tools(server, *generation).await {
                Ok(mut tools) => discovered.append(&mut tools),
                Err(err) => {
                    if matches!(err, SessionError::Busy) {
                        let pool = self.pool.lock().unwrap();
                        if pool.refresh == refresh.revision
                            && pool.is_current(&server.id, *generation)
                        {
                            // prepare removed tools for every changed generation;
                            // only lease contention may reuse the remaining cache.
                            discovered.extend(
                                pool.tools
                                    .iter()
                                    .filter(|tool| tool.server_id == server.id)
                                    .cloned()
                                    .map(|mut tool| {
                                        tool.server_name = server.name.clone();
                                        tool
                                    }),
                            );
                        }
                    }
                    errors.push(format!("{}: {err}", server.name));
                }
            }
        }
        let mut pool = self.pool.lock().unwrap();
        if pool.refresh == refresh.revision {
            pool.tools = discovered;
        }
        errors
    }

    /// Ensure a session exists, run the handshake when it is new, and list
    /// the server's tools.
    async fn server_tools(
        &self,
        server: &McpServerConfig,
        generation: u64,
    ) -> Result<Vec<McpToolInfo>, SessionError> {
        let mut lease = self.ensure_session(server, generation).await?;
        let session = lease.session.as_mut().unwrap();
        let result = request(session, "tools/list", json!({}), INIT_TIMEOUT).await;
        session.last_used = Instant::now();
        if result.is_ok() {
            lease.checkin();
        }
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

        let generation = {
            let mut pool = self.pool.lock().unwrap();
            // Support a cold direct call, but never let an old chat snapshot
            // overwrite configuration already observed by a refresh.
            if !pool.configured {
                for item in servers.iter().filter(|s| s.enabled) {
                    let generation = pool.next_serial();
                    pool.servers.insert(
                        item.id.clone(),
                        ServerVersion {
                            launch: LaunchConfig::from(item),
                            generation,
                        },
                    );
                }
                pool.configured = true;
            }
            let version = pool
                .servers
                .get(server_id)
                .filter(|v| v.launch == LaunchConfig::from(server))
                .ok_or("MCP 服务器配置已更新、禁用或删除，请重试")?;
            version.generation
        };
        let mut lease = self
            .ensure_session(server, generation)
            .await
            .map_err(|err| err.to_string())?;
        let session = lease.session.as_mut().unwrap();
        let result = request(
            session,
            "tools/call",
            json!({ "name": tool_name, "arguments": arguments }),
            CALL_TIMEOUT,
        )
        .await;
        session.last_used = Instant::now();
        // Protocol failures/timeouts leave stream state uncertain: discard it.
        if result.is_ok() {
            lease.checkin();
        }
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

    /// Kill parked sessions and invalidate borrowed ones (app exit / tests).
    /// Borrowed requests finish or time out before their process is dropped.
    pub fn shutdown_all(&self) {
        let mut pool = self.pool.lock().unwrap();
        pool.refresh = pool.next_serial();
        pool.configured = true;
        pool.servers.clear();
        pool.busy.clear();
        pool.sessions.clear();
        pool.tools.clear();
        pool.warming = None;
    }

    /// Drop sessions that have been idle for too long.
    pub fn reap_idle(&self) {
        self.pool
            .lock()
            .unwrap()
            .sessions
            .retain(|_, s| s.last_used.elapsed() <= IDLE_TIMEOUT);
    }

    /// Atomically reserve and borrow a current session (including during spawn).
    /// The captured generation never changes while waiting, even for A→B→A.
    async fn ensure_session(
        &self,
        server: &McpServerConfig,
        generation: u64,
    ) -> Result<Lease<'_>, SessionError> {
        let attempts = 400;
        #[cfg(test)]
        let attempts = self.lease_attempts.unwrap_or(attempts);
        for _ in 0..attempts {
            let reserved = {
                let mut pool = self.pool.lock().unwrap();
                if !pool.is_current(&server.id, generation)
                    || !server.enabled
                    || pool.servers[&server.id].launch != LaunchConfig::from(server)
                {
                    return Err(SessionError::Failed(
                        "MCP 服务器配置已更新、禁用或删除，请重试".into(),
                    ));
                }
                if pool.busy.contains_key(&server.id) {
                    None
                } else {
                    pool.busy.insert(server.id.clone(), generation);
                    let session = pool.sessions.remove(&server.id).filter(|s| {
                        // try_wait needs mutable access; checked just below.
                        s.last_used.elapsed() <= IDLE_TIMEOUT
                    });
                    Some(Lease {
                        manager: self,
                        id: server.id.clone(),
                        generation,
                        session,
                    })
                }
            };
            if let Some(mut lease) = reserved {
                if lease
                    .session
                    .as_mut()
                    .is_some_and(|s| matches!(s.child.try_wait(), Ok(None)))
                {
                    return Ok(lease);
                }
                lease.session = Some(spawn(server)?);
                initialize(lease.session.as_mut().unwrap()).await?;
                if !self.pool.lock().unwrap().is_current(&server.id, generation) {
                    return Err(SessionError::Failed(
                        "MCP 服务器配置已更新、禁用或删除，请重试".into(),
                    ));
                }
                return Ok(lease);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Err(SessionError::Busy)
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
        .stderr(Stdio::null())
        .kill_on_drop(true);
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

    // Re-exec only this ignored test as a local stdio MCP server. No user
    // configuration, credentials, external executables or network are involved.
    #[test]
    #[ignore]
    fn fake_mcp_process() {
        use std::io::{BufRead, Write};
        let tag = std::env::var("ZM_MCP_TEST_TAG").expect("fixture-only process");
        for line in std::io::stdin().lock().lines() {
            let message: Value = serde_json::from_str(&line.unwrap()).unwrap();
            let Some(id) = message.get("id") else {
                continue;
            };
            let method = message["method"].as_str().unwrap();
            if std::env::var("ZM_MCP_TEST_GATE_METHOD").as_deref() == Ok(method) {
                let gate = std::env::var("ZM_MCP_TEST_GATE").unwrap();
                std::fs::write(format!("{gate}.ready"), b"ready").unwrap();
                let start = Instant::now();
                while !std::path::Path::new(&format!("{gate}.release")).exists() {
                    assert!(
                        start.elapsed() < Duration::from_secs(8),
                        "fixture gate timed out"
                    );
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
            let result = match method {
                "initialize" => json!({"capabilities": {}}),
                "tools/list" => {
                    json!({"tools": [{"name": tag, "inputSchema": {"type": "object", "properties": {}}}]})
                }
                "tools/call" => {
                    json!({"content": [{"type": "text", "text": format!("{tag}:{}", std::process::id())}]})
                }
                _ => panic!("unexpected fixture method"),
            };
            println!("{}", json!({"jsonrpc": "2.0", "id": id, "result": result}));
            std::io::stdout().flush().unwrap();
        }
    }

    fn fake_server(tag: &str) -> McpServerConfig {
        McpServerConfig {
            id: "fixture".into(),
            name: "Local fixture".into(),
            command: std::env::current_exe().unwrap().to_str().unwrap().into(),
            args: vec![
                "--exact".into(),
                "mcp::tests::fake_mcp_process".into(),
                "--ignored".into(),
                "--nocapture".into(),
            ],
            env: HashMap::from([("ZM_MCP_TEST_TAG".into(), tag.into())]),
            enabled: true,
        }
    }

    async fn fixture_call(manager: &McpManager, server: &McpServerConfig) -> String {
        manager
            .call(std::slice::from_ref(server), &server.id, "probe", json!({}))
            .await
            .unwrap()["text"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn launch_configuration_changes_replace_the_actual_process() {
        let manager = McpManager::new();
        let mut server = fake_server("original");
        assert!(manager.refresh(&[server.clone()]).await.is_empty());
        let original = fixture_call(&manager, &server).await;
        assert_eq!(original, fixture_call(&manager, &server).await);
        server.name = "Renamed".into();
        assert!(manager.refresh(&[server.clone()]).await.is_empty());
        assert_eq!(original, fixture_call(&manager, &server).await);
        server
            .env
            .insert("ZM_MCP_TEST_TAG".into(), "changed".into());
        assert!(manager.refresh(&[server.clone()]).await.is_empty());
        let changed = fixture_call(&manager, &server).await;
        assert!(
            changed.starts_with("changed:"),
            "reused old process: {changed}"
        );
        assert_ne!(original, changed);
        // Equivalent CLI behavior, different ordered launch arguments.
        server.args.swap(0, 2);
        assert!(manager.refresh(&[server.clone()]).await.is_empty());
        assert_ne!(changed, fixture_call(&manager, &server).await);
        let before_command_change = fixture_call(&manager, &server).await;
        let executable = std::env::current_exe().unwrap();
        server.command = format!(
            "{}/./{}",
            executable.parent().unwrap().display(),
            executable.file_name().unwrap().to_str().unwrap()
        );
        assert!(manager.refresh(&[server.clone()]).await.is_empty());
        assert_ne!(before_command_change, fixture_call(&manager, &server).await);
        server.command = std::env::temp_dir()
            .join(format!("zm-mcp-missing-{}", std::process::id()))
            .join("nonexistent-fixture.exe")
            .to_str()
            .unwrap()
            .into();
        assert!(!manager.refresh(&[server.clone()]).await.is_empty());
        assert!(manager.cached_tools().is_empty());
        assert!(manager
            .call(&[server], "fixture", "probe", json!({}))
            .await
            .is_err());
    }

    struct Gate(std::path::PathBuf);

    impl Gate {
        fn new(server: &mut McpServerConfig, method: &str) -> Self {
            static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "zm-mcp-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            server
                .env
                .insert("ZM_MCP_TEST_GATE".into(), path.to_str().unwrap().into());
            server
                .env
                .insert("ZM_MCP_TEST_GATE_METHOD".into(), method.into());
            Self(path)
        }
        fn file(&self, suffix: &str) -> std::path::PathBuf {
            std::path::PathBuf::from(format!("{}.{suffix}", self.0.display()))
        }
        async fn ready(&self) {
            tokio::time::timeout(Duration::from_secs(5), async {
                while !self.file("ready").exists() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("fixture never reached gate");
        }
        fn release(&self) {
            std::fs::write(self.file("release"), b"release").unwrap();
        }
    }

    impl Drop for Gate {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(self.file("ready"));
            let _ = std::fs::remove_file(self.file("release"));
        }
    }

    #[tokio::test]
    async fn borrowed_old_generation_cannot_return_after_a_b_a() {
        let manager = std::sync::Arc::new(McpManager::new());
        let mut a = fake_server("a");
        let gate = Gate::new(&mut a, "tools/call");
        assert!(manager.refresh(&[a.clone()]).await.is_empty());
        let task = {
            let manager = manager.clone();
            let a = a.clone();
            tokio::spawn(async move { fixture_call(&manager, &a).await })
        };
        gate.ready().await;
        let old_generation = manager.pool.lock().unwrap().servers["fixture"].generation;
        let b = fake_server("b");
        assert!(manager.refresh(&[b]).await.is_empty());
        assert!(manager.refresh(&[a.clone()]).await.is_empty());
        let new_generation = manager.pool.lock().unwrap().servers["fixture"].generation;
        assert_ne!(old_generation, new_generation);
        // Hold the new generation too: old checkin must not clear its busy slot.
        let new_lease = manager.ensure_session(&a, new_generation).await.unwrap();
        gate.release();
        let old = task.await.unwrap();
        assert_eq!(
            manager.pool.lock().unwrap().busy.get("fixture"),
            Some(&new_generation)
        );
        new_lease.checkin();
        let current = fixture_call(&manager, &a).await;
        assert_ne!(old, current);
        assert_eq!(current, fixture_call(&manager, &a).await);
    }

    #[tokio::test]
    async fn disabled_deleted_and_shutdown_reject_borrowed_sessions_and_stale_snapshots() {
        for transition in ["disabled", "deleted", "shutdown"] {
            let manager = std::sync::Arc::new(McpManager::new());
            let mut server = fake_server(transition);
            let gate = Gate::new(&mut server, "tools/call");
            assert!(manager.refresh(&[server.clone()]).await.is_empty());
            let task = {
                let manager = manager.clone();
                let server = server.clone();
                tokio::spawn(async move { fixture_call(&manager, &server).await })
            };
            gate.ready().await;
            match transition {
                "disabled" => {
                    let mut disabled = server.clone();
                    disabled.enabled = false;
                    manager.refresh(&[disabled]).await;
                }
                "deleted" => {
                    manager.refresh(&[]).await;
                }
                _ => manager.shutdown_all(),
            }
            assert!(manager.cached_tools().is_empty());
            gate.release();
            task.await.unwrap();
            assert!(manager.pool.lock().unwrap().sessions.is_empty());
            assert!(manager
                .call(&[server.clone()], "fixture", "probe", json!({}))
                .await
                .is_err());
            assert!(manager.refresh(&[server.clone()]).await.is_empty());
            assert!(fixture_call(&manager, &server)
                .await
                .starts_with(transition));
        }
    }

    #[tokio::test]
    async fn older_discovery_and_initialize_cannot_overwrite_new_refresh() {
        for method in ["initialize", "tools/list"] {
            let manager = std::sync::Arc::new(McpManager::new());
            let mut old = fake_server("old");
            let gate = Gate::new(&mut old, method);
            let task = {
                let manager = manager.clone();
                tokio::spawn(async move { manager.refresh(&[old]).await })
            };
            gate.ready().await;
            let new = fake_server("new");
            assert!(manager.refresh(std::slice::from_ref(&new)).await.is_empty());
            let current = fixture_call(&manager, &new).await;
            gate.release();
            task.await.unwrap();
            assert_eq!(manager.cached_tools()[0].tool_name, "new");
            assert_eq!(current, fixture_call(&manager, &new).await);
        }
    }

    #[tokio::test]
    async fn concurrent_calls_reuse_one_process_and_cancelled_leases_release_the_slot() {
        let manager = std::sync::Arc::new(McpManager::new());
        let server = fake_server("shared");
        let (a, b) = tokio::join!(
            fixture_call(&manager, &server),
            fixture_call(&manager, &server)
        );
        assert_eq!(a, b);
        let mut blocked = fake_server("cancelled");
        let gate = Gate::new(&mut blocked, "initialize");
        let task = {
            let manager = manager.clone();
            let blocked = blocked.clone();
            tokio::spawn(async move { manager.refresh(&[blocked]).await })
        };
        gate.ready().await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(manager.pool.lock().unwrap().busy.is_empty());
        gate.release();
        assert!(manager.refresh(&[blocked]).await.is_empty());
    }

    #[tokio::test]
    async fn same_configuration_refresh_publishes_only_latest_metadata() {
        let manager = std::sync::Arc::new(McpManager::new());
        let mut server = fake_server("same");
        let gate = Gate::new(&mut server, "tools/list");
        let task = {
            let manager = manager.clone();
            let server = server.clone();
            tokio::spawn(async move { manager.refresh(&[server]).await })
        };
        gate.ready().await;
        server.name = "Newest name".into();
        let refresh = manager.prepare_refresh(&[server]);
        gate.release();
        task.await.unwrap();
        assert!(
            manager.cached_tools().is_empty(),
            "old refresh must not publish"
        );
        assert!(manager.finish_refresh(refresh).await.is_empty());
        assert_eq!(manager.cached_tools()[0].server_name, "Newest name");
    }

    #[tokio::test]
    async fn warm_reconciles_changes_and_old_warm_cannot_clear_new_guard() {
        let manager = std::sync::Arc::new(McpManager::new());
        let mut old = fake_server("old-warm");
        let gate = Gate::new(&mut old, "tools/list");
        let first = manager.prepare_warm(&[old.clone()]).unwrap();
        assert!(manager.prepare_warm(&[old]).is_none());
        let task = {
            let manager = manager.clone();
            tokio::spawn(async move { manager.finish_warm(first).await })
        };
        gate.ready().await;
        let new = fake_server("new-warm");
        let second = manager.prepare_warm(std::slice::from_ref(&new)).unwrap();
        gate.release();
        task.await.unwrap();
        assert!(manager.prepare_warm(std::slice::from_ref(&new)).is_none());
        manager.finish_warm(second).await;
        assert_eq!(manager.cached_tools()[0].tool_name, "new-warm");
        assert!(manager.prepare_warm(&[new]).is_none());
        let changed = fake_server("changed-warm");
        manager
            .finish_warm(manager.prepare_warm(&[changed]).unwrap())
            .await;
        assert_eq!(manager.cached_tools()[0].tool_name, "changed-warm");
        manager
            .finish_warm(manager.prepare_warm(&[]).unwrap())
            .await;
        assert!(manager.cached_tools().is_empty());
        assert!(manager.pool.lock().unwrap().sessions.is_empty());
    }

    #[tokio::test]
    async fn busy_discovery_preserves_only_current_generation_tools() {
        let manager = std::sync::Arc::new(McpManager {
            lease_attempts: Some(2), // 100ms instead of the production 20s.
            pool: Mutex::default(),
        });
        let mut server = fake_server("busy-old");
        let gate = Gate::new(&mut server, "tools/call");
        let mut other = fake_server("healthy");
        other.id = "other".into();
        let servers = vec![server.clone(), other.clone()];
        assert!(manager.refresh(&servers).await.is_empty());
        let task = {
            let manager = manager.clone();
            let servers = servers.clone();
            tokio::spawn(async move {
                manager
                    .call(&servers, "fixture", "probe", json!({}))
                    .await
                    .unwrap()
            })
        };
        gate.ready().await;
        let errors = manager.refresh(&servers).await;
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("正忙"));
        let tools = manager.cached_tools();
        assert!(tools.iter().any(|t| t.tool_name == "healthy"));
        assert!(
            tools.iter().any(|t| t.tool_name == "busy-old"),
            "busy discovery erased healthy cached tools"
        );
        gate.release();
        let result = task.await.unwrap();
        assert_eq!(
            result["text"].as_str().unwrap(),
            fixture_call(&manager, &server).await
        );
        assert!(manager
            .cached_tools()
            .iter()
            .any(|t| t.tool_name == "busy-old"));

        // A changed generation has no fallback, even while its first call is
        // holding the lease. In particular it must not inherit busy-old tools.
        let mut changed = fake_server("busy-new");
        let changed_gate = Gate::new(&mut changed, "tools/call");
        let servers = vec![changed.clone(), other];
        let refresh = manager.prepare_refresh(&servers);
        let task = {
            let manager = manager.clone();
            let servers = servers.clone();
            tokio::spawn(async move {
                manager
                    .call(&servers, "fixture", "probe", json!({}))
                    .await
                    .unwrap()
            })
        };
        changed_gate.ready().await;
        assert_eq!(manager.finish_refresh(refresh).await.len(), 1);
        assert!(manager
            .cached_tools()
            .iter()
            .all(|t| t.server_id != "fixture"));
        changed_gate.release();
        task.await.unwrap();
        assert!(manager.refresh(&servers).await.is_empty());
        assert!(manager
            .cached_tools()
            .iter()
            .any(|t| t.tool_name == "busy-new"));
    }

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
