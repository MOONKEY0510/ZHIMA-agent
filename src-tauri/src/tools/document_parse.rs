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
/// One XML part may not expand beyond this.  The archive itself is already
/// capped at 20 MiB compressed; a single entry is the realistic zip-bomb
/// vector, and document text is truncated far below this anyway.
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

/// Read one entry of a ZIP container as UTF-8 text.
///
/// The declared size is checked first and the read is capped again, because a
/// hostile archive can lie about the former.
fn zip_text(archive: &mut ZipArchive<std::io::Cursor<&[u8]>>, entry: &str) -> Option<String> {
    let file = archive.by_name(entry).ok()?;
    if file.size() > MAX_ZIP_ENTRY_BYTES {
        return None;
    }
    let mut raw = Vec::new();
    file.take(MAX_ZIP_ENTRY_BYTES).read_to_end(&mut raw).ok()?;
    Some(String::from_utf8_lossy(&raw).into_owned())
}

/// Entry names inside the archive, filtered by a prefix and sorted naturally
/// (`slide2` before `slide10`).
fn sorted_entries(archive: &ZipArchive<std::io::Cursor<&[u8]>>, prefix: &str) -> Vec<String> {
    let mut names: Vec<String> = archive
        .file_names()
        .filter(|n| n.starts_with(prefix) && n.ends_with(".xml"))
        .map(|n| n.to_string())
        .collect();
    names.sort_by_key(|n| {
        n.chars()
            .filter(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<u64>()
            .unwrap_or(0)
    });
    // A workbook or deck with thousands of parts contributes nothing useful
    // (the extracted text is truncated later) but would keep the loop busy.
    names.truncate(MAX_ARCHIVE_ENTRIES);
    names
}

fn archive(bytes: &[u8]) -> Result<ZipArchive<std::io::Cursor<&[u8]>>, String> {
    ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|_| "无法读取 Office 文件（可能已损坏或不是 .docx/.pptx/.xlsx）".to_string())
}

/// Collect the text of every paragraph: paragraph tags become line breaks,
/// text-run tags carry the characters.
fn xml_paragraphs(xml: &str, paragraph: &str, text_tag: &str) -> String {
    let para_re = Regex::new(&format!(r"(?s)<{paragraph}[ >].*?</{paragraph}>"))
        .expect("invalid paragraph regex");
    let text_re = Regex::new(&format!(r"(?s)<{text_tag}(?:\s[^>]*)?>(.*?)</{text_tag}>"))
        .expect("invalid text regex");

    let mut lines: Vec<String> = Vec::new();
    for para in para_re.find_iter(xml) {
        let mut line = String::new();
        for cap in text_re.captures_iter(para.as_str()) {
            if let Some(inner) = cap.get(1) {
                line.push_str(&unescape_xml(inner.as_str()));
            }
        }
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            lines.push(trimmed.to_string());
        }
    }
    lines.join("\n")
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

fn parse_docx(bytes: &[u8]) -> Result<String, String> {
    let mut zip = archive(bytes)?;
    let document = zip_text(&mut zip, "word/document.xml").ok_or("文档缺少正文内容")?;
    Ok(xml_paragraphs(&document, "w:p", "w:t"))
}

fn parse_pptx(bytes: &[u8]) -> Result<String, String> {
    let mut zip = archive(bytes)?;
    let slides = sorted_entries(&zip, "ppt/slides/slide");
    let mut out = String::new();
    for (index, name) in slides.iter().enumerate() {
        let Some(xml) = zip_text(&mut zip, name) else {
            continue;
        };
        let body = xml_paragraphs(&xml, "a:p", "a:t");
        if body.trim().is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&format!("## 幻灯片 {}\n{}", index + 1, body));
    }
    Ok(out)
}

/// Shared strings table of an xlsx workbook (cell text lives here).
fn parse_shared_strings(xml: &str) -> Vec<String> {
    static SI: OnceLock<Regex> = OnceLock::new();
    static T: OnceLock<Regex> = OnceLock::new();
    let si_re = SI.get_or_init(|| Regex::new(r"(?s)<si>(.*?)</si>").expect("si regex"));
    let t_re = T.get_or_init(|| Regex::new(r"(?s)<t(?:\s[^>]*)?>(.*?)</t>").expect("t regex"));

    si_re
        .captures_iter(xml)
        .map(|cap| {
            let inner = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let mut text = String::new();
            for t in t_re.captures_iter(inner) {
                if let Some(value) = t.get(1) {
                    text.push_str(&unescape_xml(value.as_str()));
                }
            }
            text
        })
        .collect()
}

