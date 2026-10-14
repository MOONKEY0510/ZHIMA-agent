import { useEffect, useState } from "react";
import {
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useProvidersStore } from "../../../stores/providers-store";
import * as api from "../../../services/providers-api";
import type { ProviderView } from "../../../types";
import { PROVIDER_PRESETS, type ProviderPreset } from "../provider-presets";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Dropdown, Modal, Notice, SettingsSection, FormRow } from "../ui";

export function ModelsTab() {
  const providers = useProvidersStore((s) => s.providers);
  const loaded = useProvidersStore((s) => s.loaded);

  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    if (loaded && providers.length === 0 && editing === null) {
      setEditing("new");
    }
  }, [loaded, providers.length, editing]);

  const editingProvider =
    editing && editing !== "new"
      ? providers.find((p) => p.id === editing) ?? null
      : null;

  return (
    <>
      <ProviderList onEdit={(id) => setEditing(id)} onAdd={() => setEditing("new")} />
      <GenerationSection />
      <VisionSection />
      <ImageGenSection />

      {editing !== null && (
        <Modal
          title={editing === "new" ? "添加服务商" : `编辑服务商 · ${editingProvider?.name ?? ""}`}
          onClose={() => setEditing(null)}
        >
          <ProviderForm provider={editingProvider} onDone={() => setEditing(null)} />
        </Modal>
      )}
    </>
  );
}

