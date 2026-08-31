//! Local conversation storage (SQLite, plan §5.4 data model).
//!
//! Schema evolves through ordered migrations tracked by `PRAGMA user_version`
//! so future upgrades never lose user data (plan §5.4, §10). On startup any
//! message still marked `streaming` from a crashed/interrupted session is
//! recovered to `cancelled` (plan Phase 5).

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use serde::{Deserialize, Serialize};

/// Ordered, append-only migration list. Never edit applied migrations —
/// add new ones at the end.
const MIGRATIONS: &[&str] = &[
    // v1 — initial schema
    "CREATE TABLE IF NOT EXISTS conversations (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        provider_id   TEXT,
        model_key     TEXT,
        system_prompt TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        status          TEXT NOT NULL,
        usage_json      TEXT,
        created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_updated
        ON conversations(updated_at DESC);",
    // v2 — store model reasoning traces separately from the answer
    "ALTER TABLE messages ADD COLUMN reasoning TEXT;",
    // v3 — text-to-image generation history
    "CREATE TABLE IF NOT EXISTS image_generations (
        id         TEXT PRIMARY KEY,
        prompt     TEXT NOT NULL,
        image_data TEXT NOT NULL,
        size_label TEXT,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_image_generations_created
        ON image_generations(created_at DESC);",
    // v4 — persist agent tool-call steps attached to assistant messages
    // (JSON array; absent when no tools were used).
    "ALTER TABLE messages ADD COLUMN tool_calls TEXT;",
    // v5 — rolling conversation summaries for long-conversation context.
    "CREATE TABLE IF NOT EXISTS conversation_summaries (
        conversation_id        TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        summary                TEXT NOT NULL,
        covered_until_message_id TEXT NOT NULL,
        source_message_count   INTEGER NOT NULL DEFAULT 0,
        model_key              TEXT,
        version                INTEGER NOT NULL DEFAULT 1,
        updated_at             INTEGER NOT NULL
    );",
    // v6 — user-confirmed long-term memories (agent/phase 4).
    "CREATE TABLE IF NOT EXISTS memories (
        id                    TEXT PRIMARY KEY,
        category              TEXT NOT NULL,
        content               TEXT NOT NULL,
        keywords_json         TEXT,
        sensitivity           TEXT NOT NULL DEFAULT 'normal',
        source_conversation_id TEXT,
        source_message_id     TEXT,
        enabled               INTEGER NOT NULL DEFAULT 1,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL,
        last_used_at          INTEGER,
        use_count             INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_memories_enabled_used
        ON memories(enabled, use_count DESC);",
    // v7 — local (redacted) agent-run traces for diagnostics (phase 5).
    // No API keys, no Authorization, no full message bodies.
    "CREATE TABLE IF NOT EXISTS agent_runs (
        id             TEXT PRIMARY KEY,
        conversation_id TEXT,
        model_key      TEXT,
        status         TEXT NOT NULL,
        error_code     TEXT,
        started_at     INTEGER NOT NULL,
        finished_at    INTEGER,
        duration_ms    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_started
        ON agent_runs(started_at DESC);",
    // v8 — agent-run diagnostics gain tool & retry counters so the UI can
    // show how many tools ran and how many HTTP retries happened.
    "ALTER TABLE agent_runs ADD COLUMN tool_count INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE agent_runs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;",
    // v9 — image generation history keeps reference images for image-to-image / reference workflows.
    "ALTER TABLE image_generations ADD COLUMN reference_images_json TEXT;",
    // v10 — assistant messages remember which model answered and how long it took.
    "ALTER TABLE messages ADD COLUMN model_name TEXT;",
    "ALTER TABLE messages ADD COLUMN duration_ms INTEGER;",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub provider_id: Option<String>,
    pub model_key: Option<String>,
    pub system_prompt: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub status: String,
    #[serde(default)]
    pub reasoning: Option<String>,
    /// Serialized JSON array of tool-call steps (v4). Only assistant
    /// messages produced by the agent loop carry this.
    #[serde(default)]
    pub tool_calls: Option<String>,
    #[serde(default)]
    pub model_name: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    pub created_at: i64,
}

