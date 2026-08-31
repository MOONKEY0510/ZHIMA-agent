//! Provider and model management commands (v0.2).
//!
//! Non-sensitive configuration lives in `providers.json`; API keys live in
//! the Windows Credential Manager. The frontend never receives key material:
//! views only carry a `hasApiKey` flag.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::api::openai_chat::{map_http_error, validate_base_url};
use crate::errors::{brief, read_body_capped};
use crate::state::AppState;
use crate::storage::{
    config::{ConfigStore, ModelEntry, Provider, ProvidersConfig},
    secrets,
};

/// Provider view sent to the frontend (never contains key material).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_type: String,
    pub has_api_key: bool,
    pub models: Vec<ModelEntry>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersStateView {
    pub providers: Vec<ProviderView>,
    pub default_provider_id: Option<String>,
    pub default_model_key: Option<String>,
    pub generation: crate::storage::config::GenerationPrefs,
    pub vision_provider_id: Option<String>,
    pub vision_model_key: Option<String>,
    pub image_provider_id: Option<String>,
    pub image_model_key: Option<String>,
    pub default_system_prompt: Option<String>,
    pub remember_window_position: bool,
    pub proxy_url: Option<String>,
    pub use_system_proxy: bool,
}

fn to_view(provider: &Provider) -> ProviderView {
    ProviderView {
        id: provider.id.clone(),
        name: provider.name.clone(),
        base_url: provider.base_url.clone(),
        api_type: provider.api_type.clone(),
        has_api_key: secrets::get_api_key(&provider.id).unwrap_or(None).is_some(),
        models: provider.models.clone(),
        created_at: provider.created_at,
        updated_at: provider.updated_at,
    }
}

fn full_view(cfg: &ProvidersConfig) -> ProvidersStateView {
    ProvidersStateView {
        providers: cfg.providers.iter().map(to_view).collect(),
        default_provider_id: cfg.default_provider_id.clone(),
        default_model_key: cfg.default_model_key.clone(),
        generation: cfg.generation.clone(),
        vision_provider_id: cfg.vision_provider_id.clone(),
        vision_model_key: cfg.vision_model_key.clone(),
        image_provider_id: cfg.image_provider_id.clone(),
        image_model_key: cfg.image_model_key.clone(),
        default_system_prompt: cfg.default_system_prompt.clone(),
        remember_window_position: cfg.remember_window_position,
        proxy_url: cfg.proxy_url.clone(),
        use_system_proxy: cfg.use_system_proxy,
    }
}

