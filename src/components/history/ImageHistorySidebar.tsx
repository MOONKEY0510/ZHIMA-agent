import { useState } from "react";
import { Trash2, X } from "lucide-react";
import { useImageGenStore } from "../../stores/imagegen-store";
import { relativeTime } from "../../lib/time";

/**
 * History sidebar for the image generation mode (shown in full mode).
 * Lists every generated image; clicking one selects it for preview.
 */
export function ImageHistorySidebar() {
  const history = useImageGenStore((s) => s.history);
  const remove = useImageGenStore((s) => s.remove);
  const clear = useImageGenStore((s) => s.clear);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const select = (id: string) => {
    setSelectedId(id);
    // Broadcast selection to the main view.
    window.dispatchEvent(new CustomEvent("imagegen-select", { detail: { id } }));
  };

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-panel-2">
      <div className="flex items-center gap-2 border-b border-line px-3 pb-2.5 pt-3">
        <p className="flex-1 font-display text-[0.9375rem] font-semibold text-ink">生成历史</p>
        {confirmingClear ? (
          <span className="flex items-center gap-1">
            <button
              onClick={() => {
                void clear();
                setConfirmingClear(false);
                setSelectedId(null);
              }}
              className="rounded bg-danger px-1.5 py-0.5 text-meta text-white"
            >
              确认清空
            </button>
            <button
              onClick={() => setConfirmingClear(false)}
              className="text-ink-2 hover:text-ink"
            >
              <X size={11} />
            </button>
          </span>
        ) : (
          <button
            onClick={() => history.length > 0 && setConfirmingClear(true)}
            disabled={history.length === 0}
            className="text-meta text-danger transition-opacity hover:opacity-80 disabled:opacity-30"
          >
            清空
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {history.length === 0 && (
          <p className="px-2 py-10 text-center text-meta text-ink-3">暂无生成记录</p>
        )}

        {history.map((g) => {
          const active = g.id === selectedId;
          return (
            <div
              key={g.id}
              onClick={() => select(g.id)}
              className={`group relative mb-1.5 flex cursor-pointer items-center gap-2 rounded-btn p-1.5 transition-colors ${
                active
                  ? "bg-panel shadow-sm before:absolute before:left-0 before:top-1.5 before:h-[calc(100%-0.75rem)] before:w-0.5 before:rounded-full before:bg-[var(--cf-accent)]"
                  : "hover:bg-panel"
              }`}
            >
              <img
                src={g.imageData}
                alt={g.prompt}
                className="h-11 w-11 shrink-0 rounded-btn border border-line object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.8125rem] leading-4 text-ink">
                  {g.prompt || "（无提示词）"}
                </p>
                <p className="mt-0.5 text-meta leading-4 text-ink-3">
                  {relativeTime(g.createdAt)}
                  {g.sizeLabel ? ` · ${g.sizeLabel}` : ""}
                </p>
              </div>
              {confirmingId === g.id ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void remove(g.id).then(() => setConfirmingId(null));
                  }}
                  className="shrink-0 rounded bg-danger px-1.5 py-0.5 text-meta text-white"
                >
                  确认
                </button>
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmingId(g.id);
                  }}
                  className="shrink-0 text-ink-3 opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                  title="删除"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