/// Rolling summary of a conversation's older turns (v5).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub conversation_id: String,
    pub summary: String,
    /// Message ID up to which the summary covers.
    pub covered_until_message_id: String,
    pub source_message_count: u32,
    #[serde(default)]
    pub model_key: Option<String>,
    #[serde(default)]
    pub version: u32,
    pub updated_at: i64,
}

/// A user-confirmed long-term memory (v6).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    pub category: String,
    pub content: String,
    #[serde(default)]
    pub keywords_json: Option<String>,
    #[serde(default)]
    pub sensitivity: String,
    #[serde(default)]
    pub source_conversation_id: Option<String>,
    #[serde(default)]
    pub source_message_id: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub last_used_at: Option<i64>,
    #[serde(default)]
    pub use_count: u32,
}

fn default_true() -> bool {
    true
}

/// One persisted text-to-image generation (v1.2).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGeneration {
    pub id: String,
    pub prompt: String,
    pub image_data: String,
    #[serde(default)]
    pub size_label: Option<String>,
    /// Serialized JSON array of reference image data URLs (image-to-image / reference workflows).
    #[serde(default)]
    pub reference_images_json: Option<String>,
    pub created_at: i64,
}

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// Open (or create) the database file, apply pending migrations and
    /// recover interrupted messages.
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("无法创建数据目录：{e}"))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("无法打开数据库：{e}"))?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate().map_err(|e| format!("数据库迁移失败：{e}"))?;
        db.recover_interrupted()
            .map_err(|e| format!("会话状态恢复失败：{e}"))?;
        Ok(db)
    }

    #[cfg(test)]
    fn in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("in-memory db");
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate().unwrap();
        db
    }

    fn migrate(&self) -> SqlResult<()> {
        let mut conn = self.conn.lock().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        let version: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        for (idx, sql) in MIGRATIONS.iter().enumerate() {
            if (idx as u32) < version {
                continue;
            }
            // Wrap the schema change and the version bump in a single
            // transaction.  `PRAGMA user_version` is transactional, so a crash
            // mid-migration rolls back both the DDL and the version — otherwise
            // the schema could be changed while the version stays behind, and
            // the next startup would re-run the migration and fail (e.g. a
            // duplicate column).
            let tx = conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", (idx + 1) as u32)?;
            tx.commit()?;
        }
        Ok(())
    }

    /// Messages left in `streaming` state by a crash or forced exit are
    /// partial answers; surface them as cancelled instead of stuck spinners.
    fn recover_interrupted(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE messages SET status = 'cancelled' WHERE status = 'streaming'",
            [],
        )?;
        Ok(())
    }

    /* ---------------- conversations ---------------- */

    pub fn create_conversation(&self, conv: &Conversation) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, provider_id, model_key, system_prompt, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                conv.id,
                conv.title,
                conv.provider_id,
                conv.model_key,
                conv.system_prompt,
                conv.created_at,
                conv.updated_at,
            ],
        )
        .map_err(|e| format!("创建会话失败：{e}"))?;
        Ok(())
    }

    /// Most recent conversations first, capped for a lean sidebar.
    pub fn list_conversations(&self, limit: u32) -> Result<Vec<Conversation>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, title, provider_id, model_key, system_prompt, created_at, updated_at
                 FROM conversations ORDER BY updated_at DESC LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit], |r| {
                Ok(Conversation {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    provider_id: r.get(2)?,
                    model_key: r.get(3)?,
                    system_prompt: r.get(4)?,
                    created_at: r.get(5)?,
                    updated_at: r.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|e| format!("读取会话列表失败：{e}"))
    }

    pub fn get_conversation(&self, id: &str) -> Result<Option<Conversation>, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, title, provider_id, model_key, system_prompt, created_at, updated_at
             FROM conversations WHERE id = ?1",
            params![id],
            |r| {
                Ok(Conversation {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    provider_id: r.get(2)?,
                    model_key: r.get(3)?,
                    system_prompt: r.get(4)?,
                    created_at: r.get(5)?,
                    updated_at: r.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("读取会话失败：{e}"))
    }

    pub fn rename_conversation(&self, id: &str, title: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET title = ?2 WHERE id = ?1",
            params![id, title],
        )
        .map_err(|e| format!("重命名失败：{e}"))?;
        Ok(())
    }

    /// Set (or clear) a conversation's per-session system prompt.
    pub fn set_conversation_system_prompt(
        &self,
        id: &str,
        system_prompt: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET system_prompt = ?2 WHERE id = ?1",
            params![id, system_prompt],
        )
        .map_err(|e| format!("更新会话提示词失败：{e}"))?;
        Ok(())
    }

    pub fn begin_chat_turn(
        &self,
        conversation: Option<&Conversation>,
        user_message: &Message,
        assistant_message: &Message,
        updated_at: i64,
        provider_id: Option<&str>,
        model_key: Option<&str>,
    ) -> Result<(), String> {
        if user_message.conversation_id != assistant_message.conversation_id {
            return Err("聊天轮次的消息不属于同一会话".into());
        }

        let mut conn = self.conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| format!("开始聊天轮次事务失败：{e}"))?;

        if let Some(conv) = conversation {
            tx.execute(
                "INSERT INTO conversations (id, title, provider_id, model_key, system_prompt, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    conv.id,
                    conv.title,
                    conv.provider_id,
                    conv.model_key,
                    conv.system_prompt,
                    conv.created_at,
                    conv.updated_at,
                ],
            )
            .map_err(|e| format!("创建会话失败：{e}"))?;
        }

        for msg in [user_message, assistant_message] {
            tx.execute(
                "INSERT INTO messages (id, conversation_id, role, content, status, reasoning, tool_calls, model_name, duration_ms, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET
                     content = excluded.content,
                     status = excluded.status,
                     reasoning = excluded.reasoning,
                     tool_calls = excluded.tool_calls,
                     model_name = excluded.model_name,
                     duration_ms = excluded.duration_ms",
                params![
                    msg.id,
                    msg.conversation_id,
                    msg.role,
                    msg.content,
                    msg.status,
                    msg.reasoning,
                    msg.tool_calls,
                    msg.model_name,
                    msg.duration_ms,
                    msg.created_at,
                ],
            )
            .map_err(|e| format!("保存聊天轮次消息失败：{e}"))?;
        }

        let changed = tx
            .execute(
                "UPDATE conversations
                 SET updated_at = ?2,
                     provider_id = COALESCE(?3, provider_id),
                     model_key = COALESCE(?4, model_key)
                 WHERE id = ?1",
                params![
                    user_message.conversation_id,
                    updated_at,
                    provider_id,
                    model_key
                ],
            )
            .map_err(|e| format!("更新会话失败：{e}"))?;
        if changed != 1 {
            return Err("会话不存在，无法保存聊天轮次".into());
        }

        tx.commit()
            .map_err(|e| format!("提交聊天轮次事务失败：{e}"))
    }

    /// Bump `updated_at` (and optionally provider/model) after activity.
    pub fn touch_conversation(
        &self,
        id: &str,
        updated_at: i64,
        provider_id: Option<&str>,
        model_key: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations
             SET updated_at = ?2,
                 provider_id = COALESCE(?3, provider_id),
                 model_key = COALESCE(?4, model_key)
             WHERE id = ?1",
            params![id, updated_at, provider_id, model_key],
        )
        .map_err(|e| format!("更新会话失败：{e}"))?;
        Ok(())
    }

    pub fn delete_conversation(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])
            .map_err(|e| format!("删除会话失败：{e}"))?;
        Ok(())
    }

    pub fn clear_all(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "DELETE FROM messages; DELETE FROM conversations; \
             DELETE FROM conversation_summaries; DELETE FROM image_generations;",
        )
        .map_err(|e| format!("清空数据失败：{e}"))?;
        Ok(())
    }

    /* ---------------- image generations ---------------- */

    /// Persist one generated image.
    pub fn save_image_generation(&self, gen: &ImageGeneration) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO image_generations (id, prompt, image_data, size_label, reference_images_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                 prompt = excluded.prompt,
                 image_data = excluded.image_data,
                 size_label = excluded.size_label,
                 reference_images_json = excluded.reference_images_json",
            params![
                gen.id,
                gen.prompt,
                gen.image_data,
                gen.size_label,
                gen.reference_images_json,
                gen.created_at
            ],
        )
        .map_err(|e| format!("保存图像生成失败：{e}"))?;
        Ok(())
    }

    /// List image generations, newest first.
    pub fn list_image_generations(&self, limit: u32) -> Result<Vec<ImageGeneration>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, prompt, image_data, size_label, reference_images_json, created_at
                 FROM image_generations
                 ORDER BY created_at DESC
                 LIMIT ?1",
            )
            .map_err(|e| format!("查询图像生成失败：{e}"))?;
        let rows = stmt
            .query_map(params![limit], |row| {
                Ok(ImageGeneration {
                    id: row.get(0)?,
                    prompt: row.get(1)?,
                    image_data: row.get(2)?,
                    size_label: row.get(3)?,
                    reference_images_json: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })
            .map_err(|e| format!("查询图像生成失败：{e}"))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("读取图像生成失败：{e}"))?);
        }
        Ok(out)
    }

    /// Delete one image generation.
    pub fn delete_image_generation(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM image_generations WHERE id = ?1", params![id])
            .map_err(|e| format!("删除图像生成失败：{e}"))?;
        Ok(())
    }

    /// Clear all image generation history.
    pub fn clear_image_generations(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("DELETE FROM image_generations;")
            .map_err(|e| format!("清空图像生成失败：{e}"))?;
        Ok(())
    }

    /* ---------------- messages ---------------- */

    /// Insert or update a message (assistant rows are created when the
    /// request starts, then updated once the stream settles).
    pub fn save_message(&self, msg: &Message) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, status, reasoning, tool_calls, model_name, duration_ms, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
                 content = excluded.content,
                 status = excluded.status,
                 reasoning = excluded.reasoning,
                 tool_calls = excluded.tool_calls,
                 model_name = excluded.model_name,
                 duration_ms = excluded.duration_ms",
            params![
                msg.id,
                msg.conversation_id,
                msg.role,
                msg.content,
                msg.status,
                msg.reasoning,
                msg.tool_calls,
                msg.model_name,
                msg.duration_ms,
                msg.created_at,
            ],
        )
        .map_err(|e| format!("保存消息失败：{e}"))?;
        Ok(())
    }

    pub fn list_messages(&self, conversation_id: &str) -> Result<Vec<Message>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, role, content, status, reasoning, tool_calls, model_name, duration_ms, created_at
                 FROM messages WHERE conversation_id = ?1 ORDER BY created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![conversation_id], |r| {
                Ok(Message {
                    id: r.get(0)?,
                    conversation_id: r.get(1)?,
                    role: r.get(2)?,
                    content: r.get(3)?,
                    status: r.get(4)?,
                    reasoning: r.get(5)?,
                    tool_calls: r.get(6)?,
                    model_name: r.get(7)?,
                    duration_ms: r.get(8)?,
                    created_at: r.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|e| format!("读取消息失败：{e}"))
    }

    /* ---------------- conversation summaries (v5) ---------------- */

    pub fn get_summary(
        &self,
        conversation_id: &str,
    ) -> Result<Option<ConversationSummary>, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT conversation_id, summary, covered_until_message_id,
                    source_message_count, model_key, version, updated_at
             FROM conversation_summaries WHERE conversation_id = ?1",
            params![conversation_id],
            |r| {
                Ok(ConversationSummary {
                    conversation_id: r.get(0)?,
                    summary: r.get(1)?,
                    covered_until_message_id: r.get(2)?,
                    source_message_count: r.get(3)?,
                    model_key: r.get(4)?,
                    version: r.get(5)?,
                    updated_at: r.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("读取会话摘要失败：{e}"))
    }

    pub fn save_summary(&self, summary: &ConversationSummary) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO conversation_summaries
                (conversation_id, summary, covered_until_message_id,
                 source_message_count, model_key, version, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(conversation_id) DO UPDATE SET
                 summary = excluded.summary,
                 covered_until_message_id = excluded.covered_until_message_id,
                 source_message_count = excluded.source_message_count,
                 model_key = excluded.model_key,
                 version = version + 1,
                 updated_at = excluded.updated_at",
            params![
                summary.conversation_id,
                summary.summary,
                summary.covered_until_message_id,
                summary.source_message_count,
                summary.model_key,
                summary.version,
                summary.updated_at,
            ],
        )
        .map_err(|e| format!("保存会话摘要失败：{e}"))?;
        Ok(())
    }

    /// Reserved for the memory/summary management UI (phase 4+).
    #[allow(dead_code)]
    pub fn delete_summary(&self, conversation_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM conversation_summaries WHERE conversation_id = ?1",
            params![conversation_id],
        )
        .map_err(|e| format!("删除会话摘要失败：{e}"))?;
        Ok(())
    }

    /* ---------------- memories (v6) ---------------- */

    /// List all memories, most-recently-used first.
    pub fn list_memories(&self) -> Result<Vec<Memory>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, category, content, keywords_json, sensitivity,
                        source_conversation_id, source_message_id, enabled,
                        created_at, updated_at, last_used_at, use_count
                 FROM memories ORDER BY last_used_at DESC, updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Memory {
                    id: r.get(0)?,
                    category: r.get(1)?,
                    content: r.get(2)?,
                    keywords_json: r.get(3)?,
                    sensitivity: r.get(4)?,
                    source_conversation_id: r.get(5)?,
                    source_message_id: r.get(6)?,
                    enabled: r.get::<_, i64>(7)? != 0,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
                    last_used_at: r.get(10)?,
                    use_count: r.get::<_, i64>(11)? as u32,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|e| format!("读取记忆失败：{e}"))
    }

    /// The enabled memories used for prompt injection, most-used first.
    /// `limit` bounds how many are injected to protect the context budget.
    pub fn list_enabled_memories(&self, limit: u32) -> Result<Vec<Memory>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, category, content, keywords_json, sensitivity,
                        source_conversation_id, source_message_id, enabled,
                        created_at, updated_at, last_used_at, use_count
                 FROM memories WHERE enabled = 1
                 ORDER BY use_count DESC, updated_at DESC
                 LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit], |r| {
                Ok(Memory {
                    id: r.get(0)?,
                    category: r.get(1)?,
                    content: r.get(2)?,
                    keywords_json: r.get(3)?,
                    sensitivity: r.get(4)?,
                    source_conversation_id: r.get(5)?,
                    source_message_id: r.get(6)?,
                    enabled: r.get::<_, i64>(7)? != 0,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
                    last_used_at: r.get(10)?,
                    use_count: r.get::<_, i64>(11)? as u32,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|e| format!("读取记忆失败：{e}"))
    }

    pub fn create_memory(&self, mem: &Memory) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO memories
                (id, category, content, keywords_json, sensitivity,
                 source_conversation_id, source_message_id, enabled,
                 created_at, updated_at, last_used_at, use_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                mem.id,
                mem.category,
                mem.content,
                mem.keywords_json,
                mem.sensitivity,
                mem.source_conversation_id,
                mem.source_message_id,
                mem.enabled as i64,
                mem.created_at,
                mem.updated_at,
                mem.last_used_at,
                mem.use_count as i64,
            ],
        )
        .map_err(|e| format!("保存记忆失败：{e}"))?;
        Ok(())
    }

    pub fn update_memory(&self, id: &str, content: &str, category: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE memories SET content = ?2, category = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, content, category, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(|e| format!("更新记忆失败：{e}"))?;
        Ok(())
    }

    pub fn set_memory_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE memories SET enabled = ?2 WHERE id = ?1",
            params![id, enabled as i64],
        )
        .map_err(|e| format!("更新记忆状态失败：{e}"))?;
        Ok(())
    }

    /// Bump use stats when a memory was injected into a prompt.
    pub fn record_memory_use(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE memories SET use_count = use_count + 1, last_used_at = ?2 WHERE id = ?1",
            params![id, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(|e| format!("更新记忆使用记录失败：{e}"))?;
        Ok(())
    }

    pub fn delete_memory(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM memories WHERE id = ?1", params![id])
            .map_err(|e| format!("删除记忆失败：{e}"))?;
        Ok(())
    }

    pub fn clear_memories(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("DELETE FROM memories;")
            .map_err(|e| format!("清空记忆失败：{e}"))?;
        Ok(())
    }

    /* ---------------- agent run traces (v7) ---------------- */

    /// Record a redacted run trace.  `error_code` and `status` only; never
    /// store credentials or message bodies.  `tool_count` / `retry_count`
    /// capture how many tools executed and how many HTTP retries happened.
    #[allow(clippy::too_many_arguments)]
    pub fn record_run(
        &self,
        id: &str,
        conversation_id: Option<&str>,
        model_key: Option<&str>,
        status: &str,
        error_code: Option<&str>,
        started_at: i64,
        finished_at: i64,
        tool_count: u32,
        retry_count: u32,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO agent_runs
                (id, conversation_id, model_key, status, error_code,
                 started_at, finished_at, duration_ms, tool_count, retry_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id,
                conversation_id,
                model_key,
                status,
                error_code,
                started_at,
                finished_at,
                finished_at.saturating_sub(started_at),
                tool_count,
                retry_count,
            ],
        )
        .map_err(|e| format!("记录运行轨迹失败：{e}"))?;
        Ok(())
    }

    /// Recent run traces, newest first.
    pub fn list_runs(&self, limit: u32) -> Result<Vec<serde_json::Value>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, model_key, status, error_code,
                        started_at, finished_at, duration_ms, tool_count, retry_count
                 FROM agent_runs ORDER BY started_at DESC LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, String>(0)?,
                    "conversationId": r.get::<_, Option<String>>(1)?,
                    "modelKey": r.get::<_, Option<String>>(2)?,
                    "status": r.get::<_, String>(3)?,
                    "errorCode": r.get::<_, Option<String>>(4)?,
                    "startedAt": r.get::<_, i64>(5)?,
                    "finishedAt": r.get::<_, i64>(6)?,
                    "durationMs": r.get::<_, i64>(7)?,
                    "toolCount": r.get::<_, u32>(8)?,
                    "retryCount": r.get::<_, u32>(9)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|e| format!("读取运行轨迹失败：{e}"))
    }

    /// Delete old traces beyond the retention window.
    pub fn prune_runs(&self, keep_younger_than_ms: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let cutoff = chrono::Utc::now().timestamp_millis() - keep_younger_than_ms;
        conn.execute(
            "DELETE FROM agent_runs WHERE started_at < ?1",
            params![cutoff],
        )
        .map_err(|e| format!("清理运行轨迹失败：{e}"))?;
        Ok(())
    }

    pub fn clear_runs(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("DELETE FROM agent_runs;")
            .map_err(|e| format!("清空运行轨迹失败：{e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conv(id: &str, title: &str, updated: i64) -> Conversation {
        Conversation {
            id: id.into(),
            title: title.into(),
            provider_id: Some("p-1".into()),
            model_key: Some("m-1".into()),
            system_prompt: None,
            created_at: updated,
            updated_at: updated,
        }
    }

    fn msg(id: &str, conv: &str, role: &str, content: &str, status: &str, at: i64) -> Message {
        Message {
            id: id.into(),
            conversation_id: conv.into(),
            role: role.into(),
            content: content.into(),
            status: status.into(),
            reasoning: None,
            tool_calls: None,
            model_name: None,
            duration_ms: None,
            created_at: at,
        }
    }

    #[test]
    fn migrations_are_idempotent() {
        let db = Database::in_memory();
        // Running migrate twice must not fail or reset data.
        db.migrate().unwrap();
        db.create_conversation(&conv("c1", "t", 1)).unwrap();
        db.migrate().unwrap();
        assert!(db.get_conversation("c1").unwrap().is_some());
    }

    #[test]
    fn record_run_stores_tool_and_retry_counts() {
        let db = Database::in_memory();
        db.record_run(
            "r1",
            Some("c1"),
            Some("m1"),
            "completed",
            None,
            100,
            2500,
            3,
            1,
        )
        .unwrap();
        let runs = db.list_runs(10).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["status"], "completed");
        assert_eq!(runs[0]["durationMs"], 2400);
        assert_eq!(runs[0]["toolCount"], 3);
        assert_eq!(runs[0]["retryCount"], 1);
    }

    #[test]
    fn begin_chat_turn_commits_conversation_and_messages_together() {
        let db = Database::in_memory();
        let conversation = conv("c1", "首轮", 10);
        let user = msg("u1", "c1", "user", "你好", "done", 10);
        let assistant = msg("a1", "c1", "assistant", "", "streaming", 10);

        db.begin_chat_turn(
            Some(&conversation),
            &user,
            &assistant,
            11,
            Some("p-1"),
            Some("m-1"),
        )
        .unwrap();

        assert_eq!(db.list_messages("c1").unwrap().len(), 2);
        assert_eq!(db.get_conversation("c1").unwrap().unwrap().updated_at, 11);
    }

    #[test]
    fn begin_chat_turn_rolls_back_when_conversation_is_missing() {
        let db = Database::in_memory();
        let user = msg("u1", "missing", "user", "你好", "done", 10);
        let assistant = msg("a1", "missing", "assistant", "", "streaming", 10);

        assert!(db
            .begin_chat_turn(None, &user, &assistant, 11, Some("p-1"), Some("m-1"))
            .is_err());
        assert!(db.list_messages("missing").unwrap().is_empty());
    }

    #[test]
    fn message_upsert_updates_content_and_status() {
        let db = Database::in_memory();
        db.create_conversation(&conv("c1", "t", 1)).unwrap();
        db.save_message(&msg("m1", "c1", "assistant", "", "streaming", 1))
            .unwrap();
        db.save_message(&msg("m1", "c1", "assistant", "最终回答", "done", 2))
            .unwrap();

        let msgs = db.list_messages("c1").unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].content, "最终回答");
        assert_eq!(msgs[0].status, "done");
    }

    #[test]
    fn deleting_conversation_cascades_messages() {
        let db = Database::in_memory();
        db.create_conversation(&conv("c1", "t", 1)).unwrap();
        db.save_message(&msg("m1", "c1", "user", "hi", "done", 1))
            .unwrap();
        db.delete_conversation("c1").unwrap();
        assert!(db.get_conversation("c1").unwrap().is_none());
        assert!(db.list_messages("c1").unwrap().is_empty());
    }

    #[test]
    fn list_orders_by_updated_desc_and_limits() {
        let db = Database::in_memory();
        db.create_conversation(&conv("old", "旧", 100)).unwrap();
        db.create_conversation(&conv("new", "新", 300)).unwrap();
        db.create_conversation(&conv("mid", "中", 200)).unwrap();

        let list = db.list_conversations(2).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "new");
        assert_eq!(list[1].id, "mid");
    }

    #[test]
    fn touch_bumps_updated_and_fills_provider() {
        let db = Database::in_memory();
        let mut c = conv("c1", "t", 1);
        c.provider_id = None;
        c.model_key = None;
        db.create_conversation(&c).unwrap();

        db.touch_conversation("c1", 50, Some("p-9"), Some("m-9"))
            .unwrap();
        let updated = db.get_conversation("c1").unwrap().unwrap();
        assert_eq!(updated.updated_at, 50);
        assert_eq!(updated.provider_id.as_deref(), Some("p-9"));
        assert_eq!(updated.model_key.as_deref(), Some("m-9"));
    }

    #[test]
    fn clear_all_removes_everything() {
        let db = Database::in_memory();
        db.create_conversation(&conv("c1", "t", 1)).unwrap();
        db.save_message(&msg("m1", "c1", "user", "hi", "done", 1))
            .unwrap();
        db.clear_all().unwrap();
        assert!(db.list_conversations(10).unwrap().is_empty());
    }

    #[test]
    fn interrupted_streaming_messages_are_recovered() {
        let dir = std::env::temp_dir().join(format!(
            "chatfloat-db-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("chatfloat.db");

        {
            let db = Database::open(&path).unwrap();
            db.create_conversation(&conv("c1", "t", 1)).unwrap();
            db.save_message(&msg("m1", "c1", "assistant", "一半", "streaming", 1))
                .unwrap();
        }

        // Reopen — simulates an app restart after a crash mid-generation.
        let db = Database::open(&path).unwrap();
        let msgs = db.list_messages("c1").unwrap();
        assert_eq!(msgs[0].status, "cancelled");
        assert_eq!(msgs[0].content, "一半");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