/// Set the network proxy for API requests and rebuild the shared HTTP client.
///
/// `proxy_url` accepts `http://`, `https://` or `socks5://` URLs; an empty
/// value disables the custom proxy. `use_system_proxy` falls back to the
/// OS-level proxy when no explicit URL is given.
#[tauri::command]
pub fn set_proxy(
    http: State<'_, AppState>,
    config: State<'_, ConfigStore>,
    proxy_url: Option<String>,
    use_system_proxy: bool,
) -> Result<(), String> {
    // Validate the proxy URL before persisting anything.
    let cleaned = proxy_url.and_then(|u| {
        let t = u.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    if let Some(url) = &cleaned {
        if reqwest::Proxy::all(url).is_err() {
            return Err(format!(
                "无效的代理地址：{url}（需以 http://、https:// 或 socks5:// 开头）"
            ));
        }
    }

    config.update(|cfg| {
        cfg.proxy_url = cleaned.clone();
        cfg.use_system_proxy = use_system_proxy;
        Ok(())
    })?;

    // Rebuild the client so the new settings take effect immediately.
    http.rebuild_http_client(cleaned.as_deref(), use_system_proxy);
    Ok(())
}

#[tauri::command]
pub fn get_providers_state(config: State<'_, ConfigStore>) -> Result<ProvidersStateView, String> {
    Ok(config.read(full_view))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertProviderArgs {
    /// `None` creates a new provider.
    pub id: Option<String>,
    pub name: String,
    pub base_url: String,
    /// `None` or empty keeps the existing key; a value replaces it.
    pub api_key: Option<String>,
}

#[tauri::command]
pub fn upsert_provider(
    config: State<'_, ConfigStore>,
    args: UpsertProviderArgs,
) -> Result<ProviderView, String> {
    let base_url = validate_base_url(&args.base_url)?;
    let name = args.name.trim().to_string();
    if name.is_empty() {
        return Err("请填写服务商名称".into());
    }

    let provider_id = args
        .id
        .clone()
        .unwrap_or_else(crate::storage::config::new_provider_id);
    let key_update = args.api_key.filter(|k| !k.trim().is_empty());
    let previous_key = if key_update.is_some() {
        secrets::get_api_key(&provider_id)?
    } else {
        None
    };
    let now = crate::storage::config::now_millis();

    let result = config.update(|cfg| {
        let provider = match args.id.as_deref() {
            Some(id) => cfg
                .providers
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or_else(|| "服务商不存在".to_string())?,
            None => {
                cfg.providers.push(Provider {
                    id: provider_id.clone(),
                    name: String::new(),
                    base_url: String::new(),
                    api_type: "chat_completions".into(),
                    models: vec![],
                    created_at: now,
                    updated_at: now,
                });
                cfg.providers
                    .last_mut()
                    .ok_or_else(|| "服务商创建失败".to_string())?
            }
        };

        provider.name = name;
        provider.base_url = base_url;
        provider.updated_at = now;

        if let Some(key) = key_update.as_deref() {
            secrets::set_api_key(&provider_id, key.trim())?;
        }

        Ok(to_view(provider))
    });

    if result.is_err() && key_update.is_some() {
        let rollback = match previous_key {
            Some(ref key) => secrets::set_api_key(&provider_id, key),
            None => secrets::delete_api_key(&provider_id),
        };
        if let Err(err) = rollback {
            eprintln!("恢复 Provider API Key 失败：{err}");
        }
    }
    result
}

#[tauri::command]
pub fn delete_provider(config: State<'_, ConfigStore>, id: String) -> Result<(), String> {
    let previous_key = secrets::get_api_key(&id)?;
    let result = config.update(|cfg| {
        let before = cfg.providers.len();
        cfg.providers.retain(|p| p.id != id);
        if cfg.providers.len() == before {
            return Err("服务商不存在".into());
        }
        if cfg.default_provider_id.as_deref() == Some(id.as_str()) {
            cfg.default_provider_id = None;
            cfg.default_model_key = None;
        }
        secrets::delete_api_key(&id)?;
        Ok(())
    });
    if result.is_err() {
        if let Some(key) = previous_key {
            if let Err(err) = secrets::set_api_key(&id, &key) {
                eprintln!("恢复已删除的 Provider API Key 失败：{err}");
            }
        }
    }
    result
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDefaultArgs {
    pub provider_id: String,
    pub model_key: String,
}

#[tauri::command]
pub fn set_default(config: State<'_, ConfigStore>, args: SetDefaultArgs) -> Result<(), String> {
    config.update(|cfg| {
        let provider = cfg
            .providers
            .iter()
            .find(|p| p.id == args.provider_id)
            .ok_or_else(|| "服务商不存在".to_string())?;
        let exists = provider
            .models
            .iter()
            .any(|m| m.model_key == args.model_key);
        if !exists {
            return Err("该服务商下不存在此模型".into());
        }
        cfg.default_provider_id = Some(args.provider_id.clone());
        cfg.default_model_key = Some(args.model_key.clone());
        Ok(())
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelArgs {
    pub provider_id: String,
    pub model_key: String,
    pub display_name: Option<String>,
}

#[tauri::command]
pub fn add_model(config: State<'_, ConfigStore>, args: ModelArgs) -> Result<ProviderView, String> {
    let model_key = args.model_key.trim().to_string();
    if model_key.is_empty() {
        return Err("模型 ID 不能为空".into());
    }

    config.update(|cfg| {
        let provider = cfg
            .providers
            .iter_mut()
            .find(|p| p.id == args.provider_id)
            .ok_or_else(|| "服务商不存在".to_string())?;

        if !provider.models.iter().any(|m| m.model_key == model_key) {
            let order = provider.models.len() as i64;
            provider.models.push(ModelEntry {
                display_name: args
                    .display_name
                    .clone()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| model_key.clone()),
                model_key: model_key.clone(),
                is_favorite: false,
                sort_order: order,
                supports_vision: false,
            });
            provider.updated_at = crate::storage::config::now_millis();
        }
        Ok(to_view(provider))
    })
}

#[tauri::command]
pub fn remove_model(
    config: State<'_, ConfigStore>,
    args: ModelArgs,
) -> Result<ProviderView, String> {
    config.update(|cfg| {
        let provider = cfg
            .providers
            .iter_mut()
            .find(|p| p.id == args.provider_id)
            .ok_or_else(|| "服务商不存在".to_string())?;
        provider.models.retain(|m| m.model_key != args.model_key);
        if cfg.default_provider_id.as_deref() == Some(args.provider_id.as_str())
            && cfg.default_model_key.as_deref() == Some(args.model_key.as_str())
        {
            cfg.default_model_key = None;
        }
        provider.updated_at = crate::storage::config::now_millis();
        Ok(to_view(provider))
    })
}

#[tauri::command]
pub fn toggle_favorite(
    config: State<'_, ConfigStore>,
    args: ModelArgs,
) -> Result<ProviderView, String> {
    config.update(|cfg| {
        let provider = cfg
            .providers
            .iter_mut()
            .find(|p| p.id == args.provider_id)
            .ok_or_else(|| "服务商不存在".to_string())?;
        let model = provider
            .models
            .iter_mut()
            .find(|m| m.model_key == args.model_key)
            .ok_or_else(|| "模型不存在".to_string())?;
        model.is_favorite = !model.is_favorite;
        Ok(to_view(provider))
    })
}

/// Toggle the `supports_vision` flag on a model.
#[tauri::command]
pub fn toggle_vision(
    config: State<'_, ConfigStore>,
    args: ModelArgs,
) -> Result<ProviderView, String> {
    config.update(|cfg| {
        let provider = cfg
            .providers
            .iter_mut()
            .find(|p| p.id == args.provider_id)
            .ok_or_else(|| "服务商不存在".to_string())?;
        let model = provider
            .models
            .iter_mut()
            .find(|m| m.model_key == args.model_key)
            .ok_or_else(|| "模型不存在".to_string())?;
        model.supports_vision = !model.supports_vision;
        Ok(to_view(provider))
    })
}

/// Set the fallback vision model used when the selected model doesn't
/// support images.
#[tauri::command]
pub fn set_vision_model(
    config: State<'_, ConfigStore>,
    args: SetDefaultArgs,
) -> Result<(), String> {
    config.update(|cfg| {
        let provider = cfg
            .providers
            .iter()
            .find(|p| p.id == args.provider_id)
            .ok_or_else(|| "服务商不存在".to_string())?;
        let exists = provider
            .models
            .iter()
            .any(|m| m.model_key == args.model_key);
        if !exists {
            return Err("该服务商下不存在此模型".into());
        }
        cfg.vision_provider_id = Some(args.provider_id.clone());
        cfg.vision_model_key = Some(args.model_key.clone());
        Ok(())
    })
}

/// Set the default text-to-image model used by the image generation mode.
#[tauri::command]
pub fn set_image_model(config: State<'_, ConfigStore>, args: SetDefaultArgs) -> Result<(), String> {
    config.update(|cfg| {
        let provider = cfg
            .providers
            .iter()
            .find(|p| p.id == args.provider_id)
            .ok_or_else(|| "服务商不存在".to_string())?;
        let exists = provider
            .models
            .iter()
            .any(|m| m.model_key == args.model_key);
        if !exists {
            return Err("该服务商下不存在此模型".into());
        }
        cfg.image_provider_id = Some(args.provider_id.clone());
        cfg.image_model_key = Some(args.model_key.clone());
        Ok(())
    })
}

/// GET `{base}/models` for an existing provider and merge the discovered ids
/// into its model list (existing entries keep their names and favorites).
#[tauri::command]
/// Fetch the candidate model id list from the provider without modifying the
/// config. The frontend shows a picker and calls `add_models` for the
/// user-selected ids, so not every upstream model ends up in the config.
pub async fn fetch_models(
    http: State<'_, AppState>,
    config: State<'_, ConfigStore>,
    provider_id: String,
) -> Result<Vec<String>, String> {
    let (base_url, api_key) = config.read(|cfg| -> Result<(String, String), String> {
        let provider = cfg
            .providers
            .iter()
            .find(|p| p.id == provider_id)
            .ok_or_else(|| "服务商不存在".to_string())?;
        let key = secrets::get_api_key(&provider.id)?
            .ok_or_else(|| "该服务商尚未配置 API Key".to_string())?;
        Ok((provider.base_url.clone(), key))
    })?;

    let client = http.http.lock().unwrap().clone();
    let ids = request_model_ids(&client, &base_url, &api_key).await?;
    if ids.is_empty() {
        return Err("连接成功，但未发现任何模型".into());
    }
    Ok(ids)
}

/// Batch-add the user-selected model ids to a provider.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddModelsArgs {
    pub provider_id: String,
    pub model_keys: Vec<String>,
}

#[tauri::command]
pub fn add_models(
    config: State<'_, ConfigStore>,
    args: AddModelsArgs,
) -> Result<ProviderView, String> {
    config
        .update(|cfg| {
            let provider = cfg
                .providers
                .iter_mut()
                .find(|p| p.id == args.provider_id)
                .ok_or_else(|| "服务商不存在".to_string())?;

            for key in &args.model_keys {
                let key = key.trim();
                if key.is_empty() || provider.models.iter().any(|m| m.model_key == key) {
                    continue;
                }
                let order = provider.models.len() as i64;
                provider.models.push(ModelEntry {
                    display_name: key.to_string(),
                    model_key: key.to_string(),
                    is_favorite: false,
                    sort_order: order,
                    supports_vision: false,
                });
            }
            provider.updated_at = crate::storage::config::now_millis();
            Ok(to_view(provider))
        })
        .map_err(|e| format!("添加模型失败：{e}"))
}

/// Connectivity test. Works for a saved provider (`provider_id`) and/or with
/// ad-hoc values from the edit form (`base_url` / `api_key` override).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestEndpointArgs {
    pub provider_id: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestEndpointResult {
    pub ok: bool,
    pub message: String,
    pub models: Vec<String>,
}

#[tauri::command]
pub async fn test_endpoint(
    http: State<'_, AppState>,
    config: State<'_, ConfigStore>,
    args: TestEndpointArgs,
) -> Result<TestEndpointResult, String> {
    let base_arg = args.base_url.unwrap_or_default();
    let key_arg = args.api_key.unwrap_or_default();

    // Resolve effective base URL and key.
    let saved: Option<(String, Option<String>)> = match args.provider_id.as_deref() {
        Some(id) => {
            let view = config.read(|cfg| -> Result<(String, Option<String>), String> {
                let provider = cfg
                    .providers
                    .iter()
                    .find(|p| p.id == id)
                    .ok_or_else(|| "服务商不存在".to_string())?;
                let key = secrets::get_api_key(&provider.id)?;
                Ok((provider.base_url.clone(), key))
            })?;
            Some(view)
        }
        None => None,
    };

    let base_url = if !base_arg.trim().is_empty() {
        validate_base_url(&base_arg)?
    } else if let Some((b, _)) = &saved {
        b.clone()
    } else {
        return Ok(TestEndpointResult {
            ok: false,
            message: "Base URL 不能为空".into(),
            models: vec![],
        });
    };

    let api_key = if !key_arg.trim().is_empty() {
        key_arg.trim().to_string()
    } else {
        saved.and_then(|(_, k)| k).unwrap_or_default()
    };

    let client = http.http.lock().unwrap().clone();
    match request_model_ids(&client, &base_url, &api_key).await {
        Ok(models) => {
            let message = if models.is_empty() {
                "连接成功，但未解析到模型列表（可手工填写模型名）".to_string()
            } else {
                format!("连接成功，发现 {} 个模型", models.len())
            };
            Ok(TestEndpointResult {
                ok: true,
                message,
                models,
            })
        }
        Err(message) => Ok(TestEndpointResult {
            ok: false,
            message,
            models: vec![],
        }),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationArgs {
    /// `null` = auto (parameter not sent to the API).
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
}

#[tauri::command]
pub fn set_generation(config: State<'_, ConfigStore>, args: GenerationArgs) -> Result<(), String> {
    if let Some(t) = args.temperature {
        if !(0.0..=2.0).contains(&t) {
            return Err("温度需在 0 到 2 之间".into());
        }
    }
    config.update(|cfg| {
        cfg.generation.temperature = args.temperature;
        cfg.generation.max_tokens = args.max_tokens;
        Ok(())
    })
}

/// Set the default system prompt prepended to every conversation.
#[tauri::command]
pub fn set_default_system_prompt(
    config: State<'_, ConfigStore>,
    prompt: Option<String>,
) -> Result<(), String> {
    config.update(|cfg| {
        cfg.default_system_prompt = prompt.and_then(|p| {
            let t = p.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        });
        Ok(())
    })
}

/// Toggle whether the window position is remembered between sessions.
#[tauri::command]
pub fn set_remember_window_position(
    config: State<'_, ConfigStore>,
    enabled: bool,
) -> Result<(), String> {
    config.update(|cfg| {
        cfg.remember_window_position = enabled;
        if !enabled {
            cfg.window_x = None;
            cfg.window_y = None;
        }
        Ok(())
    })
}

/// Save the current window position so it can be restored on next show.
#[tauri::command]
pub fn save_window_position(config: State<'_, ConfigStore>, x: i32, y: i32) -> Result<(), String> {
    config.update(|cfg| {
        if cfg.remember_window_position {
            cfg.window_x = Some(x);
            cfg.window_y = Some(y);
        }
        Ok(())
    })
}

/// Get the current "remember window position" setting.
#[tauri::command]
pub fn get_remember_window_position(config: State<'_, ConfigStore>) -> Result<bool, String> {
    Ok(config.read(|cfg| cfg.remember_window_position))
}

const MAX_MODELS_RESPONSE_BYTES: usize = 512 * 1024;

/// Shared helper: GET `{base}/models`, mapping failures to readable text.
async fn request_model_ids(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<String>, String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let result = client
        .get(&url)
        .bearer_auth(api_key.trim())
        .timeout(Duration::from_secs(10))
        .send()
        .await;

    match result {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let text = read_body_capped(resp, MAX_MODELS_RESPONSE_BYTES).await?;
            if status == 200 {
                Ok(parse_model_ids(&text))
            } else {
                let (_code, message, _) = map_http_error(status, &text);
                Err(message)
            }
        }
        Err(err) => Err(if err.is_timeout() {
            "连接超时：请检查 Base URL 与网络".into()
        } else {
            format!("无法连接：{}", brief(&err))
        }),
    }
}

fn parse_model_ids(text: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return vec![];
    };
    let Some(arr) = v.get("data").and_then(|d| d.as_array()) else {
        return vec![];
    };
    arr.iter()
        .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from))
        .take(200)
        .collect()
}
