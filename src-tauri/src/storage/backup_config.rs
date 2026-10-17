//! Deliberate portable allowlist. Never serialize ProvidersConfig here.
use crate::storage::config::{ConfigStore, GenerationPrefs, ModelEntry, Provider, ProvidersConfig};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_type: String,
    pub models: Vec<ModelEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableConfig {
    pub providers: Vec<PortableProvider>,
    pub default_provider_id: Option<String>,
    pub default_model_key: Option<String>,
    pub vision_provider_id: Option<String>,
    pub vision_model_key: Option<String>,
    pub image_provider_id: Option<String>,
    pub image_model_key: Option<String>,
    #[serde(default)]
    pub generation: GenerationPrefs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_preferences: Option<Value>,
}

fn safe_url(value: &str) -> Result<(), String> {
    let url = url::Url::parse(value).map_err(|_| "服务地址无效".to_string())?;
    // Reject every query, not only familiar credential key names: providers use
    // arbitrary names and opaque signed queries. Fragments can carry tokens too.
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("备份拒绝包含认证、查询参数或片段的服务地址；请移除凭据后重试".into());
    }
    Ok(())
}

impl PortableConfig {
    pub fn from_config(config: &ProvidersConfig, prefs: Option<Value>) -> Result<Self, String> {
        let result = Self {
            providers: config
                .providers
                .iter()
                .map(|p| PortableProvider {
                    id: p.id.clone(),
                    name: p.name.clone(),
                    base_url: p.base_url.clone(),
                    api_type: p.api_type.clone(),
                    models: p.models.clone(),
                })
                .collect(),
            default_provider_id: config.default_provider_id.clone(),
            default_model_key: config.default_model_key.clone(),
            vision_provider_id: config.vision_provider_id.clone(),
            vision_model_key: config.vision_model_key.clone(),
            image_provider_id: config.image_provider_id.clone(),
            image_model_key: config.image_model_key.clone(),
            generation: config.generation.clone(),
            ui_preferences: prefs.map(sanitize_preferences).transpose()?,
        };
        result.validate()?;
        Ok(result)
    }
    pub fn validate(&self) -> Result<(), String> {
        let mut ids = std::collections::HashSet::new();
        for p in &self.providers {
            safe_url(&p.base_url)?;
            if p.id.is_empty() || !ids.insert(&p.id) {
                return Err("服务商 ID 重复或为空".into());
            }
        }
        if self
            .generation
            .temperature
            .is_some_and(|v| !v.is_finite() || !(0.0..=2.0).contains(&v))
            || self.generation.max_tokens == Some(0)
        {
            return Err("生成参数无效".into());
        }
        if let Some(prefs) = &self.ui_preferences {
            sanitize_preferences(prefs.clone())?;
        }
        Ok(())
    }
    pub fn restore(&self, store: &ConfigStore) -> Result<Option<Value>, String> {
        self.restore_with_secret_check(store, |id| {
            crate::storage::secrets::get_api_key(id).map(|secret| secret.is_some())
        })
    }

