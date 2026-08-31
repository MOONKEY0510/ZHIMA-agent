import { useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  Loader2,
  Sparkles,
  ImagePlus,
  X,
  Settings2,
  Trash2,
  Wand2,
  Maximize2,
  Upload,
} from "lucide-react";
import { generateImage } from "../../services/providers-api";
import { currentModel, useProvidersStore } from "../../stores/providers-store";
import { useImageGenStore } from "../../stores/imagegen-store";
import { useWindowStore } from "../../stores/window-store";
import type { ImageGeneration } from "../../services/imagegen-api";

const SIZE_OPTIONS = [
  { label: "1:1", w: 1024, h: 1024 },
  { label: "9:16", w: 1024, h: 1792 },
  { label: "16:9", w: 1792, h: 1024 },
  { label: "3:4", w: 768, h: 1024 },
  { label: "4:3", w: 1024, h: 768 },
] as const;

const PRESET_SIZE_STRINGS = new Set(SIZE_OPTIONS.map((s) => `${s.w}x${s.h}`));

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
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Dedicated image-generation workbench (v2.1).
 *
 * Layout:
 *   - Left parameter panel: prompt, reference images, model, size, generate.
 *   - Center canvas: live preview / loading / empty state.
 *
 * Supports both text-to-image and image-to-image/reference workflows.
 */
