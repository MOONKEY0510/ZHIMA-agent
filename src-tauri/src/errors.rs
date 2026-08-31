//! Unified error helpers.
//!
//! Commands return `Result<T, String>` to the frontend; the strings are
//! short, user-readable Chinese messages. API keys and Authorization headers
//! must never be embedded in these messages or logged.

use futures_util::StreamExt;

/// Trim long reqwest error strings before showing them to the user.
pub fn brief(err: &reqwest::Error) -> String {
    let s = err.to_string();
    s.chars().take(200).collect()
}

/// Read a response body, aborting once it exceeds `max_bytes`.
///
/// Uses the `Content-Length` header as a cheap pre-check and streams the body
/// so an oversized (or maliciously slow) response is rejected early instead of
/// being buffered unboundedly into memory.
pub async fn read_body_capped(resp: reqwest::Response, max_bytes: usize) -> Result<String, String> {
    if let Some(len) = resp.content_length() {
        if len as usize > max_bytes {
            return Err(format!(
                "响应内容过大（超过 {} MB）",
                max_bytes / 1024 / 1024
            ));
        }
    }
    let mut body = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| brief(&e))?;
        if body.len() + bytes.len() > max_bytes {
            return Err(format!(
                "响应内容过大（超过 {} MB）",
                max_bytes / 1024 / 1024
            ));
        }
        body.extend_from_slice(&bytes);
    }
    String::from_utf8(body).map_err(|_| "响应不是有效文本".to_string())
}