    // The production restore and fixture tests share this entire persistence
    // path. Only the OS credential lookup is injected; tests never read it.
    fn restore_with_secret_check(
        &self,
        store: &ConfigStore,
        mut has_secret: impl FnMut(&str) -> Result<bool, String>,
    ) -> Result<Option<Value>, String> {
        self.validate()?;
        let prefs = self
            .ui_preferences
            .clone()
            .map(sanitize_preferences)
            .transpose()?;
        store.update(|cfg| {
            // Only these explicit fields change. Credentials, MCP, proxy and
            // machine-local permissions remain untouched.
            // A portable backup must not redirect a retained local API key to
            // another endpoint merely by reusing a provider id.
            for provider in &self.providers {
                let same_id = cfg.providers.iter().find(|old| old.id == provider.id);
                if same_id.is_some_and(|old| old.base_url != provider.base_url) {
                    return Err("备份服务商 ID 与本机相同但地址不同。为防止本机凭据被发往其他地址，配置未恢复；请手动核对服务商。".into());
                }
                // A previous two-phase restore may have removed the provider
                // row while leaving its OS credential behind. Reusing that id
                // for a new endpoint would redirect the retained key.
                if same_id.is_none() && has_secret(&provider.id)? {
                    return Err("备份服务商 ID 在本机没有配置但仍有残留凭据。为防止凭据被重定向，配置未恢复；请先清理凭据或使用新的服务商 ID。".into());
                }
            }
            let now = crate::storage::config::now_millis();
            cfg.providers = self
                .providers
                .iter()
                .map(|p| Provider {
                    id: p.id.clone(),
                    name: p.name.clone(),
                    base_url: p.base_url.clone(),
                    api_type: p.api_type.clone(),
                    models: p.models.clone(),
                    created_at: now,
                    updated_at: now,
                })
                .collect();
            cfg.default_provider_id = self.default_provider_id.clone();
            cfg.default_model_key = self.default_model_key.clone();
            cfg.vision_provider_id = self.vision_provider_id.clone();
            cfg.vision_model_key = self.vision_model_key.clone();
            cfg.image_provider_id = self.image_provider_id.clone();
            cfg.image_model_key = self.image_model_key.clone();
            cfg.generation = self.generation.clone();
            Ok(())
        })?;
        Ok(prefs)
    }
}

