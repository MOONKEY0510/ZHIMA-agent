/**
 * Convert a Markdown string to clean plain text suitable for clipboard copying.
 *
 * Strips all common Markdown syntax while preserving the readable content:
 * - Headers (`#`, `##`, ...) -> plain text
 * - Bold (`**text**`, `__text__`) -> text
 * - Italic (`*text*`, `_text_`) -> text
 * - Inline code (`` `code` ``) -> code
 * - Code fences (``` ``` ```) -> the raw code inside
 * - Links (`[text](url)`) -> text
 * - Images (`![alt](url)`) -> alt
 * - List markers (`-`, `*`, `1.`) -> removed, content kept
 * - Blockquotes (`>`) -> removed, content kept
 * - Horizontal rules (`---`, `***`) -> removed
 * - Tables -> cells joined with spaces
 */
export function markdownToPlainText(markdown: string): string {
  let text = markdown;

  // Extract fenced code blocks first, replacing them with just the inner code.
  const codeBlocks: string[] = [];
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code) => {
    const trimmed = String(code).replace(/\n$/, "");
    codeBlocks.push(trimmed);
    return `\u0000CODEBLOCK${codeBlocks.length - 1}\u0000`;
  });

  // Remove horizontal rules (---, ***, ___ on their own line).
  text = text.replace(/^[-*_]{3,}\s*$/gm, "");

  // Remove header markers (#, ##, ###, ...).
  text = text.replace(/^#{1,6}\s+/gm, "");

  // Remove blockquote markers (>).
  text = text.replace(/^>\s?/gm, "");

  // Remove list markers (-, *, +, 1., 2., ...).
  text = text.replace(/^[\s]*[-*+]\s+/gm, "");
  text = text.replace(/^[\s]*\d+\.\s+/gm, "");

  // Images: ![alt](url) -> alt
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Links: [text](url) -> text
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Bold: **text** or __text__ -> text
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");

  // Italic: *text* or _text_ -> text
  // Be careful not to touch remaining ** (already handled above).
  text = text.replace(/(?<!\*)\*(?!\s)([^*]+?)(?<!\s)\*(?!\*)/g, "$1");
  text = text.replace(/(?<!_)_(?!\s)([^_]+?)(?<!\s)_(?!_)/g, "$1");

  // Strikethrough: ~~text~~ -> text
  text = text.replace(/~~([^~]+)~~/g, "$1");

  // Inline code: `code` -> code
  text = text.replace(/`([^`]+)`/g, "$1");

  // Table rows: | cell | cell | -> cell cell
  text = text.replace(/^\|(.+)\|$/gm, (_m, inner: string) => {
    return inner
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c && !/^[-:]+$/.test(c))
      .join("  ");
  });

  // Restore code blocks.
  text = text.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_m, idx) => codeBlocks[Number(idx)]);

  // Collapse multiple blank lines into one.
  text = text.replace(/\n{3,}/g, "\n\n");

  // Trim trailing whitespace on each line.
  text = text
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n");

  return text.trim();
}
