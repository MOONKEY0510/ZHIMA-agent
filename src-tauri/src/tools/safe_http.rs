//! SSRF-safe HTTP fetching.
//!
//! The plain `reqwest::Client` used for provider API calls must never be used
//! to fetch arbitrary URLs: its default redirect handling plus DNS resolution
//! can funnel requests to loopback, private networks or cloud metadata
//! endpoints even when the original URL "looks" public.  This module provides
//! a dedicated fetcher with:
//!
//! - scheme + port allow-list (http/https, 80/443 only);
//! - pre-connect DNS validation: the literal host is resolved and every
//!   resolved IP is checked against loopback/private/link-local/reserved
//!   ranges **before** the request is issued;
//! - no automatic redirects (each hop is re-validated manually, max 5);
//! - a hard response-size cap, streamed so oversized bodies abort early;
//! - a clean client with no Authorization/Cookie headers.

use std::net::{IpAddr, SocketAddr};

use futures_util::StreamExt;
use reqwest::Url;
use serde_json::{json, Value};

const MAX_REDIRECTS: u8 = 5;
const ALLOWED_PORTS: [u16; 2] = [80, 443];

/// Validate a URL without contacting the network.
///
/// Enforces scheme, port, credentials-in-URL and literal private/loopback
/// hosts.  DNS-based checks happen separately in [`SafeHttpFetcher`] before
/// connecting.
pub fn validate_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "网页地址无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("只允许访问 http 或 https 网页".into());
    }
    if url.username() != "" || url.password().is_some() {
        return Err("不允许带账号密码的 URL".into());
    }
    let port = url.port().unwrap_or_else(|| match url.scheme() {
        "https" => 443,
        _ => 80,
    });
    if !ALLOWED_PORTS.contains(&port) {
        return Err("只允许访问 80/443 端口".into());
    }
    match url.host() {
        Some(host) => match host {
            // Literal IPv4/IPv6: validate directly (works for `[::1]` too,
            // which host_str() would render ambiguously).
            url::Host::Ipv4(ip) => {
                if is_blocked_ip(IpAddr::V4(ip)) {
                    return Err("不允许访问内网或本机地址".into());
                }
            }
            url::Host::Ipv6(ip) => {
                if is_blocked_ip(IpAddr::V6(ip)) {
                    return Err("不允许访问内网或本机地址".into());
                }
            }
            url::Host::Domain(domain) => {
                let host = domain.to_ascii_lowercase();
                if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
                    return Err("不允许访问本地地址".into());
                }
            }
        },
        None => return Err("网页地址缺少主机名".into()),
    }
    Ok(url)
}

/// True when an IP is in any range that a desktop app must never contact
/// via a user-provided or model-provided URL.
pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            v.is_loopback()
                || v.is_private()
                || v.is_link_local()
                || v.is_broadcast()
                || v.is_documentation()
                || v.is_unspecified()
                // 100.64.0.0/10 CGNAT, 192.0.0.0/24 special-purpose, 198.18.0.0/15 benchmarking.
                || (v.octets()[0] == 100 && (64..=127).contains(&v.octets()[1]))
                || (v.octets()[0] == 192 && v.octets()[1] == 0)
                || (v.octets()[0] == 198 && (18..=19).contains(&v.octets()[1]))
        }
        IpAddr::V6(v) => {
            v.is_loopback()
                || v.is_unique_local()
                || v.is_unicast_link_local()
                || v.is_unspecified()
                || v.is_multicast()
                // IPv4-mapped IPv6 (::ffff:a.b.c.d) — check the embedded v4.
                || v.to_ipv4_mapped().map(|v4| is_blocked_ip(IpAddr::V4(v4))).unwrap_or(false)
        }
    }
}

/// A dedicated fetch client that never follows redirects automatically and
/// validates every hop.
///
/// Built from scratch (no proxy/auth/cookie headers) so provider credentials
/// can never leak into webpage fetches.  Each request uses a fresh client with
/// the validated DNS addresses pinned to the connection (see
/// [`SafeHttpFetcher::pinned_client`]).
pub struct SafeHttpFetcher;

impl SafeHttpFetcher {
    /// Construct a fetcher.  No shared client is kept: every request builds a
    /// per-request client with the verified addresses pinned, so a second DNS
    /// lookup cannot rebind the host to a private/loopback address.
    pub fn new() -> Self {
        Self
    }

