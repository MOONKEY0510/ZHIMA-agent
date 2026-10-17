//! Document text extraction (P1-8).
//!
//! Supports `.docx` / `.pptx` / `.xlsx` / `.pdf` plus plain text (UTF-8 with a
//! GBK fallback).  Office formats are ZIP containers, so the work is: pull the
//! relevant XML parts out of the archive and collect their text nodes — no
//! heavyweight document crates needed, which keeps the installer small.
//!
//! Everything here is a pure function over bytes so it can be unit-tested
//! without touching the filesystem (the tests build minimal archives with the
//! same `zip` crate).

use std::io::Read;
use std::sync::OnceLock;

use regex::Regex;
use zip::ZipArchive;

/// Upper bound on a document we are willing to open.
pub const MAX_DOCUMENT_BYTES: u64 = 20 * 1024 * 1024;
/// Characters kept from one document (the agent tool caps at the same size).
pub const MAX_TEXT_CHARS: usize = 100_000;
/// Per-part decompression ceiling, in addition to the per-document budget.
/// Office extraction fails explicitly on a budget violation: returning a prefix
/// here would make callers report an incorrect total_chars / truncated value.
const MAX_ZIP_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
/// How many slides / worksheets one document may contribute.
const MAX_ARCHIVE_ENTRIES: usize = 256;

/// Which file extensions can be parsed.
pub fn is_supported(name: &str) -> bool {
    matches!(
        extension(name).as_str(),
        "docx"
            | "pptx"
            | "xlsx"
            | "xlsm"
            | "pdf"
            | "txt"
            | "md"
            | "markdown"
            | "csv"
            | "json"
            | "log"
            | "rtf"
    )
}

/// Lower-cased file extension without the dot.
pub fn extension(name: &str) -> String {
    std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// Extract text from `bytes`, dispatching on the file name's extension.
pub fn extract(name: &str, bytes: &[u8]) -> Result<String, String> {
    match extension(name).as_str() {
        "docx" => parse_docx(bytes),
        "pptx" => parse_pptx(bytes),
        "xlsx" | "xlsm" => parse_xlsx(bytes),
        "pdf" => {
            pdf_extract::extract_text_from_mem(bytes).map_err(|e| format!("PDF 文本提取失败：{e}"))
        }
        _ => parse_plain_text(bytes),
    }
}

/// Crude HTML → plain text, used when a page is ingested into the knowledge
/// base (the web-fetch tool hands the raw markup to the model, but a chunk
/// store should not carry tags).  Script/style bodies are dropped, tags are
/// removed, entities decoded, and blank lines collapsed.
pub fn html_to_text(html: &str) -> String {
    static DROP: OnceLock<Regex> = OnceLock::new();
    static BLOCK: OnceLock<Regex> = OnceLock::new();
    static TAGS: OnceLock<Regex> = OnceLock::new();

    // The regex crate has no backreferences, so the closing tag is matched
    // generically — good enough for text extraction.
    let drop_re = DROP.get_or_init(|| {
        Regex::new(r"(?is)<(script|style|head|noscript)\b[^>]*>.*?</[a-z]+>").expect("drop regex")
    });
    let block_re = BLOCK.get_or_init(|| {
        Regex::new(r"(?i)</(p|div|li|tr|h[1-6]|section|article|br)>").expect("block regex")
    });
    let tag_re = TAGS.get_or_init(|| Regex::new(r"(?s)<[^>]*>").expect("tag regex"));

    let stripped = drop_re.replace_all(html, " ");
    let with_breaks = block_re.replace_all(&stripped, "\n");
    let without_tags = tag_re.replace_all(&with_breaks, " ");
    let decoded = unescape_xml(&without_tags);

    let mut out = String::with_capacity(decoded.len());
    for line in decoded.lines() {
        let trimmed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if trimmed.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&trimmed);
    }
    out
}

/// Truncate to `max` characters on a char boundary, reporting whether the
/// text was cut.
pub fn truncate_chars(text: &str, max: usize) -> (String, bool) {
    if text.chars().count() <= max {
        return (text.to_string(), false);
    }
    let cut: String = text.chars().take(max).collect();
    (cut, true)
}

/* ---------------- office formats (zip + XML) ---------------- */

/// Every XML read (including optional metadata) spends the same byte budget.
/// Only FileNotFound is optional; corrupt or oversized entries must not vanish.
fn zip_text(
    archive: &mut ZipArchive<std::io::Cursor<&[u8]>>,
    entry: &str,
    budget: &mut OfficeBudget,
) -> Result<Option<String>, String> {
    let file = match archive.by_name(entry) {
        Ok(file) => file,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(format!("Office ZIP 项读取失败：{entry}：{e}")),
    };
    let remaining = budget.limits.total_bytes - budget.bytes;
    if file.size() > budget.limits.entry_bytes {
        return Err("Office ZIP 单项解压字节超出预算".into());
    }
    if file.size() > remaining {
        return Err("Office ZIP 累计解压字节超出预算".into());
    }
    let cap = remaining.min(budget.limits.entry_bytes);
    // One probe byte distinguishes an exact fit from a lying size header.
    let mut raw = Vec::new();
    file.take(cap.saturating_add(1))
        .read_to_end(&mut raw)
        .map_err(|e| format!("Office ZIP 项读取失败：{entry}：{e}"))?;
    if raw.len() as u64 > cap {
        return Err("Office ZIP 单项或累计解压字节超出预算".into());
    }
    budget.bytes += raw.len() as u64;
    Ok(Some(match String::from_utf8(raw) {
        Ok(text) => text,
        Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
    }))
}