/// One worksheet: cells joined by tab, rows by newline.
fn parse_sheet(xml: &str, shared: &[String]) -> String {
    static ROW: OnceLock<Regex> = OnceLock::new();
    static CELL: OnceLock<Regex> = OnceLock::new();
    let row_re = ROW.get_or_init(|| Regex::new(r"(?s)<row[^>]*>(.*?)</row>").expect("row regex"));
    let cell_re = CELL.get_or_init(|| Regex::new(r"(?s)<c([^>]*)>(.*?)</c>").expect("cell regex"));

    let mut lines: Vec<String> = Vec::new();
    for row in row_re.captures_iter(xml) {
        let body = row.get(1).map(|m| m.as_str()).unwrap_or("");
        let mut cells: Vec<String> = Vec::new();
        for cell in cell_re.captures_iter(body) {
            let attrs = cell.get(1).map(|m| m.as_str()).unwrap_or("");
            let inner = cell.get(2).map(|m| m.as_str()).unwrap_or("");
            let value = cell_value(attrs, inner, shared);
            cells.push(value);
        }
        // Trailing empty cells carry no information.
        while cells.last().is_some_and(|c| c.is_empty()) {
            cells.pop();
        }
        if !cells.is_empty() {
            lines.push(cells.join("\t"));
        }
    }
    lines.join("\n")
}

/// Resolve one cell: shared-string index, inline string, or literal value.
fn cell_value(attrs: &str, inner: &str, shared: &[String]) -> String {
    static TYPE: OnceLock<Regex> = OnceLock::new();
    static VALUE: OnceLock<Regex> = OnceLock::new();
    static TEXT: OnceLock<Regex> = OnceLock::new();
    let type_re = TYPE.get_or_init(|| Regex::new(r#"t="([^"]+)""#).expect("cell type regex"));
    let value_re = VALUE.get_or_init(|| Regex::new(r"(?s)<v>(.*?)</v>").expect("value regex"));
    let text_re =
        TEXT.get_or_init(|| Regex::new(r"(?s)<t(?:\s[^>]*)?>(.*?)</t>").expect("text regex"));

    let kind = type_re
        .captures(attrs)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
        .unwrap_or_default();

    if kind == "s" {
        // A shared-string cell stores the index into `sharedStrings.xml`.
        return value_re
            .captures(inner)
            .and_then(|c| c.get(1))
            .and_then(|m| m.as_str().trim().parse::<usize>().ok())
            .and_then(|index| shared.get(index).cloned())
            .unwrap_or_default();
    }

    if kind == "inlineStr" {
        return text_re
            .captures(inner)
            .and_then(|c| c.get(1))
            .map(|m| unescape_xml(m.as_str()))
            .unwrap_or_default();
    }

    value_re
        .captures(inner)
        .and_then(|c| c.get(1))
        .map(|m| unescape_xml(m.as_str().trim()))
        .unwrap_or_default()
}

/// Map `rId` → sheet name from `xl/workbook.xml` + its relationship file, so
/// sheets can be labelled with the name the user sees.
fn sheet_names(zip: &mut ZipArchive<std::io::Cursor<&[u8]>>) -> Vec<String> {
    let Some(workbook) = zip_text(zip, "xl/workbook.xml") else {
        return Vec::new();
    };
    let Some(rels) = zip_text(zip, "xl/_rels/workbook.xml.rels") else {
        return Vec::new();
    };

    static SHEET: OnceLock<Regex> = OnceLock::new();
    static REL: OnceLock<Regex> = OnceLock::new();
    let sheet_re = SHEET.get_or_init(|| {
        Regex::new(r#"<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]*)""#).expect("sheet regex")
    });
    let rel_re = REL.get_or_init(|| {
        Regex::new(r#"<Relationship[^>]*Id="([^"]*)"[^>]*Target="([^"]*)""#).expect("rel regex")
    });

    let mut targets: Vec<(String, String)> = Vec::new(); // (rId, sheetN)
    for cap in rel_re.captures_iter(&rels) {
        let id = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let target = cap.get(2).map(|m| m.as_str()).unwrap_or("");
        let digits: String = target.chars().filter(|c| c.is_ascii_digit()).collect();
        targets.push((id.to_string(), digits));
    }

    let mut names: Vec<String> = Vec::new();
    for cap in sheet_re.captures_iter(&workbook) {
        let name = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let rid = cap.get(2).map(|m| m.as_str()).unwrap_or("");
        let index = targets
            .iter()
            .find(|(id, _)| id == rid)
            .map(|(_, digits)| digits.clone())
            .unwrap_or_default();
        names.push(if index.is_empty() {
            name.to_string()
        } else {
            format!("{index}\u{0}{name}")
        });
    }
    names
}

fn parse_xlsx(bytes: &[u8]) -> Result<String, String> {
    let mut zip = archive(bytes)?;

    let shared = zip_text(&mut zip, "xl/sharedStrings.xml")
        .map(|xml| parse_shared_strings(&xml))
        .unwrap_or_default();

    // sheet1.xml ↔ name mapping (index prefix keeps the natural order).
    let names = sheet_names(&mut zip);
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

    let sheets = sorted_entries(&zip, "xl/worksheets/sheet");
    let mut out = String::new();
    for file in sheets {
        let Some(xml) = zip_text(&mut zip, &file) else {
            continue;
        };
        let body = parse_sheet(&xml, &shared);
        if body.trim().is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&format!("## {}\n{}", name_for(&file), body));
    }
    Ok(out)
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
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            let options =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            for (name, content) in files {
                writer.start_file(*name, options).unwrap();
                writer.write_all(content.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        buffer.into_inner()
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
