import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Search, Settings2, Star } from "lucide-react";
import { useProvidersStore } from "../../stores/providers-store";
import { useWindowStore } from "../../stores/window-store";
import { useChatStore, type ModelTarget } from "../../stores/chat-store";
import type { ModelEntry, ProviderView } from "../../types";

/** Maximum models compared in one turn (mirrors the backend cap). */
const MAX_COMPARE = 4;

/**
 * Title-bar model switcher (plan §3.1 B: 顶部显示当前模型，点击可快速切换).
 * Shows favorites first, then models grouped by provider.
 */
export function ModelPicker() {
  const providers = useProvidersStore((s) => s.providers);
  const defaultProviderId = useProvidersStore((s) => s.defaultProviderId);
  const defaultModelKey = useProvidersStore((s) => s.defaultModelKey);
  const select = useProvidersStore((s) => s.select);
  const toggleFavorite = useProvidersStore((s) => s.toggleFavorite);
  const openSettings = useWindowStore((s) => s.openSettings);
  const fullMode = useWindowStore((s) => s.fullMode);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Multi-model comparison (P1-6): pick up to MAX_COMPARE models.
  const compareTargets = useChatStore((s) => s.compareTargets);
  const setCompareTargets = useChatStore((s) => s.setCompareTargets);
  const [compareMode, setCompareMode] = useState(false);
  const [draft, setDraft] = useState<ModelTarget[]>([]);

  const openPicker = () => {
    setDraft(compareTargets);
    setCompareMode(compareTargets.length > 0);
    setOpen((v) => !v);
  };

  const toggleDraft = (providerId: string, modelKey: string) => {
    setDraft((prev) => {
      const exists = prev.some((t) => t.providerId === providerId && t.modelKey === modelKey);
      if (exists) {
        return prev.filter((t) => !(t.providerId === providerId && t.modelKey === modelKey));
      }
      if (prev.length >= MAX_COMPARE) return prev;
      return [...prev, { providerId, modelKey }];
    });
  };

  const inDraft = (providerId: string, modelKey: string) =>
    draft.some((t) => t.providerId === providerId && t.modelKey === modelKey);

  // Derive the current selection reactively from the subscribed store fields.
  const defaultProvider = providers.find((p) => p.id === defaultProviderId) ?? providers[0];
  const selection = defaultProvider
    ? {
        provider: defaultProvider,
        model:
          defaultProvider.models.find((m) => m.modelKey === defaultModelKey) ??
          defaultProvider.models[0],
      }
    : null;

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const q = query.trim().toLowerCase();
  const matches = (p: ProviderView, m: ModelEntry) =>
    !q ||
    m.modelKey.toLowerCase().includes(q) ||
    m.displayName.toLowerCase().includes(q) ||
    p.name.toLowerCase().includes(q);

  /** Sort models within a provider: alphabetical first, then by name length
   *  (shorter first) for readability. */
  const sortModels = (a: ModelEntry, b: ModelEntry) =>
    a.displayName.localeCompare(b.displayName) ||
    a.displayName.length - b.displayName.length;

  const favorites = useMemo(
    () =>
      providers.flatMap((p) =>
        p.models.filter((m) => m.isFavorite && matches(p, m)).map((m) => ({ p, m })),
      ).sort((a, b) => sortModels(a.m, b.m)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [providers, q],
  );

  /** Select a model, or toggle it when building a comparison. */
  const pick = async (p: ProviderView, m: ModelEntry) => {
    if (compareMode) {
      toggleDraft(p.id, m.modelKey);
      return;
    }
    await select(p.id, m.modelKey);
    setOpen(false);
  };

  const label =
    compareTargets.length >= 2
      ? `对比 ${compareTargets.length} 个模型`
      : selection
        ? `${selection.provider.name} · ${selection.model.displayName}`
        : providers.length === 0
          ? "未配置服务商"
          : "未选择模型";

  return (
    <>
      <button
        onClick={openPicker}
        className="flex min-w-0 max-w-[min(42vw,320px)] items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink"
        title="切换模型"
      >
        <span className="truncate">{label}</span>
        <ChevronDown size={12} className="shrink-0" />
      </button>

      {open && (
        <>
          {/* Click-away layer covering the whole window */}
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />

          <div
            className={`fixed top-9 z-40 flex max-h-[min(80vh,32rem)] w-full max-w-[420px] flex-col overflow-hidden rounded-input border border-line bg-panel shadow-lg ${
              fullMode ? "left-3 right-auto" : "inset-x-2 mx-auto"
            }`}
          >
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <Search size={13} className="text-ink-2" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    // Claim the key so the global Esc-to-hide leaves the
                    // window alone and just closes this dropdown.
                    e.preventDefault();
                    e.stopPropagation();
                    setOpen(false);
                  }
                }}
                placeholder="搜索模型或服务商…"
                className="flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-2"
              />
              <button
                type="button"
                onClick={() => setCompareMode((v) => !v)}
                title={`多选模型对比：同一问题同时发送给最多 ${MAX_COMPARE} 个模型`}
                className={`shrink-0 rounded-btn border px-1.5 py-0.5 text-[11px] transition-colors ${
                  compareMode
                    ? "border-transparent bg-accent font-medium text-accent-fg"
                    : "border-line text-ink-2 hover:bg-panel-2 hover:text-ink"
                }`}
              >
                对比
              </button>
            </div>

            <div className="flex-1 overflow-y-auto py-1">
              {providers.length === 0 && (
                <p className="px-3 py-4 text-center text-xs text-ink-2">
                  还没有服务商，请先在设置中添加
                </p>
              )}

              {favorites.length > 0 && (
                <Section title="收藏">
                  {favorites.map(({ p, m }) => (
                    <ModelRow
                      key={`${p.id}/${m.modelKey}`}
                      provider={p}
                      model={m}
                      selected={p.id === defaultProviderId && m.modelKey === defaultModelKey}
                      selectable={compareMode}
                      checked={inDraft(p.id, m.modelKey)}
                      onPick={() => void pick(p, m)}
                      onStar={() => void toggleFavorite(p.id, m.modelKey)}
                    />
                  ))}
                </Section>
              )}

              {providers.map((p) => {
                const models = p.models.filter((m) => matches(p, m)).sort(sortModels);
                if (models.length === 0) return null;
                return (
                  <Section key={p.id} title={p.name}>
                    {models.map((m) => (
                      <ModelRow
                        key={`${p.id}/${m.modelKey}`}
                        provider={p}
                        model={m}
                        selected={p.id === defaultProviderId && m.modelKey === defaultModelKey}
                        selectable={compareMode}
                        checked={inDraft(p.id, m.modelKey)}
                        onPick={() => void pick(p, m)}
                        onStar={() => void toggleFavorite(p.id, m.modelKey)}
                      />
                    ))}
                  </Section>
                );
              })}
            </div>

            {compareMode ? (
              <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2">
                <span className="text-[11px] text-ink-2">
                  已选 {draft.length}/{MAX_COMPARE}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setDraft([])}
                    disabled={draft.length === 0}
                    className="rounded-btn border border-line px-2 py-1 text-[11px] text-ink-2 transition-colors hover:bg-panel-2 disabled:opacity-40"
                  >
                    清空
                  </button>
                  <button
                    type="button"
                    disabled={draft.length < 2}
                    title={draft.length < 2 ? "至少选择 2 个模型" : "关闭选择，输入问题后一起发送"}
                    onClick={() => {
                      setCompareTargets(draft);
                      setOpen(false);
                    }}
                    className="rounded-btn bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
                  >
                    开始对比
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => {
                  setOpen(false);
                  openSettings();
                }}
                className="flex items-center gap-1.5 border-t border-line px-3 py-2 text-xs text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink"
              >
                <Settings2 size={12} /> 管理服务商与模型…
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="px-3 pb-0.5 pt-2 text-[11px] text-ink-2">{title}</p>
      {children}
    </div>
  );
}

