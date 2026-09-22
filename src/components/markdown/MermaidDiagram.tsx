import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  Download,
  Loader2,
  Maximize2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useSettingsStore } from "../../stores/settings-store";
import { diagramTheme, isLightColor } from "../../lib/mermaid-theme";
import { renderMermaidDiagram } from "../../lib/mermaid-render";
import { exportDiagramPng, exportDiagramSvg } from "../../lib/mermaid-export";

/**
 * Rendered `mermaid` code block (画图模块).
 *
 * Follows the active diagram style (跟随主题 / 科技蓝 / 莫兰迪 / 手绘风) and
 * re-renders when the app theme changes.  Invalid syntax degrades to an
 * error banner plus the source instead of a broken image.
 */

type RenderState =
  | { status: "loading" }
  | { status: "ready"; svg: string }
  | { status: "error"; message: string };

/** The concrete theme applied to the document (`light` / `dark` / `warm`…). */
function useResolvedTheme(): string {
  const [resolved, setResolved] = useState(
    () => document.documentElement.dataset.theme ?? "light",
  );
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setResolved(document.documentElement.dataset.theme ?? "light");
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return resolved;
}

export const MermaidDiagram = memo(function MermaidDiagram({
  code,
}: {
  code: string;
}) {
  const style = useSettingsStore((s) => s.diagramStyle);
  const resolvedTheme = useResolvedTheme();
  const theme = useMemo(
    () => diagramTheme(style, resolvedTheme),
    [style, resolvedTheme],
  );

  const trimmed = code.trim();
  const [state, setState] = useState<RenderState>({ status: "loading" });
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState<"png" | "svg" | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void renderMermaidDiagram(trimmed, theme)
      .then((svg) => {
        if (!cancelled) setState({ status: "ready", svg });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [trimmed, theme]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(trimmed);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Ignore clipboard failures.
    }
  }, [trimmed]);

  const exportFile = useCallback(
    async (kind: "png" | "svg", svg: string) => {
      setExporting(kind);
      try {
        if (kind === "svg") await exportDiagramSvg(svg);
        else await exportDiagramPng(svg, theme);
      } catch (error) {
        console.warn("导出流程图失败:", error);
      } finally {
        setExporting(null);
      }
    },
    [theme],
  );

  const svg = state.status === "ready" ? state.svg : null;

  return (
    <div className="group/diagram my-2 overflow-hidden rounded-xl border border-line bg-panel">
      <header className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="text-[11px] uppercase tracking-wide text-ink-2">
          mermaid 图表
        </span>
        <div className="flex items-center gap-0.5">
          {svg && (
            <>
              <ToolButton
                title="导出 PNG"
                disabled={exporting !== null}
                onClick={() => void exportFile("png", svg)}
              >
                {exporting === "png" ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Download size={11} />
                )}
                图片
              </ToolButton>
              <ToolButton
                title="导出 SVG（矢量）"
                disabled={exporting !== null}
                onClick={() => void exportFile("svg", svg)}
              >
                {exporting === "svg" ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Code2 size={11} />
                )}
                SVG
              </ToolButton>
              <ToolButton title="全屏查看" onClick={() => setFullscreen(true)}>
                <Maximize2 size={11} />
                放大
              </ToolButton>
            </>
          )}
          <ToolButton title="复制图表源码" onClick={() => void copy()}>
            {copied ? (
              <Check size={11} className="text-success" />
            ) : (
              <Copy size={11} />
            )}
            {copied ? "已复制" : "复制"}
          </ToolButton>
        </div>
      </header>

      <div className="p-3">
        {state.status === "loading" && (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-ink-2">
            <Loader2 size={14} className="animate-spin" />
            正在渲染图表…
          </div>
        )}

        {state.status === "ready" && (
          <div
            className="cf-diagram-svg overflow-x-auto"
            dangerouslySetInnerHTML={{ __html: state.svg }}
          />
        )}

        {state.status === "error" && (
          <div>
            <div className="flex items-start gap-1.5 rounded-lg border border-[var(--cf-danger)]/40 bg-[var(--cf-danger)]/5 px-2.5 py-2 text-[12px] text-[var(--cf-danger)]">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                <div className="font-medium">图表渲染失败</div>
                <div className="mt-0.5 break-all opacity-80">
                  {state.message}
                </div>
              </div>
            </div>
            <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-panel-2 p-2.5 text-[11px] leading-relaxed text-ink-2">
              {trimmed}
            </pre>
          </div>
        )}
      </div>

      {fullscreen &&
        svg &&
        createPortal(
          <DiagramFullscreen
            svg={svg}
            background={theme.canvas}
            onClose={() => setFullscreen(false)}
          />,
          document.body,
        )}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* fullscreen viewer                                                   */
