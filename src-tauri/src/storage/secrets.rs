//! API keys in the Windows Credential Manager via `keyring` (plan §6.1).
//!
//! Keys are written once on save, read only inside Rust when a request is
//! built, and never serialized to the frontend or to log output.

use keyring::Entry;

const SERVICE: &str = "ChatFloat";

fn entry(provider_id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &format!("provider:{provider_id}"))
        .map_err(|e| format!("无法访问系统凭据库：{e}"))
}

/// Credential entry for a web-search engine's API key (P0-3).  Search keys
/// live alongside provider keys but under their own namespace.
fn search_entry(engine: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &format!("websearch:{engine}"))
        .map_err(|e| format!("无法访问系统凭据库：{e}"))
}

/// Store (or clear, when `key` is empty) the API key of a search engine.
pub fn set_web_search_key(engine: &str, key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return delete_web_search_key(engine);
    }
    search_entry(engine)?
        .set_password(key)
        .map_err(|e| format!("写入搜索 API Key 失败：{e}"))
}

/// `Ok(None)` means "no key stored for this engine".
pub fn get_web_search_key(engine: &str) -> Result<Option<String>, String> {
    match search_entry(engine)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取搜索 API Key 失败：{e}")),
    }
}

pub fn delete_web_search_key(engine: &str) -> Result<(), String> {
    match search_entry(engine)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除搜索 API Key 失败：{e}")),
    }
}

pub fn set_api_key(provider_id: &str, key: &str) -> Result<(), String> {
    entry(provider_id)?
        .set_password(key)
        .map_err(|e| format!("写入 API Key 失败：{e}"))
}

/// `Ok(None)` means "no key stored for this provider".
pub fn get_api_key(provider_id: &str) -> Result<Option<String>, String> {
    match entry(provider_id)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取 API Key 失败：{e}")),
    }
}

pub fn delete_api_key(provider_id: &str) -> Result<(), String> {
    match entry(provider_id)?.delete_credential() {
        Ok(()) => Ok(()),
        // Already absent — treat as success.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除 API Key 失败：{e}")),
    }
}
