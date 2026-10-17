//! Backup queries use one connection/transaction; never call locking Database methods here.
use super::*;
use std::collections::HashSet;

fn rows<T: serde::de::DeserializeOwned>(
    conn: &Connection,
    table: &str,
    fields: &str,
) -> Result<Vec<T>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT json_object({fields}) FROM {table} ORDER BY rowid"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string()))
        .collect()
}

pub(super) fn snapshot(conn: &Connection, include_images: bool) -> Result<BackupFile, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {CONVERSATION_COLUMNS} FROM conversations ORDER BY id"
        ))
        .map_err(|e| e.to_string())?;
    let conversations = stmt
        .query_map([], map_conversation)
        .map_err(|e| e.to_string())?
        .collect::<SqlResult<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let mut messages = conn.prepare(&format!("SELECT {MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ?1 ORDER BY created_at, rowid")).map_err(|e| e.to_string())?;
    let conversations = conversations
        .into_iter()
        .map(|conversation| {
            let mut values = messages
                .query_map([&conversation.id], map_message)
                .map_err(|e| e.to_string())?
                .collect::<SqlResult<Vec<_>>>()
                .map_err(|e| e.to_string())?;
            for message in &mut values {
                message.tool_calls = sanitize_tool_calls(message.tool_calls.as_deref());
            }
            Ok(BackupConversation {
                conversation,
                messages: values,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut assistants: Vec<Assistant> = rows(conn, "assistants", "'id',id,'name',name,'icon',icon,'description',description,'systemPrompt',system_prompt,'providerId',provider_id,'modelKey',model_key,'toolPoliciesJson',tool_policies_json,'sortOrder',sort_order,'createdAt',created_at,'updatedAt',updated_at")?;
    for assistant in &mut assistants {
        assistant.tool_policies_json = safe_policies(assistant.tool_policies_json.as_deref());
    }
    Ok(BackupFile {
        app: BACKUP_APP_MARKER.into(), format_version: BACKUP_FORMAT_VERSION, exported_at: now_ms(), conversations,
        memories: rows(conn, "memories", "'id',id,'category',category,'content',content,'keywordsJson',keywords_json,'sensitivity',sensitivity,'sourceConversationId',source_conversation_id,'sourceMessageId',source_message_id,'enabled',json(CASE WHEN enabled THEN 'true' ELSE 'false' END),'createdAt',created_at,'updatedAt',updated_at,'lastUsedAt',last_used_at,'useCount',use_count")?,
        image_generations: if include_images { rows(conn, "image_generations", "'id',id,'prompt',prompt,'imageData',image_data,'sizeLabel',size_label,'referenceImagesJson',reference_images_json,'createdAt',created_at")? } else { vec![] },
        skills: rows(conn, "skills", "'id',id,'name',name,'description',description,'content',content,'triggers',json(triggers_json),'enabled',json(CASE WHEN enabled THEN 'true' ELSE 'false' END),'sortOrder',sort_order,'createdAt',created_at,'updatedAt',updated_at")?,
        assistants,
        documents: rows(conn, "kb_documents", "'id',id,'title',title,'sourceType',source_type,'sourceRef',source_ref,'chunkCount',chunk_count,'createdAt',created_at")?,
        chunks: rows(conn, "kb_chunks", "'id',id,'documentId',document_id,'seq',seq,'content',content")?,
        summaries: rows(conn, "conversation_summaries", "'conversationId',conversation_id,'summary',summary,'coveredUntilMessageId',covered_until_message_id,'sourceMessageCount',source_message_count,'modelKey',model_key,'version',version,'updatedAt',updated_at")?,
        tasks: rows(conn, "tasks", "'id',id,'title',title,'dueAt',due_at,'completed',json(CASE WHEN completed THEN 'true' ELSE 'false' END),'sourceConversationId',source_conversation_id,'sourceMessageId',source_message_id,'notifiedAt',notified_at,'createdAt',created_at,'updatedAt',updated_at,'reminderPending',json(CASE WHEN reminder_pending THEN 'true' ELSE 'false' END)")?,
        config: None,
    })
}

pub(super) fn validate(backup: &BackupFile) -> Result<(), String> {
    if backup.app != BACKUP_APP_MARKER
        || !(1..=BACKUP_FORMAT_VERSION).contains(&backup.format_version)
    {
        return Err("不支持的备份格式".into());
    }
    fn unique<'a>(ids: impl Iterator<Item = &'a str>) -> Result<HashSet<&'a str>, String> {
        let mut set = HashSet::new();
        for id in ids {
            if id.is_empty() || !set.insert(id) {
                return Err("备份含空白或重复 ID".into());
            }
        }
        Ok(set)
    }
    let conversations = unique(
        backup
            .conversations
            .iter()
            .map(|c| c.conversation.id.as_str()),
    )?;
    unique(
        backup
            .conversations
            .iter()
            .flat_map(|c| c.messages.iter().map(|m| m.id.as_str())),
    )?;
    unique(backup.assistants.iter().map(|a| a.id.as_str()))?;
    unique(backup.memories.iter().map(|a| a.id.as_str()))?;
    unique(backup.skills.iter().map(|a| a.id.as_str()))?;
    unique(backup.image_generations.iter().map(|a| a.id.as_str()))?;
    unique(backup.tasks.iter().map(|a| a.id.as_str()))?;
    for task in &backup.tasks {
        if task.title.trim().is_empty()
            || task.title.chars().count() > 500
            || task
                .due_at
                .is_some_and(|n| !(0..=8_640_000_000_000_000).contains(&n))
        {
            return Err("备份待办标题或提醒时间无效".into());
        }
    }
    let documents = unique(backup.documents.iter().map(|d| d.id.as_str()))?;
    unique(backup.chunks.iter().map(|c| c.id.as_str()))?;
    unique(backup.summaries.iter().map(|c| c.conversation_id.as_str()))?;
    for chunk in &backup.chunks {
        if !documents.contains(chunk.document_id.as_str()) {
            return Err("知识分块缺少所属文档".into());
        }
    }
    for summary in &backup.summaries {
        if !conversations.contains(summary.conversation_id.as_str()) {
            return Err("摘要缺少所属会话".into());
        }
    }
    for entry in &backup.conversations {
        for message in &entry.messages {
            validate_images_json(message.images_json.as_deref())?;
        }
    }
    if let Some(config) = &backup.config {
        config.validate()?;
    }
    Ok(())
}

pub(super) fn import_independent(
    tx: &Connection,
    backup: &BackupFile,
    report: &mut ImportReport,
) -> Result<(), String> {
    for a in &backup.assistants {
        // Approval waivers are machine-local, not portable authority.
        let policies = safe_policies(a.tool_policies_json.as_deref());
        let n = tx.execute("INSERT OR IGNORE INTO assistants (id,name,icon,description,system_prompt,provider_id,model_key,tool_policies_json,sort_order,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)", params![a.id,a.name,a.icon,a.description,a.system_prompt,a.provider_id,a.model_key,policies,a.sort_order,a.created_at,a.updated_at]).map_err(|e| e.to_string())?;
        report.assistants += n;
        report.skipped += 1 - n;
    }
    let mut imported = HashSet::new();
    for d in &backup.documents {
        let count = backup
            .chunks
            .iter()
            .filter(|c| c.document_id == d.id)
            .count();
        let n = tx.execute("INSERT OR IGNORE INTO kb_documents (id,title,source_type,source_ref,chunk_count,created_at) VALUES (?1,?2,?3,?4,?5,?6)", params![d.id,d.title,d.source_type,d.source_ref,count,d.created_at]).map_err(|e| e.to_string())?;
        report.documents += n;
        report.skipped += 1 - n;
        if n != 0 {
            imported.insert(&d.id);
        }
    }
    for c in &backup.chunks {
        if !imported.contains(&c.document_id) {
            report.skipped += 1;
            continue;
        }
        // A colliding chunk in a different document must fail the whole transaction,
        // rather than create a silently incomplete newly imported document.
        tx.execute(
            "INSERT INTO kb_chunks (id,document_id,seq,content) VALUES (?1,?2,?3,?4)",
            params![c.id, c.document_id, c.seq, c.content],
        )
        .map_err(|e| format!("知识分块冲突：{e}"))?;
        report.chunks += 1;
    }
    for t in &backup.tasks {
        let n = tx.execute("INSERT OR IGNORE INTO tasks (id,title,due_at,completed,source_conversation_id,source_message_id,notified_at,created_at,updated_at,reminder_pending) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)", params![t.id,t.title,t.due_at,t.completed,t.source_conversation_id,t.source_message_id,t.notified_at,t.created_at,t.updated_at,t.reminder_pending]).map_err(|e| e.to_string())?;
        report.tasks += n;
        report.skipped += 1 - n;
    }
    Ok(())
}

pub(super) fn safe_policies(raw: Option<&str>) -> Option<String> {
    let mut policies: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(raw?).ok()?;
    policies.retain(|_, v| matches!(v.as_str(), Some("allow" | "confirm" | "disabled")));
    serde_json::to_string(&policies).ok()
}

pub(super) fn import_summaries(
    tx: &Connection,
    backup: &BackupFile,
    imported: &HashSet<String>,
    report: &mut ImportReport,
) -> Result<(), String> {
    for s in &backup.summaries {
        if !imported.contains(&s.conversation_id) {
            report.skipped += 1;
            continue;
        }
        let covered: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM messages WHERE id=?1 AND conversation_id=?2)",
                params![s.covered_until_message_id, s.conversation_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !covered {
            return Err("摘要引用的消息不存在".into());
        }
        tx.execute("INSERT INTO conversation_summaries (conversation_id,summary,covered_until_message_id,source_message_count,model_key,version,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)", params![s.conversation_id,s.summary,s.covered_until_message_id,s.source_message_count,s.model_key,s.version,s.updated_at]).map_err(|e| e.to_string())?;
        report.summaries += 1;
    }
    Ok(())
}