export function ImageGenView() {
  const [prompt, setPrompt] = useState("");
  const [customSize, setCustomSize] = useState("1024x1024");
  const [referenceImages, setReferenceImages] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ImageGeneration | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const providers = useProvidersStore((s) => s.providers);
  const imageProviderId = useProvidersStore((s) => s.imageProviderId);
  const imageModelKey = useProvidersStore((s) => s.imageModelKey);
  const history = useImageGenStore((s) => s.history);
  const addHistory = useImageGenStore((s) => s.add);
  const loadHistory = useImageGenStore((s) => s.load);
  const openSettings = useWindowStore((s) => s.openSettings);
  const switchToChat = useWindowStore((s) => s.switchToChat);

  useEffect(() => {
    void loadHistory().then(() => {
      setSelected((prev) => prev ?? useImageGenStore.getState().history[0] ?? null);
    });
    textareaRef.current?.focus();
  }, [loadHistory]);

  // Listen to sidebar selection / "new image" events.
  useEffect(() => {
    const onSelect = (e: Event) => {
      const detail = (e as CustomEvent<{ id?: string }>).detail;
      const id = detail?.id;
      if (!id) return;
      const item = useImageGenStore.getState().history.find((g) => g.id === id);
      if (item) loadIntoWorkbench(item);
    };
    const onNew = () => {
      setSelected(null);
      setError(null);
      setPrompt("");
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

  // Sync selection when history is cleared/updated externally.
  useEffect(() => {
    if (!selected && history.length > 0) {
      setSelected(history[0]);
    }
  }, [history, selected]);

  // Paste reference images anywhere in the image view.
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
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
    return currentModel();
  }, [imageProviderId, imageModelKey, providers]);

  const loadIntoWorkbench = (item: ImageGeneration) => {
    setSelected(item);
    setPrompt(item.prompt);
    setReferenceImages(getReferenceImages(item));
    if (item.sizeLabel) {
      setCustomSize(item.sizeLabel);
    }
  };

  const appendReferenceFiles = async (files: File[]) => {
    setError(null);
    try {
      const dataUrls = await Promise.all(files.map((f) => readFileAsDataUrl(f)));
      setReferenceImages((prev) => [...prev, ...dataUrls].slice(0, 4));
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取参考图失败");
    }
  };

  const removeReference = (idx: number) => {
    setReferenceImages((prev) => prev.filter((_, i) => i !== idx));
  };

  const generate = async () => {
    const text = prompt.trim();
    if (!text || generating || !imageModel) return;

    const parsed = parseSize(customSize);
    if (!parsed) {
      setError("尺寸格式无效，请输入如 512x512 的格式（最小 64 像素）");
      return;
    }
    const { w, h } = parsed;
    const isPreset = PRESET_SIZE_STRINGS.has(`${w}x${h}`);

    setGenerating(true);
    setError(null);
    try {
      const dataUrl = await generateImage(
        imageModel.provider.id,
        imageModel.model.modelKey,
        text,
        `${w}x${h}`,
        isPreset ? undefined : w,
        isPreset ? undefined : h,
        referenceImages.length > 0 ? referenceImages : undefined,
      );
      const sizeLabel = `${w}x${h}`;
      await addHistory(text, dataUrl, sizeLabel, referenceImages);
      const item = useImageGenStore.getState().history[0];
      if (item) {
        setSelected(item);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
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
      a.download = `chatfloat-${selected.id}.png`;
      a.click();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteSelected = async () => {
    if (!selected) return;
    await useImageGenStore.getState().remove(selected.id);
    setSelected(useImageGenStore.getState().history[0] ?? null);
  };

  const modelLabel = imageModel
    ? `${imageModel.provider.name} · ${imageModel.model.displayName}`
    : providers.length === 0
      ? "未配置服务商"
      : "未选择图像模型";

  return (
    <div className="flex min-h-0 flex-1">
      {/* Left parameter panel */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-panel-2">
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
          {/* Prompt */}
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-ink">
              <Wand2 size={13} /> 画面描述
            </label>
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onKeyDown}
              rows={4}
              placeholder="描述你想生成的图片，Enter 生成，Shift+Enter 换行"
              className="resize-none rounded-input border border-line bg-panel px-3 py-2.5 text-sm leading-5 text-ink outline-none placeholder:text-ink-2 focus:border-[var(--cf-text-2)]"
            />
          </div>

          {/* Reference images */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-1.5 text-xs font-medium text-ink">
                <ImagePlus size={13} /> 参考图
                <span className="text-[10px] font-normal text-ink-2">（可选，最多 4 张）</span>
              </label>
              {referenceImages.length > 0 && (
                <button
                  onClick={() => setReferenceImages([])}
                  className="text-[10px] text-ink-2 hover:text-danger"
                >
                  清空
                </button>
              )}
            </div>

            <div
              ref={dropRef}
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
              onClick={() => fileInputRef.current?.click()}
              className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-input border border-dashed px-3 py-4 transition-colors ${
                isDragging
                  ? "border-[var(--cf-accent)] bg-panel"
                  : "border-line bg-panel hover:bg-panel-2"
              }`}
            >
              <Upload size={18} className="text-ink-2" />
              <span className="text-center text-[11px] text-ink-2">
                点击 / 拖拽 / 粘贴添加图片
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length) void appendReferenceFiles(files);
                  e.currentTarget.value = "";
                }}
              />
            </div>

            {referenceImages.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {referenceImages.map((src, idx) => (
                  <div
                    key={`${src.slice(-32)}-${idx}`}
                    className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-btn border border-line"
                  >
                    <img
                      src={src}
                      alt={`参考图 ${idx + 1}`}
                      className="h-full w-full object-cover"
                    />
                    <button
                      onClick={() => removeReference(idx)}
                      className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-danger text-white opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Model */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink">生成模型</label>
            <div className="flex items-center gap-2 rounded-input border border-line bg-panel px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-xs text-ink-2" title={modelLabel}>
                {modelLabel}
              </span>
              <button
                onClick={openSettings}
                title="更换图像模型"
                className="text-ink-2 transition-colors hover:text-ink"
              >
                <Settings2 size={13} />
              </button>
            </div>
            {!imageModel && (
              <p className="text-[11px] text-danger">
                未配置图像模型，请在设置 → 模型设置中配置
              </p>
            )}
          </div>

          {/* Size */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink">尺寸</label>
            <div className="grid grid-cols-3 gap-1.5">
              {SIZE_OPTIONS.map((s) => {
                const key = `${s.w}x${s.h}`;
                const active = customSize === key;
                return (
                  <button
                    key={key}
                    onClick={() => setCustomSize(key)}
                    className={`rounded-md border px-1 py-1.5 text-[11px] transition-colors ${
                      active
                        ? "border-[var(--cf-accent)] bg-panel text-ink"
                        : "border-line bg-panel text-ink-2 hover:bg-panel-2"
                    }`}
                    title={`${s.w}x${s.h}`}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <input
                value={customSize}
                onChange={(e) => setCustomSize(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void generate();
                  }
                }}
                placeholder="宽x高"
                spellCheck={false}
                className="flex-1 rounded-md border border-line bg-panel px-2 py-1 text-xs text-ink outline-none placeholder:text-ink-2 focus:border-[var(--cf-text-2)]"
              />
              <span className="text-[10px] text-ink-2">自定义</span>
            </div>
          </div>

          {/* Error */}
          {error && (
            <p className="rounded-btn border border-[color-mix(in_srgb,var(--cf-danger)_35%,transparent)] px-2.5 py-1.5 text-xs leading-5 text-danger">
              {error}
            </p>
          )}
        </div>

        {/* Generate button */}
        <div className="shrink-0 border-t border-line p-3">
          <button
            onClick={() => void generate()}
            disabled={!prompt.trim() || generating || !imageModel}
            className="flex w-full items-center justify-center gap-1.5 rounded-input bg-accent py-2.5 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {generating ? (
              <>
                <Loader2 size={16} className="animate-spin" /> 生成中…
              </>
            ) : (
              <>
                <Sparkles size={16} /> 立即生成
              </>
            )}
          </button>
          <button
            onClick={switchToChat}
            className="mt-2 w-full text-center text-[11px] text-ink-2 hover:text-ink hover:underline"
          >
            ← 返回对话模式
          </button>
        </div>
      </aside>

      {/* Center canvas */}
      <main className="relative flex min-w-0 flex-1 flex-col items-center justify-center bg-[var(--cf-bg)] p-4">
        {generating ? (
          <div className="flex flex-col items-center gap-3 text-ink-2">
            <Loader2 size={32} className="animate-spin" />
            <p className="text-xs">正在创作中，请稍候…</p>
          </div>
        ) : selected ? (
          <div className="flex max-h-full w-full max-w-3xl flex-col items-center gap-3">
            <div
              className="group relative flex max-h-[70vh] w-full cursor-zoom-in items-center justify-center overflow-hidden rounded-btn border border-line bg-panel shadow-sm"
              onClick={() => setPreviewOpen(true)}
            >
              <img
                src={selected.imageData}
                alt={selected.prompt}
                className="max-h-full max-w-full object-contain"
              />
              <div className="pointer-events-none absolute inset-0 flex items-start justify-end p-2 opacity-0 transition-opacity group-hover:opacity-100">
                <span className="rounded-btn bg-panel px-2 py-1 text-[11px] text-ink shadow-sm">
                  <Maximize2 size={11} className="inline align-text-bottom" /> 点击预览
                </span>
              </div>
            </div>

            <div className="flex w-full max-w-2xl items-center gap-3 rounded-input border border-line bg-panel px-3 py-2 shadow-sm">
              <p className="min-w-0 flex-1 truncate text-xs text-ink-2" title={selected.prompt}>
                {selected.prompt}
                {selected.sizeLabel && (
                  <span className="ml-2 text-[10px] opacity-70">{selected.sizeLabel}</span>
                )}
              </p>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={downloadSelected}
                  className="flex items-center gap-1 rounded-btn border border-line px-2.5 py-1 text-xs text-ink transition-colors hover:bg-panel-2"
                >
                  <Download size={12} /> 下载
                </button>
                <button
                  onClick={() => void deleteSelected()}
                  className="flex items-center gap-1 rounded-btn border border-line px-2.5 py-1 text-xs text-danger transition-colors hover:bg-panel-2"
                >
                  <Trash2 size={12} /> 删除
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 text-center text-ink-2">
            <div className="grid h-16 w-16 place-items-center rounded-full bg-panel-2">
              <Sparkles size={28} className="opacity-40" />
            </div>
            <div className="max-w-xs space-y-1">
              <p className="text-sm font-medium text-ink">图像生成工作台</p>
              <p className="text-xs leading-5">
                在左侧面板输入描述、上传参考图，即可开始创作。
                <br />
                支持文生图与参考图生图。
              </p>
            </div>
          </div>
        )}
      </main>

      {/* Full-screen preview */}
      {previewOpen && selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setPreviewOpen(false)}
        >
          <img
            src={selected.imageData}
            alt={selected.prompt}
            className="max-h-full max-w-full rounded-btn object-contain shadow-2xl"
          />
        </div>
      )}
    </div>
  );
}