    /// Fetch a page body as text with SSRF protection.
    ///
    /// `max_bytes` bounds the response body.  Redirects are followed manually
    /// (max [`MAX_REDIRECTS`]) with re-validation at every hop.
    pub async fn fetch_text(&self, raw_url: &str, max_bytes: usize) -> Result<Value, String> {
        let mut url = validate_url(raw_url)?;
        let mut redirects = 0;

        loop {
            // Resolve DNS, verify every IP is public, and pin the verified
            // addresses to the connection so a second lookup cannot rebind
            // the host to a private/loopback address (DNS rebinding / TOCTOU).
            let addrs = self.check_dns(&url).await?;
            let client = self.pinned_client(&url, &addrs)?;

            let resp = client
                .get(url.clone())
                .header("Accept", "text/html,text/plain,application/xhtml+xml")
                .send()
                .await
                .map_err(|e| format!("网页请求失败: {}", crate::errors::brief(&e)))?;

            let status = resp.status();
            if status.is_redirection() {
                if redirects >= MAX_REDIRECTS {
                    return Err("网页重定向次数过多".into());
                }
                redirects += 1;
                let Some(location) = resp.headers().get("location").and_then(|v| v.to_str().ok())
                else {
                    return Err("网页返回重定向但缺少 Location".into());
                };
                let next = url
                    .join(location)
                    .map_err(|_| "重定向地址无效".to_string())?;
                // Re-validate the new hop (SSRF via redirect blocked here).
                url = validate_url(next.as_str())?;
                continue;
            }

            if !status.is_success() {
                return Err(format!("网页返回 HTTP {}", status.as_u16()));
            }
            if let Some(len) = resp.content_length() {
                if len as usize > max_bytes {
                    return Err(format!("网页内容超过 {max_bytes} 字节"));
                }
            }

            // Stream the body, aborting once we hit the cap.
            let mut body = Vec::new();
            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let bytes =
                    chunk.map_err(|e| format!("读取网页失败: {}", crate::errors::brief(&e)))?;
                if body.len() + bytes.len() > max_bytes {
                    return Err(format!("网页内容超过 {max_bytes} 字节"));
                }
                body.extend_from_slice(&bytes);
            }

            let text = String::from_utf8_lossy(&body).to_string();
            return Ok(json!({
                "url": url.as_str(),
                "content": text,
                "content_bytes": body.len(),
            }));
        }
    }

    /// Resolve the host and reject the request unless every address is public.
    ///
    /// Returns the verified addresses so the caller can pin them to the actual
    /// connection, preventing a second DNS lookup from rebinding the host to a
    /// private/loopback address between validation and connect.
    async fn check_dns(&self, url: &Url) -> Result<Vec<SocketAddr>, String> {
        let host = url
            .host_str()
            .ok_or_else(|| "网页地址缺少主机名".to_string())?;

        // If the host is already an IP literal, validate_url covered it and no
        // pinning is needed (reqwest connects to the literal directly).
        if host.parse::<IpAddr>().is_ok() {
            return Ok(Vec::new());
        }

        let host_owned = host.to_string();
        let port = url.port().unwrap_or_else(|| match url.scheme() {
            "https" => 443,
            _ => 80,
        });
        let addrs = tokio::net::lookup_host((host_owned.as_str(), port))
            .await
            .map_err(|e| format!("解析域名失败: {e}"))?;

        let mut verified = Vec::new();
        for addr in addrs {
            let ip = addr.ip();
            if is_blocked_ip(ip) {
                return Err(format!("域名解析到不允许访问的地址: {ip}"));
            }
            verified.push(addr);
        }
        if verified.is_empty() {
            return Err("域名未解析到任何地址".into());
        }
        Ok(verified)
    }

    /// Build a per-request client that pins the verified DNS addresses to the
    /// connection.  This closes the DNS-rebinding window: even if the host
    /// later resolves to a private/loopback address, reqwest will only connect
    /// to the addresses we already validated.
    fn pinned_client(&self, url: &Url, addrs: &[SocketAddr]) -> Result<reqwest::Client, String> {
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(10))
            .user_agent(concat!("ChatFloat/", env!("CARGO_PKG_VERSION")));
        if let Some(host) = url.host_str() {
            if host.parse::<IpAddr>().is_err() && !addrs.is_empty() {
                builder = builder.resolve_to_addrs(host, addrs);
            }
        }
        builder
            .build()
            .map_err(|e| format!("构建请求客户端失败: {}", crate::errors::brief(&e)))
    }
}

impl Default for SafeHttpFetcher {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rejects_private_literals() {
        assert!(validate_url("http://127.0.0.1:8080").is_err());
        assert!(validate_url("http://localhost").is_err());
        assert!(validate_url("http://10.0.0.5").is_err());
        assert!(validate_url("http://192.168.1.1").is_err());
        assert!(validate_url("http://[::1]").is_err());
        assert!(validate_url("http://169.254.169.254").is_err()); // cloud metadata
    }

    #[test]
    fn validate_rejects_bad_ports_and_credentials() {
        assert!(validate_url("http://example.com:8080").is_err());
        assert!(validate_url("http://user:pass@example.com").is_err());
    }

    #[test]
    fn validate_accepts_public_urls() {
        assert!(validate_url("https://example.com").is_ok());
        assert!(validate_url("https://example.com/path?q=1").is_ok());
    }

    #[test]
    fn blocked_ip_ranges() {
        assert!(is_blocked_ip("127.0.0.1".parse().unwrap()));
        assert!(is_blocked_ip("10.1.2.3".parse().unwrap()));
        assert!(is_blocked_ip("::1".parse().unwrap()));
        assert!(is_blocked_ip("::ffff:127.0.0.1".parse().unwrap()));
        assert!(!is_blocked_ip("8.8.8.8".parse().unwrap()));
        assert!(!is_blocked_ip("1.1.1.1".parse().unwrap()));
    }

    #[test]
    fn pinned_client_builds_with_verified_addresses() {
        let fetcher = SafeHttpFetcher::new();
        let url = Url::parse("https://example.com").unwrap();
        let addrs: Vec<SocketAddr> = vec!["93.184.216.34:443".parse().unwrap()];
        // Building the pinned client with a validated public address must
        // succeed (no panic, no error).
        fetcher.pinned_client(&url, &addrs).expect("client builds");
    }
}
