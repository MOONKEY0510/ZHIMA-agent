import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/** Document attachments (P1-8): parse a picked file into text for context. */

export interface DocumentPreview {
  name: string;
  /** Characters returned (after truncation). */
  chars: number;
  /** Characters in the whole document. */
  totalChars: number;
  truncated: boolean;
  text: string;
}

export function parseDocumentPreview(path: string): Promise<DocumentPreview> {
  return invoke<DocumentPreview>("parse_document_preview", { path });
}

/** Ask the user for a document; returns null when they cancel. */
export async function pickDocument(): Promise<string | null> {
  const picked = await open({
    title: "选择要附加的文档",
    multiple: false,
    filters: [
      {
        name: "文档",
        extensions: ["docx", "xlsx", "xlsm", "pptx", "pdf", "txt", "md", "csv", "json", "log"],
      },
    ],
  });
  return typeof picked === "string" ? picked : null;
}
