import { useId, useState } from "react";
import { Bookmark, ChevronRight, Copy, ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { KnowledgeSnapshot } from "../../types";
import { Button } from "../ui";

/** Source metadata is untrusted. Never pass local/custom schemes to the opener. */
function safeWebSource(source?: string): string | undefined {
  if (!source || !/^https?:\/\//i.test(source) || /[\u0000-\u0020\u007f]/.test(source)) return undefined;
  try {
    const url = new URL(source);
    if ((url.protocol === "https:" || url.protocol === "http:") && url.hostname && !url.username && !url.password) return source;
  } catch { /* Display invalid metadata as text only. */ }
  return undefined;
}

export function KnowledgeEvidence({ snapshot }: { snapshot: KnowledgeSnapshot }) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const panelId = useId();
  const evidence = snapshot.kbEvidence;
  const count = evidence?.length ?? snapshot.kbHits ?? 0;
  const unavailable = !evidence?.length && (snapshot.kbEvidenceUnavailable || count > 0);
  const prepared = snapshot.kbEvidenceStage === "prepared" || !!evidence?.length;
  if (!count && !unavailable) return null;

  return (
    <div className="mb-1.5 min-w-0" data-evidence-stage={prepared ? "prepared" : undefined}>
      <button type="button" aria-expanded={open} aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 rounded-btn px-1 py-0.5 text-meta text-ink-2 transition-colors hover:bg-hover hover:text-ink">
        <Bookmark size={11} className="shrink-0 text-accent" />
        {count ? `检索参考资料 ${count} 条` : "检索参考资料：证据不可用"}
        <ChevronRight size={11} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <section id={panelId} aria-label="知识库检索参考资料" className="mt-2 space-y-3 rounded-input border border-line bg-panel p-3 text-ui text-ink">
          {unavailable ? (
            <p className="text-ink-2">证据不可用：此消息未保存本次请求准备的资料快照，无法核实当时的检索参考资料；不会重新检索替代原证据。</p>
          ) : (
            <>
              <div className="flex items-center gap-2 text-ui font-medium text-ink"><Bookmark size={14} className="text-ink-2" aria-hidden="true" />请求参考快照<span className="ml-auto text-meta font-normal text-ink-2">{count} 条资料</span></div>
              <details className="rounded-btn border border-line bg-panel-2 px-3 py-2 text-meta text-ink-2"><summary className="cursor-pointer font-medium">关于检索参考资料</summary><p className="mt-2">以下为本次请求准备的检索参考资料；是否发送以请求状态为准。不代表服务商已收到，也不代表回答已引用每条资料。复制原文仅复制准备发送的片段，可能含检索高亮或省略标记，并非完整文档。仅保留于当前应用内存，重启后不可用。</p></details>
              <ol className="max-h-96 space-y-3 overflow-y-auto">
                {evidence?.map((item) => {
                  const sourceUrl = safeWebSource(item.sourceRef);
                  return (
                    <li key={item.index} className="min-w-0 space-y-1 border-t border-line pt-2">
                      <h4 className="break-words font-medium text-ink">[资料{item.index}] {item.title}</h4>
                      <p className="break-all text-meta text-ink-2">文档 ID：{item.documentId} · 文档片段 {item.chunkIndex + 1}</p>
                      <p className="break-all text-meta text-ink-2">来源类型：{item.sourceType === "url" ? "网页" : item.sourceType === "file" ? "文件（仅展示，不读取）" : item.sourceType === "text" ? "粘贴文本" : "未记录"}</p>
                      {item.sourceRef && <p className="break-all text-meta text-ink-2">{item.sourceRef}</p>}
                      <pre className="whitespace-pre-wrap break-words font-sans text-ui text-ink select-text">{item.snippet}</pre>
                      {item.truncated && <p className="text-meta text-ink-2">片段已按请求上下文上限截断；这里只展示准备发送的原文部分。</p>}
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" aria-label={`复制资料${item.index}原文`}
                          onClick={async () => {
                            try { await navigator.clipboard.writeText(item.snippet); setNotice(`已复制资料${item.index}原文`); }
                            catch { setNotice("复制失败，请选择原文手动复制。"); }
                          }}><Copy size={12} aria-hidden="true" />复制原文</Button>
                        {sourceUrl && <Button size="sm" aria-label={`打开资料${item.index}网页来源`}
                          onClick={async () => {
                            try { await openUrl(sourceUrl); }
                            catch { setNotice("打开网页失败，请稍后重试。"); }
                          }}><ExternalLink size={12} aria-hidden="true" />打开网页来源</Button>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
          {notice && <p role="status" className="text-meta text-ink-2">{notice}</p>}
        </section>
      )}
    </div>
  );
}
