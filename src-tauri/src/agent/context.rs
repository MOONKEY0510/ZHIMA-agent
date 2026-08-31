//! Context budgeting for chat requests.
//!
//! The frontend used to truncate context to a fixed 40-message window, which
//! could either blow past a model's window (large files, images, tool
//! results) or silently drop recent turns.  This module computes a safe,
//! conservative estimate of the request size and, when it exceeds the
//! budget, drops whole older turns (keeping the current user request and the
//! most recent complete rounds) instead of mid-message byte truncation.

use crate::models::request::ChatMessage;

/// Conservative default: tokens ≈ bytes / 2.  For Chinese (≈3 bytes/token)
/// this over-estimates by ~50%, which is the safe direction; for English it
/// is roughly correct.  Callers that know a model's real tokenizer can
/// override the budget, but never trust an under-estimate.
pub fn estimate_tokens(text: &str) -> usize {
    text.len() / 2 + 1
}

/// A context budget for one request.
#[derive(Debug, Clone, Copy)]
pub struct ContextBudget {
    /// Maximum input tokens (system + messages + tools + search context).
    pub max_input_tokens: usize,
    /// Maximum size of a single message (defence against huge tool results).
    pub max_message_bytes: usize,
}

impl ContextBudget {
    /// Reasonable default: 32k token input budget with 8 MiB max message.
    pub fn conservative() -> Self {
        Self {
            max_input_tokens: 32_000,
            max_message_bytes: 8 * 1024 * 1024,
        }
    }

    /// A budget sized to a known model context window, reserving 25% for
    /// output and overhead.  Used once per-model context metadata lands.
    #[allow(dead_code)]
    pub fn for_context_window(context_window_tokens: usize) -> Self {
        let max_input = (context_window_tokens.saturating_mul(3)) / 4;
        Self {
            max_input_tokens: max_input.max(4_000),
            max_message_bytes: 8 * 1024 * 1024,
        }
    }

    /// Total estimated tokens of the system prompt plus messages.
    pub fn total_tokens(&self, system_prompt: Option<&str>, messages: &[ChatMessage]) -> usize {
        let sys = system_prompt.map(estimate_tokens).unwrap_or(0);
        let msgs: usize = messages
            .iter()
            .map(|m| {
                estimate_tokens(&m.content)
                    + m.images.iter().map(|img| img.len() / 2 + 1).sum::<usize>()
            })
            .sum();
        sys + msgs
    }

    /// True when any single message (including image payloads) exceeds the
    /// per-message cap.
    pub fn has_oversized_message(&self, messages: &[ChatMessage]) -> bool {
        messages.iter().any(|m| {
            m.content.len() > self.max_message_bytes
                || m.images
                    .iter()
                    .any(|img| img.len() > self.max_message_bytes)
        })
    }
}

/// Result of fitting messages into a budget.
#[derive(Debug)]
pub struct ContextFit {
    pub messages: Vec<ChatMessage>,
    /// Whether any older turns were dropped or messages oversized.
    /// Consumed by the UI to show "上下文已被压缩" hints in a later phase.
    #[allow(dead_code)]
    pub truncated: bool,
    /// If `oversized_message` is set, the request should not be sent as-is.
    pub oversized_message: bool,
}

/// Fit a message list into the budget.
///
/// Policy:
/// - the last message (current user request) is always kept in full;
/// - whole turns are dropped oldest-first (user + assistant pairs);
/// - if a single message is oversized on its own, we keep it but flag it
///   (the caller decides whether to reject or shrink it);
/// - never truncate in the middle of a message here — that is the tool
///   result limiter's job.
pub fn fit_context(
    messages: &[ChatMessage],
    system_prompt: Option<&str>,
    budget: &ContextBudget,
) -> ContextFit {
    if messages.is_empty() {
        return ContextFit {
            messages: Vec::new(),
            truncated: false,
            oversized_message: false,
        };
    }

    let oversized_message = budget.has_oversized_message(messages);

    let mut fitted: Vec<ChatMessage> = messages.to_vec();
    let mut truncated = false;

    loop {
        let total = budget.total_tokens(system_prompt, &fitted);
        if total <= budget.max_input_tokens {
            break;
        }
        // Drop the oldest complete turn (two messages), but never remove
        // the final (current) user message.
        if fitted.len() >= 3 {
            fitted.remove(0);
            fitted.remove(0);
            truncated = true;
        } else if fitted.len() == 2 {
            // Drop only the oldest message if it is not the last one.
            fitted.remove(0);
            truncated = true;
        } else {
            // Only the current user message remains — cannot drop it.
            break;
        }
    }

    ContextFit {
        messages: fitted,
        truncated,
        oversized_message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.into(),
            content: content.into(),
            images: vec![],
        }
    }

    #[test]
    fn estimate_is_conservative() {
        // Chinese: 1 char ≈ 3 bytes → bytes/2 over-estimates (safe).
        let zh = "你好世界".repeat(100);
        assert!(estimate_tokens(&zh) >= zh.chars().count());
        assert!(estimate_tokens("hello world") >= 2);
    }

    #[test]
    fn small_conversation_passes_through() {
        let msgs = vec![
            msg("user", "hi"),
            msg("assistant", "hello"),
            msg("user", "how are you"),
        ];
        let fit = fit_context(&msgs, None, &ContextBudget::conservative());
        assert!(!fit.truncated);
        assert_eq!(fit.messages.len(), 3);
    }

    #[test]
    fn oversize_drops_oldest_turns_keeps_last_user() {
        let mut msgs: Vec<ChatMessage> = Vec::new();
        for i in 0..50 {
            msgs.push(msg(
                "user",
                &format!("long message number {i} {}", "x".repeat(2000)),
            ));
            msgs.push(msg(
                "assistant",
                &format!("long answer {i} {}", "y".repeat(2000)),
            ));
        }
        let budget = ContextBudget {
            max_input_tokens: 2_000,
            max_message_bytes: 8 * 1024 * 1024,
        };
        let fit = fit_context(&msgs, None, &budget);
        assert!(fit.truncated);
        assert!(fit.messages.len() < msgs.len());
        // The last message must be the original current user request.
        assert_eq!(
            fit.messages.last().unwrap().content,
            msgs.last().unwrap().content
        );
    }

    #[test]
    fn oversized_message_is_flagged() {
        let big = "x".repeat(10 * 1024 * 1024);
        let msgs = vec![msg("user", &big)];
        let fit = fit_context(&msgs, None, &ContextBudget::conservative());
        assert!(fit.oversized_message);
        assert_eq!(fit.messages.len(), 1);
    }
}
