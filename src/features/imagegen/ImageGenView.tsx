import { useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  Loader2,
  Sparkles,
  X,
  Trash2,
  Send,
  Paperclip,
  Copy,
  Star,
  Pencil,
} from "lucide-react";
import { generateImage, type ReferenceImageMode } from "../../services/providers-api";
import { useProvidersStore } from "../../stores/providers-store";
import { useImageGenStore } from "../../stores/imagegen-store";
import { useWindowStore } from "../../stores/window-store";
import { Dropdown } from "../../features/settings/ui";
import type { ImageGeneration } from "../../services/imagegen-api";

const SIZE_OPTIONS = [
  { label: "1:1", value: "1024x1024" },
  { label: "9:16", value: "1024x1792" },
  { label: "16:9", value: "1792x1024" },
  { label: "3:4", value: "768x1024" },
  { label: "4:3", value: "1024x768" },
] as const;

// The current service contract has no optional image capability declaration.
// Do not infer quality/format/background/moderation support from a model name:
// compatible providers may expose that same name with a different protocol.
const MAX_REFERENCE_IMAGES = 3;
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
const REFERENCE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

function parseSize(value: string): { w: number; h: number } | null {
  const m = /^(\d+)\s*[x×X]\s*(\d+)$/.exec(value.trim());
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 64 || h < 64) return null;
  return { w, h };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function getReferenceImages(item: ImageGeneration): string[] {
  if (!item.referenceImagesJson) return [];
  try {
    const parsed = JSON.parse(item.referenceImagesJson);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && /^data:image\/(png|jpeg|webp);base64,.+/.test(value))
      : [];
  } catch {
    return [];
  }
}

function aspectOf(sizeLabel: string | null): string {
  if (!sizeLabel) return "1:1";
  const p = parseSize(sizeLabel);
  if (!p) return "1:1";
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const d = g(p.w, p.h);
  return `${p.w / d}:${p.h / d}`;
}

/**
 * Conversational image workbench.
 *
 * Layout:
 *   - Left history sidebar (rendered separately by HistorySidebar).
 *   - Center canvas: selected generation / empty state.
 *   - Bottom composer: prompt + reference chips + size picker + send.
 *   - Click the canvas image to open the detail drawer.
 */