function ProviderList({
  onEdit,
  onAdd,
}: {
  onEdit: (id: string) => void;
  onAdd: () => void;
}) {
  const providers = useProvidersStore((s) => s.providers);
  const defaultProviderId = useProvidersStore((s) => s.defaultProviderId);
  const defaultModelKey = useProvidersStore((s) => s.defaultModelKey);
  const refresh = useProvidersStore((s) => s.refresh);

  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const remove = async (id: string) => {
    await api.deleteProvider(id);
    await refresh();
    setConfirmingId(null);
  };

  return (
    <SettingsSection
      title="服务商"
      description="配置 OpenAI 兼容接口。可设置多个服务商并指定默认模型。"
      action={
        <button
          onClick={onAdd}
          className="flex items-center gap-1 rounded-btn border border-line px-2 py-1 text-ui text-ink transition-colors hover:bg-panel-2"
        >
          <Plus size={13} /> 添加
        </button>
      }
    >
      {providers.length === 0 ? (
        <p className="px-4 py-8 text-center text-ui text-ink-2">
          还没有服务商，点击右上角“添加”配置 OpenAI 兼容接口
        </p>
      ) : (
        <div className="space-y-2 p-3">
          {providers.map((p) => {
            const isDefault = p.id === defaultProviderId;
            const defaultModel = isDefault
              ? p.models.find((m) => m.modelKey === defaultModelKey)
              : null;
            return (
              <div
                key={p.id}
                className={`cf-provider-card ${isDefault ? "is-default" : ""}`}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-ui font-medium text-ink">{p.name}</span>
                  {isDefault && defaultModel && (
                    <span className="cf-provider-badge">
                      <Check size={10} />
                      默认 · {defaultModel.displayName}
                    </span>
                  )}
                  <span className="ml-auto flex shrink-0 items-center gap-0.5">
                    <button
                      className="cf-icon-btn"
                      title="编辑"
                      onClick={() => onEdit(p.id)}
                    >
                      <Pencil size={12} />
                    </button>
                    {confirmingId === p.id ? (
                      <button
                        className="flex h-6 items-center gap-1 rounded-md bg-danger px-1.5 text-ui text-white"
                        onClick={() => void remove(p.id)}
                      >
                        确认删除
                      </button>
                    ) : (
                      <button
                        className="cf-icon-btn danger"
                        title="删除"
                        onClick={() => setConfirmingId(p.id)}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-ui text-ink-2">
                  <span className="truncate">{p.baseUrl}</span>
                  <span className="shrink-0">{p.models.length} 个模型</span>
                  <span
                    className={`shrink-0 ${p.hasApiKey ? "text-success" : "text-danger"}`}
                  >
                    {p.hasApiKey ? "Key 已配置" : "缺 API Key"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SettingsSection>
  );
}

function ProviderForm({
  provider,
  onDone,
}: {
  provider: ProviderView | null;
  onDone: () => void;
}) {
  const refresh = useProvidersStore((s) => s.refresh);

  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  // Highlighted vendor preset chip (create mode only).
  const [presetId, setPresetId] = useState<string | null>(null);

  const selectedPreset = PROVIDER_PRESETS.find((p) => p.id === presetId) ?? null;
  const presetConsoleUrl = selectedPreset?.consoleUrl ?? null;

  const applyPreset = (preset: ProviderPreset) => {
    setPresetId(preset.id);
    setName(preset.name);
    setBaseUrl(preset.baseUrl);
    setError(null);
    setTestMsg(null);
  };

  const httpPlainWarning =
    /^http:\/\//i.test(baseUrl.trim()) &&
    !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(baseUrl.trim());

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.upsertProvider({
        id: provider?.id ?? null,
        name: name.trim() || "未命名服务商",
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || null,
      });
      await refresh();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const result = await api.testEndpoint({
        providerId: provider?.id ?? null,
        baseUrl: baseUrl.trim() || null,
        apiKey: apiKey.trim() || null,
      });
      setTestMsg(result);
    } catch (err) {
      setTestMsg({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const inputCls =
    "w-full rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-accent";

  return (
    <div className="space-y-4">
      {!provider && (
        <div>
          <label className="mb-1 block text-xs text-ink-2">常用服务商</label>
          <div className="flex flex-wrap gap-1.5">
            {PROVIDER_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset)}
                className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                  presetId === preset.id
                    ? "border-accent bg-accent text-accent-fg"
                    : "border-line text-ink-2 hover:bg-panel-2 hover:text-ink"
                }`}
              >
                {preset.name}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-ink-2">
            选择后自动填入名称与 Base URL，也可以直接手动填写。
          </p>
        </div>
      )}

      <div>
        <label className="mb-1 block text-xs text-ink-2">名称</label>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setPresetId(null);
          }}
          placeholder="例如：OpenAI / DeepSeek / 本地 Ollama"
          className={inputCls}
        />
      </div>

      <div>
        <label className="mb-1 block text-xs text-ink-2">Base URL</label>
        <input
          value={baseUrl}
          onChange={(e) => {
            setBaseUrl(e.target.value);
            setPresetId(null);
          }}
          placeholder="https://api.openai.com/v1"
          className={inputCls}
          spellCheck={false}
        />
        {httpPlainWarning && (
          <p className="mt-1 text-xs text-danger">
            正在使用非本机的明文 HTTP，API Key 可能被窃听，建议改用 HTTPS。
          </p>
        )}
      </div>

      <div>
        <label className="mb-1 block text-xs text-ink-2">API Key</label>
        <div className="relative">
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              provider?.hasApiKey ? "已配置 · 留空则保持不变" : "sk-..."
            }
            type={showKey ? "text" : "password"}
            className={`${inputCls} pr-9`}
            spellCheck={false}
          />
          <button
            onClick={() => setShowKey(!showKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-2 hover:text-ink"
          >
            {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        </div>
        <p className="mt-1 text-xs text-ink-2">
          保存在 Windows 凭据管理器中，不会写入配置文件。
        </p>
        {presetConsoleUrl && (
          <button
            type="button"
            onClick={() => void openUrl(presetConsoleUrl).catch(() => undefined)}
            className="mt-1 flex items-center gap-1 text-xs text-accent transition-opacity hover:opacity-80"
          >
            <ExternalLink size={11} />
            前往 {selectedPreset?.name} 获取 API Key
          </button>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          onClick={() => void test()}
          disabled={testing || (!baseUrl.trim() && !provider)}
          className="flex items-center gap-1.5 rounded-btn border border-line px-3 py-1.5 text-xs text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
        >
          {testing && <Loader2 size={12} className="animate-spin" />}
          测试连接
        </button>
        <button
          onClick={() => void save()}
          disabled={saving || !baseUrl.trim()}
          className="flex items-center gap-1.5 rounded-btn bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {saving && <Loader2 size={12} className="animate-spin" />}
          保存
        </button>
      </div>

      {error && <Notice ok={false} text={error} />}
      {testMsg && <Notice ok={testMsg.ok} text={testMsg.message} />}

      {provider && <ModelManager provider={provider} />}
    </div>
  );
}

function ModelManager({ provider }: { provider: ProviderView }) {
  const refresh = useProvidersStore((s) => s.refresh);
  const defaultProviderId = useProvidersStore((s) => s.defaultProviderId);
  const defaultModelKey = useProvidersStore((s) => s.defaultModelKey);
  const toggleFavorite = useProvidersStore((s) => s.toggleFavorite);

  const [newModel, setNewModel] = useState("");
  const [fetching, setFetching] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);

  // Candidate models fetched from the upstream /models endpoint.
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  // Fuzzy search over the fetched candidates (substring, case-insensitive).
  const [search, setSearch] = useState("");

  const fetchCandidates = async () => {
    setFetching(true);
    setMsg(null);
    try {
      const ids = await api.fetchModels(provider.id);
      setCandidates(ids);
      // Pre-select nothing by default (existing models are skipped anyway).
      setSelected(new Set());
    } catch (err) {
      setMsg({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setFetching(false);
    }
  };

  const commitAdd = async () => {
    const keys = Array.from(selected);
    if (keys.length === 0) return;
    setAdding(true);
    setMsg(null);
    try {
      await api.addModels(provider.id, keys);
      await refresh();
      setCandidates(null);
      setSelected(new Set());
    } catch (err) {
      setMsg({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setAdding(false);
    }
  };

  const toggleCandidate = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addManual = async () => {
    const key = newModel.trim();
    if (!key) return;
    try {
      await api.addModel(provider.id, key);
      await refresh();
      setNewModel("");
    } catch (err) {
      setMsg({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  };

  const isDefaultHere = defaultProviderId === provider.id;

  // Models already present in the config (skip these in the picker).
  const existingKeys = new Set(provider.models.map((m) => m.modelKey));
  const freshCandidates = candidates
    ? candidates.filter((id) => !existingKeys.has(id))
    : [];

  // Substring fuzzy match, whitespace-separated terms, case-insensitive.
  const q = search.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  const matched = terms.length
    ? freshCandidates.filter((id) => terms.every((t) => id.toLowerCase().includes(t)))
    : freshCandidates;

  // Selecting the "全选匹配项" button adds exactly the currently matched ids.
  const selectAllMatched = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of matched) next.add(id);
      return next;
    });
  };

  return (
    <div className="border-t border-line pt-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs text-ink-2">模型（{provider.models.length}）</p>
        <button
          onClick={() => void fetchCandidates()}
          disabled={fetching || adding || !provider.hasApiKey}
          className="flex items-center gap-1 rounded-btn border border-line px-2 py-1 text-ui text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
          title={provider.hasApiKey ? "从 /v1/models 拉取候选模型" : "需先配置 API Key"}
        >
          {fetching ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          拉取模型
        </button>
      </div>

      <div className="flex gap-1.5">
        <input
          value={newModel}
          onChange={(e) => setNewModel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void addManual();
          }}
          placeholder="手工添加模型 ID，回车确认"
          className="flex-1 rounded-btn border border-line bg-panel-2 px-2.5 py-1 text-xs text-ink outline-none placeholder:text-ink-2 focus:border-accent"
          spellCheck={false}
        />
        <button
          onClick={() => void addManual()}
          className="rounded-btn border border-line px-2 py-1 text-xs text-ink transition-colors hover:bg-panel-2"
        >
          添加
        </button>
      </div>

      {/* Candidate picker shown after a successful fetch */}
      {candidates && (
        <div className="mt-2 rounded-btn border border-line bg-panel-2/60 p-2">
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-ui text-ink-2">
              上游发现 {candidates.length} 个模型，
              {freshCandidates.length === 0
                ? "均已在配置中"
                : `新增可选 ${freshCandidates.length} 个`}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSelected(new Set(freshCandidates))}
                className="text-ui text-ink hover:underline"
              >
                全选
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="text-ui text-ink hover:underline"
              >
                清空
              </button>
              <button
                onClick={() => setCandidates(null)}
                className="grid h-4 w-4 place-items-center text-ink-2 hover:text-ink"
                title="关闭"
              >
                <X size={11} />
              </button>
            </div>
          </div>

          {/* Fuzzy search over the fetched candidates */}
          <div className="mb-1.5 flex items-center gap-1.5">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="输入关键字模糊匹配，如 gpt-4 或 mini"
              className="min-w-0 flex-1 rounded-btn border border-line bg-panel-2 px-2 py-1 text-ui text-ink outline-none placeholder:text-ink-2 focus:border-accent"
              spellCheck={false}
            />
            {terms.length > 0 && (
              <span className="shrink-0 text-meta text-ink-2">
                匹配 {matched.length} 个
              </span>
            )}
          </div>

          {freshCandidates.length === 0 ? (
            <p className="py-2 text-center text-ui text-ink-2">
              无需添加（上游模型都已存在）
            </p>
          ) : matched.length === 0 ? (
            <p className="py-2 text-center text-ui text-ink-2">
              没有匹配“{search.trim()}”的模型
            </p>
          ) : (
            <>
              <div className="max-h-40 space-y-0.5 overflow-y-auto">
                {matched.map((id) => (
                  <label
                    key={id}
                    className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 text-ui hover:bg-panel-2"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(id)}
                      onChange={() => toggleCandidate(id)}
                      className="shrink-0"
                    />
                    <span className="truncate text-ink">{id}</span>
                  </label>
                ))}
              </div>
              <div className="mt-1.5 flex items-center gap-2 border-t border-line pt-1.5">
                <button
                  onClick={() => void commitAdd()}
                  disabled={selected.size === 0 || adding}
                  className="flex items-center gap-1 rounded-btn bg-accent px-2.5 py-1 text-ui text-accent-fg transition-opacity hover:opacity-85 disabled:opacity-40"
                >
                  {adding && <Loader2 size={11} className="animate-spin" />}
                  添加所选（{selected.size}）
                </button>
                {terms.length > 0 && (
                  <button
                    onClick={selectAllMatched}
                    disabled={matched.length === 0}
                    className="rounded-btn border border-line px-2 py-1 text-ui text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
                    title={`勾选当前匹配到的 ${matched.length} 个模型`}
                  >
                    全选匹配项
                  </button>
                )}
                <button
                  onClick={() => setCandidates(null)}
                  className="rounded-btn border border-line px-2 py-1 text-ui text-ink transition-colors hover:bg-panel-2"
                >
                  取消
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {provider.models.length > 0 && (
        <ul className="mt-2 max-h-44 overflow-y-auto">
          {[...provider.models]
            .sort((a, b) => Number(b.isFavorite) - Number(a.isFavorite) || a.sortOrder - b.sortOrder)
            .map((m) => {
              const isDefault = isDefaultHere && m.modelKey === defaultModelKey;
              return (
                <li
                  key={m.modelKey}
                  className="flex items-center gap-2 rounded-btn px-2 py-1.5 text-xs hover:bg-panel-2"
                >
                  <button
                    onClick={() => void toggleFavorite(provider.id, m.modelKey)}
                    title={m.isFavorite ? "取消收藏" : "收藏"}
                    className="shrink-0 text-ink-2 hover:text-ink"
                  >
                    <Star
                      size={12}
                      className={
                        m.isFavorite
                          ? "fill-[var(--cf-success)] text-[var(--cf-success)]"
                          : ""
                      }
                    />
                  </button>
                  <button
                    onClick={() =>
                      void useProvidersStore
                        .getState()
                        .select(provider.id, m.modelKey)
                    }
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    title="设为默认模型"
                  >
                    <span className="truncate text-ink">{m.displayName}</span>
                    {m.displayName !== m.modelKey && (
                      <span className="truncate text-meta text-ink-2">{m.modelKey}</span>
                    )}
                  </button>
                  {isDefault && (
                    <span className="shrink-0 rounded bg-panel-2 px-1.5 py-px text-meta text-success">
                      默认
                    </span>
                  )}
                  <button
                    onClick={() =>
                      void api
                        .removeModel(provider.id, m.modelKey)
                        .then(() => refresh())
                    }
                    className="cf-icon-btn danger h-5 w-5"
                    title="移除模型"
                  >
                    <X size={11} />
                  </button>
                </li>
              );
            })}
        </ul>
      )}

      {msg && <div className="mt-2"><Notice ok={msg.ok} text={msg.message} /></div>}
    </div>
  );
}

function GenerationSection() {
  const generation = useProvidersStore((s) => s.generation);
  const setGeneration = useProvidersStore((s) => s.setGeneration);

  const [tempAuto, setTempAuto] = useState(generation.temperature === null);
  const [temp, setTemp] = useState(generation.temperature ?? 0.7);
  const [tokensAuto, setTokensAuto] = useState(generation.maxTokens === null);
  const [tokens, setTokens] = useState(generation.maxTokens ?? 2048);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    await setGeneration(tempAuto ? null : temp, tokensAuto ? null : tokens);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const inputCls =
    "w-20 rounded-btn border border-line bg-panel-2 px-2 py-1 text-ui text-ink outline-none focus:border-accent disabled:opacity-40";

  return (
    <SettingsSection
      title="生成参数"
      description="“自动”表示不向接口发送该参数，由服务端决定。"
    >
      <div className="cf-form-row">
        <div className="flex-1">
          <p className="text-ui font-medium text-ink">随机性（温度）</p>
          <p className="mt-0.5 text-meta text-ink-2">越低越严谨稳定，越高越发散有创意</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <label className="flex items-center gap-1 text-meta text-ink">
            <input
              type="checkbox"
              checked={tempAuto}
              onChange={(e) => setTempAuto(e.target.checked)}
              className="rounded border-line"
            />
            自动
          </label>
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={temp}
            disabled={tempAuto}
            onChange={(e) => setTemp(Number(e.target.value))}
            className={inputCls}
          />
        </div>
      </div>

      <div className="cf-form-row">
        <div className="flex-1">
          <p className="text-ui font-medium text-ink">最大输出</p>
          <p className="mt-0.5 text-meta text-ink-2">模型单次回复的最大 token 数</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <label className="flex items-center gap-1 text-meta text-ink">
            <input
              type="checkbox"
              checked={tokensAuto}
              onChange={(e) => setTokensAuto(e.target.checked)}
              className="rounded border-line"
            />
            自动
          </label>
          <input
            type="number"
            min={1}
            step={256}
            value={tokens}
            disabled={tokensAuto}
            onChange={(e) => setTokens(Number(e.target.value))}
            className={inputCls}
          />
          <span className="text-meta text-ink-3">tokens</span>
        </div>
      </div>

      {!tokensAuto && tokens < 16 && (
        <p className="px-4 py-2 text-ui text-danger">
          最大输出长度过小，模型可能只返回几个字符。
        </p>
      )}

      <div className="flex items-center justify-end gap-2 px-3 py-2">
        <button
          onClick={() => void save()}
          className="flex items-center gap-1 rounded-btn bg-accent px-3 py-1 text-ui font-medium text-accent-fg transition-colors hover:opacity-90"
        >
          {saved && <Check size={13} />}
          {saved ? "已保存" : "保存参数"}
        </button>
      </div>
    </SettingsSection>
  );
}

function VisionSection() {
  const providers = useProvidersStore((s) => s.providers);
  const visionProviderId = useProvidersStore((s) => s.visionProviderId);
  const visionModelKey = useProvidersStore((s) => s.visionModelKey);
  const setVisionModel = useProvidersStore((s) => s.setVisionModel);
  const toggleVision = useProvidersStore((s) => s.toggleVision);
  const refresh = useProvidersStore((s) => s.refresh);

  // All models across all providers, for the vision model dropdown.
  const allModels = providers.flatMap((p) =>
    p.models.map((m) => ({ provider: p, model: m })),
  );

  return (
    <SettingsSection
      title="视觉模型"
      description="当用户发送图片但当前模型不支持视觉时，使用此模型描述图片内容后转发给当前模型。"
    >
      <FormRow label="默认视觉模型">
        <Dropdown
          value={
            visionProviderId && visionModelKey
              ? `${visionProviderId}::${visionModelKey}`
              : ""
          }
          onChange={(val) => {
            if (!val) return;
            const [pid, mkey] = val.split("::");
            void setVisionModel(pid, mkey);
          }}
          options={[
            { value: "", label: "未配置" },
            ...allModels.map(({ provider, model }) => ({
              value: `${provider.id}::${model.modelKey}`,
              label: `${provider.name} · ${model.displayName}`,
            })),
          ]}
        />
      </FormRow>

      <div className="border-t border-line p-3">
        <p className="mb-1 text-xs font-medium text-ink">模型视觉能力标记</p>
        <p className="mb-2 text-ui text-ink-2">
          标记为“视觉”的模型将直接接收图片，无需通过视觉模型中转。
        </p>
        <div className="max-h-40 space-y-0.5 overflow-y-auto">
          {allModels.map(({ provider, model }) => (
            <label
              key={`${provider.id}::${model.modelKey}`}
              className="flex items-center gap-2 rounded-btn px-2 py-1.5 text-xs hover:bg-panel-2"
            >
              <input
                type="checkbox"
                checked={model.supportsVision}
                onChange={async () => {
                  await toggleVision(provider.id, model.modelKey);
                  await refresh();
                }}
                className="rounded border-line"
              />
              <Eye size={13} className="text-accent/70" />
              <span className="truncate text-ink">{model.displayName}</span>
              <span className="truncate text-meta text-ink-2">{provider.name}</span>
            </label>
          ))}
        </div>
      </div>
    </SettingsSection>
  );
}

function ImageGenSection() {
  const providers = useProvidersStore((s) => s.providers);
  const imageProviderId = useProvidersStore((s) => s.imageProviderId);
  const imageModelKey = useProvidersStore((s) => s.imageModelKey);
  const setImageModel = useProvidersStore((s) => s.setImageModel);

  const allModels = providers.flatMap((p) =>
    p.models.map((m) => ({ provider: p, model: m })),
  );

  return (
    <SettingsSection
      title="图像生成"
      description="配置后可在文生图模式中生成图片（调用 /v1/images/generations 接口）。"
    >
      <FormRow label="文生图模型">
        <Dropdown
          value={
            imageProviderId && imageModelKey
              ? `${imageProviderId}::${imageModelKey}`
              : ""
          }
          onChange={(val) => {
            if (!val) return;
            const [pid, mkey] = val.split("::");
            void setImageModel(pid, mkey);
          }}
          options={[
            { value: "", label: "未配置" },
            ...allModels.map(({ provider, model }) => ({
              value: `${provider.id}::${model.modelKey}`,
              label: `${provider.name} · ${model.displayName}`,
            })),
          ]}
        />
      </FormRow>
    </SettingsSection>
  );
}
