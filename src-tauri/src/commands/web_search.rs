//! Web-search engine settings (P0-3).
//!
//! The engine choice lives in `providers.json`; API keys live in the Windows
//! Credential Manager.  The frontend only ever learns *whether* a key is set.

use serde::Serialize;
use tauri::State;

use crate::api::web_search::{self, Engine, WebSearchSettings};
use crate::state::AppState;
use crate::storage::config::ConfigStore;
use crate::storage::secrets;

/// Settings payload for the frontend — never contains key material.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchConfigView {
    pub engine: String,
    pub searxng_base_url: Option<String>,
    pub tavily_key_set: bool,
    pub bocha_key_set: bool,
    /// Whether the current engine has everything it needs to run.
    pub ready: bool,
}

fn key_set(engine: &str) -> bool {
    matches!(secrets::get_web_search_key(engine), Ok(Some(_)))
}

fn view(config: &ConfigStore) -> WebSearchConfigView {
    let settings = WebSearchSettings::resolve(config);
    WebSearchConfigView {
        engine: settings.engine.id().to_string(),
        searxng_base_url: settings.searxng_base_url.clone(),
        tavily_key_set: key_set("tavily"),
        bocha_key_set: key_set("bocha"),
        ready: settings.ready(),
    }
}

/// Parse an engine id typed by the UI, rejecting unknown values instead of
/// silently falling back to the default engine.
fn parse_engine(value: &str) -> Result<Engine, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "duckduckgo" => Ok(Engine::DuckDuckGo),
        "tavily" => Ok(Engine::Tavily),
        "bocha" => Ok(Engine::Bocha),
        "searxng" => Ok(Engine::Searxng),
        other => Err(format!("未知的搜索引擎：{other}")),
    }
}

#[tauri::command]
pub fn get_web_search_config(config: State<'_, ConfigStore>) -> WebSearchConfigView {
    view(&config)
}

/// Persist the engine choice (and the SearXNG instance URL when applicable).
#[tauri::command]
pub fn set_web_search_config(
    config: State<'_, ConfigStore>,
    engine: String,
    searxng_base_url: Option<String>,
) -> Result<WebSearchConfigView, String> {
    let parsed = parse_engine(&engine)?;
    let base = searxng_base_url
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());

    if parsed == Engine::Searxng {
        match &base {
            Some(url) if !(url.starts_with("http://") || url.starts_with("https://")) => {
                return Err("SearXNG 实例地址必须以 http:// 或 https:// 开头".into());
            }
            None => {
                return Err("请填写 SearXNG 实例地址".into());
            }
            _ => {}
        }
    }

    config.update(|c| {
        c.web_search.engine = parsed.id().to_string();
        c.web_search.searxng_base_url = base.clone();
        Ok(())
    })?;
    Ok(view(&config))
}

/// Store (or clear, when `key` is empty) an engine's API key.
#[tauri::command]
pub fn set_web_search_api_key(
    config: State<'_, ConfigStore>,
    engine: String,
    key: String,
) -> Result<WebSearchConfigView, String> {
    let parsed = match parse_engine(&engine)? {
        Engine::Tavily => Engine::Tavily,
        Engine::Bocha => Engine::Bocha,
        other => return Err(format!("{} 无需 API Key", other.label())),
    };
    secrets::set_web_search_key(parsed.id(), &key)?;
    Ok(view(&config))
}

/// Result of a "test search" from the settings panel.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchTestResult {
    pub engine: String,
    pub count: usize,
    pub elapsed_ms: u64,
    /// First few hits, so the UI can show what the engine returns.
    pub results: Vec<web_search::SearchResult>,
}

/// Run one real search with the saved settings (the settings panel needs a
/// key to be present; `set_web_search_api_key` is called before this).
#[tauri::command]
pub async fn test_web_search(
    state: State<'_, AppState>,
    config: State<'_, ConfigStore>,
    query: String,
) -> Result<WebSearchTestResult, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("请输入测试关键词".into());
    }

    let settings = WebSearchSettings::resolve(&config);
    let client = state.http.lock().unwrap().clone();
    let started = std::time::Instant::now();
    let results = web_search::search(&client, &settings, &query, 5).await?;

    Ok(WebSearchTestResult {
        engine: settings.engine.id().to_string(),
        count: results.len(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        results: results.into_iter().take(3).collect(),
    })
}