export function ImageGenView() {
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState<string>("auto");
  const [referenceImages, setReferenceImages] = useState<string[]>([]);
  const referenceImagesRef = useRef(referenceImages);
  referenceImagesRef.current = referenceImages;
  const [generating, setGenerating] = useState(false);
  const [readingReferences, setReadingReferences] = useState(false);
  const [referenceImageMode, setReferenceImageMode] = useState<ReferenceImageMode>("edits");
  const generatingRef = useRef(false);
  const readingReferencesRef = useRef(false);
  // Ignore reads belonging to a previous new/history draft.
  const draftEpoch = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ImageGeneration | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const providers = useProvidersStore((s) => s.providers);
  const imageProviderId = useProvidersStore((s) => s.imageProviderId);
  const imageModelKey = useProvidersStore((s) => s.imageModelKey);
  const history = useImageGenStore((s) => s.history);
  const addHistory = useImageGenStore((s) => s.add);
  const loadHistory = useImageGenStore((s) => s.load);
  const openSettings = useWindowStore((s) => s.openSettings);

  useEffect(() => {
    void loadHistory().then(() => {
      setSelected((prev) => prev ?? useImageGenStore.getState().history[0] ?? null);
    });
    textareaRef.current?.focus();
  }, [loadHistory]);

  useEffect(() => {
    const onSelect = (e: Event) => {
      const detail = (e as CustomEvent<{ id?: string }>).detail;
      const id = detail?.id;
      if (!id || generatingRef.current) return;
      const item = useImageGenStore.getState().history.find((g) => g.id === id);
      if (item) loadIntoWorkbench(item);
    };
    const onNew = () => {
      if (generatingRef.current) return;
      resetReferenceRead();
      setSelected(null);
      setDetailOpen(false);
      setError(null);
      setPrompt("");
      setSize("auto");
      setReferenceImages([]);
      textareaRef.current?.focus();
    };
    window.addEventListener("imagegen-select", onSelect);
    window.addEventListener("imagegen-new", onNew);
    return () => {
      window.removeEventListener("imagegen-select", onSelect);
      window.removeEventListener("imagegen-new", onNew);
    };
  }, []);

  useEffect(() => {
    // Deletion/clear in the sidebar must update the canvas. A new blank
    // workbench must not immediately reselect the newest historical image.
    setSelected((previous) => previous && !history.some((item) => item.id === previous.id)
      ? history[0] ?? null : previous);
  }, [history]);

  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      if (generatingRef.current) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (files.length > 0) {
        e.preventDefault();
        await appendReferenceFiles(files);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const imageModel = useMemo(() => {
    if (imageProviderId && imageModelKey) {
      const p = providers.find((x) => x.id === imageProviderId);
      const m = p?.models.find((x) => x.modelKey === imageModelKey);
      if (p && m) return { provider: p, model: m };
    }
    return null;
  }, [imageProviderId, imageModelKey, providers]);

  const resetReferenceRead = () => {
    draftEpoch.current += 1;
    readingReferencesRef.current = false;
    setReadingReferences(false);
  };

  const loadIntoWorkbench = (item: ImageGeneration) => {
    resetReferenceRead();
    setError(null);
    setDetailOpen(false);
    setSize("auto");
    setSelected(item);
    setPrompt(item.prompt);
    setReferenceImages(getReferenceImages(item).slice(0, MAX_REFERENCE_IMAGES));
    if (item.sizeLabel) {
      const p = parseSize(item.sizeLabel);
      if (p) {
        const key = `${p.w}x${p.h}`;
        const preset = SIZE_OPTIONS.find((s) => s.value === key);
        setSize(preset ? preset.value : key);
      }
    }
  };

  const appendReferenceFiles = async (files: File[]) => {
    if (!files.length || generatingRef.current || readingReferencesRef.current) return;
    setError(null);
    const epoch = draftEpoch.current;
    readingReferencesRef.current = true;
    setReadingReferences(true);
    try {
      if (referenceImagesRef.current.length + files.length > MAX_REFERENCE_IMAGES) {
        throw new Error("一次最多支持 3 张参考图，请移除已有图片后再添加");
      }
      for (const file of files) {
        if (!REFERENCE_IMAGE_TYPES.includes(file.type)) throw new Error("参考图仅支持 PNG、JPEG 或 WebP 格式");
        if (file.size > MAX_REFERENCE_IMAGE_BYTES) throw new Error("每张参考图不能超过 10 MB");
      }
      const dataUrls = await Promise.all(files.map(readFileAsDataUrl));
      if (epoch !== draftEpoch.current) return;
      setReferenceImages((prev) => [...prev, ...dataUrls].slice(0, MAX_REFERENCE_IMAGES));
    } catch (err) {
      if (epoch === draftEpoch.current) setError(err instanceof Error ? err.message : "读取参考图失败");
    } finally {
      if (epoch === draftEpoch.current) {
        readingReferencesRef.current = false;
        setReadingReferences(false);
      }
    }
  };

  const removeReference = (idx: number) => {
    setReferenceImages((prev) => prev.filter((_, i) => i !== idx));
  };

  const resolvedSize = useMemo(() => {
    if (size !== "auto") {
      const p = parseSize(size);
      if (p) return { w: p.w, h: p.h, label: `${p.w}x${p.h}` };
    }
    return { w: 1024, h: 1024, label: "1024x1024" };
  }, [size]);

  const generate = async () => {
    const text = prompt.trim();
    if (!text || generatingRef.current || readingReferencesRef.current || !imageModel) return;

    generatingRef.current = true;

    setGenerating(true);
    setError(null);
    try {
      const dataUrl = await generateImage(
        imageModel.provider.id,
        imageModel.model.modelKey,
        text,
        resolvedSize.label,
        undefined,
        undefined,
        referenceImages.length > 0 ? referenceImages : undefined,
        referenceImageMode,
      );
      // Keep a usable result even when the history database fails to save.
      setSelected({ id: `unsaved-${Date.now()}`, prompt: text, imageData: dataUrl,
        sizeLabel: resolvedSize.label, referenceImagesJson: JSON.stringify(referenceImages), createdAt: Date.now() });
      try {
        const item = await addHistory(text, dataUrl, resolvedSize.label, referenceImages);
        setSelected(item);
      } catch (err) {
        setError(`图片已生成，但保存历史失败：${err instanceof Error ? err.message : String(err)}`);
      }
      setPrompt("");
      setReferenceImages([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      generatingRef.current = false;
      setGenerating(false);
      textareaRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void generate();
    }
  };

  const downloadSelected = () => {
    if (!selected) return;
    try {
      const a = document.createElement("a");
      a.href = selected.imageData;
      const extension = selected.imageData.startsWith("data:image/jpeg;") ? "jpg" : selected.imageData.startsWith("data:image/webp;") ? "webp" : "png";
      a.download = `zhima-${selected.id}.${extension}`;
      a.click();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteSelected = async () => {
    if (!selected) return;
    try {
      await useImageGenStore.getState().remove(selected.id);
      setSelected(useImageGenStore.getState().history[0] ?? null);
      setDetailOpen(false);
    } catch (err) {
      setError(`删除历史失败：${String(err)}`);
    }
  };

  const reuseConfig = () => {
    if (!selected || generatingRef.current) return;
    loadIntoWorkbench(selected);
    textareaRef.current?.focus();
  };

  const editOutput = () => {
    if (!selected || generatingRef.current) return;
    loadIntoWorkbench(selected);
    setPrompt("");
    setReferenceImages([selected.imageData]);
    textareaRef.current?.focus();
  };

  const copyPrompt = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.prompt);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Canvas area */}
      <main
        className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[var(--cf-bg)] transition-colors ${
          isDragging ? "bg-[color-mix(in_srgb,var(--cf-accent)_5%,transparent)]" : ""
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          const files = Array.from(e.dataTransfer.files).filter((f) =>
            f.type.startsWith("image/"),
          );
          void appendReferenceFiles(files);
        }}
      >
        {generating ? (
          <div className="flex flex-col items-center gap-3 text-ink-2">
            <Loader2 size={32} className="animate-spin text-accent" />
            <p className="text-ui">正在创作中，请稍候…</p>
          </div>
        ) : selected ? (
          <div className="group relative max-h-full max-w-full overflow-hidden rounded-input border border-line bg-panel shadow-sm transition-shadow hover:shadow-md">
            <button type="button" onClick={() => setDetailOpen(true)} className="block cursor-zoom-in">
            <img
              src={selected.imageData}
              alt={selected.prompt}
              className="max-h-[calc(100vh-220px)] max-w-full object-contain"
            />
            {/* Top-left badges */}
            <div className="absolute left-3 top-3 flex items-center gap-1.5">
              <span className="rounded-md bg-panel-2/80 px-2 py-0.5 text-meta text-ink backdrop-blur">
                {aspectOf(selected.sizeLabel ?? null)}
              </span>
              {selected.sizeLabel && (
                <span className="rounded-md bg-panel-2/80 px-2 py-0.5 text-meta text-ink backdrop-blur">
                  {selected.sizeLabel}
                </span>
              )}
            </div>
            </button>
            {/* Top-right download */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                downloadSelected();
              }}
              title="下载"
              className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-md bg-panel-2/80 text-ink opacity-0 backdrop-blur transition-opacity group-hover:opacity-100"
            >
              <Download size={13} />
            </button>
            {/* Hover hint */}
            <span className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-panel-2/80 px-3 py-1 text-meta text-ink opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
              点击查看详情
            </span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="grid h-16 w-16 place-items-center rounded-full bg-panel-2">
              <Sparkles size={28} className="text-ink-2 opacity-50" />
            </div>
            <div className="max-w-xs space-y-1">
              <p className="font-display text-title text-ink">图像工作台</p>
              <p className="text-meta leading-5 text-ink-2">
                在下方输入描述、上传参考图，即可开始创作。
                <br />
                支持文生图与参考图生图。
              </p>
            </div>
            {!imageModel && (
              <button
                onClick={() => openSettings()}
                className="cf-btn-primary"
              >
                先去配置图像模型
              </button>
            )}
          </div>
        )}

        {isDragging && (
          <div className="pointer-events-none absolute inset-4 grid place-items-center rounded-input border-2 border-dashed border-[var(--cf-accent)] bg-[color-mix(in_srgb,var(--cf-accent)_8%,transparent)]">
            <p className="font-medium text-accent">松开以添加参考图</p>
          </div>
        )}
      </main>

      {/* Bottom composer */}
      <div className="shrink-0 border-t border-line bg-panel px-4 pb-4 pt-3">
        {/* Reference chips */}
        {referenceImages.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {referenceImages.map((src, idx) => (
              <div
                key={`${src.slice(-32)}-${idx}`}
                className="group relative h-12 w-12 shrink-0 overflow-hidden rounded-btn border border-line"
              >
                <img
                  src={src}
                  alt={`参考图 ${idx + 1}`}
                  className="h-full w-full object-cover"
                />
                <button
                  disabled={generating}
                  onClick={() => removeReference(idx)}
                  className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-danger text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <X size={9} />
                </button>
              </div>
            ))}
            <button
              onClick={() => { resetReferenceRead(); setReferenceImages([]); }}
              className="grid h-12 w-12 shrink-0 place-items-center rounded-btn border border-dashed border-line text-ink-3 transition-colors hover:border-danger hover:text-danger"
              disabled={generating}
              title="清空参考图"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}

        {/* Prompt input */}
        <div className="rounded-composer border border-line bg-panel shadow-composer transition-shadow duration-150 focus-within:border-[color-mix(in_srgb,var(--cf-accent)_40%,var(--cf-border))] focus-within:shadow-composer-focus">
          <textarea
            ref={textareaRef}
            value={prompt}
            disabled={generating}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder="描述你想生成的图片，可上传、粘贴或拖入参考图…"
            className="w-full resize-none bg-transparent px-3.5 pt-3 text-body leading-6 text-ink outline-none placeholder:text-ink-3"
          />

          {/* Param row */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 pb-2.5 pt-1">
            <ParamPicker label="尺寸" value={size} onChange={(value) => { if (!generatingRef.current) setSize(value); }}
              options={[{ value: "auto", label: "auto" }, ...SIZE_OPTIONS.map((s) => ({ value: s.value, label: s.label }))]} />
            {referenceImages.length > 0 && (
              <ParamPicker label="参考图接口" value={referenceImageMode}
                onChange={(value) => { if (!generatingRef.current) setReferenceImageMode(value as ReferenceImageMode); }}
                options={[{ value: "edits", label: "标准编辑（文件上传）" }, { value: "generations", label: "JSON 兼容（Data URL）" }]} />
            )}
            <span className="text-meta text-ink-3">数量：1（每次仅生成 1 张，暂不支持批量）</span>

            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={generating || readingReferences || referenceImages.length >= MAX_REFERENCE_IMAGES}
                title={
                  referenceImages.length >= MAX_REFERENCE_IMAGES
                    ? `最多 ${MAX_REFERENCE_IMAGES} 张参考图`
                    : "添加参考图"
                }
                className="grid h-8 w-8 place-items-center rounded-btn text-ink-2 transition-colors hover:bg-hover hover:text-ink"
              >
                <Paperclip size={15} />
              </button>
              <button
                type="button"
                onClick={() => void generate()}
                disabled={!prompt.trim() || generating || readingReferences || !imageModel}
                title="生成"
                className="grid h-8 w-8 place-items-center rounded-btn bg-accent text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {generating ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Send size={15} />
                )}
              </button>
            </div>
          </div>
        </div>

        <p className="mt-2 text-meta leading-5 text-ink-3">
          当前接口未声明质量、格式、透明背景和审核参数能力，暂不提供这些设置，也不会发送这些参数。
        </p>

        {readingReferences && <p role="status" className="mt-2 text-meta text-ink-3">正在读取参考图，读取完成后才能生成…</p>}
        {referenceImages.length > 0 && <p className="mt-1 text-meta text-ink-3">
          将发送 {referenceImages.length} 张参考图；{referenceImageMode === "edits" ? "使用 /images/edits 文件上传" : "使用 /images/generations JSON（完整 Data URL）"}。请确认服务商和模型支持此接口；失败不会退回纯文生图。
        </p>}
        {error && (
          <p className="mt-2 rounded-btn border border-[color-mix(in_srgb,var(--cf-danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--cf-danger)_6%,transparent)] px-3 py-2 text-meta leading-5 text-danger">
            {error}
          </p>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={generating || readingReferences}
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) void appendReferenceFiles(files);
            e.currentTarget.value = "";
          }}
        />
      </div>

      {/* Detail drawer */}
      {detailOpen && selected && (
        <ImageDetailDrawer
          item={selected}
          onClose={() => setDetailOpen(false)}
          onDownload={downloadSelected}
          onDelete={() => void deleteSelected()}
          onReuse={reuseConfig}
          onEdit={editOutput}
          onCopyPrompt={() => void copyPrompt()}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Bottom param picker (one labeled dropdown)                                */
/* ------------------------------------------------------------------------ */

function ParamPicker({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-meta text-ink-3">{label}</span>
      <Dropdown value={value} onChange={onChange} options={options} className="min-w-[5rem]" placement="top" />
    </label>
  );
}

/* ------------------------------------------------------------------------ */
/* Detail drawer — right-hand panel showing the selected generation          */
/* ------------------------------------------------------------------------ */

function ImageDetailDrawer({
  item,
  onClose,
  onDownload,
  onDelete,
  onReuse,
  onEdit,
  onCopyPrompt,
}: {
  item: ImageGeneration;
  onClose: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onReuse: () => void;
  onEdit: () => void;
  onCopyPrompt: () => void;
}) {
  const refs = getReferenceImages(item);
  const createdAt = new Date(item.createdAt);
  const createdText = `${createdAt.getFullYear()}/${String(createdAt.getMonth() + 1).padStart(2, "0")}/${String(createdAt.getDate()).padStart(2, "0")} ${String(createdAt.getHours()).padStart(2, "0")}:${String(createdAt.getMinutes()).padStart(2, "0")}:${String(createdAt.getSeconds()).padStart(2, "0")}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="生成详情"
        className="relative grid h-[85vh] w-[90vw] max-w-7xl grid-cols-[3fr_2fr] overflow-hidden rounded-input border border-line bg-panel shadow-menu"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left: image */}
        <div className="relative flex min-h-0 items-center justify-center bg-panel-2 p-4">
          <img
            src={item.imageData}
            alt={item.prompt}
            className="max-h-full max-w-full rounded-btn object-contain"
          />
          <div className="absolute left-3 top-3 flex items-center gap-1.5">
            <span className="rounded-md bg-panel/90 px-2 py-0.5 text-meta text-ink">
              {aspectOf(item.sizeLabel ?? null)}
            </span>
            {item.sizeLabel && (
              <span className="rounded-md bg-panel/90 px-2 py-0.5 text-meta text-ink">
                {item.sizeLabel}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onDownload}
            title="下载"
            className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-md bg-panel/90 text-ink transition-colors hover:bg-panel"
          >
            <Download size={14} />
          </button>
        </div>

        {/* Right: info */}
        <div className="relative flex min-h-0 flex-col">
          <button
            onClick={onClose}
            title="关闭"
            className="absolute right-3 top-3 z-10 grid h-7 w-7 place-items-center rounded-btn text-ink-2 transition-colors hover:bg-hover hover:text-ink"
          >
            <X size={15} />
          </button>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
            {/* Prompt */}
            <section>
              <div className="mb-1 flex items-center justify-between pr-8">
                <h3 className="text-meta font-medium text-ink-3">输入内容</h3>
                <button
                  onClick={onCopyPrompt}
                  title="复制"
                  className="grid h-5 w-5 place-items-center rounded text-ink-3 transition-colors hover:bg-hover hover:text-ink"
                >
                  <Copy size={11} />
                </button>
              </div>
              <p className="text-[0.9375rem] leading-6 text-ink">{item.prompt}</p>
            </section>

            {/* References */}
            {refs.length > 0 && (
              <section>
                <h3 className="mb-1.5 text-meta font-medium text-ink-3">参考图</h3>
                <div className="flex flex-wrap gap-2">
                  {refs.map((src, idx) => (
                    <img
                      key={idx}
                      src={src}
                      alt={`参考图 ${idx + 1}`}
                      className="h-14 w-14 rounded-btn border border-line object-cover"
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Params */}
            <section>
              <h3 className="mb-1.5 text-meta font-medium text-ink-3">参数配置</h3>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-ui">
                {item.sizeLabel && <KV k="尺寸" v={item.sizeLabel} />}
                <KV k="创建于" v={createdText} />
              </dl>
            </section>
          </div>

          {/* Actions */}
          <div className="flex flex-nowrap items-center gap-1 border-t border-line px-4 py-2.5">
            <button
              onClick={onReuse}
              className="inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-btn px-2.5 text-ui font-medium text-accent transition-colors hover:bg-[color-mix(in_srgb,var(--cf-accent)_8%,transparent)]"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
              复用配置
            </button>
            <button
              onClick={onEdit}
              className="inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-btn px-2.5 text-ui font-medium text-success transition-colors hover:bg-[color-mix(in_srgb,var(--cf-success)_8%,transparent)]"
            >
              <Pencil size={12} className="shrink-0" />
              编辑输出
            </button>
            <button
              onClick={onDelete}
              className="inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-btn px-2.5 text-ui font-medium text-danger transition-colors hover:bg-[color-mix(in_srgb,var(--cf-danger)_8%,transparent)]"
            >
              <Trash2 size={12} className="shrink-0" />
              删除任务
            </button>
            <button
              type="button"
              title="收藏"
              className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-btn text-ink-3 transition-colors hover:bg-hover hover:text-ink"
            >
              <Star size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line pb-1 last:border-0">
      <dt className="shrink-0 text-meta text-ink-3">{k}</dt>
      <dd className="min-w-0 flex-1 truncate text-right text-ink">{v}</dd>
    </div>
  );
}
