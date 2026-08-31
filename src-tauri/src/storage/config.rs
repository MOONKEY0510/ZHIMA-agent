//! Provider / model configuration persisted in `providers.json`.
//!
//! Only non-sensitive data lives here (plan §2.1: ordinary settings in JSON).
//! API keys are stored in the Windows Credential Manager — see `secrets.rs`.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Per-tool usage policy configured by the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolPolicy {
    /// Use the tool's builtin confirmation setting as-is.
    #[default]
    Allow,
    /// Force a confirmation dialog before every call.
    Confirm,
    /// Tool is disabled entirely and never offered to the model.
    Disabled,
}

impl ToolPolicy {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Confirm => "confirm",
            Self::Disabled => "disabled",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "allow" => Some(Self::Allow),
            "confirm" => Some(Self::Confirm),
            "disabled" => Some(Self::Disabled),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub model_key: String,
    pub display_name: String,
    #[serde(default)]
    pub is_favorite: bool,
    #[serde(default)]
    pub sort_order: i64,
    /// Whether this model supports image input (vision).
    #[serde(default)]
    pub supports_vision: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    /// Only `chat_completions` in v0.2; `/v1/responses` adapter comes later.
    #[serde(default = "default_api_type")]
    pub api_type: String,
    #[serde(default)]
    pub models: Vec<ModelEntry>,
    pub created_at: u64,
    pub updated_at: u64,
}

fn default_api_type() -> String {
    "chat_completions".into()
}

/// Generation parameters; `None` means "auto" — the field is not sent.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationPrefs {
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersConfig {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub providers: Vec<Provider>,
    pub default_provider_id: Option<String>,
    pub default_model_key: Option<String>,
    #[serde(default)]
    pub generation: GenerationPrefs,
    /// Custom global wake shortcut, e.g. "Alt+Space", "Ctrl+Shift+K".
    #[serde(default)]
    pub shortcut: Option<String>,
    /// Fallback vision model used when the selected model doesn't support
    /// images but the user attached one.
    #[serde(default)]
    pub vision_provider_id: Option<String>,
    #[serde(default)]
    pub vision_model_key: Option<String>,
    /// Default text-to-image model used by the image generation mode.
    #[serde(default)]
    pub image_provider_id: Option<String>,
    #[serde(default)]
    pub image_model_key: Option<String>,
    /// Default system prompt prepended to every conversation. Individual
    /// conversations can override this via the `conversations.system_prompt`
    /// column.
    #[serde(default)]
    pub default_system_prompt: Option<String>,
    /// Whether to remember the window position between sessions.
    #[serde(default)]
    pub remember_window_position: bool,
    /// Saved window position (physical coordinates) for restoration.
    #[serde(default)]
    pub window_x: Option<i32>,
    #[serde(default)]
    pub window_y: Option<i32>,
    /// Network proxy URL (`http://`, `https://`, `socks5://`). Empty when
    /// disabled. Used to route API requests through a local proxy.
    #[serde(default)]
    pub proxy_url: Option<String>,
    /// Whether to use the OS-level system proxy for API requests.
    #[serde(default)]
    pub use_system_proxy: bool,
    /// Per-tool usage policy. Keys are tool names; absent means `Allow`.
    #[serde(default)]
    pub tool_policies: HashMap<String, ToolPolicy>,
}

pub struct ConfigStore {
    path: PathBuf,
    inner: Mutex<ProvidersConfig>,
}

impl ConfigStore {
    /// Load from disk. Missing files use defaults; malformed files are kept
    /// and renamed so a later save cannot silently destroy the user's data.
    pub fn load(path: PathBuf) -> Self {
        let cfg = match fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str(&raw) {
                Ok(cfg) => cfg,
                Err(err) => {
                    eprintln!("配置文件损坏，将保留原文件：{err}");
                    let corrupt = path.with_extension(format!("json.corrupt.{}", now_millis()));
                    let _ = fs::rename(&path, corrupt);
                    ProvidersConfig {
                        version: 1,
                        ..Default::default()
                    }
                }
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => ProvidersConfig {
                version: 1,
                ..Default::default()
            },
            Err(err) => {
                eprintln!("读取配置文件失败，使用默认配置：{err}");
                ProvidersConfig {
                    version: 1,
                    ..Default::default()
                }
            }
        };
        Self {
            path,
            inner: Mutex::new(cfg),
        }
    }

