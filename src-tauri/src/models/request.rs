use serde::Deserialize;

/// Default for optional booleans that should be `true` when absent.
fn default_true() -> bool {
    true
}

fn default_thinking_effort() -> String {
    "medium".to_string()
}

/// One chat message coming from the frontend.
///
/// `images` is an optional list of base64 data URLs (e.g.
/// `data:image/png;base64,iVBOR...`).  When present and the target model
/// supports vision, the message is sent as a multipart content array
/// (OpenAI vision format).
#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub images: Vec<String>,
}

/// Payload of the `chat_send` command (v0.2): provider + model selection,
/// plus the message history. The API key is resolved from the system
/// credential store on the Rust side and never crosses this boundary.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendRequest {
    pub provider_id: String,
    pub model_key: String,
    pub messages: Vec<ChatMessage>,
    /// Optional system prompt prepended to the messages array. When `None`
    /// or empty, no system message is sent (the provider's default applies).
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// When `true`, the backend performs a DuckDuckGo web search using the
    /// last user message as the query, and injects the results into the
    /// system prompt before sending the request to the LLM.
    #[serde(default)]
    pub web_search: bool,
    /// When `true`, the agent loop is active: the request carries the tool
    /// registry, and `tool_calls` in the stream are executed and fed back
    /// to the model until it answers without calling a tool.
    /// When `true`, the agent loop is active: the request carries the tool
    /// registry, and `tool_calls` in the stream are executed and fed back
    /// to the model until it answers without calling a tool.
    #[serde(default)]
    pub enable_tools: bool,
    /// When `false`, the backend asks the model not to return a thinking
    /// trace and drops any reasoning deltas it still receives.
    #[serde(default = "default_true")]
    pub enable_thinking: bool,
    /// Requested reasoning depth: `low`, `medium`, `high`, or `max`.
    #[serde(default = "default_thinking_effort")]
    pub thinking_effort: String,
    /// Frontend-generated request ID. When present, the backend uses this ID
    /// directly instead of generating its own, eliminating the race where
    /// early stream events arrive before the frontend has registered the ID.
    #[serde(default)]
    pub request_id: Option<String>,
    /// Conversation id when history recording is on.  Used for rolling
    /// conversation summaries (v5): the summary is loaded before the request
    /// and regenerated after it finishes.
    #[serde(default)]
    pub conversation_id: Option<String>,
}

/// Payload for the `describe_image` command: send one image to a vision
/// model and get back a text description (non-streaming).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DescribeImageRequest {
    pub provider_id: String,
    pub model_key: String,
    pub image_data_url: String,
    pub prompt: String,
}