function ModelRow({
  provider,
  model,
  selected,
  selectable = false,
  checked = false,
  onPick,
  onStar,
}: {
  provider: ProviderView;
  model: ModelEntry;
  selected: boolean;
  /** Compare mode: show a checkbox and let the row toggle the selection. */
  selectable?: boolean;
  checked?: boolean;
  onPick: () => void;
  onStar: () => void;
}) {
  return (
    <div
      className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-panel-2 ${
        selected ? "text-ink" : "text-ink-2"
      }`}
      onClick={onPick}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onStar();
        }}
        className="shrink-0 text-ink-2 hover:text-ink"
        title={model.isFavorite ? "取消收藏" : "收藏"}
      >
        <Star
          size={12}
          className={model.isFavorite ? "fill-[var(--cf-success)] text-[var(--cf-success)]" : ""}
        />
      </button>
      {selectable && (
        <span
          className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded border transition-colors ${
            checked ? "border-transparent bg-accent text-accent-fg" : "border-line"
          }`}
        >
          {checked && <Check size={10} />}
        </span>
      )}
      <span className="flex-1 truncate">{model.displayName}</span>
      {!provider.hasApiKey && <span className="text-[10px] text-danger">缺 Key</span>}
      {!selectable && selected && <Check size={13} className="shrink-0 text-success" />}
    </div>
  );
}
