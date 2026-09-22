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

use crate::storage::assistants::Assistant;
use crate::storage::skills::{new_skill_id, Skill, SkillDraft};

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
    // v11 — message version stacks: `versions_json` holds every version of a
    // message's content (JSON array); the row's content fields mirror the
    // entry at `active_version`.  Absent (NULL) for never-edited messages.
    "ALTER TABLE messages ADD COLUMN versions_json TEXT;
     ALTER TABLE messages ADD COLUMN active_version INTEGER NOT NULL DEFAULT 0;",
    // v12 — full-text search over message content (P0-2).
    //
    // `trigram` is the only built-in tokenizer that supports CJK substring
    // matching (unicode61 treats a whole CJK run as one token).  It indexes
    // 3-character windows, so MATCH needs queries of 3+ characters; shorter
    // queries are answered by a LIKE fallback in `search_messages`.
    //
    // External-content FTS table + triggers keep the index in step with every
    // insert / update / delete (including cascade deletes and version writes).
    "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content=messages,
        content_rowid=rowid,
        tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');",
    // v13 — assistants (P1-7): role presets that bundle a system prompt, an
    // optional pinned model and suggested tool policies.  Conversations bind
    // to one assistant; rows are seeded from the built-in definitions on
    // startup (`seed_builtin_assistants`).
    "ALTER TABLE conversations ADD COLUMN assistant_id TEXT;
     CREATE TABLE IF NOT EXISTS assistants (
         id                 TEXT PRIMARY KEY,
         name               TEXT NOT NULL,
         icon               TEXT,
         description        TEXT,
         system_prompt      TEXT NOT NULL,
         provider_id        TEXT,
         model_key          TEXT,
         tool_policies_json TEXT,
         sort_order         INTEGER NOT NULL DEFAULT 0,
         created_at         INTEGER NOT NULL,
         updated_at         INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_assistants_sort ON assistants(sort_order);",
    // v14 — message attachments (P1-8): metadata (name + character count) of
    // the documents a prompt was sent with.  The extracted text lives inside
    // `content`, so exports / search / summaries keep working unchanged.
    "ALTER TABLE messages ADD COLUMN attachments_json TEXT;",
    // v15 — local knowledge base (P1-9): documents, their chunks, and a trigram
    // FTS index over the chunks (same pattern as messages_fts, so CJK
    // substring search works out of the box).  No vectors: BM25 over this
    // index is the whole retrieval model.
    "CREATE TABLE IF NOT EXISTS kb_documents (
         id           TEXT PRIMARY KEY,
         title        TEXT NOT NULL,
         source_type  TEXT NOT NULL,
         source_ref   TEXT,
         chunk_count  INTEGER NOT NULL DEFAULT 0,
         created_at   INTEGER NOT NULL
     );
     CREATE TABLE IF NOT EXISTS kb_chunks (
         id          TEXT PRIMARY KEY,
         document_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
         seq         INTEGER NOT NULL,
         content     TEXT NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(document_id, seq);
     CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
         content,
         content=kb_chunks,
         content_rowid=rowid,
         tokenize='trigram'
     );
     CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_ai AFTER INSERT ON kb_chunks BEGIN
         INSERT INTO kb_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
     END;
     CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_ad AFTER DELETE ON kb_chunks BEGIN
         INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content)
         VALUES ('delete', old.rowid, old.content);
     END;
     CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_au AFTER UPDATE ON kb_chunks BEGIN
         INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content)
         VALUES ('delete', old.rowid, old.content);
         INSERT INTO kb_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
     END;",
    // v16 — pinned conversations sort above the recency list (P1-11.1).
    "ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;",
    // v17 — per-message token usage.  The v1 `usage_json` column was never
    // written; dedicated integer columns keep the aggregate queries
    // (`SUM` / `GROUP BY` over models and days) simple.  NULL for rows that
    // predate usage recording or whose provider never reported it.
    "ALTER TABLE messages ADD COLUMN input_tokens INTEGER;
     ALTER TABLE messages ADD COLUMN output_tokens INTEGER;",
    // v18 — built-in assistant icons become vector-icon keys resolved by the
    // frontend (`AssistantIcon`).  Only rows still carrying the shipped emoji
    // are rewritten, so a user's own icon choice is never clobbered; the
    // emoji variants cover both the U+FE0F and bare forms.
    "UPDATE assistants SET icon = 'sparkles'
        WHERE id = 'assistant.builtin.default' AND icon = '💬';
     UPDATE assistants SET icon = 'search'
        WHERE id = 'assistant.builtin.researcher' AND icon = '🔍';
     UPDATE assistants SET icon = 'pen-line'
        WHERE id = 'assistant.builtin.writer' AND icon IN ('✍️', '✍');
     UPDATE assistants SET icon = 'code'
        WHERE id = 'assistant.builtin.coder' AND icon IN ('👨‍💻', '👨💻');
     UPDATE assistants SET icon = 'languages'
        WHERE id = 'assistant.builtin.translator' AND icon = '🌐';
     UPDATE assistants SET icon = 'clipboard-list'
        WHERE id = 'assistant.builtin.meeting' AND icon = '📋';",
    // v19 — user skills (自定义技能): reusable instruction packages the user
    // writes once and the assistant applies when triggered.  Triggers live in
    // a JSON array string; an empty array means "always active"
    // (see `agent::skills` for the two-stage prompt injection).
    "CREATE TABLE IF NOT EXISTS skills (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        content       TEXT NOT NULL,
        triggers_json TEXT NOT NULL DEFAULT '[]',
        enabled       INTEGER NOT NULL DEFAULT 1,
        sort_order    INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skills_sort ON skills(sort_order);",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub provider_id: Option<String>,
    pub model_key: Option<String>,
    pub system_prompt: Option<String>,
    /// Assistant this conversation is bound to (v13).  `None` = follow the
    /// global default prompt/model.
    #[serde(default)]
    pub assistant_id: Option<String>,
    /// Pinned conversations sort above the recency list (v16).
    #[serde(default)]
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Columns selected by every conversation query (keep in sync with
/// [`map_conversation`]).
const CONVERSATION_COLUMNS: &str = "id, title, provider_id, model_key, system_prompt, \
     assistant_id, pinned, created_at, updated_at";

/// Map one `conversations` row selected with [`CONVERSATION_COLUMNS`].
fn map_conversation(r: &rusqlite::Row<'_>) -> SqlResult<Conversation> {
    Ok(Conversation {
        id: r.get(0)?,
        title: r.get(1)?,
        provider_id: r.get(2)?,
        model_key: r.get(3)?,
        system_prompt: r.get(4)?,
        assistant_id: r.get(5)?,
        pinned: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

/// One version inside a message's version stack (v11).
///
/// The array stored in `messages.versions_json` contains **all** versions
/// including the active one; the row's own content fields are a mirror of
/// `versions[active_version]`, so every existing query (list, search, export)
/// keeps working without knowing about versions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageVersion {
    pub content: String,
    #[serde(default)]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub model_name: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    /// `done` | `streaming` | `error` | `cancelled`.
    #[serde(default)]
    pub status: Option<String>,
    pub created_at: i64,
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
    /// Serialized JSON array of [`MessageVersion`] (v11). `None` when the
    /// message was never edited or regenerated.
    #[serde(default)]
    pub versions_json: Option<String>,
    /// Index into `versions_json` mirrored by the row's content fields (v11).
    #[serde(default)]
    pub active_version: i64,
    /// Serialized JSON array of `{ name, chars }` for attached documents
    /// (v14).  Only metadata — the extracted text lives inside `content`.
    #[serde(default)]
    pub attachments_json: Option<String>,
    /// Prompt tokens reported by the provider (v17).  `None` when the
    /// provider did not report usage or the row predates recording.
    #[serde(default)]
    pub input_tokens: Option<i64>,
    /// Completion tokens reported by the provider (v17).
    #[serde(default)]
    pub output_tokens: Option<i64>,
    pub created_at: i64,
}

/// One full-text search hit (v12).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageHit {
    pub message_id: String,
    pub conversation_id: String,
    pub conversation_title: String,
    pub role: String,
    /// Excerpt around the match, with 「」 markers on the matched phrase.
    pub snippet: String,
    pub created_at: i64,
}

/// Aggregated token usage for one model (v17).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    /// Model display name as stored on the messages; `None` for rows that
    /// never recorded one — the UI labels that bucket itself.
    pub model_name: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    /// Finished assistant turns attributed to this model.
    pub rounds: i64,
    /// Mean wall-clock duration of those turns (ms); `None` without data.
    pub avg_duration_ms: Option<i64>,
    /// Timestamp (ms) of the most recent turn using this model.
    pub last_used_at: Option<i64>,
}

/// Tokens consumed on one calendar day (local time), for the trend chart.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsage {
    /// `YYYY-MM-DD` in the user's local time zone.
    pub day: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub rounds: i64,
}

/// Tokens consumed by one model on one calendar day, for the per-model
/// trend lines.  Only days with token data produce a row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDailyUsage {
    /// Model display name; `None` for the "unknown model" bucket.
    pub model_name: Option<String>,
    /// `YYYY-MM-DD` in the user's local time zone.
    pub day: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

/// Everything the usage panel needs, from one round of queries.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    pub input_tokens: i64,
    pub output_tokens: i64,
    /// Finished assistant turns on record.
    pub rounds: i64,
    /// How many of those turns carry token numbers (providers may omit
    /// usage, and rows saved before v17 have none).
    pub rounds_with_usage: i64,
    /// Longest span between the first and last message of a conversation
    /// (ms); 0 when nothing is recorded.
    pub longest_session_ms: i64,
    pub models: Vec<ModelUsage>,
    pub daily: Vec<DailyUsage>,
    /// Per-model per-day totals over the last year (trend chart).
    pub model_daily: Vec<ModelDailyUsage>,
}

/// One knowledge-base document (v15).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbDocument {
    pub id: String,
    pub title: String,
    /// `file` | `url` | `text`.
    pub source_type: String,
    /// File name, URL, or `None` for pasted text.
    #[serde(default)]
    pub source_ref: Option<String>,
    pub chunk_count: i64,
    pub created_at: i64,
}

/// One retrieved knowledge-base passage (v15).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbHit {
    pub document_id: String,
    pub title: String,
    /// Chunk index inside its document.
    pub seq: i64,
    pub snippet: String,
    /// BM25 score (lower is better); 0 for the LIKE fallback.
    pub score: f64,
}

/// The columns every message query selects, in the order [`map_message`]
/// expects.  Keep the two in sync.
const MESSAGE_COLUMNS: &str = "id, conversation_id, role, content, status, reasoning, \
     tool_calls, model_name, duration_ms, versions_json, active_version, attachments_json, \
     input_tokens, output_tokens, created_at";

