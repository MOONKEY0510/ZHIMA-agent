/**
 * Document attachment formatting (P1-8).
 *
 * The extracted text is folded into the message content so that persistence,
 * export and full-text search all see it without special cases.  These helpers
 * build those blocks and split them back out for display, so the bubble can
 * show a compact chip plus a collapsible view instead of 30k characters.
 */

export interface AttachmentMeta {
  name: string;
  chars: number;
}

export interface AttachmentBlock {
  name: string;
  text: string;
}

/** 【附件：报告.docx】 … 【附件结束】 block, one per attached document. */
const BLOCK = /【附件：(.+?)】\n([\s\S]*?)\n【附件结束】/g;

/** `8200` → `8,200 字`. */
export function formatChars(chars: number): string {
  return `${chars.toLocaleString("zh-CN")} 字`;
}

/** Build the content prefix for one prompt's attachments. */
export function buildAttachmentBlocks(
  docs: { name: string; chars: number; text: string }[],
): string {
  return docs
    .map((doc) => `【附件：${doc.name}】\n${doc.text}\n【附件结束】`)
    .join("\n\n");
}

/**
 * Split a user message into its attachment blocks and the actual prompt.
 * Messages without attachments come back unchanged.
 */
export function splitAttachments(content: string): {
  blocks: AttachmentBlock[];
  prompt: string;
} {
  const blocks: AttachmentBlock[] = [];
  const withoutBlocks = content.replace(BLOCK, (_match, name: string, text: string) => {
    blocks.push({ name, text });
    return "\u0000"; // placeholder, removed below
  });
  return {
    blocks,
    prompt: withoutBlocks.replace(/\u0000\s*/g, "").trim(),
  };
}
