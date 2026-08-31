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
