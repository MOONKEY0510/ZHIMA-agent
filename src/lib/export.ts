import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { Message } from "../types";

/**
 * Convert a list of chat messages into a Markdown document.
 *
 * - User messages are prefixed with `**我**`.
 * - Assistant messages are prefixed with `**AI**`.
 * - Reasoning traces (if any) are included in a `<details>` block.
 * - Error messages are noted inline.
 * - Images are represented as `[图片]` placeholders (data URLs are too large).
 */
export function messagesToMarkdown(messages: Message[]): string {
  const lines: string[] = [];
  const now = new Date();
  lines.push(`# 对话导出`);
  lines.push("");
  lines.push(`> 导出时间：${now.toLocaleString("zh-CN")}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const msg of messages) {
    const speaker = msg.role === "user" ? "**我**" : "**AI**";
    lines.push(`### ${speaker}`);
    lines.push("");

    if (msg.reasoning) {
      lines.push("<details><summary>思考过程</summary>");
      lines.push("");
      lines.push(msg.reasoning);
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }

    if (msg.status === "error") {
      lines.push(`> ⚠️ 生成失败：${msg.error ?? "未知错误"}`);
      lines.push("");
    }

    if (msg.content) {
      lines.push(msg.content);
      lines.push("");
    }

    if (msg.images && msg.images.length > 0) {
      lines.push(`[附图 ×${msg.images.length}]`);
      lines.push("");
    }

    if (msg.usage) {
      const parts: string[] = [];
      if (msg.usage.inputTokens != null) parts.push(`输入 ${msg.usage.inputTokens}`);
      if (msg.usage.outputTokens != null) parts.push(`输出 ${msg.usage.outputTokens}`);
      if (parts.length > 0) {
        lines.push(`<sub>Token: ${parts.join(" · ")}</sub>`);
        lines.push("");
      }
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Export messages to a Markdown file.
 *
 * Shows a native save dialog, then writes the file. Returns `true` if the
 * file was saved, `false` if the user cancelled.
 */
export async function exportMessagesToMarkdown(messages: Message[]): Promise<boolean> {
  const markdown = messagesToMarkdown(messages);
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;

  const filePath = await save({
    title: "导出对话",
    defaultPath: `对话-${stamp}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });

  if (!filePath) return false;

  await writeTextFile(filePath, markdown);
  return true;
}