/// Entry names inside the archive, filtered by a prefix and sorted naturally
/// (`slide2` before `slide10`).
fn sorted_entries(
    archive: &ZipArchive<std::io::Cursor<&[u8]>>,
    prefix: &str,
    limit: usize,
) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    for name in archive
        .file_names()
        .filter(|n| n.starts_with(prefix) && n.ends_with(".xml"))
    {
        if names.len() == limit {
            return Err("Office 工作表或幻灯片数量超出预算".into());
        }
        names.push(name.to_string());
    }
    names.sort_by_key(|name| numeric_index(name));
    Ok(names)
}

fn numeric_index(name: &str) -> u64 {
    name.bytes()
        .filter(u8::is_ascii_digit)
        .try_fold(0u64, |n, digit| {
            n.checked_mul(10)?.checked_add(u64::from(digit - b'0'))
        })
        .unwrap_or(0)
}

fn archive(bytes: &[u8]) -> Result<ZipArchive<std::io::Cursor<&[u8]>>, String> {
    ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|_| "无法读取 Office 文件（可能已损坏或不是 .docx/.pptx/.xlsx）".to_string())
}

/// Collect the text of every paragraph: paragraph tags become line breaks,
/// text-run tags carry the characters.
fn xml_paragraphs(
    xml: &str,
    paragraph: &str,
    text_tag: &str,
    out: &mut LimitedText,
) -> Result<(), String> {
    let para_re = Regex::new(&format!(r"(?s)<{paragraph}[ >].*?</{paragraph}>"))
        .expect("invalid paragraph regex");
    let text_re = Regex::new(&format!(r"(?s)<{text_tag}(?:\s[^>]*)?>(.*?)</{text_tag}>"))
        .expect("invalid text regex");
    for para in para_re.find_iter(xml) {
        let mut line = LimitedText::new(out.remaining(), out.label);
        let mut pending = String::new();
        let mut pending_chars = 0usize;
        for cap in text_re.captures_iter(para.as_str()) {
            decode_xml(cap.get(1).unwrap().as_str(), |ch| {
                if ch.is_whitespace() {
                    if !line.text.is_empty() {
                        // Retain only whitespace that could still fit. Trailing
                        // whitespace is discarded without ever allocating it all.
                        pending_chars = pending_chars.saturating_add(1);
                        if pending_chars <= line.remaining() {
                            pending.push(ch);
                        }
                    }
                    return Ok(());
                }
                if pending_chars > line.remaining() {
                    return Err(line.error());
                }
                line.push(&pending)?;
                pending.clear();
                pending_chars = 0;
                line.push_char(ch)
            })?;
        }
        if !line.text.is_empty() {
            if !out.text.is_empty() {
                out.push("\n")?;
            }
            out.push(&line.text)?;
        }
    }
    Ok(())
}

/// Decode the XML entities that appear in document text.
fn unescape_xml(input: &str) -> String {
    let mut out = input
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&");

    // Numeric character references (&#x4E2D; / &#20013;).
    static NUMERIC: OnceLock<Regex> = OnceLock::new();
    let re = NUMERIC.get_or_init(|| Regex::new(r"&#(x?[0-9A-Fa-f]+);").expect("numeric entity"));
    if re.is_match(&out) {
        let mut decoded = String::with_capacity(out.len());
        let mut last = 0;
        for cap in re.captures_iter(&out) {
            let whole = cap.get(0).expect("whole match");
            let value = cap.get(1).expect("entity body").as_str();
            let code = if let Some(hex) = value.strip_prefix('x') {
                u32::from_str_radix(hex, 16).ok()
            } else {
                value.parse::<u32>().ok()
            };
            decoded.push_str(&out[last..whole.start()]);
            match code.and_then(char::from_u32) {
                Some(ch) => decoded.push(ch),
                None => decoded.push_str(whole.as_str()),
            }
            last = whole.end();
        }
        decoded.push_str(&out[last..]);
        out = decoded;
    }
    out
}

// Injectable limits also let the regression tests use tiny, harmless archives.
#[derive(Clone, Copy)]
struct OfficeLimits {
    output_chars: usize,
    entry_bytes: u64,
    total_bytes: u64,
    shared_chars: usize,
    shared_items: usize,
    entries: usize,
}

impl Default for OfficeLimits {
    fn default() -> Self {
        Self {
            output_chars: MAX_TEXT_CHARS,
            entry_bytes: MAX_ZIP_ENTRY_BYTES,
            total_bytes: 128 * 1024 * 1024,
            shared_chars: 1_000_000,
            shared_items: 100_000,
            entries: MAX_ARCHIVE_ENTRIES,
        }
    }
}

struct OfficeBudget {
    limits: OfficeLimits,
    bytes: u64,
}

/// Bounded storage, measured in Unicode scalar values, not UTF-8 bytes.
struct LimitedText {
    text: String,
    chars: usize,
    limit: usize,
    label: &'static str,
}

impl LimitedText {
    fn new(limit: usize, label: &'static str) -> Self {
        Self {
            text: String::new(),
            chars: 0,
            limit,
            label,
        }
    }
    fn remaining(&self) -> usize {
        self.limit - self.chars
    }
    fn error(&self) -> String {
        format!("Office {}超出预算（上限 {}）", self.label, self.limit)
    }
    fn push(&mut self, text: &str) -> Result<(), String> {
        let count = text
            .chars()
            .take(self.remaining().saturating_add(1))
            .count();
        if count > self.remaining() {
            return Err(self.error());
        }
        self.text.push_str(text);
        self.chars += count;
        Ok(())
    }
    fn push_char(&mut self, ch: char) -> Result<(), String> {
        if self.remaining() == 0 {
            return Err(self.error());
        }
        self.text.push(ch);
        self.chars += 1;
        Ok(())
    }
    fn decoded(&mut self, text: &str) -> Result<(), String> {
        decode_xml(text, |ch| self.push_char(ch))
    }
}

