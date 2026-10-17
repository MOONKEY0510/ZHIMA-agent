import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BookOpen, Brain, Layers, LoaderCircle, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import { Button } from "../../components/ui";
import { Modal } from "../settings/ui";
import { buildContextPreviewRequest, contextScope, useChatStore, type TurnContextPreview } from "../../stores/chat-store";
import { EMPTY_CONTEXT_EXCLUSIONS, useContextOptionsStore } from "../../stores/context-options-store";
import { useHistoryStore } from "../../services/history-store";
import { useProvidersStore } from "../../stores/providers-store";
import { useAssistantsStore } from "../../stores/assistants-store";
import { useSettingsStore, type ThinkingEffort } from "../../stores/settings-store";

export interface ContextPreviewButtonProps {
  /** Actual outgoing text, including parsed attachment bodies. */
  text: string;
  /** Local image/attachment revision only; never sent to the backend. */
  inputRevision?: string;
  skillIds?: string[];
  webSearch?: boolean;
  enableTools?: boolean;
  enableThinking?: boolean;
  thinkingEffort?: ThinkingEffort;
  disabled?: boolean;
}

export function ContextPreviewButton({ text, inputRevision = "", skillIds, webSearch, enableTools, enableThinking: thinkingOverride, thinkingEffort: effortOverride, disabled = false }: ContextPreviewButtonProps) {
  // Changes to selection/history/assistant/options invalidate the displayed snapshot.
  useChatStore();
  useHistoryStore();
  useProvidersStore();
  useAssistantsStore();
  const drafts = useContextOptionsStore((s) => s.drafts);
  const enableThinking = useSettingsStore((s) => s.defaultEnableThinking);
  const thinkingEffort = useSettingsStore((s) => s.defaultThinkingEffort);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<TurnContextPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const generation = useRef(0);
  const scope = contextScope();
  const exclusions = drafts[scope] ?? EMPTY_CONTEXT_EXCLUSIONS;
  const options = { skillIds, webSearch, enableTools, enableThinking: thinkingOverride ?? enableThinking, thinkingEffort: effortOverride ?? thinkingEffort };
  let fingerprint = "";
  try { fingerprint = buildContextPreviewRequest(text, options).fingerprint; } catch { /* surfaced on click */ }
  const localFingerprint = JSON.stringify([fingerprint, inputRevision]);
  const [previewFingerprint, setPreviewFingerprint] = useState<string | null>(null);
  const previousRevision = useRef(inputRevision);
  const stale = !!preview && (previewFingerprint !== localFingerprint || externalChange || disabled);

  // Invalidate before async responses can commit after a rendered revision change.
  // Keep the dirty flag even if the caller restores an earlier revision value.
  useLayoutEffect(() => {
    if (previousRevision.current === inputRevision) return;
    previousRevision.current = inputRevision;
    generation.current++;
    setBusy(false);
    setError(null);
    setExternalChange(true);
  }, [inputRevision]);

  useEffect(() => {
    generation.current++;
    setPreview(null); setError(null); setBusy(false); setOpen(false);
  }, [scope]);
  useEffect(() => {
    const mark = () => setExternalChange(true);
    window.addEventListener("focus", mark);
    return () => { window.removeEventListener("focus", mark); generation.current++; };
  }, []);

  async function refresh() {
    if (disabled || useChatStore.getState().importingBackup) return;
    const id = ++generation.current;
    setOpen(true); setBusy(true); setError(null);
    try {
      const value = await useChatStore.getState().previewContext(text, options);
      if (id !== generation.current || scope !== contextScope()) return;
      setPreview(value);
      setPreviewFingerprint(JSON.stringify([value.fingerprint, inputRevision]));
      setExternalChange(false);
    } catch (err) {
      if (id === generation.current) setError(err instanceof Error ? err.message : String(err));
    } finally { if (id === generation.current) setBusy(false); }
  }
  const toggle = (kind: "memoryIds" | "knowledgeDocumentIds", id: string) => {
    useContextOptionsStore.getState().toggle(scope, kind, id);
  };
  const close = () => { generation.current++; setBusy(false); setOpen(false); };

  return <>
    <Button size="sm" variant="ghost" aria-haspopup="dialog" aria-expanded={open}
      disabled={disabled || busy || useChatStore.getState().importingBackup} onClick={() => void refresh()}
      title="只读预览本轮上下文，不联网、不调用模型"><Layers size={14} aria-hidden="true" />上下文</Button>
    {open && <Modal title="本轮上下文预览" subtitle="查看本轮候选资料与输入预算" icon={<Layers size={17} />} size="lg" onClose={close}
      actions={<Button size="sm" disabled={disabled || busy} onClick={() => void refresh()}><RefreshCw size={13} className={busy ? "animate-spin" : ""} aria-hidden="true" />刷新预览</Button>}
      footer={<p className="flex items-start gap-2 text-meta text-ink-2"><ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden="true" />只读预览 · 不联网、不调用模型；发送时会重新解析。</p>}>
      <div className="space-y-4">
        {busy && <p role="status" className="flex items-center gap-2 rounded-btn border border-line bg-panel-2 px-3 py-2 text-ui text-ink-2"><LoaderCircle size={14} className="animate-spin" aria-hidden="true" />正在读取本地上下文…</p>}
        {error && <p role="alert" className="break-words rounded-btn border border-line bg-panel-2 px-3 py-2 text-ui text-danger">{error}</p>}
        {stale && <p role="status" className="rounded-btn border border-line bg-panel-2 px-3 py-2 text-ui text-ink-2">上下文已变化，请刷新预览。下方为上一次快照。</p>}
        {preview && <>
          <section aria-label="上下文概览" className="grid grid-cols-2 gap-2">
            <div className="col-span-2 min-w-0 rounded-input border border-line bg-panel-2 px-3 py-2.5"><p className="text-meta text-ink-2">当前模型</p><p className="mt-0.5 break-words font-medium text-ink">{preview.modelLabel}</p></div>
            <div className="min-w-0 rounded-input border border-line bg-panel-2 px-3 py-2.5"><p className="text-meta text-ink-2">静态文本粗估 / 输入预算</p><p className="mt-1 break-words font-medium tabular-nums text-ink">{preview.estimatedTokens.toLocaleString()} <span className="font-normal text-ink-2">/ {preview.inputBudget.toLocaleString()}</span></p><p className="text-meta text-ink-2">tokens · 非精确估算</p></div>
            <div className="min-w-0 rounded-input border border-line bg-panel-2 px-3 py-2.5"><p className="text-meta text-ink-2">历史消息</p><p className="mt-1 font-medium text-ink">保留 {preview.retainedMessageCount} 条</p><p className="text-meta text-ink-2">窗口裁剪 {preview.frontendDroppedMessageCount} · 预算裁剪 {preview.droppedMessageCount}</p></div>
          </section>
          {(preview.overBudget || preview.oversizedMessage) && <p role="alert" className="rounded-btn border border-line bg-panel-2 px-3 py-2 text-ui text-danger">当前内容仍超出预算或存在超大消息，请缩短正文/附件；预览不保证发送成功。</p>}
          <section aria-label="长期记忆">
            <h3 className="mb-2 flex items-center gap-2 text-ui font-semibold text-ink"><Brain size={15} className="text-ink-2" aria-hidden="true" />长期记忆<span className="ml-auto text-meta font-normal text-ink-2">{preview.memories.length} 条候选</span></h3>
            <div className="overflow-hidden rounded-input border border-line">
              {!preview.memories.length && <p className="bg-panel-2 px-3 py-3 text-meta text-ink-2">无候选记忆</p>}
              {preview.memories.map((memory) => <label key={memory.id} className="flex cursor-pointer items-start gap-2.5 border-t border-line px-3 py-2.5 first:border-t-0 hover:bg-hover">
                <input type="checkbox" className="cf-checkbox mt-0.5" checked={!exclusions.memoryIds.includes(memory.id)} disabled={disabled}
                  onChange={() => toggle("memoryIds", memory.id)} aria-label={`包含记忆 ${memory.content}`} />
                <span className="min-w-0"><span className="mb-0.5 block text-meta text-ink-2">{memory.category}</span><span className="whitespace-pre-wrap break-words text-ui text-ink">{memory.content}</span></span>
              </label>)}
            </div>
          </section>
          <section aria-label="知识片段">
            <h3 className="mb-2 flex items-center gap-2 text-ui font-semibold text-ink"><BookOpen size={15} className="text-ink-2" aria-hidden="true" />知识片段<span className="ml-auto text-meta font-normal text-ink-2">按文档排除</span></h3>
            <div className="overflow-hidden rounded-input border border-line">
              {!preview.knowledge.length && <p className="bg-panel-2 px-3 py-3 text-meta text-ink-2">无候选知识片段，或自动注入已关闭</p>}
              {preview.knowledge.map((hit) => <div key={`${hit.documentId}-${hit.chunkIndex}`} className="border-t border-line px-3 py-2.5 first:border-t-0">
                <label className="flex cursor-pointer items-start gap-2.5"><input type="checkbox" className="cf-checkbox mt-0.5" checked={!exclusions.knowledgeDocumentIds.includes(hit.documentId)} disabled={disabled}
                  onChange={() => toggle("knowledgeDocumentIds", hit.documentId)} aria-label={`包含文档 ${hit.title} 片段 ${hit.chunkIndex + 1}`} />
                  <span className="min-w-0 break-words font-medium text-ink">{hit.title}<span className="ml-2 text-meta font-normal text-ink-2">片段 {hit.chunkIndex + 1}</span></span></label>
                <p className="ml-6 mt-1 whitespace-pre-wrap break-words text-ui text-ink-2">{hit.snippet}{hit.truncated ? "（片段已截断）" : ""}</p>
              </div>)}
            </div>
          </section>
          {(exclusions.memoryIds.length > 0 || exclusions.knowledgeDocumentIds.length > 0) && <section aria-label="本次已排除">
            <h3 className="mb-2 text-ui font-semibold text-ink">本次已排除<span className="ml-2 text-meta font-normal text-ink-2">点击恢复</span></h3>
            <div className="flex flex-wrap gap-2">
              {exclusions.memoryIds.map((id) => <Button size="sm" className="h-auto min-h-7 max-w-full py-1" key={`m-${id}`} disabled={disabled} onClick={() => toggle("memoryIds", id)}><RotateCcw size={12} className="shrink-0" aria-hidden="true" /><span className="min-w-0 break-all">恢复记忆 {id}</span></Button>)}
              {exclusions.knowledgeDocumentIds.map((id) => <Button size="sm" className="h-auto min-h-7 max-w-full py-1" key={`k-${id}`} disabled={disabled} onClick={() => toggle("knowledgeDocumentIds", id)}><RotateCcw size={12} className="shrink-0" aria-hidden="true" /><span className="min-w-0 break-all">恢复文档 {id}</span></Button>)}
            </div>
          </section>}
          <div className="divide-y divide-line rounded-input border border-line px-3">
            <details className="py-2.5"><summary className="cursor-pointer text-ui font-medium text-ink">技能目录与激活说明</summary><p className="mt-2 whitespace-pre-wrap break-words text-ui text-ink-2">{preview.skillsBlock || "无已启用技能"}</p></details>
            <details className="py-2.5"><summary className="cursor-pointer text-ui font-medium text-ink">历史摘要</summary><p className="mt-2 whitespace-pre-wrap break-words text-ui text-ink-2">{preview.summary || "暂无摘要"}</p></details>
            <details className="py-2.5"><summary className="cursor-pointer text-ui font-medium text-ink">待发送动态内容</summary><div className="mt-2 space-y-1 break-words text-ui text-ink-2">{preview.dynamicContent.map((line) => <p key={line}>{line}</p>)}</div></details>
            <details className="py-2.5"><summary className="cursor-pointer text-ui font-medium text-ink">静态系统提示（安全规则不可排除）</summary><pre className="mt-2 whitespace-pre-wrap break-words font-sans text-meta text-ink-2">{preview.systemPrompt}</pre></details>
          </div>
        </>}
        <details className="rounded-input border border-line bg-panel-2 px-3 py-2.5 text-meta text-ink-2">
          <summary className="cursor-pointer font-medium text-ink">预览与排除说明</summary>
          <div className="mt-2 space-y-2">
            <p>只读的当前候选快照，不冻结发送结果。文本、附件、模型、技能或本地资料变化后请刷新；发送时会重新解析。</p>
            <p>排除仅影响下一轮（重试/重新生成沿用该轮选择），不删除或停用持久资料，不移除安全系统提示；不代表资料不会出现在已有历史或摘要中。</p>
            <p>静态文本粗估不是完整请求或精确 token 预估。</p>
          </div>
        </details>
      </div>
    </Modal>}
  </>;
}
