//! Incremental Server-Sent-Events parser.
//!
//! Requirements covered (see development plan §5.3):
//! - multiple SSE events inside a single network chunk;
//! - one SSE event split across several network chunks;
//! - blank lines and `:` comment/heartbeat lines are ignored;
//! - CRLF and LF line endings;
//! - `[DONE]` is handled by the caller on the emitted data payload;
//! - unparseable payloads never panic the application.

/// Upper bound for one SSE line. A broken or hostile endpoint that never
/// sends a newline would otherwise grow `buf` without bound.
const MAX_LINE_BYTES: usize = 1024 * 1024; // 1 MiB
/// Upper bound for the accumulated `data:` payload of a single event.
const MAX_EVENT_BYTES: usize = 8 * 1024 * 1024; // 8 MiB

/// Collects bytes from the network and emits complete SSE `data` payloads.
///
/// Once a limit is exceeded the parser refuses further input and reports it
/// via [`SseParser::overflowed`]; the caller turns that into a user-visible
/// error instead of letting the app consume unbounded memory.
#[derive(Default)]
pub struct SseParser {
    /// Bytes received but not yet terminated by a newline.
    buf: Vec<u8>,
    /// `data:` lines accumulated for the event currently being built.
    data_lines: Vec<String>,
    /// Bytes currently held by `data_lines`.
    data_bytes: usize,
    /// Set when a line or an event exceeded its limit.
    overflowed: bool,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether a limit was exceeded.  Checked by the caller after every push.
    pub fn overflowed(&self) -> bool {
        self.overflowed
    }

    /// Feed one network chunk; returns every event payload completed by it.
    ///
    /// Splitting on the raw `\n` byte is UTF-8 safe because continuation
    /// bytes can never equal `0x0A`, so a line boundary never cuts a
    /// multi-byte character. A character split mid-line stays in `buf`.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        if self.overflowed {
            return Vec::new();
        }
        self.buf.extend_from_slice(chunk);
        if self.buf.len() > MAX_LINE_BYTES && !self.buf.contains(&b'\n') {
            // A single line already exceeds the cap and has not ended yet.
            self.mark_overflowed();
            return Vec::new();
        }
        let mut events = Vec::new();

        while let Some(pos) = self.buf.iter().position(|b| *b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
            line.pop(); // drop '\n'
            if line.last() == Some(&b'\r') {
                line.pop(); // tolerate CRLF
            }
            if line.len() > MAX_LINE_BYTES {
                self.mark_overflowed();
                break;
            }
            self.process_line(&line, &mut events);
            if self.overflowed {
                break;
            }
        }

        events
    }

    /// Flush a trailing event when the stream ends without a final blank
    /// line (some providers close the connection right after the last data).
    pub fn finish(&mut self) -> Vec<String> {
        if self.overflowed {
            return Vec::new();
        }
        let mut events = Vec::new();

        if !self.buf.is_empty() {
            let line = std::mem::take(&mut self.buf);
            if line.len() > MAX_LINE_BYTES {
                self.mark_overflowed();
                return Vec::new();
            }
            let mut line = line;
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.process_line(&line, &mut events);
        }
        if !self.data_lines.is_empty() {
            events.push(self.data_lines.join("\n"));
            self.data_lines.clear();
            self.data_bytes = 0;
        }

        events
    }

    /// Drop everything held and refuse further input.
    fn mark_overflowed(&mut self) {
        self.overflowed = true;
        self.buf.clear();
        self.data_lines.clear();
        self.data_bytes = 0;
    }

    fn process_line(&mut self, line: &[u8], events: &mut Vec<String>) {
        if line.is_empty() {
            // Blank line → dispatch the pending event, if any.
            if !self.data_lines.is_empty() {
                events.push(self.data_lines.join("\n"));
            }
            self.data_lines.clear();
            self.data_bytes = 0;
            return;
        }

        // Comment / heartbeat lines keep the connection alive; ignore them.
        if line[0] == b':' {
            return;
        }

        let text = String::from_utf8_lossy(line);
        let (field, value) = match text.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (text.as_ref(), ""),
        };

        if field == "data" {
            if self.data_bytes + value.len() > MAX_EVENT_BYTES {
                self.mark_overflowed();
                return;
            }
            self.data_bytes += value.len();
            self.data_lines.push(value.to_string());
        }
        // `event:`, `id:`, `retry:` are not needed by the v0.1 adapter and
        // are intentionally ignored.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multiple_events_in_one_chunk() {
        let mut p = SseParser::new();
        let ev = p.push(b"data: alpha\n\ndata: beta\n\n");
        assert_eq!(ev, vec!["alpha", "beta"]);
    }

    #[test]
    fn event_split_across_chunks() {
        let mut p = SseParser::new();
        assert!(p.push(b"data: hel").is_empty());
        assert!(p.push(b"lo wor").is_empty());
        let ev = p.push(b"ld\n\n");
        assert_eq!(ev, vec!["hello world"]);
    }

    #[test]
    fn crlf_line_endings() {
        let mut p = SseParser::new();
        let ev = p.push(b"data: crlf\r\n\r\n");
        assert_eq!(ev, vec!["crlf"]);
    }

    #[test]
    fn heartbeats_and_comments_are_ignored() {
        let mut p = SseParser::new();
        let ev = p.push(b": keep-alive\n\n:ping\n\n\n\ndata: real\n\n");
        assert_eq!(ev, vec!["real"]);
    }

    #[test]
    fn multiple_data_lines_join_with_newline() {
        let mut p = SseParser::new();
        let ev = p.push(b"data: line1\ndata: line2\n\n");
        assert_eq!(ev, vec!["line1\nline2"]);
    }

    #[test]
    fn blank_lines_only_produce_nothing() {
        let mut p = SseParser::new();
        assert!(p.push(b"\n\n\n").is_empty());
        assert!(p.finish().is_empty());
    }

    #[test]
    fn a_runaway_line_is_rejected_instead_of_buffered() {
        let mut p = SseParser::new();
        let chunk = vec![b'a'; MAX_LINE_BYTES + 1];
        assert!(p.push(&chunk).is_empty());
        assert!(p.overflowed());
        // Further input is ignored and nothing panics.
        assert!(p.push(b"data: late\n\n").is_empty());
        assert!(p.finish().is_empty());
    }

    #[test]
    fn an_oversized_event_is_rejected() {
        let mut p = SseParser::new();
        let line = format!("data: {}\n", "x".repeat(MAX_EVENT_BYTES / 2));
        assert!(p.push(line.as_bytes()).is_empty());
        // The second half crosses the event cap before any blank line.
        assert!(p.push(line.as_bytes()).is_empty());
        assert!(p.overflowed());
    }

    #[test]
    fn finish_flushes_unterminated_event() {
        let mut p = SseParser::new();
        assert!(p.push(b"data: tail").is_empty());
        let ev = p.finish();
        assert_eq!(ev, vec!["tail"]);
    }

    #[test]
    fn done_sentinel_is_passed_through() {
        let mut p = SseParser::new();
        let ev = p.push(b"data: [DONE]\n\n");
        assert_eq!(ev, vec!["[DONE]"]);
    }

    #[test]
    fn utf8_split_mid_character_is_safe() {
        let mut p = SseParser::new();
        // "你" = E4 BD A0 — split the bytes across two chunks.
        assert!(p
            .push(&[b'd', b'a', b't', b'a', b':', b' ', 0xE4, 0xBD])
            .is_empty());
        let ev = p.push(&[0xA0, b'\n', b'\n']);
        assert_eq!(ev, vec!["你"]);
    }
}
