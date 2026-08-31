import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Search, Settings2, Star } from "lucide-react";
import { useProvidersStore } from "../../stores/providers-store";
import { useWindowStore } from "../../stores/window-store";
import type { ModelEntry, ProviderView } from "../../types";

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

  const label = selection
    ? `${selection.provider.name} · ${selection.model.displayName}`
    : providers.length === 0
      ? "未配置服务商"
      : "未选择模型";

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
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
                      onPick={async () => {
                        await select(p.id, m.modelKey);
                        setOpen(false);
                      }}
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
                        onPick={async () => {
                          await select(p.id, m.modelKey);
                          setOpen(false);
                        }}
                        onStar={() => void toggleFavorite(p.id, m.modelKey)}
                      />
                    ))}
                  </Section>
                );
              })}
            </div>

            <button
              onClick={() => {
                setOpen(false);
                openSettings();
              }}
              className="flex items-center gap-1.5 border-t border-line px-3 py-2 text-xs text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink"
            >
              <Settings2 size={12} /> 管理服务商与模型…
            </button>
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
  onPick,
  onStar,
}: {
  provider: ProviderView;
  model: ModelEntry;
  selected: boolean;
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
      <span className="flex-1 truncate">{model.displayName}</span>
      {!provider.hasApiKey && <span className="text-[10px] text-danger">缺 Key</span>}
      {selected && <Check size={13} className="shrink-0 text-success" />}
    </div>
  );
}
