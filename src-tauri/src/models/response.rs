use serde::Serialize;

use crate::api::web_search::SearchResult;

/// A bounded snapshot of one passage prepared in this turn's request prompt.
/// Preparation precedes approval and HTTP: not proof of delivery or model citation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeEvidenceStage {
    Prepared,
}

/// The original prepared retrieval context, never reconstructed by a later search.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeEvidence {
    pub index: usize,
    pub document_id: String,
    pub chunk_index: i64,
    pub title: String,
    pub snippet: String,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
}

/// Unified stream events emitted to the frontend on the `chat-event` channel.
///
/// The frontend must never depend on raw vendor payload shapes: everything
/// vendor-specific is normalized into these variants by the API adapters.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ChatEvent {
    Start {
        request_id: String,
    },
    /// Fired when a web search begins, before the LLM request is sent.
    SearchStart {
        request_id: String,
        query: String,
    },
    /// Fired when the web search completes, carrying the results so the
    /// frontend can display source references.
    SearchEnd {
        request_id: String,
        results: Vec<SearchResult>,
    },
    /// Legacy event name retained for compatibility. Emitted when request
    /// context is prepared, BEFORE approval/HTTP; it never confirms delivery.
    KbUsed {
        request_id: String,
        count: usize,
        /// Document titles of the prepared passages.
        titles: Vec<String>,
        evidence: Vec<KnowledgeEvidence>,
        stage: KnowledgeEvidenceStage,
    },
    /// Fired when the agent loop starts executing a tool call.
    ToolStart {
        request_id: String,
        call_id: String,
        name: String,
        /// Serialized JSON arguments the model requested.
        arguments: String,
    },
    /// Fired when a tool call finishes successfully with its result.
    ToolEnd {
        request_id: String,
        call_id: String,
        name: String,
        /// Serialized JSON result from the tool.
        result: String,
    },
    /// Fired when a tool call fails (execution error, not the model's fault).
    ToolError {
        request_id: String,
        call_id: String,
        name: String,
        message: String,
    },
    /// Fired when the agent needs the user to approve (or reject) a
    /// sensitive tool call. The frontend shows a confirmation card; the
    /// user's answer is delivered via `chat_approve_tool`.
    ToolPending {
        request_id: String,
        call_id: String,
        name: String,
        /// Human-readable argument summary for the confirmation card.
        summary: String,
        /// False for data transfers, MCP tools and "confirm every time".
        can_remember: bool,
    },
    /// Fired when the user rejected a pending tool call. The model is
    /// informed through a tool result message that it was refused.
    ToolRejected {
        request_id: String,
        call_id: String,
        name: String,
    },
    Delta {
        request_id: String,
        text: String,
    },
    ReasoningDelta {
        request_id: String,
        text: String,
    },
    Usage {
        request_id: String,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },
    Finish {
        request_id: String,
        reason: Option<String>,
    },
    Error {
        request_id: String,
        code: String,
        message: String,
        retryable: bool,
    },
}

/// Wrapper that adds a monotonically increasing sequence number to every
/// emitted event.  The `#[serde(flatten)]` ensures `seq` appears at the top
/// level alongside `type` and the event's own fields, so the frontend can
/// read it without changing the existing event dispatch structure.
///
/// Sequence numbers let the frontend:
/// - deduplicate events delivered more than once,
/// - detect gaps (events emitted but not received),
/// - order out-of-sequence deliveries.
#[derive(Debug, Clone, Serialize)]
pub struct SequencedChatEvent {
    pub seq: u64,
    #[serde(flatten)]
    pub event: ChatEvent,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kb_used_serializes_numbered_snapshot_with_camel_case_fields() {
        let event = SequencedChatEvent {
            seq: 2,
            event: ChatEvent::KbUsed {
                request_id: "req".into(),
                count: 1,
                stage: KnowledgeEvidenceStage::Prepared,
                titles: vec!["手册".into()],
                evidence: vec![KnowledgeEvidence {
                    index: 1,
                    document_id: "doc".into(),
                    chunk_index: 3,
                    title: "手册".into(),
                    snippet: "实际注入".into(),
                    truncated: false,
                    source_type: Some("url".into()),
                    source_ref: Some("https://example.test".into()),
                }],
            },
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["type"], "kb_used");
        assert_eq!(value["stage"], "prepared");
        assert_eq!(value["seq"], 2);
        assert_eq!(value["requestId"], "req");
        assert_eq!(value["evidence"][0]["documentId"], "doc");
        assert_eq!(value["evidence"][0]["chunkIndex"], 3);
        assert_eq!(value["evidence"][0]["snippet"], "实际注入");
        assert_eq!(value["evidence"][0]["sourceRef"], "https://example.test");
    }
}
