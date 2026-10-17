import { parseDocumentPreview } from "../services/document-api";

export const MAX_DOCUMENTS = 8;
export const DOCUMENT_CONCURRENCY = 2;
export const MAX_DOCUMENT_CHARS = 60_000;
export interface StagedDocument {
  id: number;
  name: string;
  status: "queued" | "parsing" | "ready" | "error";
  text: string;
  chars: number;
  notice?: string;
}

/** A small per-composer queue: all entry points share limits and cancellation. */
export function createDocumentStager(onChange: (docs: StagedDocument[]) => void, isCurrent: () => boolean) {
  let docs: StagedDocument[] = [];
  let sequence = 0;
  let running = 0;
  const queue: { id: number; path: string }[] = [];
  const publish = () => { if (isCurrent()) onChange([...docs]); };
  const pump = () => {
    while (isCurrent() && running < DOCUMENT_CONCURRENCY && queue.length) {
      const job = queue.shift()!;
      const doc = docs.find((item) => item.id === job.id);
      if (!doc) continue;
      doc.status = "parsing";
      running++;
      publish();
      void parseDocumentPreview(job.path).then((preview) => {
        if (!isCurrent() || !docs.includes(doc)) return;
        const remaining = MAX_DOCUMENT_CHARS - docs.reduce((sum, item) => sum + item.text.length, 0);
        if (remaining <= 0) throw new Error(`总文本预算 ${MAX_DOCUMENT_CHARS.toLocaleString()} 字已用完；未附加正文`);
        if (!preview.text.trim()) throw new Error("未提取到正文");
        doc.name = preview.name;
        doc.text = preview.text.slice(0, remaining);
        doc.chars = doc.text.length;
        doc.status = "ready";
        if (preview.truncated || doc.text.length < preview.text.length) {
          doc.notice = `已截断：仅附加 ${doc.chars.toLocaleString()} 字 / 原文 ${preview.totalChars.toLocaleString()} 字，未包含全文`;
        }
      }).catch((error: unknown) => {
        if (!isCurrent() || !docs.includes(doc)) return;
        doc.status = "error";
        doc.notice = error instanceof Error ? error.message : String(error);
      }).finally(() => {
        running--;
        publish();
        pump();
      });
    }
  };
  return {
    stage(paths: string[]) {
      if (!isCurrent()) return 0;
      const accepted = paths.slice(0, Math.max(0, MAX_DOCUMENTS - docs.length));
      for (const path of accepted) {
        const id = sequence++;
        docs.push({ id, name: path.split(/[\\/]/).pop() || "文档", status: "queued", text: "", chars: 0 });
        queue.push({ id, path });
      }
      publish();
      pump();
      return paths.length - accepted.length;
    },
    remove(id: number) { docs = docs.filter((doc) => doc.id !== id); publish(); },
    clear() { docs = []; queue.length = 0; publish(); },
    busy() { return docs.some((doc) => doc.status === "queued" || doc.status === "parsing"); },
  };
}