    pub fn read<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&ProvidersConfig) -> R,
    {
        f(&self.inner.lock().unwrap())
    }

    /// Run `f` on the config and atomically persist the result
    /// (write temp file, then rename).
    pub fn update<F, R>(&self, f: F) -> Result<R, String>
    where
        F: FnOnce(&mut ProvidersConfig) -> Result<R, String>,
    {
        let mut guard = self.inner.lock().unwrap();
        let mut candidate = guard.clone();
        let out = f(&mut candidate)?;
        let json = serde_json::to_string_pretty(&candidate).map_err(|e| e.to_string())?;
        let tmp = self.path.with_extension("json.tmp");
        let backup = self.path.with_extension("json.bak");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&tmp)
            .map_err(|e| format!("写入配置文件失败：{e}"))?;
        file.write_all(json.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("同步配置文件失败：{e}"))?;
        drop(file);

        if self.path.exists() {
            let _ = fs::remove_file(&backup);
            fs::rename(&self.path, &backup).map_err(|e| format!("备份配置文件失败：{e}"))?;
        }
        if let Err(err) = fs::rename(&tmp, &self.path) {
            if backup.exists() {
                let _ = fs::rename(&backup, &self.path);
            }
            let _ = fs::remove_file(&tmp);
            return Err(format!("更新配置文件失败：{err}"));
        }
        *guard = candidate;
        Ok(out)
    }
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

static ID_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn new_provider_id() -> String {
    let seq = ID_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("p-{:x}-{seq:x}", now_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_roundtrip_keeps_fields() {
        let cfg = ProvidersConfig {
            version: 1,
            providers: vec![Provider {
                id: "p-1".into(),
                name: "测试".into(),
                base_url: "https://api.test/v1".into(),
                api_type: "chat_completions".into(),
                models: vec![ModelEntry {
                    model_key: "m1".into(),
                    display_name: "模型一".into(),
                    is_favorite: true,
                    sort_order: 0,
                    supports_vision: false,
                }],
                created_at: 1,
                updated_at: 2,
            }],
            default_provider_id: Some("p-1".into()),
            default_model_key: Some("m1".into()),
            generation: GenerationPrefs {
                temperature: Some(0.7),
                max_tokens: None,
            },
            shortcut: Some("Alt+Space".into()),
            vision_provider_id: None,
            vision_model_key: None,
            image_provider_id: None,
            image_model_key: None,
            default_system_prompt: None,
            remember_window_position: false,
            window_x: None,
            window_y: None,
            proxy_url: None,
            use_system_proxy: false,
            tool_policies: std::collections::HashMap::new(),
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: ProvidersConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.providers[0].name, "测试");
        assert_eq!(back.providers[0].models[0].model_key, "m1");
        assert_eq!(back.generation.temperature, Some(0.7));
        assert!(back.generation.max_tokens.is_none());
    }

    #[test]
    fn camel_case_field_names() {
        let cfg = ProvidersConfig {
            default_provider_id: Some("p".into()),
            ..Default::default()
        };
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("defaultProviderId"));
    }

    #[test]
    fn tool_policy_roundtrip_and_parse() {
        assert_eq!(ToolPolicy::parse("allow"), Some(ToolPolicy::Allow));
        assert_eq!(ToolPolicy::parse("confirm"), Some(ToolPolicy::Confirm));
        assert_eq!(ToolPolicy::parse("disabled"), Some(ToolPolicy::Disabled));
        assert_eq!(ToolPolicy::parse("bogus"), None);
        assert_eq!(ToolPolicy::Allow.as_str(), "allow");
        assert_eq!(ToolPolicy::Confirm.as_str(), "confirm");
        assert_eq!(ToolPolicy::Disabled.as_str(), "disabled");
        assert_eq!(ToolPolicy::default(), ToolPolicy::Allow);
    }

    #[test]
    fn tool_policies_survive_roundtrip() {
        let mut policies = std::collections::HashMap::new();
        policies.insert("read_clipboard".to_string(), ToolPolicy::Confirm);
        policies.insert("web_search".to_string(), ToolPolicy::Disabled);
        let cfg = ProvidersConfig {
            tool_policies: policies,
            ..Default::default()
        };
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("toolPolicies"));
        let back: ProvidersConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(
            back.tool_policies.get("read_clipboard"),
            Some(&ToolPolicy::Confirm)
        );
        assert_eq!(
            back.tool_policies.get("web_search"),
            Some(&ToolPolicy::Disabled)
        );
    }

    #[test]
    fn store_persists_updates_atomically() {
        let dir = std::env::temp_dir().join(format!("chatfloat-test-{}", now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("providers.json");

        let store = ConfigStore::load(path.clone());
        store
            .update(|cfg| {
                cfg.providers.push(Provider {
                    id: "p-x".into(),
                    name: "X".into(),
                    base_url: "https://x.test/v1".into(),
                    api_type: "chat_completions".into(),
                    models: vec![],
                    created_at: 1,
                    updated_at: 1,
                });
                Ok(())
            })
            .unwrap();

        // Reload from disk and verify.
        let store2 = ConfigStore::load(path.clone());
        assert_eq!(store2.read(|c| c.providers.len()), 1);
        assert!(!path.with_extension("json.tmp").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupted_file_is_preserved_and_defaults_are_loaded() {
        let dir = std::env::temp_dir().join(format!("chatfloat-test2-{}", now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("providers.json");
        std::fs::write(&path, "{ not json !!").unwrap();

        let store = ConfigStore::load(path.clone());
        assert_eq!(store.read(|c| c.providers.len()), 0);
        assert_eq!(store.read(|c| c.version), 1);
        assert!(!path.exists());
        assert!(std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains("corrupt")));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