/// Unknown keys are dropped recursively, including desktop command execution
/// flags and binary avatar/background paths. Known malformed fields fail closed.
pub fn sanitize_preferences(value: Value) -> Result<Value, String> {
    let input = value.as_object().ok_or("UI 偏好必须是对象")?;
    let mut out = Map::new();
    for (key, values) in [
        (
            "theme",
            &[
                "system",
                "light",
                "dark",
                "paper",
                "paper-dark",
                "warm",
                "rose",
                "spring",
            ][..],
        ),
        ("aiAvatar", &["circle", "rounded", "square"][..]),
        ("userAvatar", &["circle", "rounded", "square"][..]),
        (
            "defaultThinkingEffort",
            &["low", "medium", "high", "max"][..],
        ),
        (
            "diagramStyle",
            &["auto", "tech", "morandi", "handdrawn"][..],
        ),
    ] {
        if let Some(v) = input.get(key) {
            if !v.as_str().is_some_and(|s| values.contains(&s)) {
                return Err(format!("UI 偏好 {key} 无效"));
            }
            out.insert(key.into(), v.clone());
        }
    }
    for key in ["hideOnBlur", "defaultEnableTools", "defaultEnableThinking"] {
        if let Some(v) = input.get(key) {
            if !v.is_boolean() {
                return Err(format!("UI 偏好 {key} 无效"));
            }
            out.insert(key.into(), v.clone());
        }
    }
    for key in ["aiAvatarColor", "userAvatarColor"] {
        if let Some(v) = input.get(key) {
            let s = v.as_str().ok_or("头像颜色无效")?;
            if !s.starts_with('#')
                || ![4, 7, 9].contains(&s.len())
                || !s[1..].bytes().all(|c| c.is_ascii_hexdigit())
            {
                return Err("头像颜色无效".into());
            }
            out.insert(key.into(), v.clone());
        }
    }
    if let Some(presets) = input.get("presets") {
        let values = presets.as_array().ok_or("预设必须是数组")?;
        if values.len() > 200 {
            return Err("预设数量超过上限".into());
        }
        let mut clean = Vec::new();
        for preset in values {
            let p = preset.as_object().ok_or("预设无效")?;
            let mut v = Map::new();
            for key in ["id", "name", "command", "content"] {
                let s = p.get(key).and_then(Value::as_str).ok_or("预设字段无效")?;
                if s.len() > 100_000 {
                    return Err("预设过大".into());
                }
                v.insert(key.into(), Value::String(s.into()));
            }
            if let Some(action) = p.get("desktopAction") {
                let a = action.as_object().ok_or("桌面动作无效")?;
                let mut safe = Map::new();
                for (key, allowed) in [
                    ("source", &["selection", "clipboard"][..]),
                    ("output", &["display", "copy"][..]),
                ] {
                    let s = a
                        .get(key)
                        .and_then(Value::as_str)
                        .ok_or("桌面动作字段无效")?;
                    if !allowed.contains(&s) {
                        return Err("桌面动作字段无效".into());
                    }
                    safe.insert(key.into(), Value::String(s.into()));
                }
                for key in ["template", "assistantId"] {
                    if let Some(s) = a.get(key) {
                        if !s.is_string() {
                            return Err("桌面动作文本无效".into());
                        }
                        safe.insert(key.into(), s.clone());
                    }
                }
                if let Some(ids) = a.get("skillIds") {
                    if !ids
                        .as_array()
                        .is_some_and(|a| a.len() <= 200 && a.iter().all(Value::is_string))
                    {
                        return Err("技能引用无效".into());
                    }
                    safe.insert("skillIds".into(), ids.clone());
                }
                if let Some(favorite) = a.get("favorite") {
                    if !favorite.is_boolean() {
                        return Err("收藏状态无效".into());
                    }
                    safe.insert("favorite".into(), favorite.clone());
                }
                v.insert("desktopAction".into(), Value::Object(safe));
            }
            clean.push(Value::Object(v));
        }
        out.insert("presets".into(), Value::Array(clean));
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backup_config_rejects_url_credentials_and_query() {
        for url in [
            "https://user:pass@example.com",
            "https://example.com?api_key=secret",
            "https://example.com?opaque=secret",
            "https://example.com#token",
        ] {
            assert!(safe_url(url).is_err());
        }
        assert!(safe_url("https://example.com/v1").is_ok());
    }
    #[test]
    fn backup_config_projection_never_serializes_machine_configuration() {
        let mut cfg = ProvidersConfig {
            proxy_url: Some("http://user:proxy-password@localhost:8080".into()),
            ..Default::default()
        };
        cfg.mcp_servers
            .push(crate::storage::config::McpServerConfig {
                id: "mcp".into(),
                name: "server".into(),
                command: "private-executable".into(),
                args: vec!["private-argument".into()],
                env: std::collections::HashMap::from([("API_KEY".into(), "mcp-secret".into())]),
                enabled: true,
            });
        cfg.tool_policies.insert(
            "shell".into(),
            crate::storage::config::ToolPolicy::AlwaysAllow,
        );
        cfg.providers.push(Provider {
            id: "p".into(),
            name: "Provider".into(),
            base_url: "https://example.test/v1".into(),
            api_type: "chat_completions".into(),
            models: vec![],
            created_at: 1,
            updated_at: 1,
        });
        let portable = PortableConfig::from_config(&cfg, None).unwrap();
        let json = serde_json::to_string(&portable).unwrap();
        for secret in [
            "proxy-password",
            "private-executable",
            "private-argument",
            "mcp-secret",
            "always_allow",
            "mcpServers",
            "proxyUrl",
        ] {
            assert!(!json.contains(secret));
        }
        assert!(json.contains("Provider"));
    }

    #[test]
    fn backup_config_failed_write_leaves_memory_unchanged() {
        let root = std::env::temp_dir().join(format!(
            "zhima-config-backup-test-{}-{}",
            std::process::id(),
            crate::storage::config::now_millis()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let blocker = root.join("not-a-directory");
        std::fs::write(&blocker, "fixture").unwrap();
        let store = ConfigStore::load(blocker.join("providers.json"));
        let portable = PortableConfig {
            default_model_key: Some("new-model".into()),
            ..Default::default()
        };
        assert!(portable
            .restore_with_secret_check(&store, |_| Ok(false))
            .is_err());
        assert!(store.read(|cfg| cfg.default_model_key.is_none()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn backup_config_cannot_redirect_existing_provider_credentials() {
        let root = std::env::temp_dir().join(format!(
            "zhima-config-redirect-test-{}-{}",
            std::process::id(),
            crate::storage::config::now_millis()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let store = ConfigStore::load(root.join("providers.json"));
        store
            .update(|cfg| {
                cfg.providers.push(Provider {
                    id: "p".into(),
                    name: "P".into(),
                    base_url: "https://trusted.test/v1".into(),
                    api_type: "chat_completions".into(),
                    models: vec![],
                    created_at: 1,
                    updated_at: 1,
                });
                Ok(())
            })
            .unwrap();
        let mut portable = store
            .read(|cfg| PortableConfig::from_config(cfg, None))
            .unwrap();
        portable.providers[0].base_url = "https://untrusted.test/v1".into();
        assert!(portable
            .restore_with_secret_check(&store, |_| panic!(
                "known provider must not query credentials"
            ))
            .unwrap_err()
            .contains("凭据"));
        assert_eq!(
            store.read(|cfg| cfg.providers[0].base_url.clone()),
            "https://trusted.test/v1"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn backup_config_two_stage_restore_cannot_reuse_orphaned_credentials() {
        let root = std::env::temp_dir().join(format!(
            "zhima-config-two-stage-test-{}-{}",
            std::process::id(),
            crate::storage::config::now_millis()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("providers.json");
        let store = ConfigStore::load(path.clone());
        store
            .update(|cfg| {
                cfg.providers.push(Provider {
                    id: "p".into(),
                    name: "Trusted".into(),
                    base_url: "https://trusted.test/v1".into(),
                    api_type: "chat_completions".into(),
                    models: vec![],
                    created_at: 1,
                    updated_at: 1,
                });
                Ok(())
            })
            .unwrap();
        let mut incoming = store
            .read(|cfg| PortableConfig::from_config(cfg, None))
            .unwrap();
        // Stage one really replaces the on-disk configuration, but does not
        // delete credentials. Model that retained credential in the closure.
        PortableConfig::default()
            .restore_with_secret_check(&store, |_| {
                panic!("empty restore has no credentials to check")
            })
            .unwrap();
        assert!(store.read(|cfg| cfg.providers.is_empty()));
        drop(store);
        // Restart makes sure the test is not relying on in-memory history.
        let store = ConfigStore::load(path.clone());
        let before = std::fs::read(&path).unwrap();
        incoming.providers[0].base_url = "https://evil.test/v1".into();
        let mut queried = Vec::new();
        let err = incoming
            .restore_with_secret_check(&store, |id| {
                queried.push(id.to_string());
                Ok(id == "p")
            })
            .unwrap_err();
        assert!(err.contains("残留凭据"));
        assert_eq!(queried, vec!["p"]);
        assert!(store.read(|cfg| cfg.providers.is_empty()));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        // Credential-store errors fail closed too, with no partial writes.
        assert_eq!(
            incoming
                .restore_with_secret_check(&store, |_| Err("credential lookup unavailable".into()))
                .unwrap_err(),
            "credential lookup unavailable"
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        // A genuinely fresh id without a secret may still be restored.
        incoming.providers[0].id = "fresh-provider".into();
        incoming
            .restore_with_secret_check(&store, |id| {
                assert_eq!(id, "fresh-provider");
                Ok(false)
            })
            .unwrap();
        assert_eq!(
            store.read(|cfg| cfg.providers[0].id.clone()),
            "fresh-provider"
        );
        drop(store);
        assert_eq!(
            ConfigStore::load(path).read(|cfg| cfg.providers[0].id.clone()),
            "fresh-provider"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn backup_preferences_drop_machine_secrets_recursively() {
        let clean = sanitize_preferences(serde_json::json!({"theme":"dark","proxyUrl":"secret","backgroundImage":"private","presets":[{"id":"p","name":"P","command":"/p","content":"text","desktopAction":{"source":"clipboard","output":"copy","template":"{{text}}","skillIds":[],"shellCommand":"evil","autoExecute":true}}]})).unwrap();
        let text = clean.to_string();
        assert!(!text.contains("secret"));
        assert!(!text.contains("evil"));
        assert!(!text.contains("autoExecute"));
    }
}