/// Match entities without allocating decoded copies of whole XML text runs.
/// Preserve the old replacement order, including &amp;#65; -> A, while
/// &amp;lt; remains &lt; (named entities are not recursively decoded).
fn decode_xml(input: &str, mut emit: impl FnMut(char) -> Result<(), String>) -> Result<(), String> {
    static ENTITY: OnceLock<Regex> = OnceLock::new();
    let re = ENTITY.get_or_init(|| {
        Regex::new(r"&(?:lt;|gt;|quot;|apos;|amp;(?:#x?[0-9A-Fa-f]+;)?|#x?[0-9A-Fa-f]+;)")
            .expect("entity regex")
    });
    let mut last = 0;
    for token in re.find_iter(input) {
        for ch in input[last..token.start()].chars() {
            emit(ch)?;
        }
        let raw = token.as_str();
        let named = match raw {
            "&lt;" => Some('<'),
            "&gt;" => Some('>'),
            "&quot;" => Some('"'),
            "&apos;" => Some('\''),
            "&amp;" => Some('&'),
            _ => None,
        };
        if let Some(ch) = named {
            emit(ch)?;
        } else {
            let numeric = raw.strip_prefix("&amp;").unwrap_or(&raw[1..]);
            let value = &numeric[1..numeric.len() - 1];
            let code = if let Some(hex) = value.strip_prefix('x') {
                u32::from_str_radix(hex, 16).ok()
            } else {
                value.parse::<u32>().ok()
            };
            if let Some(ch) = code.and_then(char::from_u32) {
                emit(ch)?;
            } else {
                emit('&')?;
                for ch in numeric.chars() {
                    emit(ch)?;
                }
            }
        }
        last = token.end();
    }
    for ch in input[last..].chars() {
        emit(ch)?;
    }
    Ok(())
}

fn parse_office_with_limits(
    kind: &str,
    bytes: &[u8],
    limits: OfficeLimits,
) -> Result<String, String> {
    let mut zip = archive(bytes)?;
    let mut budget = OfficeBudget { limits, bytes: 0 };
    let mut out = LimitedText::new(limits.output_chars, "输出字符");
    match kind {
        "docx" => {
            let document =
                zip_text(&mut zip, "word/document.xml", &mut budget)?.ok_or("文档缺少正文内容")?;
            xml_paragraphs(&document, "w:p", "w:t", &mut out)?;
        }
        "pptx" => extract_slides(&mut zip, &mut budget, &mut out)?,
        _ => extract_sheets(&mut zip, &mut budget, &mut out)?,
    }
    Ok(out.text)
}

fn parse_docx(bytes: &[u8]) -> Result<String, String> {
    parse_office_with_limits("docx", bytes, OfficeLimits::default())
}

fn parse_pptx(bytes: &[u8]) -> Result<String, String> {
    parse_office_with_limits("pptx", bytes, OfficeLimits::default())
}

fn extract_slides(
    zip: &mut ZipArchive<std::io::Cursor<&[u8]>>,
    budget: &mut OfficeBudget,
    out: &mut LimitedText,
) -> Result<(), String> {
    let slides = sorted_entries(zip, "ppt/slides/slide", budget.limits.entries)?;
    for (index, name) in slides.iter().enumerate() {
        let xml = zip_text(zip, name, budget)?.ok_or("幻灯片内容缺失")?;
        let mut body = LimitedText::new(out.remaining(), out.label);
        xml_paragraphs(&xml, "a:p", "a:t", &mut body)?;
        if body.text.is_empty() {
            continue;
        }
        if !out.text.is_empty() {
            out.push("\n\n")?;
        }
        out.push(&format!("## 幻灯片 {}\n", index + 1))?;
        out.push(&body.text)?;
    }
    Ok(())
}

/// Shared strings table of an xlsx workbook (cell text lives here).
fn parse_shared_strings(xml: &str, limits: OfficeLimits) -> Result<Vec<String>, String> {
    static SI: OnceLock<Regex> = OnceLock::new();
    static T: OnceLock<Regex> = OnceLock::new();
    let si_re = SI.get_or_init(|| Regex::new(r"(?s)<si>(.*?)</si>").expect("si regex"));
    let t_re = T.get_or_init(|| Regex::new(r"(?s)<t(?:\s[^>]*)?>(.*?)</t>").expect("t regex"));

    let mut shared = Vec::new();
    let mut remaining = limits.shared_chars;
    for cap in si_re.captures_iter(xml) {
        if shared.len() == limits.shared_items {
            return Err("Office 共享字符串数量超出预算".into());
        }
        let inner = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let mut text = LimitedText::new(remaining, "共享字符串字符");
        for t in t_re.captures_iter(inner) {
            text.decoded(t.get(1).unwrap().as_str())?;
        }
        remaining -= text.chars;
        shared.push(text.text);
    }
    Ok(shared)
}