/// Map one `messages` row selected with [`MESSAGE_COLUMNS`].
fn map_message(r: &rusqlite::Row<'_>) -> SqlResult<Message> {
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
        versions_json: r.get(9)?,
        active_version: r.get(10)?,
        attachments_json: r.get(11)?,
        input_tokens: r.get(12)?,
        output_tokens: r.get(13)?,
        created_at: r.get(14)?,
    })
}

/// Parse a `versions_json` payload into the version list (empty when absent
/// or corrupted — a corrupted payload must never break reading history).
fn parse_versions(raw: Option<&str>) -> Vec<MessageVersion> {
    raw.filter(|s| !s.trim().is_empty())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default()
}

/// Current wall-clock time in milliseconds since the Unix epoch.
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Parse the `skills.triggers_json` column, tolerating garbage values.
fn parse_triggers(json: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(json).unwrap_or_default()
}

/// Trim, drop empties and de-duplicate triggers (case-insensitively).
fn normalized_triggers(triggers: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    triggers
        .iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .filter(|t| seen.insert(t.to_lowercase()))
        .collect()
}

/// Build a short excerpt centred on the first occurrence of `query`
/// (used by the LIKE fallback, where FTS5's `snippet()` is unavailable).
fn snippet_around(content: &str, query: &str, radius: usize) -> String {
    let chars: Vec<char> = content.chars().collect();
    let qchars: Vec<char> = query.chars().collect();
    let found = (!qchars.is_empty())
        .then(|| {
            chars
                .windows(qchars.len())
                .position(|w| w == qchars.as_slice())
        })
        .flatten();

    let (start, end) = match found {
        Some(pos) => (
            pos.saturating_sub(radius),
            (pos + qchars.len() + radius).min(chars.len()),
        ),
        None => (0, chars.len().min(radius * 2)),
    };

    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(chars[start..end].iter());
    if end < chars.len() {
        out.push('…');
    }
    out
}

/// Escape LIKE wildcards so user input is matched literally.
fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Persist a version array and mirror `versions[active]` into the row's
/// content fields, keeping the mirror invariant in exactly one place.
///
/// `tool_calls` is cleared: tool steps belong to one specific answer, and a
/// stale card under a switched version would be misleading.
fn write_versions(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
    versions: &[MessageVersion],
    active: usize,
) -> Result<Message, String> {
    let version = versions
        .get(active)
        .ok_or_else(|| "版本索引越界".to_string())?;
    let json = serde_json::to_string(versions).map_err(|e| format!("序列化版本失败：{e}"))?;

    tx.execute(
        "UPDATE messages
         SET content = ?2, reasoning = ?3, tool_calls = NULL,
             model_name = ?4, duration_ms = ?5, status = ?6,
             versions_json = ?7, active_version = ?8
         WHERE id = ?1",
        params![
            id,
            version.content,
            version.reasoning,
            version.model_name,
            version.duration_ms,
            version.status.clone().unwrap_or_else(|| "done".to_string()),
            json,
            active as i64,
        ],
    )
    .map_err(|e| format!("保存消息版本失败：{e}"))?;

    Database::get_message(tx, id)?.ok_or_else(|| "消息不存在".to_string())
}

/// Drop the rolling summary of a conversation whose turns changed: it covers
/// message content that no longer exists in the active path.  The agent loop
/// rebuilds it from scratch on a later turn (`agent::summary` treats a missing
/// summary as "nothing covered yet").
fn invalidate_summary(tx: &rusqlite::Transaction<'_>, conversation_id: &str) -> Result<(), String> {
    tx.execute(
        "DELETE FROM conversation_summaries WHERE conversation_id = ?1",
        params![conversation_id],
    )
    .map_err(|e| format!("清理会话摘要失败：{e}"))?;
    Ok(())
}

impl Message {
    /// Snapshot the row's content fields as a version entry.
    fn to_version(&self) -> MessageVersion {
        MessageVersion {
            content: self.content.clone(),
            reasoning: self.reasoning.clone(),
            model_name: self.model_name.clone(),
            duration_ms: self.duration_ms,
            status: Some(self.status.clone()),
            created_at: self.created_at,
        }
    }
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

/// One conversation plus its messages, as stored in a backup file (P0-4).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupConversation {
    #[serde(flatten)]
    pub conversation: Conversation,
    #[serde(default)]
    pub messages: Vec<Message>,
}

/// Portable backup payload (P0-4).  **Never contains API keys** — those live
/// in the Windows Credential Manager and must be re-entered on a new machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    /// App marker, checked on import to reject unrelated files.
    pub app: String,
    /// Schema version of this payload; imports refuse unknown versions.
    pub format_version: u32,
    pub exported_at: i64,
    #[serde(default)]
    pub conversations: Vec<BackupConversation>,
    #[serde(default)]
    pub memories: Vec<Memory>,
    #[serde(default)]
    pub image_generations: Vec<ImageGeneration>,
    /// User skills (v19); absent in backups written before the feature.
    #[serde(default)]
    pub skills: Vec<Skill>,
}

/// Current backup payload version.
pub const BACKUP_FORMAT_VERSION: u32 = 1;
/// Marker written into every backup file.
pub const BACKUP_APP_MARKER: &str = "zhima";

/// How an import combines with existing data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportStrategy {
    /// Keep existing rows; skip incoming rows whose id already exists.
    Merge,
    /// Wipe conversations/memories/images first, then insert everything.
    Replace,
}

impl ImportStrategy {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "merge" => Some(Self::Merge),
            "replace" => Some(Self::Replace),
            _ => None,
        }
    }
}

