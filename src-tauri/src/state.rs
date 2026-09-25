use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// Verdict for one pending call. Remembered permissions are handled at the
/// command boundary before the agent is allowed to resume.
#[derive(Debug, Clone, Default)]
pub struct ApprovalVerdict {
    pub approved: bool,
}

pub struct PendingToolApproval {
    pub sender: oneshot::Sender<ApprovalVerdict>,
    pub tool_name: String,
    pub scope: String,
    /// Data transfers and MCP tools may only be approved one call at a time.
    pub can_remember: bool,
}

pub type PendingToolApprovals = Arc<Mutex<HashMap<String, PendingToolApproval>>>;

/// Shared application state.
///
/// API requests are issued from Rust so the frontend never touches raw
/// network details. Every in-flight generation owns a cancellation token;
/// `chat_cancel` simply flips the matching token and the stream loop aborts.
pub struct AppState {
    /// The shared HTTP client. Wrapped in a `Mutex` so it can be rebuilt
    /// at runtime when the user changes the proxy configuration. Requests
    /// clone the client (cheap: `reqwest::Client` is an `Arc` inside) and
    /// never hold the lock for longer than the clone.
    pub http: Mutex<reqwest::Client>,
    pub cancellations: Arc<Mutex<HashMap<String, CancellationToken>>>,
    /// Pending tool-approval channels, keyed by `request_id:call_id`.
    ///
    /// When the agent loop needs user confirmation for a tool call it
    /// registers a `oneshot` sender here, emits `ToolPending`, and awaits
    /// the receiver. `chat_approve_tool` resolves the matching channel.
    pub tool_approvals: PendingToolApprovals,
    /// Ordinary approvals scoped to the current conversation; a new or
    /// reloaded chat uses a new scope even while the app keeps running.
    pub session_tool_approvals: Arc<Mutex<HashSet<(String, String)>>>,
    /// MCP client: child processes of the configured servers (P1-10).
    pub mcp: crate::mcp::McpManager,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            http: Mutex::new(build_http_client(None, false)),
            cancellations: Arc::new(Mutex::new(HashMap::new())),
            tool_approvals: Arc::new(Mutex::new(HashMap::new())),
            session_tool_approvals: Arc::new(Mutex::new(HashSet::new())),
            mcp: crate::mcp::McpManager::new(),
        }
    }

    /// Rebuild the HTTP client from the current proxy settings.
    pub fn rebuild_http_client(&self, proxy_url: Option<&str>, use_system_proxy: bool) {
        let client = build_http_client(proxy_url, use_system_proxy);
        *self.http.lock().unwrap() = client;
    }
}

/// Build a `reqwest::Client` with connection optimizations (plan §13 "路由加速
/// 方案 D") and an optional proxy (方案 A).
///
/// Optimizations applied:
/// - `connect_timeout(10s)`: fail fast when a host is unreachable.
/// - `tcp_nodelay(true)`: disable Nagle, reduces latency on small packets.
/// - `tcp_keepalive(60s)`: keep idle connections alive through NATs.
/// - `pool_max_idle_per_host(8)` / `pool_idle_timeout(90s)`: connection reuse.
/// - `http2_adaptive_window(true)`: smoother HTTP/2 flow control for streams.
/// - No global `timeout`: SSE streaming responses can run arbitrarily long,
///   so only the connect phase is time-bound.
///
/// When `proxy_url` is set it is applied to all schemes (http/https/socks5
/// depending on the scheme prefix). `use_system_proxy` makes reqwest honour
/// the OS proxy settings.
fn build_http_client(proxy_url: Option<&str>, use_system_proxy: bool) -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .tcp_nodelay(true)
        .tcp_keepalive(std::time::Duration::from_secs(60))
        .pool_max_idle_per_host(8)
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .http2_adaptive_window(true)
        .user_agent(concat!("Zhima/", env!("CARGO_PKG_VERSION")));

    // Proxy handling (方案 A).
    match (proxy_url, use_system_proxy) {
        (Some(url), _) if !url.trim().is_empty() => {
            // Explicit proxy URL overrides the system proxy.
            match reqwest::Proxy::all(url.trim()) {
                Ok(proxy) => {
                    builder = builder.proxy(proxy);
                }
                Err(e) => {
                    eprintln!("无效的代理配置，已忽略: {e}");
                }
            }
        }
        (_, true) => {
            // Honour OS-level proxy (e.g. Windows Internet Options).
            builder = builder.proxy(reqwest::Proxy::custom(|_| {
                system_proxy_url().and_then(|u| reqwest::Url::parse(&u).ok())
            }));
        }
        _ => {}
    }

    builder.build().expect("failed to build http client")
}

/// Best-effort read of the Windows system proxy from the registry
/// (`Internet Settings`), returning a `http://host:port` URL when set.
///
/// Only the "manual proxy" case is handled; PAC scripts are ignored.
#[cfg(windows)]
fn system_proxy_url() -> Option<String> {
    let key = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let settings = key
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;

    let proxy_enable: u32 = settings.get_value("ProxyEnable").unwrap_or(0);
    if proxy_enable == 0 {
        return None;
    }

    let server: String = settings.get_value("ProxyServer").ok()?;
    if server.trim().is_empty() {
        return None;
    }

    // If it already contains a scheme, use it as-is; otherwise default to http.
    if server.contains("://") {
        Some(server)
    } else {
        Some(format!("http://{server}"))
    }
}

#[cfg(not(windows))]
fn system_proxy_url() -> Option<String> {
    None
}