/* ------------------------------------------------------------------ */

function DiagramFullscreen({
  svg,
  background,
  onClose,
}: {
  svg: string;
  background: string;
  onClose: () => void;
}) {
  const darkChrome = !isLightColor(background);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // React registers `onWheel` as a passive listener, so zooming needs a
  // native non-passive listener to be able to preventDefault.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom((z) =>
        Math.min(8, Math.max(0.2, z * (event.deltaY < 0 ? 1.12 : 0.89))),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragState.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: pos.x,
      originY: pos.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (!drag) return;
    setPos({
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    });
  };

  const endDrag = () => {
    dragState.current = null;
  };

  const reset = () => {
    setZoom(1);
    setPos({ x: 0, y: 0 });
  };

  const chromeText = darkChrome ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.7)";
  const chromeBorder = darkChrome
    ? "rgba(255,255,255,0.2)"
    : "rgba(0,0,0,0.15)";

  return (
    <div
      className="fixed inset-0 z-[999] flex flex-col"
      style={{ background }}
      role="dialog"
      aria-modal="true"
      aria-label="流程图全屏预览"
    >
      <div
        className="flex items-center justify-between border-b px-4 py-2"
        style={{ borderColor: chromeBorder }}
      >
        <span className="text-xs" style={{ color: chromeText }}>
          滚轮缩放 · 拖拽平移 · 按 Esc 退出
        </span>
        <div className="flex items-center gap-1">
          <FullscreenButton
            title="缩小"
            color={chromeText}
            border={chromeBorder}
            onClick={() => setZoom((z) => Math.max(0.2, z * 0.85))}
          >
            <ZoomOut size={14} />
          </FullscreenButton>
          <button
            onClick={reset}
            className="min-w-14 rounded-md border px-2 py-1 text-xs tabular-nums transition-opacity hover:opacity-75"
            style={{ color: chromeText, borderColor: chromeBorder }}
            title="重置缩放"
          >
            {Math.round(zoom * 100)}%
          </button>
          <FullscreenButton
            title="放大"
            color={chromeText}
            border={chromeBorder}
            onClick={() => setZoom((z) => Math.min(8, z * 1.18))}
          >
            <ZoomIn size={14} />
          </FullscreenButton>
          <FullscreenButton
            title="关闭"
            color={chromeText}
            border={chromeBorder}
            onClick={onClose}
          >
            <X size={14} />
          </FullscreenButton>
        </div>
      </div>

      <div
        ref={viewportRef}
        className="relative flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          className="absolute left-1/2 top-1/2 select-none"
          style={{
            transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px)) scale(${zoom})`,
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}

function FullscreenButton({
  title,
  color,
  border,
  onClick,
  children,
}: {
  title: string;
  color: string;
  border: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="rounded-md border p-1.5 transition-opacity hover:opacity-75"
      style={{ color, borderColor: border }}
    >
      {children}
    </button>
  );
}

function ToolButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink disabled:opacity-50"
    >
      {children}
    </button>
  );
}
