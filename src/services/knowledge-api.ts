import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/** Local knowledge base (P1-9). */

export interface KbDocument {
  id: string;
  title: string;
  /** `file` | `url` | `text`. */
  sourceType: string;
  sourceRef: string | null;
  chunkCount: number;
  createdAt: number;
}

export interface KbHit {
  documentId: string;
  title: string;
  seq: number;
  snippet: string;
  /** BM25 score (lower is better); 0 for the short-query fallback. */
  score: number;
}

export interface KnowledgeView {
  autoInject: boolean;
  maxChunks: number;
  documents: number;
  chunks: number;
}

export function getKnowledgeConfig(): Promise<KnowledgeView> {
  return invoke<KnowledgeView>("get_knowledge_config");
}

export function setKnowledgeConfig(autoInject: boolean, maxChunks: number): Promise<void> {
  return invoke("set_knowledge_config", { autoInject, maxChunks });
}

export function listKbDocuments(): Promise<KbDocument[]> {
  return invoke<KbDocument[]>("list_kb_documents");
}

export function deleteKbDocument(id: string): Promise<void> {
  return invoke("delete_kb_document", { id });
}

export function addKbFile(path: string): Promise<KbDocument> {
  return invoke<KbDocument>("add_kb_file", { path });
}

export function addKbUrl(url: string): Promise<KbDocument> {
  return invoke<KbDocument>("add_kb_url", { url });
}

export function addKbText(title: string, text: string): Promise<KbDocument> {
  return invoke<KbDocument>("add_kb_text", { title, text });
}

export function searchKb(query: string, topK = 5): Promise<KbHit[]> {
  return invoke<KbHit[]>("search_kb", { query, topK });
}

/** Ask the user for a document to import; null when cancelled. */
export async function pickKbFile(): Promise<string | null> {
  const picked = await open({
    title: "选择要导入知识库的文档",
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