/// One worksheet: cells joined by tab, rows by newline.
fn parse_sheet(xml: &str, shared: &[String], out: &mut LimitedText) -> Result<(), String> {
    static ROW: OnceLock<Regex> = OnceLock::new();
    static CELL: OnceLock<Regex> = OnceLock::new();
    let row_re = ROW.get_or_init(|| Regex::new(r"(?s)<row[^>]*>(.*?)</row>").expect("row regex"));
    let cell_re = CELL.get_or_init(|| Regex::new(r"(?s)<c([^>]*)>(.*?)</c>").expect("cell regex"));

    for row in row_re.captures_iter(xml) {
        let body = row.get(1).map(|m| m.as_str()).unwrap_or("");
        let mut row_started = false;
        let mut pending_tabs = 0usize;
        for cell in cell_re.captures_iter(body) {
            let attrs = cell.get(1).map(|m| m.as_str()).unwrap_or("");
            let inner = cell.get(2).map(|m| m.as_str()).unwrap_or("");
            let (value, encoded) = cell_value(attrs, inner, shared);
            if value.is_empty() {
                // No per-cell allocation, even for millions of empty cells.
                pending_tabs = pending_tabs.saturating_add(1);
                continue;
            }
            if !row_started && !out.text.is_empty() {
                out.push("\n")?;
            }
            if pending_tabs > out.remaining() {
                return Err(out.error());
            }
            for _ in 0..pending_tabs {
                out.push_char('\t')?;
            }
            if encoded {
                out.decoded(value)?;
            } else {
                out.push(value)?;
            }
            row_started = true;
            pending_tabs = 1;
        }
        // Discard pending tabs (trailing empty cells), just like the old join.
    }
    Ok(())
}

/// Resolve one cell: shared-string index, inline string, or literal value.
fn cell_value<'a>(attrs: &str, inner: &'a str, shared: &'a [String]) -> (&'a str, bool) {
    static TYPE: OnceLock<Regex> = OnceLock::new();
    static VALUE: OnceLock<Regex> = OnceLock::new();
    static TEXT: OnceLock<Regex> = OnceLock::new();
    let type_re = TYPE.get_or_init(|| Regex::new(r#"t="([^"]+)""#).expect("cell type regex"));
    let value_re = VALUE.get_or_init(|| Regex::new(r"(?s)<v>(.*?)</v>").expect("value regex"));
    let text_re =
        TEXT.get_or_init(|| Regex::new(r"(?s)<t(?:\s[^>]*)?>(.*?)</t>").expect("text regex"));

    let kind = type_re
        .captures(attrs)
        .and_then(|c| c.get(1).map(|m| m.as_str()))
        .unwrap_or_default();
    if kind == "s" {
        // Borrow cached text; each reference still spends the output budget.
        let value = value_re
            .captures(inner)
            .and_then(|c| c.get(1))
            .and_then(|m| m.as_str().trim().parse::<usize>().ok())
            .and_then(|index| shared.get(index))
            .map(String::as_str)
            .unwrap_or_default();
        return (value, false);
    }
    let value = if kind == "inlineStr" {
        text_re
            .captures(inner)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str())
    } else {
        value_re
            .captures(inner)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim())
    };
    (value.unwrap_or_default(), true)
}

