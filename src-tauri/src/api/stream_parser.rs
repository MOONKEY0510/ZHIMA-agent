//! Incremental Server-Sent-Events parser.
//!
//! Requirements covered (see development plan §5.3):
//! - multiple SSE events inside a single network chunk;
//! - one SSE event split across several network chunks;
//! - blank lines and `:` comment/heartbeat lines are ignored;
//! - CRLF and LF line endings;
//! - `[DONE]` is handled by the caller on the emitted data payload;
//! - unparseable payloads never panic the application.

/// Collects bytes from the network and emits complete SSE `data` payloads.
#[derive(Default)]
pub struct SseParser {
    /// Bytes received but not yet terminated by a newline.
    buf: Vec<u8>,
    /// `data:` lines accumulated for the event currently being built.
    data_lines: Vec<String>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one network chunk; returns every event payload completed by it.
    ///
    /// Splitting on the raw `\n` byte is UTF-8 safe because continuation
    /// bytes can never equal `0x0A`, so a line boundary never cuts a
    /// multi-byte character. A character split mid-line stays in `buf`.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut events = Vec::new();

        while let Some(pos) = self.buf.iter().position(|b| *b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
            line.pop(); // drop '\n'
            if line.last() == Some(&b'\r') {
                line.pop(); // tolerate CRLF
            }
            self.process_line(&line, &mut events);
        }

        events
    }

    /// Flush a trailing event when the stream ends without a final blank
    /// line (some providers close the connection right after the last data).
    pub fn finish(&mut self) -> Vec<String> {
        let mut events = Vec::new();

        if !self.buf.is_empty() {
            let mut line = std::mem::take(&mut self.buf);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.process_line(&line, &mut events);
        }
        if !self.data_lines.is_empty() {
            events.push(self.data_lines.join("\n"));
            self.data_lines.clear();
        }

        events
    }

    fn process_line(&mut self, line: &[u8], events: &mut Vec<String>) {
        if line.is_empty() {
            // Blank line → dispatch the pending event, if any.
            if !self.data_lines.is_empty() {
                events.push(self.data_lines.join("\n"));
            }
            self.data_lines.clear();
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