/// What an import actually did.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub conversations: usize,
    pub messages: usize,
    pub memories: usize,
    pub images: usize,
    pub skills: usize,
    /// Rows left alone because their id already existed (merge only).
    pub skipped: usize,
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
        db.seed_builtin_assistants()
            .map_err(|e| format!("初始化内置助手失败：{e}"))?;
        Ok(db)
    }

    /// Keep the built-in assistant rows in step with the shipped set:
    ///
    /// 1. built-ins that are no longer shipped are removed — but only when
    ///    still untouched (an edited row is user data) — and their
    ///    conversations fall back to the global default;
    /// 2. missing built-ins are inserted;
    /// 3. built-ins whose prompt still matches a previously shipped
    ///    definition (see [`crate::storage::assistants::LEGACY_BUILTIN_PROMPTS`])
    ///    are refreshed to the current definition, so the redesigned presets
    ///    reach existing installs.  User edits are never touched.
    ///
    /// `reset_builtin_assistant` restores a single built-in on demand.
    fn seed_builtin_assistants(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();

        // 1. Retire built-ins that left the set (untouched rows only).
        for (id, legacy_prefix) in crate::storage::assistants::RETIRED_BUILTINS {
            conn.execute(
                "DELETE FROM assistants WHERE id = ?1 AND system_prompt LIKE ?2",
                params![id, format!("{legacy_prefix}%")],
            )
            .map_err(|e| format!("下线旧内置助手失败：{e}"))?;
            // Any conversation still bound to a removed assistant follows the
            // global default again (the row may survive when it was edited).
            conn.execute(
                "UPDATE conversations SET assistant_id = NULL
                  WHERE assistant_id = ?1
                    AND NOT EXISTS (SELECT 1 FROM assistants WHERE id = ?1)",
                params![id],
            )
            .map_err(|e| format!("解除会话绑定失败：{e}"))?;
        }

        // 2. / 3. Seed and upgrade.
        let now = now_ms();
        for a in crate::storage::assistants::builtin_assistants(now) {
            let stored_prompt: Option<String> = conn
                .query_row(
                    "SELECT system_prompt FROM assistants WHERE id = ?1",
                    params![a.id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| format!("读取内置助手失败：{e}"))?;

            let Some(prompt) = stored_prompt else {
                conn.execute(
                    "INSERT OR IGNORE INTO assistants
                        (id, name, icon, description, system_prompt, provider_id, model_key,
                         tool_policies_json, sort_order, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![
                        a.id,
                        a.name,
                        a.icon,
                        a.description,
                        a.system_prompt,
                        a.provider_id,
                        a.model_key,
                        a.tool_policies_json,
                        a.sort_order,
                        a.created_at,
                        a.updated_at,
                    ],
                )
                .map_err(|e| format!("写入内置助手失败：{e}"))?;
                continue;
            };

            let outdated = crate::storage::assistants::LEGACY_BUILTIN_PROMPTS
                .iter()
                .any(|(id, prefix)| *id == a.id && prompt.starts_with(prefix));
            if outdated {
                // The row still carries a previously shipped prompt: upgrade
                // the definition while keeping the user's icon and model pin.
                conn.execute(
                    "UPDATE assistants
                        SET name = ?2, description = ?3, system_prompt = ?4,
                            tool_policies_json = ?5, sort_order = ?6, updated_at = ?7
                      WHERE id = ?1",
                    params![
                        a.id,
                        a.name,
                        a.description,
                        a.system_prompt,
                        a.tool_policies_json,
                        a.sort_order,
                        now,
                    ],
                )
                .map_err(|e| format!("升级内置助手失败：{e}"))?;
            }
        }
        Ok(())
    }

    #[cfg(test)]
    fn in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("in-memory db");
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate().unwrap();
        db.seed_builtin_assistants().unwrap();
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
            "INSERT INTO conversations
                (id, title, provider_id, model_key, system_prompt, assistant_id, pinned, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                conv.id,
                conv.title,
                conv.provider_id,
                conv.model_key,
                conv.system_prompt,
                conv.assistant_id,
                conv.pinned,
                conv.created_at,
                conv.updated_at,
            ],
        )
        .map_err(|e| format!("创建会话失败：{e}"))?;
        Ok(())
    }

    /// Pinned conversations first, then most recent, capped for a lean sidebar.
    pub fn list_conversations(&self, limit: u32) -> Result<Vec<Conversation>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {CONVERSATION_COLUMNS} FROM conversations
                 ORDER BY pinned DESC, updated_at DESC LIMIT ?1"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit], map_conversation)
            .map_err(|e| e.to_string())?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|e| format!("读取会话列表失败：{e}"))
    }

    pub fn get_conversation(&self, id: &str) -> Result<Option<Conversation>, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {CONVERSATION_COLUMNS} FROM conversations WHERE id = ?1"),
            params![id],
            map_conversation,
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

    /// Pin or unpin a conversation (P1-11.1).
    pub fn set_conversation_pinned(&self, id: &str, pinned: bool) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET pinned = ?2 WHERE id = ?1",
            params![id, pinned],
        )
        .map_err(|e| format!("更新置顶状态失败：{e}"))?;
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

    /// Bind a conversation to a provider/model ("对话级模型"): every future
    /// turn of this conversation uses it, other conversations are unaffected.
    pub fn set_conversation_model(
        &self,
        id: &str,
        provider_id: Option<&str>,
        model_key: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let changed = conn
            .execute(
                "UPDATE conversations SET provider_id = ?2, model_key = ?3 WHERE id = ?1",
                params![id, provider_id, model_key],
            )
            .map_err(|e| format!("更新会话模型失败：{e}"))?;
        if changed != 1 {
            return Err("会话不存在，无法更新模型".into());
        }
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
                "INSERT INTO conversations
                    (id, title, provider_id, model_key, system_prompt, assistant_id, pinned,
                     created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    conv.id,
                    conv.title,
                    conv.provider_id,
                    conv.model_key,
                    conv.system_prompt,
                    conv.assistant_id,
                    conv.pinned,
                    conv.created_at,
                    conv.updated_at,
                ],
            )
            .map_err(|e| format!("创建会话失败：{e}"))?;
        }

        for msg in [user_message, assistant_message] {
            tx.execute(
                "INSERT INTO messages (id, conversation_id, role, content, status, reasoning, tool_calls, model_name, duration_ms, attachments_json, input_tokens, output_tokens, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                 ON CONFLICT(id) DO UPDATE SET
                     content = excluded.content,
                     status = excluded.status,
                     reasoning = excluded.reasoning,
                     tool_calls = excluded.tool_calls,
                     model_name = excluded.model_name,
                     duration_ms = excluded.duration_ms,
                     input_tokens = excluded.input_tokens,
                     output_tokens = excluded.output_tokens,
                     attachments_json = COALESCE(excluded.attachments_json, attachments_json)",
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
                    msg.attachments_json,
                    msg.input_tokens,
                    msg.output_tokens,
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
            "INSERT INTO messages (id, conversation_id, role, content, status, reasoning, tool_calls, model_name, duration_ms, attachments_json, input_tokens, output_tokens, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(id) DO UPDATE SET
                 content = excluded.content,
                 status = excluded.status,
                 reasoning = excluded.reasoning,
                 tool_calls = excluded.tool_calls,
                 model_name = excluded.model_name,
                 duration_ms = excluded.duration_ms,
                 attachments_json = COALESCE(excluded.attachments_json, attachments_json),
                 input_tokens = excluded.input_tokens,
                 output_tokens = excluded.output_tokens",
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
                msg.attachments_json,
                msg.input_tokens,
                msg.output_tokens,
                msg.created_at,
            ],
        )
        .map_err(|e| format!("保存消息失败：{e}"))?;

        // Keep the version mirror in sync: when the message carries a version
        // stack, the active slot must reflect the row values just written
        // (this is how a regenerated answer lands in its version entry).
        if let Some((Some(raw), active)) = conn
            .query_row(
                "SELECT versions_json, active_version FROM messages WHERE id = ?1",
                params![msg.id],
                |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(|e| format!("读取消息版本失败：{e}"))?
        {
            let mut versions = parse_versions(Some(&raw));
            if let Some(slot) = versions.get_mut(active.max(0) as usize) {
                slot.content = msg.content.clone();
                slot.reasoning = msg.reasoning.clone();
                slot.model_name = msg.model_name.clone();
                slot.duration_ms = msg.duration_ms;
                slot.status = Some(msg.status.clone());
                let json =
                    serde_json::to_string(&versions).map_err(|e| format!("序列化版本失败：{e}"))?;
                conn.execute(
                    "UPDATE messages SET versions_json = ?2 WHERE id = ?1",
                    params![msg.id, json],
                )
                .map_err(|e| format!("同步消息版本失败：{e}"))?;
            }
        }
        Ok(())
    }

    pub fn list_messages(&self, conversation_id: &str) -> Result<Vec<Message>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {MESSAGE_COLUMNS} FROM messages
                 WHERE conversation_id = ?1 ORDER BY created_at ASC"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![conversation_id], map_message)
            .map_err(|e| e.to_string())?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|e| format!("读取消息失败：{e}"))
    }

    /// Read a single message row (used by version operations).
    fn get_message(conn: &Connection, id: &str) -> Result<Option<Message>, String> {
        conn.query_row(
            &format!("SELECT {MESSAGE_COLUMNS} FROM messages WHERE id = ?1"),
            params![id],
            map_message,
        )
        .optional()
        .map_err(|e| format!("读取消息失败：{e}"))
    }

    /* ---------------- message versions (v11) ---------------- */

    /// Append `content` as a new version and make it active (user edit).
    /// The first call seeds the stack with the message's current state, so the
    /// pre-edit content is never lost.
    pub fn edit_message(&self, id: &str, content: &str) -> Result<Message, String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| format!("开始事务失败：{e}"))?;
        let current = Self::get_message(&tx, id)?.ok_or_else(|| "消息不存在".to_string())?;
        if current.role != "user" {
            return Err("只能编辑用户消息".into());
        }

        let mut versions = parse_versions(current.versions_json.as_deref());
        if versions.is_empty() {
            versions.push(current.to_version());
        }
        versions.push(MessageVersion {
            content: content.to_string(),
            reasoning: None,
            model_name: None,
            duration_ms: None,
            status: Some("done".into()),
            created_at: now_ms(),
        });
        let active = versions.len() - 1;

        let updated = write_versions(&tx, id, &versions, active)?;
        invalidate_summary(&tx, &current.conversation_id)?;
        tx.commit().map_err(|e| format!("提交事务失败：{e}"))?;
        Ok(updated)
    }

    /// Open a new blank "streaming" version for regeneration: the current
    /// answer is archived as a version and the row is cleared, so the
    /// streaming pipeline can fill it in like a fresh reply.
    pub fn start_message_version(&self, id: &str) -> Result<Message, String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| format!("开始事务失败：{e}"))?;
        let current = Self::get_message(&tx, id)?.ok_or_else(|| "消息不存在".to_string())?;
        if current.role != "assistant" {
            return Err("只能重新生成助手消息".into());
        }

        let mut versions = parse_versions(current.versions_json.as_deref());
        if versions.is_empty() {
            versions.push(current.to_version());
        }
        versions.push(MessageVersion {
            content: String::new(),
            reasoning: None,
            model_name: current.model_name.clone(),
            duration_ms: None,
            status: Some("streaming".into()),
            created_at: now_ms(),
        });
        let active = versions.len() - 1;

        let updated = write_versions(&tx, id, &versions, active)?;
        invalidate_summary(&tx, &current.conversation_id)?;
        tx.commit().map_err(|e| format!("提交事务失败：{e}"))?;
        Ok(updated)
    }

    /// Make `index` the active version (switching between versions).
    pub fn activate_message_version(&self, id: &str, index: i64) -> Result<Message, String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| format!("开始事务失败：{e}"))?;
        let current = Self::get_message(&tx, id)?.ok_or_else(|| "消息不存在".to_string())?;

        let versions = parse_versions(current.versions_json.as_deref());
        if versions.is_empty() {
            return Err("该消息没有历史版本".into());
        }
        let active = usize::try_from(index)
            .ok()
            .filter(|i| *i < versions.len())
            .ok_or_else(|| "版本索引越界".to_string())?;

        let updated = write_versions(&tx, id, &versions, active)?;
        invalidate_summary(&tx, &current.conversation_id)?;
        tx.commit().map_err(|e| format!("提交事务失败：{e}"))?;
        Ok(updated)
    }

    /* ---------------- knowledge base (v15) ---------------- */

    /// Ingest one document: chunk it and store document + chunks atomically.
    pub fn kb_ingest(
        &self,
        id: &str,
        title: &str,
        source_type: &str,
        source_ref: Option<&str>,
        text: &str,
    ) -> Result<KbDocument, String> {
        let chunks = crate::agent::knowledge::chunk_text(text);
        let document = KbDocument {
            id: id.to_string(),
            title: title.trim().to_string(),
            source_type: source_type.to_string(),
            source_ref: source_ref.map(|s| s.to_string()),
            chunk_count: chunks.len() as i64,
            created_at: now_ms(),
        };
        self.kb_add_document(&document, &chunks)?;
        Ok(document)
    }

    /* ---------------- full-text search (v12) ---------------- */

    /// Search message content across every conversation (P0-2).
    ///
    /// Queries of 3+ characters run against the FTS5 trigram index; shorter
    /// ones (common for two-character Chinese words) fall back to a LIKE scan,
    /// which is plenty fast at this app's data scale.
    pub fn search_messages(&self, query: &str, limit: u32) -> Result<Vec<MessageHit>, String> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let limit = limit.clamp(1, 200) as i64;
        let conn = self.conn.lock().unwrap();

        if q.chars().count() >= 3 {
            // Wrap in double quotes so the whole query is a phrase and FTS5
            // operators the user typed are treated as literal text.
            let phrase = format!("\"{}\"", q.replace('"', "\"\""));
            let mut stmt = conn
                .prepare(
                    "SELECT m.id, m.conversation_id, c.title, m.role,
                            snippet(messages_fts, 0, '「', '」', '…', 12),
                            m.created_at
                     FROM messages_fts
                     JOIN messages m ON m.rowid = messages_fts.rowid
                     JOIN conversations c ON c.id = m.conversation_id
                     WHERE messages_fts MATCH ?1
                     ORDER BY bm25(messages_fts), m.created_at DESC
                     LIMIT ?2",
                )
                .map_err(|e| format!("搜索失败：{e}"))?;
            let rows = stmt
                .query_map(params![phrase, limit], |r| {
                    Ok(MessageHit {
                        message_id: r.get(0)?,
                        conversation_id: r.get(1)?,
                        conversation_title: r.get(2)?,
                        role: r.get(3)?,
                        snippet: r.get(4)?,
                        created_at: r.get(5)?,
                    })
                })
                .map_err(|e| format!("搜索失败：{e}"))?;
            return rows
                .collect::<SqlResult<Vec<_>>>()
                .map_err(|e| format!("搜索失败：{e}"));
        }

        let like = format!("%{}%", escape_like(q));
        let mut stmt = conn
            .prepare(
                "SELECT m.id, m.conversation_id, c.title, m.role, m.content, m.created_at
                 FROM messages m
                 JOIN conversations c ON c.id = m.conversation_id
                 WHERE m.content LIKE ?1 ESCAPE '\\'
                 ORDER BY m.created_at DESC
                 LIMIT ?2",
            )
            .map_err(|e| format!("搜索失败：{e}"))?;
        let rows = stmt
            .query_map(params![like, limit], |r| {
                let content: String = r.get(4)?;
                Ok(MessageHit {
                    message_id: r.get(0)?,
                    conversation_id: r.get(1)?,
                    conversation_title: r.get(2)?,
                    role: r.get(3)?,
                    snippet: snippet_around(&content, q, 30),
                    created_at: r.get(5)?,
                })
            })
            .map_err(|e| format!("搜索失败：{e}"))?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|e| format!("搜索失败：{e}"))
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

    /* ---------------- token usage (v17) ---------------- */

    /// Aggregate per-model and per-day token usage.
    ///
    /// Only finished assistant turns count.  Rows saved before v17 (or from
    /// providers that never report usage) have NULL token columns: they still
    /// contribute to the round counts, so the UI can explain the gap.
    pub fn usage_stats(&self) -> Result<UsageStats, String> {
        let conn = self.conn.lock().unwrap();

        let (input_tokens, output_tokens, rounds, rounds_with_usage) = conn
            .query_row(
                "SELECT COALESCE(SUM(input_tokens), 0),
                        COALESCE(SUM(output_tokens), 0),
                        COUNT(*),
                        COALESCE(SUM(
                            CASE WHEN input_tokens IS NOT NULL OR output_tokens IS NOT NULL
                                 THEN 1 ELSE 0 END
                        ), 0)
                 FROM messages
                 WHERE role = 'assistant' AND status = 'done'",
                [],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                },
            )
            .map_err(|e| format!("统计用量失败：{e}"))?;

        let mut model_stmt = conn
            .prepare(
                "SELECT model_name,
                        COALESCE(SUM(input_tokens), 0),
                        COALESCE(SUM(output_tokens), 0),
                        COUNT(*),
                        CAST(AVG(duration_ms) AS INTEGER),
                        MAX(created_at)
                 FROM messages
                 WHERE role = 'assistant' AND status = 'done'
                 GROUP BY model_name
                 ORDER BY SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) DESC,
                          COUNT(*) DESC",
            )
            .map_err(|e| e.to_string())?;
        let models = model_stmt
            .query_map([], |r| {
                Ok(ModelUsage {
                    model_name: r.get(0)?,
                    input_tokens: r.get(1)?,
                    output_tokens: r.get(2)?,
                    rounds: r.get(3)?,
                    avg_duration_ms: r.get(4)?,
                    last_used_at: r.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<SqlResult<Vec<_>>>()
            .map_err(|e| format!("统计模型用量失败：{e}"))?;

        let mut daily_stmt = conn
            .prepare(
                "SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime'),
                        COALESCE(SUM(input_tokens), 0),
                        COALESCE(SUM(output_tokens), 0),
                        COUNT(*)
                 FROM messages
                 WHERE role = 'assistant' AND status = 'done'
                 GROUP BY 1
                 ORDER BY 1 ASC",
            )
            .map_err(|e| e.to_string())?;
        let daily = daily_stmt
            .query_map([], |r| {
                Ok(DailyUsage {
                    day: r.get(0)?,
                    input_tokens: r.get(1)?,
                    output_tokens: r.get(2)?,
                    rounds: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<SqlResult<Vec<_>>>()
            .map_err(|e| format!("统计每日用量失败：{e}"))?;

        // Per-model per-day totals for the trend lines.  Bounded to one year:
        // the heatmap and the widest trend window never look further back.
        let year_ago = chrono::Utc::now().timestamp_millis() - 366 * 24 * 60 * 60 * 1000;
        let mut model_daily_stmt = conn
            .prepare(
                "SELECT model_name,
                        strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime'),
                        COALESCE(SUM(input_tokens), 0),
                        COALESCE(SUM(output_tokens), 0)
                 FROM messages
                 WHERE role = 'assistant' AND status = 'done'
                   AND created_at >= ?1
                   AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
                 GROUP BY model_name, 2
                 ORDER BY 2 ASC",
            )
            .map_err(|e| e.to_string())?;
        let model_daily = model_daily_stmt
            .query_map(params![year_ago], |r| {
                Ok(ModelDailyUsage {
                    model_name: r.get(0)?,
                    day: r.get(1)?,
                    input_tokens: r.get(2)?,
                    output_tokens: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<SqlResult<Vec<_>>>()
            .map_err(|e| format!("统计模型每日用量失败：{e}"))?;

        // Longest conversation span (first → last message of one conversation).
        let longest_session_ms = conn
            .query_row(
                "SELECT COALESCE(MAX(span), 0) FROM (
                     SELECT MAX(created_at) - MIN(created_at) AS span
                     FROM messages
                     GROUP BY conversation_id
                 )",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|e| format!("统计会话时长失败：{e}"))?;

        Ok(UsageStats {
            input_tokens,
            output_tokens,
            rounds,
            rounds_with_usage,
            longest_session_ms,
            models,
            daily,
            model_daily,
        })
    }

    /* ---------------- assistants (v13) ---------------- */

    /// All assistants: shipped ones first (by `sort_order`), then user ones.
    pub fn list_assistants(&self) -> Result<Vec<Assistant>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, icon, description, system_prompt, provider_id, model_key,
                        tool_policies_json, sort_order, created_at, updated_at
                 FROM assistants ORDER BY sort_order ASC, created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Assistant {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    icon: r.get(2)?,
                    description: r.get(3)?,
                    system_prompt: r.get(4)?,
                    provider_id: r.get(5)?,
                    model_key: r.get(6)?,
                    tool_policies_json: r.get(7)?,
                    sort_order: r.get(8)?,
                    created_at: r.get(9)?,
                    updated_at: r.get(10)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|e| format!("读取助手失败：{e}"))
    }

    pub fn get_assistant(&self, id: &str) -> Result<Option<Assistant>, String> {
        Ok(self.list_assistants()?.into_iter().find(|a| a.id == id))
    }

    /// Insert or update an assistant and return the stored row.
    ///
    /// Built-in rows keep their id (the UI hides delete for them) but may be
    /// edited; `reset_builtin_assistant` restores the shipped definition.
    pub fn upsert_assistant(&self, assistant: &Assistant) -> Result<Assistant, String> {
        if assistant.id.trim().is_empty() {
            return Err("助手 ID 不能为空".into());
        }
        let name = assistant.name.trim();
        if name.is_empty() {
            return Err("请填写助手名称".into());
        }
        let system_prompt = assistant.system_prompt.trim();
        if system_prompt.is_empty() {
            return Err("请填写助手的系统提示词".into());
        }

        let now = now_ms();
        let created_at = if assistant.created_at > 0 {
            assistant.created_at
        } else {
            now
        };
        // Scoped so the connection lock is released before reading the row
        // back (the mutex is not reentrant).
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO assistants
                    (id, name, icon, description, system_prompt, provider_id, model_key,
                     tool_policies_json, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(id) DO UPDATE SET
                     name = excluded.name,
                     icon = excluded.icon,
                     description = excluded.description,
                     system_prompt = excluded.system_prompt,
                     provider_id = excluded.provider_id,
                     model_key = excluded.model_key,
                     tool_policies_json = excluded.tool_policies_json,
                     sort_order = excluded.sort_order,
                     updated_at = excluded.updated_at",
                params![
                    assistant.id,
                    name,
                    assistant.icon,
                    assistant.description,
                    system_prompt,
                    assistant.provider_id,
                    assistant.model_key,
                    assistant.tool_policies_json,
                    assistant.sort_order,
                    created_at,
                    now,
                ],
            )
            .map_err(|e| format!("保存助手失败：{e}"))?;
        }

        self.get_assistant(&assistant.id)?
            .ok_or_else(|| "保存助手失败：记录不存在".to_string())
    }

    /// Delete a user-created assistant.  Built-ins are rejected; conversations
    /// bound to the deleted assistant fall back to the global default.
    pub fn delete_assistant(&self, id: &str) -> Result<(), String> {
        // Built-ins are shipped with the app: they may be edited and reset,
        // never removed.  (`get_assistant` releases its lock before returning.)
        if self.get_assistant(id)?.is_some_and(|a| a.is_builtin()) {
            return Err("内置助手不能删除，可使用「恢复默认」重置".into());
        }
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM assistants WHERE id = ?1", params![id])
            .map_err(|e| format!("删除助手失败：{e}"))?;
        conn.execute(
            "UPDATE conversations SET assistant_id = NULL WHERE assistant_id = ?1",
            params![id],
        )
        .map_err(|e| format!("解除会话绑定失败：{e}"))?;
        Ok(())
    }

    /// Restore a built-in assistant to its shipped definition.
    pub fn reset_builtin_assistant(&self, id: &str) -> Result<Assistant, String> {
        let now = now_ms();
        let template = crate::storage::assistants::builtin_by_id(id, now)
            .ok_or_else(|| "该助手不是内置助手，无法恢复默认".to_string())?;
        self.upsert_assistant(&template)
    }

    /* ---------------- skills (v19) ---------------- */

    /// All skills, ordered by `sort_order` then creation time.
    pub fn list_skills(&self) -> Result<Vec<Skill>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, description, content, triggers_json, enabled,
                        sort_order, created_at, updated_at
                 FROM skills ORDER BY sort_order ASC, created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                let triggers_json: String = r.get(4)?;
                Ok(Skill {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    content: r.get(3)?,
                    triggers: parse_triggers(&triggers_json),
                    enabled: r.get::<_, i64>(5)? != 0,
                    sort_order: r.get(6)?,
                    created_at: r.get(7)?,
                    updated_at: r.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|e| format!("读取技能失败：{e}"))
    }

    pub fn get_skill(&self, id: &str) -> Result<Option<Skill>, String> {
        Ok(self.list_skills()?.into_iter().find(|s| s.id == id))
    }

    /// Insert or update a skill and return the stored row.
    ///
    /// Triggers are trimmed, de-duplicated (case-insensitively) and stored as
    /// a JSON array; a skill without triggers is always active.
    pub fn upsert_skill(&self, skill: &Skill) -> Result<Skill, String> {
        if skill.id.trim().is_empty() {
            return Err("技能 ID 不能为空".into());
        }
        let name = skill.name.trim();
        if name.is_empty() {
            return Err("请填写技能名称".into());
        }
        let content = skill.content.trim();
        if content.is_empty() {
            return Err("请填写技能内容".into());
        }

        let now = now_ms();
        let created_at = if skill.created_at > 0 {
            skill.created_at
        } else {
            now
        };
        let triggers_json = serde_json::to_string(&normalized_triggers(&skill.triggers))
            .unwrap_or_else(|_| "[]".to_string());
        // Scoped so the connection lock is released before reading the row
        // back (the mutex is not reentrant).
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO skills
                    (id, name, description, content, triggers_json, enabled,
                     sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                     name = excluded.name,
                     description = excluded.description,
                     content = excluded.content,
                     triggers_json = excluded.triggers_json,
                     enabled = excluded.enabled,
                     sort_order = excluded.sort_order,
                     updated_at = excluded.updated_at",
                params![
                    skill.id,
                    name,
                    skill.description.trim(),
                    content,
                    triggers_json,
                    if skill.enabled { 1 } else { 0 },
                    skill.sort_order,
                    created_at,
                    now,
                ],
            )
            .map_err(|e| format!("保存技能失败：{e}"))?;
        }

        self.get_skill(&skill.id)?
            .ok_or_else(|| "保存技能失败：记录不存在".to_string())
    }

    pub fn delete_skill(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM skills WHERE id = ?1", params![id])
            .map_err(|e| format!("删除技能失败：{e}"))?;
        Ok(())
    }

    /// Insert or update a skill from an imported draft, matching existing
    /// rows by name so re-importing the same file updates it instead of
    /// creating duplicates.  Returns `true` when a new row was created.
    pub fn import_skill(&self, draft: &SkillDraft) -> Result<bool, String> {
        let name = draft.name.trim();
        if name.is_empty() {
            return Err("技能缺少名称".into());
        }
        if draft.content.trim().is_empty() {
            return Err("技能内容为空".into());
        }

        let existing = self
            .list_skills()?
            .into_iter()
            .find(|s| s.name.trim() == name);
        let created = existing.is_none();
        let now = now_ms();
        let skill = match existing {
            // Keep the id / created_at / enabled state of the user's row.
            Some(mut stored) => {
                stored.description = draft.description.clone();
                stored.content = draft.content.clone();
                stored.triggers = draft.triggers.clone();
                stored.updated_at = now;
                stored
            }
            None => Skill {
                id: new_skill_id(),
                name: name.to_string(),
                description: draft.description.clone(),
                content: draft.content.clone(),
                triggers: draft.triggers.clone(),
                enabled: true,
                sort_order: 0,
                created_at: now,
                updated_at: now,
            },
        };
        self.upsert_skill(&skill)?;
        Ok(created)
    }

    /* ---------------- local knowledge base (v15) ---------------- */

    /// Every knowledge-base document, newest first.
    pub fn kb_list_documents(&self) -> Result<Vec<KbDocument>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, title, source_type, source_ref, chunk_count, created_at
                 FROM kb_documents ORDER BY created_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(KbDocument {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    source_type: r.get(2)?,
                    source_ref: r.get(3)?,
                    chunk_count: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|e| format!("读取知识库文档失败：{e}"))
    }

    /// Store one document and its chunks in a single transaction.
    pub fn kb_add_document(&self, document: &KbDocument, chunks: &[String]) -> Result<(), String> {
        if chunks.is_empty() {
            return Err("没有可入库的内容".into());
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| format!("开始事务失败：{e}"))?;

        tx.execute(
            "INSERT INTO kb_documents
                (id, title, source_type, source_ref, chunk_count, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                document.id,
                document.title,
                document.source_type,
                document.source_ref,
                chunks.len() as i64,
                document.created_at,
            ],
        )
        .map_err(|e| format!("保存知识库文档失败：{e}"))?;

        for (seq, content) in chunks.iter().enumerate() {
            tx.execute(
                "INSERT INTO kb_chunks (id, document_id, seq, content)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    format!("{}-{}", document.id, seq),
                    document.id,
                    seq as i64,
                    content
                ],
            )
            .map_err(|e| format!("保存知识库分块失败：{e}"))?;
        }

        tx.commit().map_err(|e| format!("提交事务失败：{e}"))?;
        Ok(())
    }

    /// Remove a document and (via cascade + delete trigger) its chunks.
    pub fn kb_delete_document(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM kb_documents WHERE id = ?1", params![id])
            .map_err(|e| format!("删除知识库文档失败：{e}"))?;
        Ok(())
    }

    /// BM25 retrieval over the chunk index (P1-9).
    ///
    /// Like message search, queries shorter than three characters cannot hit
    /// the trigram index and fall back to a LIKE scan.
    pub fn kb_search(&self, query: &str, top_k: usize) -> Result<Vec<KbHit>, String> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let top_k = top_k.clamp(1, crate::agent::knowledge::MAX_TOP_K) as i64;
        let conn = self.conn.lock().unwrap();

        if q.chars().count() >= 3 {
            let phrase = format!("\"{}\"", q.replace('"', "\"\""));
            let mut stmt = conn
                .prepare(
                    "SELECT c.document_id, d.title, c.seq,
                            snippet(kb_chunks_fts, 0, '「', '」', '…', 16),
                            bm25(kb_chunks_fts)
                     FROM kb_chunks_fts
                     JOIN kb_chunks c ON c.rowid = kb_chunks_fts.rowid
                     JOIN kb_documents d ON d.id = c.document_id
                     WHERE kb_chunks_fts MATCH ?1
                     ORDER BY bm25(kb_chunks_fts), c.seq
                     LIMIT ?2",
                )
                .map_err(|e| format!("检索失败：{e}"))?;
            let rows = stmt
                .query_map(params![phrase, top_k], |r| {
                    Ok(KbHit {
                        document_id: r.get(0)?,
                        title: r.get(1)?,
                        seq: r.get(2)?,
                        snippet: r.get(3)?,
                        score: r.get(4)?,
                    })
                })
                .map_err(|e| format!("检索失败：{e}"))?;
            return rows
                .collect::<SqlResult<Vec<_>>>()
                .map_err(|e| format!("检索失败：{e}"));
        }

        let like = format!("%{}%", escape_like(q));
        let mut stmt = conn
            .prepare(
                "SELECT c.document_id, d.title, c.seq, c.content, 0.0
                 FROM kb_chunks c
                 JOIN kb_documents d ON d.id = c.document_id
                 WHERE c.content LIKE ?1 ESCAPE '\\'
                 ORDER BY c.seq
                 LIMIT ?2",
            )
            .map_err(|e| format!("检索失败：{e}"))?;
        let rows = stmt
            .query_map(params![like, top_k], |r| {
                let content: String = r.get(3)?;
                Ok(KbHit {
                    document_id: r.get(0)?,
                    title: r.get(1)?,
                    seq: r.get(2)?,
                    snippet: snippet_around(&content, q, 40),
                    score: r.get(4)?,
                })
            })
            .map_err(|e| format!("检索失败：{e}"))?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|e| format!("检索失败：{e}"))
    }

    /// Total documents / chunks, for the settings panel header.
    pub fn kb_stats(&self) -> Result<(i64, i64), String> {
        let conn = self.conn.lock().unwrap();
        let documents: i64 = conn
            .query_row("SELECT count(*) FROM kb_documents", [], |r| r.get(0))
            .map_err(|e| format!("统计知识库失败：{e}"))?;
        let chunks: i64 = conn
            .query_row("SELECT count(*) FROM kb_chunks", [], |r| r.get(0))
            .map_err(|e| format!("统计知识库失败：{e}"))?;
        Ok((documents, chunks))
    }

    /* ---------------- backup: export / import (P0-4) ---------------- */

    /// Build the backup payload from the database contents.
    pub fn export_backup(&self, include_images: bool) -> Result<BackupFile, String> {
        let conversations = self.list_conversations(u32::MAX)?;
        let mut entries = Vec::with_capacity(conversations.len());
        for conversation in conversations {
            let messages = self.list_messages(&conversation.id)?;
            entries.push(BackupConversation {
                conversation,
                messages,
            });
        }

        Ok(BackupFile {
            app: BACKUP_APP_MARKER.to_string(),
            format_version: BACKUP_FORMAT_VERSION,
            exported_at: now_ms(),
            conversations: entries,
            memories: self.list_memories()?,
            image_generations: if include_images {
                self.list_image_generations(u32::MAX)?
            } else {
                Vec::new()
            },
            skills: self.list_skills()?,
        })
    }

    /// Import a backup payload atomically.
    ///
    /// `Replace` wipes conversations, summaries, memories and images first;
    /// `Merge` keeps existing rows and skips incoming ids that are already
    /// present.  The FTS index is rebuilt afterwards so search sees the new
    /// data immediately.
    pub fn import_backup(
        &self,
        backup: &BackupFile,
        strategy: ImportStrategy,
    ) -> Result<ImportReport, String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| format!("开始事务失败：{e}"))?;
        let mut report = ImportReport::default();

        if strategy == ImportStrategy::Replace {
            tx.execute_batch(
                "DELETE FROM messages; DELETE FROM conversations;
                 DELETE FROM conversation_summaries; DELETE FROM memories;
                 DELETE FROM image_generations; DELETE FROM skills;",
            )
            .map_err(|e| format!("清空现有数据失败：{e}"))?;
        }

        for entry in &backup.conversations {
            let c = &entry.conversation;
            let inserted = tx
                .execute(
                    "INSERT OR IGNORE INTO conversations
                        (id, title, provider_id, model_key, system_prompt, pinned,
                         created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        c.id,
                        c.title,
                        c.provider_id,
                        c.model_key,
                        c.system_prompt,
                        c.pinned,
                        c.created_at,
                        c.updated_at,
                    ],
                )
                .map_err(|e| format!("导入会话失败：{e}"))?;
            if inserted == 0 {
                // Keep the existing conversation (and its messages) as-is;
                // count them so the report reflects what was left untouched.
                report.skipped += 1 + entry.messages.len();
                continue;
            }
            report.conversations += 1;

            for m in &entry.messages {
                let inserted = tx
                    .execute(
                        "INSERT OR IGNORE INTO messages
                            (id, conversation_id, role, content, status, reasoning, tool_calls,
                             model_name, duration_ms, versions_json, active_version,
                             attachments_json, input_tokens, output_tokens, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                        params![
                            m.id,
                            // Trust the parent: never let a message point at
                            // a conversation outside this backup branch.
                            c.id,
                            m.role,
                            m.content,
                            m.status,
                            m.reasoning,
                            m.tool_calls,
                            m.model_name,
                            m.duration_ms,
                            m.versions_json,
                            m.active_version,
                            m.attachments_json,
                            m.input_tokens,
                            m.output_tokens,
                            m.created_at,
                        ],
                    )
                    .map_err(|e| format!("导入消息失败：{e}"))?;
                if inserted == 0 {
                    report.skipped += 1;
                } else {
                    report.messages += 1;
                }
            }
        }

        for mem in &backup.memories {
            let inserted = tx
                .execute(
                    "INSERT OR IGNORE INTO memories
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
                .map_err(|e| format!("导入记忆失败：{e}"))?;
            if inserted == 0 {
                report.skipped += 1;
            } else {
                report.memories += 1;
            }
        }

        for gen in &backup.image_generations {
            let inserted = tx
                .execute(
                    "INSERT OR IGNORE INTO image_generations
                        (id, prompt, image_data, size_label, reference_images_json, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        gen.id,
                        gen.prompt,
                        gen.image_data,
                        gen.size_label,
                        gen.reference_images_json,
                        gen.created_at,
                    ],
                )
                .map_err(|e| format!("导入图像记录失败：{e}"))?;
            if inserted == 0 {
                report.skipped += 1;
            } else {
                report.images += 1;
            }
        }

        for skill in &backup.skills {
            let triggers_json = serde_json::to_string(&normalized_triggers(&skill.triggers))
                .unwrap_or_else(|_| "[]".to_string());
            let inserted = tx
                .execute(
                    "INSERT OR IGNORE INTO skills
                        (id, name, description, content, triggers_json, enabled,
                         sort_order, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        skill.id,
                        skill.name,
                        skill.description,
                        skill.content,
                        triggers_json,
                        if skill.enabled { 1 } else { 0 },
                        skill.sort_order,
                        skill.created_at,
                        skill.updated_at,
                    ],
                )
                .map_err(|e| format!("导入技能失败：{e}"))?;
            if inserted == 0 {
                report.skipped += 1;
            } else {
                report.skills += 1;
            }
        }

        // Make the search index authoritative for the imported rows.
        tx.execute_batch("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');")
            .map_err(|e| format!("重建搜索索引失败：{e}"))?;

        tx.commit().map_err(|e| format!("提交事务失败：{e}"))?;
        Ok(report)
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
            assistant_id: None,
            pinned: false,
            created_at: updated,
            updated_at: updated,
        }
    }

    #[test]
    fn pinned_conversations_sort_first() {
        let db = Database::in_memory();
        db.create_conversation(&conv("c1", "旧会话", 10)).unwrap();
        db.create_conversation(&conv("c2", "新会话", 20)).unwrap();
        // Recency order by default.
        let ids: Vec<String> = db
            .list_conversations(10)
            .unwrap()
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(ids, vec!["c2".to_string(), "c1".to_string()]);

        // Pinning lifts the older conversation above the newer one.
        db.set_conversation_pinned("c1", true).unwrap();
        let list = db.list_conversations(10).unwrap();
        assert_eq!(list[0].id, "c1");
        assert!(list[0].pinned);
        assert!(!list[1].pinned);

        // Unpinning restores the recency order.
        db.set_conversation_pinned("c1", false).unwrap();
        let ids: Vec<String> = db
            .list_conversations(10)
            .unwrap()
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(ids, vec!["c2".to_string(), "c1".to_string()]);
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
            versions_json: None,
            active_version: 0,
            attachments_json: None,
            input_tokens: None,
            output_tokens: None,
            created_at: at,
        }
    }

    #[test]
    fn editing_a_message_keeps_the_previous_versions() {
        let db = Database::in_memory();
        db.create_conversation(&conv("c1", "t", 1)).unwrap();
        db.save_message(&msg("u1", "c1", "user", "第一版", "done", 10))
            .unwrap();

        let edited = db.edit_message("u1", "第二版").unwrap();
        assert_eq!(edited.content, "第二版");
        assert_eq!(edited.active_version, 1);

        let versions = parse_versions(edited.versions_json.as_deref());
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].content, "第一版");
        assert_eq!(versions[1].content, "第二版");

        // Switching back restores the original content.
        let switched = db.activate_message_version("u1", 0).unwrap();
        assert_eq!(switched.content, "第一版");
        assert_eq!(switched.active_version, 0);

        // Editing again appends a third version without losing the first.
        let edited = db.edit_message("u1", "第三版").unwrap();
        assert_eq!(edited.active_version, 2);
        let versions = parse_versions(edited.versions_json.as_deref());
        assert_eq!(versions.len(), 3);
        assert_eq!(versions[0].content, "第一版");
        assert_eq!(versions[2].content, "第三版");
    }

    #[test]
    fn editing_an_assistant_message_is_rejected() {
        let db = Database::in_memory();
        db.create_conversation(&conv("c1", "t", 1)).unwrap();
        db.save_message(&msg("a1", "c1", "assistant", "答案", "done", 10))
            .unwrap();
        assert!(db.edit_message("a1", "改").is_err());
        assert!(db.start_message_version("u1").is_err());
    }

    #[test]
    fn regeneration_archives_the_answer_and_syncs_the_mirror() {
        let db = Database::in_memory();
        db.create_conversation(&conv("c1", "t", 1)).unwrap();
        db.save_message(&msg("u1", "c1", "user", "问题", "done", 10))
            .unwrap();
        db.save_message(&msg("a1", "c1", "assistant", "旧答案", "done", 11))
            .unwrap();

        // Archiving opens a blank streaming version for the new answer.
        let opened = db.start_message_version("a1").unwrap();
        assert_eq!(opened.content, "");
        assert_eq!(opened.status, "streaming");
        assert_eq!(opened.active_version, 1);

        // The stream settles and the final content is saved as usual.
        let final_msg = Message {
            content: "新答案".into(),
            status: "done".into(),
            duration_ms: Some(1234),
            ..msg("a1", "c1", "assistant", "", "done", 11)
        };
        db.save_message(&final_msg).unwrap();

        // The active version slot mirrors the final row state (no divergence).
        let stored = db
            .list_messages("c1")
            .unwrap()
            .into_iter()
            .find(|m| m.id == "a1")
            .unwrap();
        assert_eq!(stored.content, "新答案");
        let versions = parse_versions(stored.versions_json.as_deref());
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].content, "旧答案");
        assert_eq!(versions[1].content, "新答案");
        assert_eq!(versions[1].duration_ms, Some(1234));

        // Switching back shows the old answer again.
        let old = db.activate_message_version("a1", 0).unwrap();
        assert_eq!(old.content, "旧答案");
        assert_eq!(old.status, "done");
    }

    #[test]
    fn version_operations_invalidate_the_rolling_summary() {
        let db = Database::in_memory();
        db.create_conversation(&conv("c1", "t", 1)).unwrap();
        db.save_message(&msg("u1", "c1", "user", "第一版", "done", 10))
            .unwrap();
        db.save_summary(&ConversationSummary {
            conversation_id: "c1".into(),
            summary: "摘要".into(),
            covered_until_message_id: "u1".into(),
            source_message_count: 1,
            model_key: None,
            version: 1,
            updated_at: 10,
        })
        .unwrap();

        db.edit_message("u1", "第二版").unwrap();
        assert!(db.get_summary("c1").unwrap().is_none());
    }

    #[test]
    fn activate_rejects_out_of_range_index() {
        let db = Database::in_memory();
        db.create_conversation(&conv("c1", "t", 1)).unwrap();
        db.save_message(&msg("u1", "c1", "user", "第一版", "done", 10))
            .unwrap();
        // No version stack yet.
        assert!(db.activate_message_version("u1", 0).is_err());
        db.edit_message("u1", "第二版").unwrap();
        assert!(db.activate_message_version("u1", 2).is_err());
        assert!(db.activate_message_version("u1", -1).is_err());
    }

    /* ---------------- full-text search (v12) ---------------- */

    #[test]
    fn search_messages_matches_cjk_via_fts_and_short_queries_via_like() {
        let db = Database::in_memory();
        db.create_conversation(&conv("c1", "会话一", 1)).unwrap();
        db.save_message(&msg("m1", "c1", "user", "如何配置中文全文搜索", "done", 10))
            .unwrap();
        db.save_message(&msg(
            "m2",
            "c1",
            "assistant",
            "使用 FTS5 与 trigram 分词方案",
            "done",
            11,
        ))
        .unwrap();

        // 4-character CJK phrase goes through the FTS index.
        let hits = db.search_messages("全文搜索", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message_id, "m1");
        assert_eq!(hits[0].conversation_title, "会话一");
        assert!(hits[0].snippet.contains("全文搜索"));

        // 2-character CJK query is answered by the LIKE fallback.
        let hits = db.search_messages("分词", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message_id, "m2");
        assert!(hits[0].snippet.contains("分词"));

        // No match / empty query.
        assert!(db
            .search_messages("完全不存在的内容", 10)
            .unwrap()
            .is_empty());
        assert!(db.search_messages("   ", 10).unwrap().is_empty());
    }

    #[test]
    fn search_index_follows_updates_edits_and_deletes() {
        let db = Database::in_memory();
        db.create_conversation(&conv("c1", "t", 1)).unwrap();
        db.save_message(&msg("m1", "c1", "user", "原始内容甲乙丙", "done", 10))
            .unwrap();
        assert_eq!(db.search_messages("甲乙丙", 10).unwrap().len(), 1);

        // Upsert with new content must reindex through the UPDATE trigger.
        db.save_message(&msg("m1", "c1", "user", "替换内容丁戊己", "done", 10))
            .unwrap();
        assert!(db.search_messages("甲乙丙", 10).unwrap().is_empty());
        assert_eq!(db.search_messages("丁戊己", 10).unwrap().len(), 1);

        // Version edits write through UPDATE as well: only the active version
        // stays searchable.
        db.edit_message("m1", "编辑之后庚辛壬").unwrap();
        assert!(db.search_messages("丁戊己", 10).unwrap().is_empty());
        assert_eq!(db.search_messages("庚辛壬", 10).unwrap().len(), 1);

        // Deleting the conversation cascades and clears the index.
        db.delete_conversation("c1").unwrap();
        assert!(db.search_messages("庚辛壬", 10).unwrap().is_empty());
    }

    #[test]
    fn search_messages_escapes_like_wildcards() {
        let db = Database::in_memory();
        db.create_conversation(&conv("c1", "t", 1)).unwrap();
        db.save_message(&msg("m1", "c1", "user", "进度 50% 完成", "done", 10))
            .unwrap();
        db.save_message(&msg("m2", "c1", "user", "没有百分号", "done", 11))
            .unwrap();

        // `%` must be matched literally, not as a wildcard.
        let hits = db.search_messages("50%", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message_id, "m1");
    }

    /* ---------------- assistants (v13) ---------------- */

    fn test_assistant(id: &str, name: &str) -> Assistant {
        Assistant {
            id: id.into(),
            name: name.into(),
            icon: Some("🤖".into()),
            description: Some("自定义助手".into()),
            system_prompt: "你是一个自定义助手。".into(),
            provider_id: None,
            model_key: None,
            tool_policies_json: None,
            sort_order: 100,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn builtin_assistants_are_seeded_and_edits_survive_reseeding() {
        let db = Database::in_memory();
        let list = db.list_assistants().unwrap();
        assert_eq!(list.len(), 6);
        assert!(list.iter().all(|a| a.is_builtin()));

        // User edits to a built-in survive the startup re-seed…
        let mut edited = list[0].clone();
        edited.name = "我的通用助手".into();
        db.upsert_assistant(&edited).unwrap();
        db.seed_builtin_assistants().unwrap();
        assert_eq!(db.list_assistants().unwrap()[0].name, "我的通用助手");

        // …and "restore default" puts the shipped definition back.
        let reset = db
            .reset_builtin_assistant("assistant.builtin.default")
            .unwrap();
        assert_eq!(reset.name, "通用助手");
        assert!(reset.system_prompt.contains("通用、可靠的桌面助手"));
        // Reset also restores the shipped vector icon key.
        assert_eq!(reset.icon.as_deref(), Some("sparkles"));
    }

    #[test]
    fn legacy_builtins_are_refreshed_or_retired() {
        let db = Database::in_memory();
        {
            // A database from the previous release: the default assistant
            // still carries the old shipped prompt, the writer was customised
            // by the user, and the retired meeting assistant is still there.
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE assistants
                    SET system_prompt = '你是一个轻量可靠的桌面助手，旧版提示词。'
                  WHERE id = 'assistant.builtin.default'",
                [],
            )
            .unwrap();
            conn.execute(
                "UPDATE assistants
                    SET name = '我的写作助手', system_prompt = '你是我的私人写作助手。'
                  WHERE id = 'assistant.builtin.writer'",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO assistants
                    (id, name, icon, description, system_prompt, provider_id, model_key,
                     tool_policies_json, sort_order, created_at, updated_at)
                 VALUES ('assistant.builtin.meeting', '会议纪要', 'clipboard-list', '旧版',
                         '你是一个高效的会议记录助手。整理为结构化纪要。', NULL, NULL, NULL, 5, 0, 0)",
                [],
            )
            .unwrap();
        }
        db.create_conversation(&conv("c1", "t", 1)).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE conversations SET assistant_id = 'assistant.builtin.meeting' WHERE id = 'c1'",
                [],
            )
            .unwrap();
        }

        db.seed_builtin_assistants().unwrap();

        // The untouched built-in was upgraded to the current definition…
        let default = db
            .get_assistant("assistant.builtin.default")
            .unwrap()
            .unwrap();
        assert!(default.system_prompt.contains("通用、可靠的桌面助手"));

        // …the customised one kept the user's edit…
        let writer = db
            .get_assistant("assistant.builtin.writer")
            .unwrap()
            .unwrap();
        assert_eq!(writer.name, "我的写作助手");
        assert_eq!(writer.system_prompt, "你是我的私人写作助手。");

        // …the retired built-in is gone and its conversation fell back…
        assert!(db
            .get_assistant("assistant.builtin.meeting")
            .unwrap()
            .is_none());
        assert_eq!(
            db.get_conversation("c1").unwrap().unwrap().assistant_id,
            None
        );

        // …and the new built-in was seeded.
        assert!(db
            .get_assistant("assistant.builtin.summarizer")
            .unwrap()
            .is_some());
    }

    #[test]
    fn migration_v18_normalizes_legacy_emoji_icons() {
        let db = Database::in_memory();
        {
            // Simulate a database created before v18: the shipped emoji are
            // still stored and `user_version` counts every already-applied
            // migration (18 — one legacy entry carries no vN label).
            let conn = db.conn.lock().unwrap();
            conn.execute_batch(
                "UPDATE assistants SET icon = '💬' WHERE id = 'assistant.builtin.default';
                 UPDATE assistants SET icon = '✍️' WHERE id = 'assistant.builtin.writer';
                 PRAGMA user_version = 18;",
            )
            .unwrap();
        }
        db.migrate().unwrap();

        assert_eq!(
            db.get_assistant("assistant.builtin.default")
                .unwrap()
                .unwrap()
                .icon
                .as_deref(),
            Some("sparkles")
        );
        assert_eq!(
            db.get_assistant("assistant.builtin.writer")
                .unwrap()
                .unwrap()
                .icon
                .as_deref(),
            Some("pen-line")
        );
    }

    #[test]
    fn user_assistants_can_be_created_and_deleted() {
        let db = Database::in_memory();
        let saved = db
            .upsert_assistant(&test_assistant("assistant-1", "我的助手"))
            .unwrap();
        assert!(!saved.is_builtin());
        assert_eq!(db.list_assistants().unwrap().len(), 7);

        // A conversation bound to it falls back to the default on delete.
        let mut c = conv("c1", "t", 1);
        c.assistant_id = Some("assistant-1".into());
        db.create_conversation(&c).unwrap();
        assert_eq!(
            db.get_conversation("c1")
                .unwrap()
                .unwrap()
                .assistant_id
                .as_deref(),
            Some("assistant-1")
        );

        db.delete_assistant("assistant-1").unwrap();
        assert_eq!(db.list_assistants().unwrap().len(), 6);
        assert!(db
            .get_conversation("c1")
            .unwrap()
            .unwrap()
            .assistant_id
            .is_none());

        // Built-ins refuse deletion; resetting a user assistant does too.
        assert!(db.delete_assistant("assistant.builtin.coder").is_err());
        assert!(db.reset_builtin_assistant("assistant-9").is_err());
    }

    #[test]
    fn upsert_assistant_validates_fields() {
        let db = Database::in_memory();
        let mut a = test_assistant("assistant-2", "   ");
        assert!(db.upsert_assistant(&a).is_err());

        a.name = "有名字".into();
        a.system_prompt = "   ".into();
        assert!(db.upsert_assistant(&a).is_err());

        a.system_prompt = "有效提示词".into();
        a.id = "  ".into();
        assert!(db.upsert_assistant(&a).is_err());
    }

    /* ---------------- skills (v19) ---------------- */

    fn test_skill(id: &str, name: &str) -> Skill {
        Skill {
            id: id.into(),
            name: name.into(),
            description: "整理周报".into(),
            content: "把零散记录整理为结构化周报".into(),
            triggers: vec!["周报".into()],
            enabled: true,
            sort_order: 0,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn skills_round_trip_with_trigger_cleanup() {
        let db = Database::in_memory();
        let stored = db.upsert_skill(&test_skill("skill-1", "周报助手")).unwrap();
        assert_eq!(stored.name, "周报助手");
        assert_eq!(stored.triggers, vec!["周报"]);
        assert!(stored.created_at > 0);
        assert!(stored.enabled);

        // Editing trims, drops empty and de-duplicates triggers.
        let mut edited = stored.clone();
        edited.name = "  周报生成  ".into();
        edited.triggers = vec![
            "周报".into(),
            " 周报 ".into(),
            String::new(),
            "Weekly".into(),
            "weekly".into(),
        ];
        edited.enabled = false;
        let stored = db.upsert_skill(&edited).unwrap();
        assert_eq!(stored.name, "周报生成");
        assert_eq!(stored.triggers, vec!["周报", "Weekly"]);
        assert!(!stored.enabled);
        assert_eq!(
            stored.created_at,
            db.get_skill("skill-1").unwrap().unwrap().created_at
        );
        assert_eq!(db.list_skills().unwrap().len(), 1);

        db.delete_skill("skill-1").unwrap();
        assert!(db.list_skills().unwrap().is_empty());
    }

    #[test]
    fn upsert_skill_validates_fields() {
        let db = Database::in_memory();
        let mut blank = test_skill("skill-2", "   ");
        assert!(db.upsert_skill(&blank).is_err());

        blank.name = "有名字".into();
        blank.content = "   ".into();
        assert!(db.upsert_skill(&blank).is_err());

        assert!(db.list_skills().unwrap().is_empty());
    }

    #[test]
    fn skills_survive_migration_reruns() {
        let db = Database::in_memory();
        db.upsert_skill(&test_skill("skill-3", "保留")).unwrap();
        db.migrate().unwrap();
        assert_eq!(db.list_skills().unwrap().len(), 1);
    }

    fn draft(name: &str, content: &str) -> SkillDraft {
        SkillDraft {
            name: name.into(),
            description: "描述".into(),
            triggers: vec!["周报".into()],
            content: content.into(),
        }
    }

    #[test]
    fn import_skill_matches_existing_by_name() {
        let db = Database::in_memory();
        assert!(
            db.import_skill(&draft("周报助手", "第一版")).unwrap(),
            "first import creates a row"
        );
        assert_eq!(db.list_skills().unwrap().len(), 1);
        let first_id = db.list_skills().unwrap()[0].id.clone();

        // Re-importing the same name updates in place and keeps the id.
        assert!(
            !db.import_skill(&draft("周报助手", "第二版")).unwrap(),
            "second import updates"
        );
        let rows = db.list_skills().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, first_id);
        assert_eq!(rows[0].content, "第二版");

        // A different name creates another row.
        assert!(db.import_skill(&draft("翻译助手", "x")).unwrap());
        assert_eq!(db.list_skills().unwrap().len(), 2);
    }

    #[test]
    fn import_skill_rejects_incomplete_drafts() {
        let db = Database::in_memory();
        assert!(db.import_skill(&draft("   ", "内容")).is_err());
        assert!(db.import_skill(&draft("有名字", "   ")).is_err());
        assert!(db.list_skills().unwrap().is_empty());
    }

    #[test]
    fn conversation_binds_an_assistant_through_chat_turn() {
        let db = Database::in_memory();
        let mut conversation = conv("c1", "带助手的会话", 10);
        conversation.assistant_id = Some("assistant.builtin.coder".into());
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

        assert_eq!(
            db.get_conversation("c1")
                .unwrap()
                .unwrap()
                .assistant_id
                .as_deref(),
            Some("assistant.builtin.coder")
        );
    }

    /* ---------------- token usage (v17) ---------------- */

    fn usage_msg(
        id: &str,
        model: Option<&str>,
        input: Option<i64>,
        output: Option<i64>,
        status: &str,
        at: i64,
    ) -> Message {
        Message {
            model_name: model.map(str::to_string),
            input_tokens: input,
            output_tokens: output,
            duration_ms: Some(1000),
            ..msg(id, "c1", "assistant", "答案", status, at)
        }
    }

    /// The local calendar day a millisecond timestamp falls on, matching the
    /// `localtime` modifier used by the aggregate query.
    fn local_day(ms: i64) -> String {
        use chrono::TimeZone;
        chrono::Local
            .timestamp_millis_opt(ms)
            .single()
            .expect("valid timestamp")
            .format("%Y-%m-%d")
            .to_string()
    }

    #[test]
    fn token_usage_round_trips_and_clears_on_resave() {
        let db = Database::in_memory();
        db.create_conversation(&conv("c1", "t", 1)).unwrap();
        db.save_message(&usage_msg(
            "a1",
            Some("deepseek-chat"),
            Some(120),
            Some(45),
            "done",
            10,
        ))
        .unwrap();

        let stored = db.list_messages("c1").unwrap();
        assert_eq!(stored[0].input_tokens, Some(120));
        assert_eq!(stored[0].output_tokens, Some(45));

        // A regeneration starts with a blank row: re-saving without usage
        // must clear the stale counters rather than keep the old numbers.
        db.save_message(&usage_msg(
            "a1",
            Some("deepseek-chat"),
            None,
            None,
            "streaming",
            10,
        ))
        .unwrap();
        let stored = db.list_messages("c1").unwrap();
        assert_eq!(stored[0].input_tokens, None);
        assert_eq!(stored[0].output_tokens, None);
    }

    #[test]
    fn usage_stats_aggregate_per_model_and_day() {
        let db = Database::in_memory();
        db.create_conversation(&conv("c1", "t", 1)).unwrap();

        // Relative to "now": the per-model daily rows are bounded to the last
        // year, so fixed timestamps would fall out of the window over time.
        let t1 = chrono::Utc::now().timestamp_millis() - 40 * 24 * 60 * 60 * 1000;
        let t2 = t1 + 26 * 60 * 60 * 1000; // always a different calendar day

        db.save_message(&usage_msg(
            "a1",
            Some("alpha"),
            Some(100),
            Some(40),
            "done",
            t1,
        ))
        .unwrap();
        db.save_message(&usage_msg(
            "a2",
            Some("beta"),
            Some(10),
            Some(5),
            "done",
            t1,
        ))
        .unwrap();
        // No model name: its own bucket (the UI labels it itself).
        db.save_message(&usage_msg("a3", None, Some(7), Some(3), "done", t1))
            .unwrap();
        // A model with rounds but no token data still shows up.
        db.save_message(&usage_msg("a4", Some("gamma"), None, None, "done", t1))
            .unwrap();
        // Different day, same model as a1.
        db.save_message(&usage_msg(
            "a5",
            Some("alpha"),
            Some(50),
            Some(20),
            "done",
            t2,
        ))
        .unwrap();
        // Failed turns are excluded entirely, even with token numbers.
        db.save_message(&usage_msg(
            "a6",
            Some("beta"),
            Some(999),
            Some(999),
            "error",
            t2,
        ))
        .unwrap();

        let stats = db.usage_stats().unwrap();
        assert_eq!(stats.input_tokens, 167);
        assert_eq!(stats.output_tokens, 68);
        assert_eq!(stats.rounds, 5);
        assert_eq!(stats.rounds_with_usage, 4);

        // Ordered by total tokens: alpha (210) > beta (15) > unknown (10) > gamma (0).
        let names: Vec<Option<&str>> = stats
            .models
            .iter()
            .map(|m| m.model_name.as_deref())
            .collect();
        assert_eq!(
            names,
            vec![Some("alpha"), Some("beta"), None, Some("gamma")]
        );
        assert_eq!(stats.models[0].input_tokens, 150);
        assert_eq!(stats.models[0].output_tokens, 60);
        assert_eq!(stats.models[0].rounds, 2);
        assert_eq!(stats.models[0].avg_duration_ms, Some(1000));
        assert_eq!(stats.models[0].last_used_at, Some(t2));
        assert_eq!(stats.models[3].rounds, 1);
        assert_eq!(stats.models[3].input_tokens, 0);

        // Two calendar days, ascending, with the per-day totals of the done rows.
        assert_eq!(stats.daily.len(), 2);
        assert_eq!(stats.daily[0].day, local_day(t1));
        assert_eq!(stats.daily[0].input_tokens, 117);
        assert_eq!(stats.daily[0].output_tokens, 48);
        assert_eq!(stats.daily[0].rounds, 4);
        assert_eq!(stats.daily[1].day, local_day(t2));
        assert_eq!(stats.daily[1].input_tokens, 50);
        assert_eq!(stats.daily[1].output_tokens, 20);
        assert_eq!(stats.daily[1].rounds, 1);

        // Per-model per-day rows power the trend lines: alpha on two days,
        // beta and the unknown bucket on day one (gamma has no tokens)
        // and the failed row never appears.
        assert_eq!(stats.model_daily.len(), 4);
        let alpha_late = stats
            .model_daily
            .iter()
            .find(|row| row.model_name.as_deref() == Some("alpha") && row.day == local_day(t2))
            .expect("alpha has a row on the second day");
        assert_eq!(alpha_late.input_tokens, 50);
        assert_eq!(alpha_late.output_tokens, 20);
        assert!(!stats.model_daily.iter().any(|row| row.input_tokens >= 999));

        // a1 and a5 share conversation c1, 26 hours apart.
        assert_eq!(stats.longest_session_ms, t2 - t1);
    }

    #[test]
    fn usage_stats_are_empty_without_finished_turns() {
        let db = Database::in_memory();
        db.create_conversation(&conv("c1", "t", 1)).unwrap();
        db.save_message(&msg("u1", "c1", "user", "问题", "done", 10))
            .unwrap();

        let stats = db.usage_stats().unwrap();
        assert_eq!(stats.rounds, 0);
        assert_eq!(stats.input_tokens, 0);
        assert!(stats.models.is_empty());
        assert!(stats.daily.is_empty());
    }

    /* ---------------- knowledge base (v15) ---------------- */

    #[test]
    fn knowledge_base_ingests_chunks_and_retrieves_them() {
        let db = Database::in_memory();
        let text = "芝麻助手支持中文全文搜索。\n\n知识库使用 BM25 排序返回片段。";
        let document = db.kb_ingest("kb-1", "说明.md", "text", None, text).unwrap();
        assert_eq!(document.chunk_count, 1);
        assert_eq!(db.kb_stats().unwrap(), (1, 1));
        assert_eq!(db.kb_list_documents().unwrap().len(), 1);

        // 6-character query goes through the trigram index.
        let hits = db.kb_search("中文全文搜索", 3).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "说明.md");
        assert_eq!(hits[0].document_id, "kb-1");
        assert!(hits[0].snippet.contains("中文全文搜索"));

        // 2-character query falls back to LIKE.
        let hits = db.kb_search("排序", 3).unwrap();
        assert_eq!(hits.len(), 1);

        // Deleting the document removes its chunks from the index.
        db.kb_delete_document("kb-1").unwrap();
        assert!(db.kb_search("中文全文搜索", 3).unwrap().is_empty());
        assert_eq!(db.kb_stats().unwrap(), (0, 0));
    }

    #[test]
    fn knowledge_ingest_splits_long_text_into_chunks() {
        let db = Database::in_memory();
        let text = vec!["段落内容".repeat(120); 6].join("\n\n");
        let document = db
            .kb_ingest("kb-2", "长文档.txt", "file", Some("长文档.txt"), &text)
            .unwrap();
        assert!(document.chunk_count > 1);
        // Every chunk is retrievable (index + rows agree).
        let hits = db.kb_search("段落内容", 8).unwrap();
        assert!(!hits.is_empty());
        let (_, chunks) = db.kb_stats().unwrap();
        assert_eq!(chunks, document.chunk_count);
    }

    /* ---------------- backup export / import (P0-4) ---------------- */

    fn test_memory(id: &str) -> Memory {
        Memory {
            id: id.into(),
            category: "preference".into(),
            content: "用户喜欢简洁的回答".into(),
            keywords_json: None,
            sensitivity: "normal".into(),
            source_conversation_id: Some("c1".into()),
            source_message_id: None,
            enabled: true,
            created_at: 10,
            updated_at: 10,
            last_used_at: None,
            use_count: 0,
        }
    }

    #[test]
    fn backup_round_trip_preserves_versions_and_search() {
        let db = Database::in_memory();
        db.create_conversation(&conv("c1", "备份会话", 1)).unwrap();
        db.save_message(&msg("m1", "c1", "user", "原始提问", "done", 10))
            .unwrap();
        db.edit_message("m1", "编辑后的提问内容").unwrap();
        db.create_memory(&test_memory("mem1")).unwrap();
        db.upsert_skill(&test_skill("skill-1", "备份技能")).unwrap();

        let backup = db.export_backup(true).unwrap();
        assert_eq!(backup.app, BACKUP_APP_MARKER);
        assert_eq!(backup.format_version, BACKUP_FORMAT_VERSION);
        assert_eq!(backup.conversations.len(), 1);
        assert_eq!(backup.conversations[0].messages.len(), 1);
        assert_eq!(backup.memories.len(), 1);
        assert_eq!(backup.skills.len(), 1);

        // Merging into the same database skips everything.
        let report = db.import_backup(&backup, ImportStrategy::Merge).unwrap();
        assert_eq!(report.conversations, 0);
        assert_eq!(report.messages, 0);
        assert_eq!(report.memories, 0);
        assert_eq!(report.skills, 0);
        assert_eq!(report.skipped, 4);

        // Replacing into a fresh database restores everything, versions included.
        let fresh = Database::in_memory();
        let report = fresh
            .import_backup(&backup, ImportStrategy::Replace)
            .unwrap();
        assert_eq!(report.conversations, 1);
        assert_eq!(report.messages, 1);
        assert_eq!(report.memories, 1);
        assert_eq!(report.skills, 1);
        assert_eq!(report.skipped, 0);

        let restored = fresh.list_messages("c1").unwrap();
        assert_eq!(restored[0].content, "编辑后的提问内容");
        let versions = parse_versions(restored[0].versions_json.as_deref());
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].content, "原始提问");
        assert_eq!(fresh.list_memories().unwrap().len(), 1);
        assert_eq!(fresh.list_skills().unwrap()[0].name, "备份技能");

        // Search works immediately after import (index rebuilt).
        assert_eq!(fresh.search_messages("编辑后的提问", 10).unwrap().len(), 1);
        assert!(fresh.search_messages("原始提问", 10).unwrap().len() <= 1);
    }

    #[test]
    fn replace_import_wipes_existing_data() {
        let db = Database::in_memory();
        db.create_conversation(&conv("old", "旧会话", 1)).unwrap();
        db.save_message(&msg("old-m", "old", "user", "旧内容", "done", 10))
            .unwrap();
        db.upsert_skill(&test_skill("old-skill", "旧技能")).unwrap();

        // A backup that only carries a different conversation.
        let other = Database::in_memory();
        other
            .create_conversation(&conv("new", "新会话", 2))
            .unwrap();
        other
            .save_message(&msg("new-m", "new", "user", "新内容", "done", 20))
            .unwrap();
        let backup = other.export_backup(false).unwrap();

        db.import_backup(&backup, ImportStrategy::Replace).unwrap();
        assert!(db.get_conversation("old").unwrap().is_none());
        assert!(db.get_conversation("new").unwrap().is_some());
        assert!(db.search_messages("旧内容", 10).unwrap().is_empty());
        assert_eq!(db.search_messages("新内容", 10).unwrap().len(), 1);
        // Replace also clears user skills before inserting the backup's own.
        assert!(db.list_skills().unwrap().is_empty());
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

    /// M0 spike: the bundled SQLite build must ship FTS5 with the trigram
    /// tokenizer (required for CJK substring search) and support the
    /// external-content pattern keyed by the content table's implicit rowid.
    #[test]
    fn fts5_trigram_is_available() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE t (id TEXT PRIMARY KEY, content TEXT NOT NULL);
             CREATE VIRTUAL TABLE t_fts USING fts5(
                 content, content=t, content_rowid=rowid, tokenize='trigram'
             );
             INSERT INTO t(id, content) VALUES ('m1', '芝麻助手支持中文全文搜索');
             INSERT INTO t(id, content) VALUES ('m2', 'unrelated english text');
             INSERT INTO t_fts(rowid, content) SELECT rowid, content FROM t;",
        )
        .unwrap();

        // 4-char CJK phrase hits only the matching row.
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM t_fts WHERE t_fts MATCH '中文全文'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);

        // Substring in the middle of the text is found too (trigram property).
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM t_fts WHERE t_fts MATCH '全文搜索'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);

        // The join back to the content table works via rowid.
        let content: String = conn
            .query_row(
                "SELECT t.content FROM t_fts JOIN t ON t.rowid = t_fts.rowid
                 WHERE t_fts MATCH '全文搜索'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(content, "芝麻助手支持中文全文搜索");

        // Documented trigram limit: queries shorter than 3 characters produce
        // no MATCH hits (they must go through the LIKE fallback instead).
        let short_hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM t_fts WHERE t_fts MATCH '中文'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(short_hits, 0);
        let like_hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM t WHERE content LIKE '%中文%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(like_hits, 1);
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