/// Map `rId` → sheet name from `xl/workbook.xml` + its relationship file, so
/// sheets can be labelled with the name the user sees.
fn sheet_names(
    zip: &mut ZipArchive<std::io::Cursor<&[u8]>>,
    budget: &mut OfficeBudget,
) -> Result<Vec<String>, String> {
    let Some(workbook) = zip_text(zip, "xl/workbook.xml", budget)? else {
        return Ok(Vec::new());
    };
    let Some(rels) = zip_text(zip, "xl/_rels/workbook.xml.rels", budget)? else {
        return Ok(Vec::new());
    };

    static SHEET: OnceLock<Regex> = OnceLock::new();
    static REL: OnceLock<Regex> = OnceLock::new();
    let sheet_re = SHEET.get_or_init(|| {
        Regex::new(r#"<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]*)""#).expect("sheet regex")
    });
    let rel_re = REL.get_or_init(|| {
        Regex::new(r#"<Relationship[^>]*Id="([^"]*)"[^>]*Target="([^"]*)""#).expect("rel regex")
    });

    let mut targets: Vec<(&str, String)> = Vec::new(); // (rId, sheetN)
    let mut metadata_remaining = budget.limits.shared_chars;
    for cap in rel_re.captures_iter(&rels) {
        if targets.len() == budget.limits.entries {
            return Err("Office 工作簿关系数量超出预算".into());
        }
        let id = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let target = cap.get(2).map(|m| m.as_str()).unwrap_or("");
        let mut digits = LimitedText::new(metadata_remaining, "工作簿元数据字符");
        for ch in target.chars().filter(char::is_ascii_digit) {
            digits.push_char(ch)?;
        }
        metadata_remaining -= digits.chars;
        targets.push((id, digits.text));
    }

    let mut names: Vec<String> = Vec::new();
    for cap in sheet_re.captures_iter(&workbook) {
        if names.len() == budget.limits.entries {
            return Err("Office 工作表名称数量超出预算".into());
        }
        let name = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let rid = cap.get(2).map(|m| m.as_str()).unwrap_or("");
        let index = targets
            .iter()
            .find(|(id, _)| *id == rid)
            .map(|(_, digits)| digits.as_str())
            .unwrap_or_default();
        let mut entry = LimitedText::new(metadata_remaining, "工作簿元数据字符");
        if !index.is_empty() {
            entry.push(index)?;
            entry.push_char('\0')?;
        }
        entry.push(name)?;
        metadata_remaining -= entry.chars;
        names.push(entry.text);
    }
    Ok(names)
}

fn parse_xlsx(bytes: &[u8]) -> Result<String, String> {
    parse_office_with_limits("xlsx", bytes, OfficeLimits::default())
}

fn extract_sheets(
    zip: &mut ZipArchive<std::io::Cursor<&[u8]>>,
    budget: &mut OfficeBudget,
    out: &mut LimitedText,
) -> Result<(), String> {
    let sheets = sorted_entries(zip, "xl/worksheets/sheet", budget.limits.entries)?;
    let shared = match zip_text(zip, "xl/sharedStrings.xml", budget)? {
        Some(xml) => parse_shared_strings(&xml, budget.limits)?,
        None => Vec::new(),
    };

    // sheet1.xml ↔ name mapping (index prefix keeps the natural order).
    let names = sheet_names(zip, budget)?;
    let name_for = |file: &str| -> String {
        let digits: String = file.chars().filter(|c| c.is_ascii_digit()).collect();
        names
            .iter()
            .find(|entry| {
                entry
                    .split('\0')
                    .next()
                    .is_some_and(|index| !index.is_empty() && index == digits)
            })
            .and_then(|entry| entry.split('\0').nth(1))
            .map(|name| name.to_string())
            .unwrap_or_else(|| format!("工作表 {digits}"))
    };

    for file in sheets {
        let xml = zip_text(zip, &file, budget)?.ok_or("工作表内容缺失")?;
        let mut body = LimitedText::new(out.remaining(), out.label);
        parse_sheet(&xml, &shared, &mut body)?;
        if body.text.trim().is_empty() {
            continue;
        }
        if !out.text.is_empty() {
            out.push("\n\n")?;
        }
        out.push("## ")?;
        out.push(&name_for(&file))?;
        out.push("\n")?;
        out.push(&body.text)?;
    }
    Ok(())
}

/* ---------------- plain text ---------------- */

/// Decode a text file: UTF-8 first, GBK when that fails (common for Chinese
/// CSV/TXT exported by Windows tools).
fn parse_plain_text(bytes: &[u8]) -> Result<String, String> {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok(text.replace("\r\n", "\n"));
    }
    let (decoded, _, had_errors) = encoding_rs::GBK.decode(bytes);
    if had_errors {
        // Last resort: lossy UTF-8 so the user still sees something.
        return Ok(String::from_utf8_lossy(bytes).replace("\r\n", "\n"));
    }
    Ok(decoded.replace("\r\n", "\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// Build a minimal Office archive from (name, xml) pairs.
    fn make_zip(files: &[(&str, &str)]) -> Vec<u8> {
        make_zip_with_method(files, zip::CompressionMethod::Stored)
    }

    fn make_zip_with_method(files: &[(&str, &str)], method: zip::CompressionMethod) -> Vec<u8> {
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            let options = SimpleFileOptions::default().compression_method(method);
            for (name, content) in files {
                writer.start_file(*name, options).unwrap();
                writer.write_all(content.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        buffer.into_inner()
    }

    fn assert_budget_error(kind: &str, files: &[(&str, &str)], limits: OfficeLimits, label: &str) {
        let result = parse_office_with_limits(kind, &make_zip(files), limits);
        assert!(
            matches!(&result, Err(error) if error.contains(label)),
            "{result:?}"
        );
    }

    #[test]
    fn budget_docx_output_is_checked_during_parsing() {
        assert_budget_error(
            "docx",
            &[("word/document.xml", "<w:p><w:t>甲乙丙丁</w:t></w:p>")],
            OfficeLimits {
                output_chars: 3,
                ..OfficeLimits::default()
            },
            "输出字符",
        );
    }

    #[test]
    fn budget_shared_references_and_sheets_share_output_limit() {
        let sheet = "<row><c t=\"s\"><v>0</v></c><c t=\"s\"><v>0</v></c></row>";
        assert_budget_error(
            "xlsx",
            &[
                (
                    "xl/sharedStrings.xml",
                    "<sst><si><t>甲乙丙丁</t></si></sst>",
                ),
                ("xl/worksheets/sheet1.xml", sheet),
                ("xl/worksheets/sheet2.xml", sheet),
            ],
            OfficeLimits {
                output_chars: 25,
                ..OfficeLimits::default()
            },
            "输出字符",
        );
    }

    #[test]
    fn budget_slides_share_output_limit() {
        let slide = "<a:p><a:t>甲乙丙丁</a:t></a:p>";
        assert_budget_error(
            "pptx",
            &[
                ("ppt/slides/slide1.xml", slide),
                ("ppt/slides/slide2.xml", slide),
            ],
            OfficeLimits {
                output_chars: 20,
                ..OfficeLimits::default()
            },
            "输出字符",
        );
    }

    #[test]
    fn budget_zip_parts_share_decompression_limit() {
        let slide = "<a:p><a:t>甲乙</a:t></a:p>";
        assert_budget_error(
            "pptx",
            &[
                ("ppt/slides/slide1.xml", slide),
                ("ppt/slides/slide2.xml", slide),
            ],
            OfficeLimits {
                total_bytes: slide.len() as u64,
                ..OfficeLimits::default()
            },
            "累计解压",
        );
    }

    #[test]
    fn budget_shared_cache_limits_empty_objects_and_characters() {
        assert_budget_error(
            "xlsx",
            &[(
                "xl/sharedStrings.xml",
                "<sst><si></si><si></si><si></si></sst>",
            )],
            OfficeLimits {
                shared_items: 2,
                ..OfficeLimits::default()
            },
            "共享字符串数量",
        );
        assert_budget_error(
            "xlsx",
            &[(
                "xl/sharedStrings.xml",
                "<sst><si><t>甲乙</t></si><si><t>丙丁</t></si></sst>",
            )],
            OfficeLimits {
                shared_chars: 3,
                ..OfficeLimits::default()
            },
            "共享字符串字符",
        );
    }

    #[test]
    fn output_exact_boundaries_include_titles_separators_and_unicode() {
        let doc = "<w:p><w:t> 甲&#x1F680; </w:t></w:p><w:p><w:t>乙</w:t></w:p>";
        let slide = "<a:p><a:t>甲</a:t></a:p>";
        let sheet = "<row><c><v>甲</v></c><c><v>乙</v></c></row><row><c><v>丙</v></c></row>";
        let cases = [
            ("docx", vec![("word/document.xml", doc)], "甲\u{1f680}\n乙"),
            (
                "pptx",
                vec![
                    ("ppt/slides/slide1.xml", slide),
                    ("ppt/slides/slide2.xml", slide),
                ],
                "## 幻灯片 1\n甲\n\n## 幻灯片 2\n甲",
            ),
            (
                "xlsx",
                vec![
                    ("xl/worksheets/sheet1.xml", sheet),
                    ("xl/worksheets/sheet2.xml", sheet),
                ],
                "## 工作表 1\n甲\t乙\n丙\n\n## 工作表 2\n甲\t乙\n丙",
            ),
        ];
        for (kind, files, expected) in cases {
            let limits = OfficeLimits {
                output_chars: expected.chars().count(),
                ..OfficeLimits::default()
            };
            assert_eq!(
                parse_office_with_limits(kind, &make_zip(&files), limits).unwrap(),
                expected
            );
            assert_budget_error(
                kind,
                &files,
                OfficeLimits {
                    output_chars: limits.output_chars - 1,
                    ..limits
                },
                "输出字符",
            );
        }
    }

    #[test]
    fn limited_text_never_appends_past_budget() {
        let mut text = LimitedText::new(3, "输出字符");
        text.push("甲").unwrap();
        assert!(text.push(&"乙".repeat(1000)).is_err());
        assert_eq!(text.text, "甲");
        assert!(text.decoded("&#x1F680;&#20013;&amp;").is_err());
        assert_eq!(text.text, "甲\u{1f680}中");
        assert_eq!(text.chars, 3);
    }

    #[test]
    fn streamed_entities_preserve_existing_decoding() {
        for input in [
            "&lt;&gt;&quot;&apos;&amp;中文",
            "&#20013;&#x1F680;&#xD800;&#999999999999999999999999;",
            "&amp;#65;&amp;#x4E2D;&amp;#xD800;&amp;lt;&amp;amp;",
            "&&bogus;&#X41;&#x;&#-1;&#abc;&#65;&amp;#abc;",
        ] {
            let mut text = LimitedText::new(1000, "输出字符");
            text.decoded(input).unwrap();
            assert_eq!(text.text, unescape_xml(input), "{input}");
        }
    }

    #[test]
    fn paragraph_trimming_does_not_store_discarded_whitespace() {
        let whitespace = " \t\u{3000}".repeat(1000);
        let doc = format!(
            "<w:p><w:t>{whitespace}甲{whitespace}</w:t></w:p><w:p><w:t>{whitespace}</w:t></w:p>"
        );
        let limits = OfficeLimits {
            output_chars: 1,
            ..OfficeLimits::default()
        };
        assert_eq!(
            parse_office_with_limits("docx", &make_zip(&[("word/document.xml", &doc)]), limits)
                .unwrap(),
            "甲"
        );
        let mut out = LimitedText::new(3, "输出字符");
        xml_paragraphs(
            "<w:p><w:t> 甲 </w:t><w:t>乙 </w:t></w:p>",
            "w:p",
            "w:t",
            &mut out,
        )
        .unwrap();
        assert_eq!(out.text, "甲 乙");
    }

    #[test]
    fn shared_references_borrow_cache_and_stop_within_one_row() {
        let shared = vec!["甲".repeat(128)];
        let (value, encoded) = cell_value("t=\"s\"", "<v>0</v>", &shared);
        assert_eq!(value.as_ptr(), shared[0].as_ptr());
        assert!(!encoded);
        let sheet = format!("<row>{}</row>", "<c t=\"s\"><v>0</v></c>".repeat(1000));
        let mut out = LimitedText::new(130, "输出字符");
        assert!(parse_sheet(&sheet, &shared, &mut out)
            .unwrap_err()
            .contains("输出字符"));
        assert!(out.chars <= 130);
    }

    #[test]
    fn empty_rows_and_cells_need_no_collections() {
        let empties = "<c></c>".repeat(1000);
        let sheet = format!(
            "<row>{empties}</row><row><c><v>甲</v></c>{empties}</row>{}",
            "<row></row>".repeat(1000)
        );
        let mut out = LimitedText::new(1, "输出字符");
        parse_sheet(&sheet, &[], &mut out).unwrap();
        assert_eq!(out.text, "甲");
        let mut out = LimitedText::new(8, "输出字符");
        assert!(parse_sheet(
            &format!("<row>{empties}<c><v>甲</v></c></row>"),
            &[],
            &mut out
        )
        .is_err());
        assert!(out.text.is_empty());
        let mut out = LimitedText::new(100, "输出字符");
        parse_sheet("<row><c></c><c><v>A</v></c><c></c><c><v>B</v></c><c></c></row><row><c></c></row><row><c><v>C</v></c></row>", &[], &mut out).unwrap();
        assert_eq!(out.text, "\tA\t\tB\nC");
    }

    #[test]
    fn shared_cache_exact_limits_and_rich_text() {
        let limits = OfficeLimits {
            shared_items: 2,
            shared_chars: 3,
            ..OfficeLimits::default()
        };
        let shared = parse_shared_strings(
            "<sst><si></si><si><r><t>甲</t></r><r><t>&amp;&#x1F680;</t></r></si></sst>",
            limits,
        )
        .unwrap();
        assert_eq!(shared, ["", "甲&\u{1f680}"]);
    }

    #[test]
    fn entry_count_limit_is_an_error_not_silent_truncation() {
        for (kind, prefix) in [
            ("pptx", "ppt/slides/slide"),
            ("xlsx", "xl/worksheets/sheet"),
        ] {
            let names = [format!("{prefix}1.xml"), format!("{prefix}2.xml")];
            assert_budget_error(
                kind,
                &[(names[0].as_str(), ""), (names[1].as_str(), "")],
                OfficeLimits {
                    entries: 1,
                    ..OfficeLimits::default()
                },
                "数量",
            );
        }
    }

    #[test]
    fn zip_exact_budget_and_optional_parts_spend_bytes() {
        let shared = "<sst><si><t>甲</t></si></sst>";
        let workbook = "<workbook/>";
        let rels = "<Relationships/>";
        let sheet = "<row><c t=\"s\"><v>0</v></c></row>";
        let files = [
            ("xl/sharedStrings.xml", shared),
            ("xl/workbook.xml", workbook),
            ("xl/_rels/workbook.xml.rels", rels),
            ("xl/worksheets/sheet1.xml", sheet),
        ];
        let total_bytes = files.iter().map(|(_, text)| text.len() as u64).sum();
        let limits = OfficeLimits {
            total_bytes,
            ..OfficeLimits::default()
        };
        assert_eq!(
            parse_office_with_limits("xlsx", &make_zip(&files), limits).unwrap(),
            "## 工作表 1\n甲"
        );
        assert_budget_error(
            "xlsx",
            &files,
            OfficeLimits {
                total_bytes: total_bytes - 1,
                ..limits
            },
            "累计解压",
        );
        assert_budget_error(
            "xlsx",
            &files,
            OfficeLimits {
                entry_bytes: 8,
                ..limits
            },
            "单项解压",
        );
        let doc = "<w:p><w:t>甲</w:t></w:p>";
        assert_eq!(
            parse_office_with_limits(
                "docx",
                &make_zip(&[("word/document.xml", doc)]),
                OfficeLimits {
                    entry_bytes: doc.len() as u64,
                    total_bytes: doc.len() as u64,
                    ..limits
                }
            )
            .unwrap(),
            "甲"
        );
    }

    #[test]
    fn metadata_objects_and_strings_are_bounded() {
        let workbook = "<sheet name=\"一\" r:id=\"r1\"/><sheet name=\"二\" r:id=\"r2\"/>";
        let rels = "<Relationship Id=\"r1\" Target=\"sheet1.xml\"/>";
        let files = [
            ("xl/workbook.xml", workbook),
            ("xl/_rels/workbook.xml.rels", rels),
        ];
        assert_budget_error(
            "xlsx",
            &files,
            OfficeLimits {
                entries: 1,
                ..OfficeLimits::default()
            },
            "名称数量",
        );
        assert_budget_error(
            "xlsx",
            &files,
            OfficeLimits {
                shared_chars: 2,
                ..OfficeLimits::default()
            },
            "元数据字符",
        );
        let rels = format!("{rels}{rels}");
        assert_budget_error(
            "xlsx",
            &[
                ("xl/workbook.xml", workbook),
                ("xl/_rels/workbook.xml.rels", &rels),
            ],
            OfficeLimits {
                entries: 1,
                ..OfficeLimits::default()
            },
            "关系数量",
        );
    }

    #[test]
    fn compressed_parts_enforce_cumulative_budget_and_probe_lying_sizes() {
        let content = format!("<a:p><a:t>{}</a:t></a:p>", "甲".repeat(512));
        let files = [
            ("ppt/slides/slide1.xml", content.as_str()),
            ("ppt/slides/slide2.xml", content.as_str()),
        ];
        let bytes = make_zip_with_method(&files, zip::CompressionMethod::Deflated);
        let limits = OfficeLimits {
            total_bytes: content.len() as u64,
            ..OfficeLimits::default()
        };
        assert!(parse_office_with_limits("pptx", &bytes, limits)
            .unwrap_err()
            .contains("累计解压"));

        // Tiny real decompression, not a bomb: lie about the uncompressed
        // size in both headers, then verify the capped read detects byte 33.
        let mut bytes = make_zip_with_method(&files[..1], zip::CompressionMethod::Deflated);
        let central = bytes.windows(4).position(|w| w == b"PK\x01\x02").unwrap();
        bytes[22..26].copy_from_slice(&1u32.to_le_bytes());
        bytes[central + 24..central + 28].copy_from_slice(&1u32.to_le_bytes());
        let mut zip = archive(&bytes).unwrap();
        let mut budget = OfficeBudget {
            limits: OfficeLimits {
                entry_bytes: 32,
                total_bytes: 32,
                ..limits
            },
            bytes: 0,
        };
        let error = zip_text(&mut zip, files[0].0, &mut budget).unwrap_err();
        assert!(error.contains("解压字节超出预算"), "{error}");
    }

    #[test]
    fn corrupt_optional_zip_entry_is_not_treated_as_missing() {
        let content = "<sst><si><t>unique-text</t></si></sst>";
        let mut bytes = make_zip(&[("xl/sharedStrings.xml", content)]);
        let start = bytes
            .windows(content.len())
            .position(|w| w == content.as_bytes())
            .unwrap();
        bytes[start] ^= 1; // Stored data no longer matches its CRC.
        assert!(extract("test.xlsx", &bytes)
            .unwrap_err()
            .contains("ZIP 项读取失败"));
    }

    #[test]
    fn docx_paragraphs_become_lines() {
        let doc = r#"<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
            <w:p><w:r><w:t>第一段</w:t></w:r></w:p>
            <w:p><w:r><w:t>第二</w:t></w:r><w:r><w:t>段</w:t></w:r></w:p>
            <w:p><w:pPr><w:jc w:val="center"/></w:pPr></w:p>
        </w:body></w:document>"#;
        let bytes = make_zip(&[("word/document.xml", doc)]);
        let text = extract("报告.docx", &bytes).unwrap();
        assert_eq!(text, "第一段\n第二段");
    }

    #[test]
    fn docx_entities_are_decoded() {
        let doc = r#"<w:document><w:p><w:r><w:t>A &amp; B &lt;tag&gt; &#20013;</w:t></w:r></w:p></w:document>"#;
        let bytes = make_zip(&[("word/document.xml", doc)]);
        assert_eq!(extract("a.docx", &bytes).unwrap(), "A & B <tag> 中");
    }

    #[test]
    fn pptx_slides_are_numbered_in_order() {
        let slide1 = r#"<p:sld><a:p><a:r><a:t>封面</a:t></a:r></a:p></p:sld>"#;
        let slide2 = r#"<p:sld><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:sld>"#;
        let slide10 = r#"<p:sld><a:p><a:r><a:t>第十页</a:t></a:r></a:p></p:sld>"#;
        let bytes = make_zip(&[
            ("ppt/slides/slide10.xml", slide10),
            ("ppt/slides/slide2.xml", slide2),
            ("ppt/slides/slide1.xml", slide1),
        ]);
        let text = extract("deck.pptx", &bytes).unwrap();
        assert_eq!(
            text,
            "## 幻灯片 1\n封面\n\n## 幻灯片 2\n第二页\n\n## 幻灯片 3\n第十页"
        );
    }

    #[test]
    fn xlsx_reads_shared_strings_and_numbers() {
        let shared = r#"<sst><si><t>姓名</t></si><si><t>芝麻助手</t></si></sst>"#;
        let sheet = r#"<worksheet><sheetData>
            <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
            <row r="2"><c r="A2"><v>42</v></c></row>
        </sheetData></worksheet>"#;
        let workbook = r#"<workbook><sheets><sheet name="数据表" sheetId="1" r:id="rId1"/></sheets></workbook>"#;
        let rels = r#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#;
        let bytes = make_zip(&[
            ("xl/workbook.xml", workbook),
            ("xl/_rels/workbook.xml.rels", rels),
            ("xl/sharedStrings.xml", shared),
            ("xl/worksheets/sheet1.xml", sheet),
        ]);
        let text = extract("表格.xlsx", &bytes).unwrap();
        assert_eq!(text, "## 数据表\n姓名\t芝麻助手\n42");
    }

    #[test]
    fn xlsx_inline_strings_work_without_shared_table() {
        let sheet = r#"<worksheet><sheetData>
            <row><c t="inlineStr"><is><t>内联文本</t></is></c></row>
        </sheetData></worksheet>"#;
        let bytes = make_zip(&[("xl/worksheets/sheet1.xml", sheet)]);
        let text = extract("t.xlsx", &bytes).unwrap();
        assert_eq!(text, "## 工作表 1\n内联文本");
    }

    #[test]
    fn plain_text_prefers_utf8_and_falls_back_to_gbk() {
        assert_eq!(
            parse_plain_text("你好\r\n世界".as_bytes()).unwrap(),
            "你好\n世界"
        );
        // "中文" encoded as GBK.
        let gbk = [0xD6u8, 0xD0, 0xCE, 0xC4];
        assert_eq!(parse_plain_text(&gbk).unwrap(), "中文");
    }

    #[test]
    fn corrupt_office_file_reports_readable_error() {
        let err = extract("broken.docx", b"not a zip").unwrap_err();
        assert!(err.contains("无法读取 Office 文件"));
    }

    #[test]
    fn truncate_chars_respects_char_boundaries() {
        let text = "甲乙丙丁";
        let (cut, truncated) = truncate_chars(text, 2);
        assert_eq!(cut, "甲乙");
        assert!(truncated);
        let (whole, truncated) = truncate_chars(text, 10);
        assert_eq!(whole, text);
        assert!(!truncated);
    }

    #[test]
    fn html_to_text_drops_markup_and_scripts() {
        let html = r#"<html><head><style>body{color:red}</style></head>
            <body><h1>标题</h1><p>第一段 &amp; 内容</p>
            <script>alert('x')</script>
            <ul><li>要点一</li><li>要点二</li></ul></body></html>"#;
        let text = html_to_text(html);
        assert!(text.contains("标题"));
        assert!(text.contains("第一段 & 内容"));
        assert!(text.contains("要点一"));
        assert!(!text.contains("alert"));
        assert!(!text.contains("color:red"));
        assert!(!text.contains('<'));
    }

    #[test]
    fn supported_extensions() {
        assert!(is_supported("a.docx"));
        assert!(is_supported("A.PPTX"));
        assert!(is_supported("表.xlsx"));
        assert!(is_supported("说明.md"));
        assert!(!is_supported("image.png"));
    }
}
