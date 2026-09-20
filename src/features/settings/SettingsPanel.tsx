import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Activity,
  Calculator,
  Check,
  ChevronDown,
  Clipboard,
  ClipboardPaste,
  Clock,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  FileType,
  Globe,
  Link as LinkIcon,
  Loader2,
  MonitorUp,
  Pencil,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Palette,
  Image as ImageIcon,
  Wrench,
  Star,
  Bot,
  Trash2,
  X,
  UserCircle,
} from "lucide-react";
import { useSettingsStore, AVATAR_COLORS, type AvatarShape, type PromptPreset } from "../../stores/settings-store";
import { useProvidersStore } from "../../stores/providers-store";
import { useHistoryStore } from "../../services/history-store";
import { useChatStore } from "../../stores/chat-store";
import * as api from "../../services/providers-api";
import * as historyApi from "../../services/history-api";
import * as memoryApi from "../../services/memory-api";
import type { Memory } from "../../services/memory-api";
import * as diagnosticsApi from "../../services/diagnostics-api";
import type { RunTrace } from "../../services/diagnostics-api";
import type { ProviderView, ThemeMode } from "../../types";
import { UpdateSettingsCard } from "../../components/updater/UpdateBanner";
import {
  listTools,
  setToolPolicy,
  type ToolInfo,
  type ToolPolicy,
} from "../../services/tools-api";
import { PROVIDER_PRESETS, type ProviderPreset } from "./provider-presets";
import {
  isBuiltinAssistant,
  type AssistantView,
} from "../../services/assistants-api";
import { sortedAssistants, useAssistantsStore } from "../../stores/assistants-store";
import {
  getWebSearchConfig,
  setWebSearchApiKey,
  setWebSearchConfig,
  testWebSearch,
  type WebSearchConfigView,
  type WebSearchTestResult,
} from "../../services/web-search-api";
import {
  exportData,
  importData,
  previewBackup,
  type BackupPreview,
  type ImportStrategy,
} from "../../services/backup-api";
import {
  addKbFile,
  addKbText,
  addKbUrl,
  deleteKbDocument,
  getKnowledgeConfig,
  listKbDocuments,
  pickKbFile,
  searchKb,
  setKnowledgeConfig,
  type KbDocument,
  type KbHit,
  type KnowledgeView,
} from "../../services/knowledge-api";
import {
  deleteMcpServer,
  listMcpServers,
  parseMcpJson,
  setMcpServerEnabled,
  testMcpServer,
  upsertMcpServer,
  type McpServerConfig,
  type McpServerView,
  type McpToolInfo,
  type McpView,
} from "../../services/mcp-api";

type SettingsTab = "models" | "appearance" | "tools" | "diagnostics" | "general" | "persona";

/** Fully custom dropdown. The browser-native `<select>` popup cannot be
 *  styled consistently across platforms, so we render our own menu.
 *  This gives the same rounded panel, border and hover states as the rest
 *  of the UI. */
function Dropdown({
  value,
  onChange,
  options,
  disabled,
  title,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div ref={ref} className={`relative ${className ?? ""}`} title={title}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-left text-sm text-ink outline-none transition-colors hover:bg-panel focus:border-[var(--cf-text-2)] disabled:opacity-40"
      >
        <span className="truncate">{selected?.label ?? value}</span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-ink-2 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-btn border border-line bg-panel py-1 shadow-lg">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              className={`block w-full px-2.5 py-1.5 text-left text-sm transition-colors ${
                option.value === value
                  ? "bg-accent/15 text-accent"
                  : "text-ink hover:bg-panel-2"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const TABS: { id: SettingsTab; label: string; icon: typeof SettingsIcon }[] = [
  { id: "models", label: "模型设置", icon: SlidersHorizontal },
  { id: "appearance", label: "外观行为", icon: Palette },
  { id: "persona", label: "角色与提示词", icon: UserCircle },
  { id: "tools", label: "Agent 工具", icon: Bot },
  { id: "diagnostics", label: "诊断信息", icon: Activity },
  { id: "general", label: "通用", icon: Wrench },
];

export function SettingsPanel() {
  const [tab, setTab] = useState<SettingsTab>("models");
  // Travel direction, so the incoming page drifts in from the side you
  // moved towards rather than always from the same place.
  const [direction, setDirection] = useState<1 | -1>(1);
  const navRef = useRef<HTMLElement>(null);
  const [marker, setMarker] = useState({ top: 0, height: 0 });

  const go = (next: SettingsTab) => {
    const from = TABS.findIndex((t) => t.id === tab);
    const to = TABS.findIndex((t) => t.id === next);
    if (next === tab) return;
    setDirection(to > from ? 1 : -1);
    setTab(next);
  };

  // The selection pill is measured from the live DOM instead of a hard-coded
  // row height, so it stays correct if labels wrap or the type scale changes.
  useEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
    if (el) setMarker({ top: el.offsetTop, height: el.offsetHeight });
  }, [tab]);

  return (
    <div className="flex min-h-0 flex-1">
      {/* Settings sidebar */}
      <nav
        ref={navRef}
        className="relative flex w-36 shrink-0 flex-col gap-0.5 border-r border-line bg-panel-2 px-2 py-3"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-2 right-2 rounded-btn bg-panel shadow-sm transition-[top,height] duration-300 ease-out"
          style={{ top: marker.top, height: marker.height }}
        />
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              data-tab={t.id}
              onClick={() => go(t.id)}
              className={`relative z-10 flex items-center gap-2 rounded-btn px-2.5 py-1.5 text-xs transition-colors duration-200 ${
                active ? "text-ink" : "text-ink-2 hover:text-ink"
              }`}
            >
              <Icon size={13} />
              {t.label}
            </button>
          );
        })}
      </nav>

      {/* Tab content. Keyed by tab so every switch replays the enter
          animation from a clean mount. */}
      <div className="min-w-0 flex-1 overflow-y-auto px-4 pb-4 pt-1">
        <div
          key={tab}
          className={`cf-settings-page mx-auto w-full max-w-xl ${
            direction === 1 ? "cf-page-enter-next" : "cf-page-enter-prev"
          }`}
        >
          {tab === "models" && <ModelsTab />}
          {tab === "appearance" && <AppearanceTab />}
          {tab === "persona" && <PersonaTab />}
          {tab === "tools" && <AgentToolsTab />}
          {tab === "diagnostics" && <DiagnosticsTab />}
          {tab === "general" && <GeneralTab />}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Models tab — provider list + form + generation params                     */
/* ------------------------------------------------------------------------ */

function ModelsTab() {
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

/* ------------------------------------------------------------------------ */
/* Provider list                                                             */
/* ------------------------------------------------------------------------ */

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
          className="flex items-center gap-1 rounded-btn border border-line px-2 py-1 text-xs text-ink transition-colors hover:bg-panel-2"
        >
          <Plus size={12} /> 添加
        </button>
      }
    >
      {providers.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-ink-2">
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
                  <span className="truncate text-sm font-medium text-ink">{p.name}</span>
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
                        className="flex h-6 items-center gap-1 rounded-md bg-danger px-1.5 text-[11px] text-white"
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
                <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-2">
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

/* ------------------------------------------------------------------------ */
/* Provider create / edit form                                               */
/* ------------------------------------------------------------------------ */

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
    "w-full rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-[var(--cf-text-2)]";

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

/* ------------------------------------------------------------------------ */
/* Model management inside the provider edit form                            */
/* ------------------------------------------------------------------------ */

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
          className="flex items-center gap-1 rounded-btn border border-line px-2 py-1 text-[11px] text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
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
          className="flex-1 rounded-btn border border-line bg-panel-2 px-2.5 py-1 text-xs text-ink outline-none placeholder:text-ink-2 focus:border-[var(--cf-text-2)]"
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
            <p className="text-[11px] text-ink-2">
              上游发现 {candidates.length} 个模型，
              {freshCandidates.length === 0
                ? "均已在配置中"
                : `新增可选 ${freshCandidates.length} 个`}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSelected(new Set(freshCandidates))}
                className="text-[11px] text-ink hover:underline"
              >
                全选
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="text-[11px] text-ink hover:underline"
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
              className="min-w-0 flex-1 rounded-btn border border-line bg-panel-2 px-2 py-1 text-[11px] text-ink outline-none placeholder:text-ink-2 focus:border-[var(--cf-text-2)]"
              spellCheck={false}
            />
            {terms.length > 0 && (
              <span className="shrink-0 text-[10px] text-ink-2">
                匹配 {matched.length} 个
              </span>
            )}
          </div>

          {freshCandidates.length === 0 ? (
            <p className="py-2 text-center text-[11px] text-ink-2">
              无需添加（上游模型都已存在）
            </p>
          ) : matched.length === 0 ? (
            <p className="py-2 text-center text-[11px] text-ink-2">
              没有匹配“{search.trim()}”的模型
            </p>
          ) : (
            <>
              <div className="max-h-40 space-y-0.5 overflow-y-auto">
                {matched.map((id) => (
                  <label
                    key={id}
                    className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] hover:bg-panel-2"
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
                  className="flex items-center gap-1 rounded-btn bg-accent px-2.5 py-1 text-[11px] text-accent-fg transition-opacity hover:opacity-85 disabled:opacity-40"
                >
                  {adding && <Loader2 size={11} className="animate-spin" />}
                  添加所选（{selected.size}）
                </button>
                {terms.length > 0 && (
                  <button
                    onClick={selectAllMatched}
                    disabled={matched.length === 0}
                    className="rounded-btn border border-line px-2 py-1 text-[11px] text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
                    title={`勾选当前匹配到的 ${matched.length} 个模型`}
                  >
                    全选匹配项
                  </button>
                )}
                <button
                  onClick={() => setCandidates(null)}
                  className="rounded-btn border border-line px-2 py-1 text-[11px] text-ink transition-colors hover:bg-panel-2"
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
                      <span className="truncate text-[10px] text-ink-2">{m.modelKey}</span>
                    )}
                  </button>
                  {isDefault && (
                    <span className="shrink-0 rounded bg-panel-2 px-1.5 py-px text-[10px] text-success">
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

/* ------------------------------------------------------------------------ */
/* Generation parameters                                                     */
/* ------------------------------------------------------------------------ */

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
    "w-20 rounded-btn border border-line bg-panel-2 px-2 py-1 text-xs text-ink outline-none focus:border-[var(--cf-text-2)] disabled:opacity-40";

  return (
    <SettingsSection
      title="生成参数"
      description="“自动”表示不向接口发送该参数，由服务端决定。"
    >
      <div className="cf-form-row">
        <div className="flex-1">
          <p className="text-sm font-medium text-ink">随机性（温度）</p>
          <p className="mt-0.5 text-xs text-ink-2">越低越严谨稳定，越高越发散有创意</p>
        </div>
        <div className="flex w-44 shrink-0 items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-ink-2">
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
          <p className="text-sm font-medium text-ink">最大输出</p>
          <p className="mt-0.5 text-xs text-ink-2">模型单次回复的最大 token 数</p>
        </div>
        <div className="flex w-44 shrink-0 items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-ink-2">
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
          <span className="text-xs text-ink-2">tokens</span>
        </div>
      </div>

      {!tokensAuto && tokens < 16 && (
        <p className="px-4 py-2 text-[11px] text-danger">
          最大输出长度过小，模型可能只返回几个字符。
        </p>
      )}

      <div className="flex items-center justify-end gap-2 px-3 py-2">
        <button
          onClick={() => void save()}
          className="flex items-center gap-1 rounded-btn bg-accent px-3 py-1 text-xs font-medium text-accent-fg transition-colors hover:opacity-90"
        >
          {saved && <Check size={12} />}
          {saved ? "已保存" : "保存参数"}
        </button>
      </div>
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------------ */
/* Assistants (P1-7)                                                         */
/* ------------------------------------------------------------------------ */

function AssistantsSection() {
  const assistants = useAssistantsStore((s) => s.assistants);
  const activeId = useAssistantsStore((s) => s.activeId);
  const setActive = useAssistantsStore((s) => s.setActive);
  const remove = useAssistantsStore((s) => s.remove);
  const resetBuiltin = useAssistantsStore((s) => s.resetBuiltin);
  const providers = useProvidersStore((s) => s.providers);

  const [draft, setDraft] = useState<AssistantView | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const newDraft = (): AssistantView => ({
    id: "",
    name: "",
    icon: "🤖",
    description: "",
    systemPrompt: "",
    providerId: null,
    modelKey: null,
    toolPoliciesJson: null,
    sortOrder: 100 + assistants.length,
    createdAt: 0,
    updatedAt: 0,
  });

  const doRemove = async (id: string) => {
    setError(null);
    try {
      await remove(id);
      setConfirmingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const doReset = async (id: string) => {
    setError(null);
    try {
      await resetBuiltin(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const modelLabel = (a: AssistantView) => {
    if (!a.providerId) return "跟随全局模型";
    const provider = providers.find((p) => p.id === a.providerId);
    const model =
      a.modelKey ?? provider?.models[0]?.modelKey ?? "";
    return `${provider?.name ?? "未知服务商"}${model ? ` · ${model}` : ""}`;
  };

  return (
    <SettingsSection
      title="助手"
      description="每个助手带一套角色提示词与模型。选中后新对话即使用它，侧栏顶部可随时切换。"
    >
      <div className="grid grid-cols-2 gap-2 p-3">
        {sortedAssistants(assistants).map((a) => (
          <div key={a.id} className="relative">
            <button
              type="button"
              onClick={() => setActive(a.id)}
              title={a.description ?? undefined}
              className={`cf-template-card w-full ${activeId === a.id ? "is-active" : ""}`}
            >
              <span className="flex items-center gap-1.5 text-xs text-ink">
                <span aria-hidden="true">{a.icon || "🤖"}</span>
                <span className="truncate font-medium">{a.name}</span>
                {activeId === a.id && <Check size={12} className="shrink-0 text-success" />}
              </span>
              <span className="line-clamp-2 text-[10px] leading-4 text-ink-2">
                {a.description || a.systemPrompt.slice(0, 40)}
              </span>
              <span className="truncate text-[10px] text-ink-2/80">{modelLabel(a)}</span>
            </button>
            <span className="absolute right-1.5 top-1.5 flex items-center gap-0.5">
              <button
                type="button"
                className="cf-icon-btn"
                title="编辑"
                onClick={(e) => {
                  e.stopPropagation();
                  setDraft(a);
                }}
              >
                <Pencil size={11} />
              </button>
              {isBuiltinAssistant(a.id) ? (
                <button
                  type="button"
                  className="cf-icon-btn"
                  title="恢复默认（内置助手不可删除）"
                  onClick={(e) => {
                    e.stopPropagation();
                    void doReset(a.id);
                  }}
                >
                  <RefreshCw size={11} />
                </button>
              ) : confirmingId === a.id ? (
                <button
                  type="button"
                  className="cf-icon-btn danger"
                  title="确认删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    void doRemove(a.id);
                  }}
                >
                  <Check size={11} />
                </button>
              ) : (
                <button
                  type="button"
                  className="cf-icon-btn danger"
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmingId(a.id);
                  }}
                >
                  <Trash2 size={11} />
                </button>
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <p className="text-[11px] text-ink-2">
          内置助手可编辑并随时恢复默认；删除自定义助手后，其会话回到全局默认。
        </p>
        <button
          type="button"
          onClick={() => setDraft(newDraft())}
          className="flex shrink-0 items-center gap-1 rounded-btn border border-line px-2 py-1 text-xs text-ink transition-colors hover:bg-panel-2"
        >
          <Plus size={12} /> 新建助手
        </button>
      </div>

      {error && <p className="px-4 pb-2 text-[11px] text-danger">{error}</p>}

      {draft !== null && (
        <Modal
          title={draft.id ? `编辑助手 · ${draft.name}` : "新建助手"}
          onClose={() => setDraft(null)}
        >
          <AssistantForm initial={draft} onDone={() => setDraft(null)} />
        </Modal>
      )}
    </SettingsSection>
  );
}

/** Create / edit form for one assistant. */
function AssistantForm({
  initial,
  onDone,
}: {
  initial: AssistantView;
  onDone: () => void;
}) {
  const save = useAssistantsStore((s) => s.save);
  const providers = useProvidersStore((s) => s.providers);

  const [name, setName] = useState(initial.name);
  const [icon, setIcon] = useState(initial.icon ?? "🤖");
  const [description, setDescription] = useState(initial.description ?? "");
  const [prompt, setPrompt] = useState(initial.systemPrompt);
  const [providerId, setProviderId] = useState(initial.providerId ?? "");
  const [modelKey, setModelKey] = useState(initial.modelKey ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const models = providers.find((p) => p.id === providerId)?.models ?? [];

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await save({
        ...initial,
        name: name.trim(),
        icon: icon.trim() || null,
        description: description.trim() || null,
        systemPrompt: prompt.trim(),
        // A pinned model only makes sense together with a provider.
        providerId: providerId || null,
        modelKey: providerId ? modelKey || null : null,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    "w-full rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-[var(--cf-text-2)]";

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="w-20 shrink-0">
          <label className="mb-1 block text-xs text-ink-2">图标</label>
          <input
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            placeholder="🤖"
            className={`${inputCls} text-center`}
          />
        </div>
        <div className="min-w-0 flex-1">
          <label className="mb-1 block text-xs text-ink-2">名称</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：周报助手"
            className={inputCls}
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs text-ink-2">简介（可选）</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="一句话说明这个助手擅长什么"
          className={inputCls}
        />
      </div>

      <div>
        <label className="mb-1 block text-xs text-ink-2">系统提示词</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
          placeholder="定义这个助手的角色、输出结构与风格"
          className={`${inputCls} resize-none leading-5`}
        />
      </div>

      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <label className="mb-1 block text-xs text-ink-2">服务商</label>
          <Dropdown
            value={providerId}
            onChange={(value) => {
              setProviderId(value);
              setModelKey("");
            }}
            options={[
              { value: "", label: "跟随全局默认" },
              ...providers.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        </div>
        <div className="min-w-0 flex-1">
          <label className="mb-1 block text-xs text-ink-2">模型</label>
          <Dropdown
            value={modelKey}
            onChange={setModelKey}
            disabled={!providerId || models.length === 0}
            options={[
              { value: "", label: providerId ? "该服务商首个模型" : "跟随全局默认" },
              ...models.map((m) => ({
                value: m.modelKey,
                label: m.displayName || m.modelKey,
              })),
            ]}
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="rounded-btn border border-line px-3 py-1.5 text-xs text-ink-2 transition-colors hover:bg-panel-2"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={saving || !name.trim() || !prompt.trim()}
          className="flex items-center gap-1.5 rounded-btn bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {saving && <Loader2 size={12} className="animate-spin" />}
          保存
        </button>
      </div>

      {error && <Notice ok={false} text={error} />}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* System prompt configuration                                               */
/* ------------------------------------------------------------------------ */

function SystemPromptSection() {
  const defaultSystemPrompt = useProvidersStore((s) => s.defaultSystemPrompt);
  const setDefaultSystemPrompt = useProvidersStore((s) => s.setDefaultSystemPrompt);

  const [value, setValue] = useState(defaultSystemPrompt ?? "");
  const [saved, setSaved] = useState(false);

  // Sync local state when the store value changes (e.g. after load).
  useEffect(() => {
    setValue(defaultSystemPrompt ?? "");
  }, [defaultSystemPrompt]);

  const save = async () => {
    const trimmed = value.trim();
    await setDefaultSystemPrompt(trimmed || null);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const clear = async () => {
    setValue("");
    await setDefaultSystemPrompt(null);
  };

  return (
    <SettingsSection
      title="系统提示词"
      description="每次对话开始时自动作为 system 消息发送，用于设定 AI 的角色和行为。留空则不发送。"
    >
      <div className="p-3">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="例如：你是一个简洁可靠的桌面助手，用中文回答。"
          rows={4}
          className="w-full resize-none rounded-btn border border-line bg-panel-2 px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-[var(--cf-text-2)]"
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          {value.trim() && (
            <button
              onClick={() => void clear()}
              className="rounded-btn border border-line px-3 py-1 text-xs text-ink-2 transition-colors hover:bg-panel-2"
            >
              清除
            </button>
          )}
          <button
            onClick={() => void save()}
            className="flex items-center gap-1 rounded-btn bg-accent px-3 py-1 text-xs font-medium text-accent-fg transition-colors hover:opacity-90"
          >
            {saved && <Check size={12} />}
            {saved ? "已保存" : "保存"}
          </button>
        </div>
      </div>
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------------ */
/* Vision model configuration                                                */
/* ------------------------------------------------------------------------ */

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
        <p className="mb-2 text-[11px] text-ink-2">
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
              <span className="truncate text-[10px] text-ink-2">{provider.name}</span>
            </label>
          ))}
        </div>
      </div>
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------------ */
/* Image generation model configuration                                      */
/* ------------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------------ */
/* Persona tab — assistants + system prompt                                  */
/* ------------------------------------------------------------------------ */

function PersonaTab() {
  return (
    <>
      <AssistantsSection />
      <SystemPromptSection />
    </>
  );
}

/* ------------------------------------------------------------------------ */
/* Appearance tab — theme + avatar + hide-on-blur                            */
/* ------------------------------------------------------------------------ */

function AppearanceTab() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const backgroundImage = useSettingsStore((s) => s.backgroundImage);
  const setBackgroundImage = useSettingsStore((s) => s.setBackgroundImage);

  const themeOptions = [
    { value: "system" as ThemeMode, label: "跟随系统" },
    { value: "light" as ThemeMode, label: "浅色" },
    { value: "dark" as ThemeMode, label: "深色" },
    { value: "warm" as ThemeMode, label: "暖色" },
    { value: "rose" as ThemeMode, label: "玫瑰" },
    { value: "spring" as ThemeMode, label: "春日星语" },
  ];

  return (
    <div className="space-y-5">
      <SettingsSection title="主题" description="选择整个应用的配色风格">
        <div className="px-4 py-3">
          <VisualPills options={themeOptions} value={theme} onChange={(v) => void setTheme(v)} />
        </div>
      </SettingsSection>

      <AvatarSettingsSection />

      <BackgroundImageSection image={backgroundImage} onUpload={setBackgroundImage} />
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Network proxy configuration (方案 A - 路由加速)                            */
/* ------------------------------------------------------------------------ */

function ProxySection() {
  const proxyUrl = useProvidersStore((s) => s.proxyUrl);
  const useSystemProxy = useProvidersStore((s) => s.useSystemProxy);
  const setProxy = useProvidersStore((s) => s.setProxy);

  const [url, setUrl] = useState(proxyUrl ?? "");
  const [useSystem, setUseSystem] = useState(useSystemProxy);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Sync when the store changes (e.g. after config load).
  useEffect(() => {
    setUrl(proxyUrl ?? "");
    setUseSystem(useSystemProxy);
  }, [proxyUrl, useSystemProxy]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const trimmed = url.trim();
      // Disable the system-proxy flag when an explicit URL is provided.
      const effectiveSystem = trimmed ? false : useSystem;
      await setProxy(trimmed || null, effectiveSystem);
      setUseSystem(effectiveSystem);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    "w-full rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-sm text-ink outline-none transition-colors focus:border-[var(--cf-text-2)]";

  return (
    <SettingsSection
      title="网络加速"
      description="通过本地代理转发 API 请求，可显著改善直连海外服务的速度与稳定性。"
    >
      <div className="p-3">
        <label className="mb-1 block text-xs text-ink-2">代理地址</label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="例如：http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
          spellCheck={false}
          className={inputCls}
        />
        <p className="mt-1 text-[11px] text-ink-2">
          支持 http://、https://、socks5:// 协议。留空则使用下面的系统代理选项。
        </p>
      </div>
      <FormRow label="使用系统代理" description="读取 Windows 系统代理设置">
        <Dropdown
          value={useSystem ? "on" : "off"}
          onChange={(val) => setUseSystem(val === "on")}
          disabled={url.trim().length > 0}
          options={[
            { value: "off", label: "关闭" },
            { value: "on", label: "开启" },
          ]}
        />
      </FormRow>
      <div className="flex items-center justify-end gap-2 px-3 py-2">
        {url.trim() && (
          <button
            onClick={() => {
              setUrl("");
              setUseSystem(false);
              void setProxy(null, false);
            }}
            className="rounded-btn border border-line px-2.5 py-1 text-xs text-ink-2 transition-colors hover:bg-panel-2"
          >
            清除
          </button>
        )}
        <button
          onClick={() => void save()}
          disabled={saving}
          className="flex items-center gap-1 rounded-btn bg-accent px-3 py-1 text-xs font-medium text-accent-fg transition-colors hover:opacity-90 disabled:opacity-40"
        >
          {saved && <Check size={12} />}
          {saving ? "应用中…" : saved ? "已应用" : "应用"}
        </button>
      </div>
      {error && <p className="px-4 pb-2 text-[11px] text-danger">{error}</p>}
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------------ */
/* Web-search engine (P0-3)                                                  */
/* ------------------------------------------------------------------------ */

const SEARCH_ENGINE_OPTIONS = [
  { value: "duckduckgo", label: "DuckDuckGo（免费，无需 Key）" },
  { value: "tavily", label: "Tavily（需 API Key）" },
  { value: "bocha", label: "博查（需 API Key）" },
  { value: "searxng", label: "SearXNG（自建实例）" },
];

/* ------------------------------------------------------------------------ */
/* Data backup: export / import (P0-4)                                       */
/* ------------------------------------------------------------------------ */

function BackupSection() {
  const [includeImages, setIncludeImages] = useState(false);
  const [includeMemories, setIncludeMemories] = useState(true);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [strategy, setStrategy] = useState<ImportStrategy>("merge");
  const [confirming, setConfirming] = useState(false);

  const doExport = async () => {
    setMessage(null);
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    let path: string | null = null;
    try {
      path = await saveDialog({
        title: "导出芝麻数据",
        defaultPath: `zhima-backup-${stamp}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!path) return;

    setBusy("export");
    try {
      const report = await exportData(path, { includeImages, includeMemories });
      setMessage({
        ok: true,
        text: `已导出 ${report.conversations} 个会话 · ${report.messages} 条消息${
          report.memories ? ` · ${report.memories} 条记忆` : ""
        }${report.images ? ` · ${report.images} 张图片` : ""}（${(report.bytes / 1024).toFixed(1)} KB）`,
      });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const pickImportFile = async () => {
    setMessage(null);
    let path: string | null = null;
    try {
      const picked = await openDialog({
        title: "选择芝麻备份文件",
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      path = typeof picked === "string" ? picked : null;
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!path) return;

    setBusy("import");
    try {
      const info = await previewBackup(path);
      setPendingPath(path);
      setPreview(info);
      setStrategy("merge");
      setConfirming(false);
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const confirmImport = async () => {
    if (!pendingPath) return;
    setBusy("import");
    setMessage(null);
    try {
      const report = await importData(pendingPath, strategy);
      setMessage({
        ok: true,
        text: `导入完成：新增 ${report.conversations} 个会话 · ${report.messages} 条消息 · ${report.memories} 条记忆${
          report.skipped > 0 ? `，跳过 ${report.skipped} 条已存在内容` : ""
        }`,
      });
      setPendingPath(null);
      setPreview(null);
      setConfirming(false);

      // Refresh the sidebar and re-load the open conversation so imported
      // data shows up without a restart.
      await useHistoryStore.getState().refreshList();
      const activeId = useHistoryStore.getState().activeId;
      if (activeId) {
        await useChatStore.getState().loadConversation(activeId);
      }
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsSection
      title="数据备份"
      description="导出/导入会话、记忆与生成图片。备份中不包含 API Key，换机器后需要重新填写。"
    >
      <div className="space-y-2 px-3 pb-2 pt-1">
        <label className="flex items-center gap-2 text-xs text-ink">
          <input
            type="checkbox"
            checked={includeMemories}
            onChange={(e) => setIncludeMemories(e.target.checked)}
            className="rounded border-line"
          />
          包含长期记忆
        </label>
        <label className="flex items-center gap-2 text-xs text-ink">
          <input
            type="checkbox"
            checked={includeImages}
            onChange={(e) => setIncludeImages(e.target.checked)}
            className="rounded border-line"
          />
          包含生成图片（体积较大）
        </label>
      </div>

      <div className="flex items-center justify-end gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => void doExport()}
          disabled={busy !== null}
          className="flex items-center gap-1.5 rounded-btn border border-line px-3 py-1.5 text-xs text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
        >
          {busy === "export" && <Loader2 size={12} className="animate-spin" />}
          导出备份…
        </button>
        <button
          type="button"
          onClick={() => void pickImportFile()}
          disabled={busy !== null}
          className="flex items-center gap-1.5 rounded-btn border border-line px-3 py-1.5 text-xs text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
        >
          {busy === "import" && <Loader2 size={12} className="animate-spin" />}
          导入备份…
        </button>
      </div>

      {preview && (
        <div className="mx-3 mb-2 rounded-btn border border-line bg-panel-2 p-2.5">
          <p className="text-xs text-ink">
            该备份包含 {preview.conversations} 个会话 · {preview.messages} 条消息 ·{" "}
            {preview.memories} 条记忆
            {preview.images > 0 ? ` · ${preview.images} 张图片` : ""}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-2">
            导出于 {new Date(preview.exportedAt).toLocaleString("zh-CN")}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] text-ink">
              <input
                type="radio"
                checked={strategy === "merge"}
                onChange={() => setStrategy("merge")}
                className="border-line"
              />
              合并（保留现有数据）
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-ink">
              <input
                type="radio"
                checked={strategy === "replace"}
                onChange={() => setStrategy("replace")}
                className="border-line"
              />
              替换（先清空现有数据）
            </label>
          </div>

          {strategy === "replace" && (
            <p className="mt-1.5 text-[11px] text-danger">
              替换会删除当前全部会话、记忆与生成图片，且无法撤销。
            </p>
          )}

          <div className="mt-2 flex items-center gap-2">
            {confirming ? (
              <>
                <button
                  type="button"
                  onClick={() => void confirmImport()}
                  disabled={busy !== null}
                  className="rounded-btn bg-danger px-2.5 py-1 text-[11px] text-white transition-opacity hover:opacity-85 disabled:opacity-40"
                >
                  确认导入
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded-btn border border-line px-2.5 py-1 text-[11px] text-ink-2 transition-colors hover:bg-panel"
                >
                  取消
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  className="rounded-btn bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-fg transition-opacity hover:opacity-90"
                >
                  开始导入
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPreview(null);
                    setPendingPath(null);
                  }}
                  className="rounded-btn border border-line px-2.5 py-1 text-[11px] text-ink-2 transition-colors hover:bg-panel"
                >
                  取消
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {message && (
        <p className={`px-4 pb-2 text-[11px] ${message.ok ? "text-ink-2" : "text-danger"}`}>
          {message.text}
        </p>
      )}
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------------ */
/* Knowledge base (P1-9)                                                     */
/* ------------------------------------------------------------------------ */

const KB_SOURCE_LABELS: Record<string, string> = {
  file: "文件",
  url: "网页",
  text: "文本",
};

/* ------------------------------------------------------------------------ */
/* MCP servers (P1-10)                                                       */
/* ------------------------------------------------------------------------ */

function McpSection() {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<McpServerConfig | null>(null);
  const [toolsFor, setToolsFor] = useState<Record<string, McpToolInfo[]>>({});
  const [jsonDraft, setJsonDraft] = useState("");

  const apply = (view: McpView) => setServers(view.servers);

  const refresh = async () => {
    try {
      apply(await listMcpServers());
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      setNotice({ ok: true, text: `${label}完成` });
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const emptyServer = (): McpServerConfig => ({
    id: "",
    name: "",
    command: "",
    args: [],
    env: {},
    enabled: true,
  });

  const applyJson = async () => {
    setNotice(null);
    try {
      const parsed = await parseMcpJson(jsonDraft);
      setEditing({ ...parsed, id: editing?.id ?? "" });
      setJsonDraft("");
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  const inputCls =
    "w-full rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-[var(--cf-text-2)]";

  return (
    <SettingsSection
      title="MCP 服务器"
      description="接入 Model Context Protocol 工具服务器（stdio）。其工具会出现在 Agent 工具列表中，且默认每次调用都需要确认。"
    >
      <div className="mx-3 mb-2 rounded-btn border border-[color-mix(in_srgb,var(--cf-danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--cf-danger)_8%,transparent)] px-2.5 py-1.5 text-[11px] leading-5 text-danger">
        MCP 服务器会在本机执行任意代码（与你当前用户权限相同）。仅添加你信任来源的服务器。
      </div>

      {servers.map((server) => (
        <div key={server.id} className="mx-3 mb-2 rounded-btn border border-line bg-panel p-2.5">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-ink">{server.name}</span>
            <span className="shrink-0 text-[10px] text-ink-2">{server.tools.length} 个工具</span>
            <Dropdown
              value={server.enabled ? "on" : "off"}
              onChange={(value) =>
                void run("切换启用状态", async () => {
                  apply(await setMcpServerEnabled(server.id, value === "on"));
                })
              }
              options={[
                { value: "on", label: "启用" },
                { value: "off", label: "禁用" },
              ]}
              className="w-20 shrink-0"
            />
          </div>
          <p className="mt-1 break-all font-mono text-[10px] text-ink-2">{server.commandLine}</p>

          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              type="button"
              disabled={busy || !server.enabled}
              onClick={() =>
                void run("测试连接", async () => {
                  const tools = await testMcpServer(server.id);
                  setToolsFor((prev) => ({ ...prev, [server.id]: tools }));
                })
              }
              className="rounded-btn border border-line px-2 py-1 text-[11px] text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
            >
              测试连接
            </button>
            <button
              type="button"
              onClick={() => setEditing({ ...server })}
              className="rounded-btn border border-line px-2 py-1 text-[11px] text-ink-2 transition-colors hover:bg-panel-2"
            >
              编辑
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run("删除服务器", async () => {
                  apply(await deleteMcpServer(server.id));
                })
              }
              className="rounded-btn border border-line px-2 py-1 text-[11px] text-danger transition-colors hover:bg-panel-2 disabled:opacity-40"
            >
              删除
            </button>
            {toolsFor[server.id] && (
              <span className="text-[10px] text-ink-2">
                发现 {toolsFor[server.id].length} 个工具
              </span>
            )}
          </div>

          {toolsFor[server.id] && toolsFor[server.id].length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {toolsFor[server.id].map((tool) => (
                <li key={tool.qualified} className="truncate text-[10px] text-ink-2" title={tool.description}>
                  · {tool.toolName} → {tool.qualified}
                </li>
              ))}
            </ul>
          )}

          {server.tools.length > 0 && !toolsFor[server.id] && (
            <ul className="mt-1.5 space-y-0.5">
              {server.tools.map((tool) => (
                <li key={tool.qualified} className="truncate text-[10px] text-ink-2" title={tool.description}>
                  · {tool.qualified}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      {editing ? (
        <div className="mx-3 mb-2 space-y-2 rounded-btn border border-line bg-panel-2 p-2.5">
          <input
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            placeholder="名称，例如：文件系统"
            className={inputCls}
          />
          <input
            value={editing.command}
            onChange={(e) => setEditing({ ...editing, command: e.target.value })}
            placeholder="命令，例如 npx / uvx / C:\\tools\\server.exe"
            spellCheck={false}
            className={inputCls}
          />
          <textarea
            value={editing.args.join("\n")}
            onChange={(e) =>
              setEditing({
                ...editing,
                args: e.target.value.split("\n").map((line) => line.trim()).filter(Boolean),
              })
            }
            rows={2}
            placeholder={"参数，每行一个，例如：\n-y\n@modelcontextprotocol/server-filesystem\nD:\\docs"}
            spellCheck={false}
            className={`${inputCls} resize-none font-mono text-[11px] leading-5`}
          />
          <textarea
            value={Object.entries(editing.env)
              .map(([key, value]) => `${key}=${value}`)
              .join("\n")}
            onChange={(e) =>
              setEditing({
                ...editing,
                env: Object.fromEntries(
                  e.target.value
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .map((line) => {
                      const index = line.indexOf("=");
                      return index < 0
                        ? [line, ""]
                        : [line.slice(0, index).trim(), line.slice(index + 1).trim()];
                    }),
                ),
              })
            }
            rows={2}
            placeholder={"环境变量，每行 KEY=VALUE（明文保存，注意不要放长期密钥）"}
            spellCheck={false}
            className={`${inputCls} resize-none font-mono text-[11px] leading-5`}
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded-btn border border-line px-2 py-1 text-[11px] text-ink-2 transition-colors hover:bg-panel"
            >
              取消
            </button>
            <button
              type="button"
              disabled={busy || !editing.name.trim() || !editing.command.trim()}
              onClick={() =>
                void run("保存服务器", async () => {
                  apply(await upsertMcpServer(editing));
                  setEditing(null);
                })
              }
              className="rounded-btn bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              保存并连接
            </button>
          </div>
        </div>
      ) : (
        <div className="mx-3 mb-2 space-y-2">
          <div className="flex items-center gap-2">
            <input
              value={jsonDraft}
              onChange={(e) => setJsonDraft(e.target.value)}
              placeholder='JSON 快捷粘贴：{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","D:\\docs"]}'
              spellCheck={false}
              className={`${inputCls} font-mono text-[11px]`}
            />
            <button
              type="button"
              disabled={!jsonDraft.trim()}
              onClick={() => void applyJson()}
              className="shrink-0 rounded-btn border border-line px-2.5 py-1.5 text-xs text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
            >
              解析
            </button>
          </div>
          <button
            type="button"
            onClick={() => setEditing(emptyServer())}
            className="flex items-center gap-1 rounded-btn border border-line px-2 py-1 text-xs text-ink transition-colors hover:bg-panel-2"
          >
            <Plus size={12} /> 手动添加服务器
          </button>
        </div>
      )}

      {notice && (
        <p className={`px-4 pb-2 text-[11px] ${notice.ok ? "text-ink-2" : "text-danger"}`}>
          {notice.text}
        </p>
      )}
    </SettingsSection>
  );
}

function KnowledgeSection() {
  const [view, setView] = useState<KnowledgeView | null>(null);
  const [documents, setDocuments] = useState<KbDocument[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [url, setUrl] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KbHit[] | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [cfg, docs] = await Promise.all([getKnowledgeConfig(), listKbDocuments()]);
      setView(cfg);
      setDocuments(docs);
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      await refresh();
      setNotice({ ok: true, text: `${label}完成` });
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const addFile = async () => {
    setNotice(null);
    let path: string | null = null;
    try {
      path = await pickKbFile();
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!path) return;
    await run("导入文件", () => addKbFile(path));
  };

  const runSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setNotice(null);
    try {
      setHits(await searchKb(q, 5));
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "w-full rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-[var(--cf-text-2)]";

  return (
    <SettingsSection
      title="知识库"
      description="把本地文档、网页或笔记分块入库；提问时按相关度检索，命中片段自动注入上下文（无需向量模型）。"
    >
      <FormRow
        label="自动注入"
        description={`每次提问检索最相关的片段：当前 ${view?.maxChunks ?? 3} 条`}
      >
        <div className="flex items-center gap-2">
          <Dropdown
            value={String(view?.maxChunks ?? 3)}
            onChange={(value) =>
              void run("保存设置", () =>
                setKnowledgeConfig(view?.autoInject ?? true, Number(value)),
              )
            }
            options={[1, 2, 3, 4, 5, 6, 8].map((n) => ({ value: String(n), label: `${n} 条` }))}
            className="w-24"
          />
          <Dropdown
            value={view?.autoInject === false ? "off" : "on"}
            onChange={(value) =>
              void run("保存设置", () =>
                setKnowledgeConfig(value === "on", view?.maxChunks ?? 3),
              )
            }
            options={[
              { value: "on", label: "开启" },
              { value: "off", label: "关闭" },
            ]}
            className="w-24"
          />
        </div>
      </FormRow>

      <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-2 text-[11px] text-ink-2">
        <span>
          共 {view?.documents ?? documents.length} 篇 · {view?.chunks ?? 0} 个片段
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void addFile()}
            disabled={busy}
            className="flex items-center gap-1 rounded-btn border border-line px-2 py-1 text-[11px] text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />} 导入文件
          </button>
          <button
            type="button"
            onClick={() => setPasteOpen((v) => !v)}
            className="rounded-btn border border-line px-2 py-1 text-[11px] text-ink transition-colors hover:bg-panel-2"
          >
            粘贴文本
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 px-3 pb-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="或粘贴网页地址，例如 https://example.com/article"
          spellCheck={false}
          className={inputCls}
        />
        <button
          type="button"
          disabled={busy || !url.trim()}
          onClick={() => void run("导入网页", () => addKbUrl(url.trim()))}
          className="shrink-0 rounded-btn border border-line px-2.5 py-1.5 text-xs text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
        >
          导入网页
        </button>
      </div>

      {pasteOpen && (
        <div className="mx-3 mb-2 space-y-2 rounded-btn border border-line bg-panel-2 p-2.5">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="资料标题"
            className={inputCls}
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            placeholder="粘贴要入库的文本内容"
            className={`${inputCls} resize-none leading-5`}
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setPasteOpen(false)}
              className="rounded-btn border border-line px-2 py-1 text-[11px] text-ink-2 transition-colors hover:bg-panel"
            >
              取消
            </button>
            <button
              type="button"
              disabled={busy || !title.trim() || !body.trim()}
              onClick={() =>
                void run("保存文本", async () => {
                  await addKbText(title.trim(), body.trim());
                  setTitle("");
                  setBody("");
                  setPasteOpen(false);
                })
              }
              className="rounded-btn bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              入库
            </button>
          </div>
        </div>
      )}

      {documents.length > 0 && (
        <div className="mx-3 mb-2 divide-y divide-[var(--cf-border)] overflow-hidden rounded-btn border border-line">
          {documents.map((doc) => (
            <div key={doc.id} className="flex items-center gap-2 bg-panel px-2.5 py-1.5">
              <FileText size={12} className="shrink-0 text-ink-2" />
              <span className="min-w-0 flex-1 truncate text-xs text-ink" title={doc.sourceRef ?? doc.title}>
                {doc.title}
              </span>
              <span className="cf-provider-badge shrink-0">
                {KB_SOURCE_LABELS[doc.sourceType] ?? doc.sourceType}
              </span>
              <span className="shrink-0 text-[10px] text-ink-2">{doc.chunkCount} 片段</span>
              {confirmingId === doc.id ? (
                <button
                  type="button"
                  onClick={() => {
                    void run("删除", () => deleteKbDocument(doc.id));
                    setConfirmingId(null);
                  }}
                  className="shrink-0 text-[11px] text-danger"
                >
                  确认删除
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingId(doc.id)}
                  title="从知识库移除"
                  className="cf-icon-btn danger shrink-0"
                >
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="px-3 pb-2">
        <label className="mb-1 block text-xs text-ink-2">检索测试</label>
        <div className="flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void runSearch();
              }
            }}
            placeholder="输入问题，看看会召回哪些片段"
            className={inputCls}
          />
          <button
            type="button"
            disabled={busy || !query.trim()}
            onClick={() => void runSearch()}
            className="shrink-0 rounded-btn border border-line px-2.5 py-1.5 text-xs text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
          >
            检索
          </button>
        </div>
        {hits && (
          <div className="mt-1.5 space-y-1.5">
            {hits.length === 0 && <p className="text-[11px] text-ink-2">没有命中片段</p>}
            {hits.map((hit, index) => (
              <div
                key={`${hit.documentId}-${hit.seq}-${index}`}
                className="rounded-btn border border-line bg-panel-2 px-2 py-1.5 text-[11px] leading-5"
              >
                <p className="text-ink-2">
                  {hit.title} · 片段 {hit.seq + 1}
                </p>
                <p className="text-ink">{hit.snippet}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {notice && (
        <p className={`px-4 pb-2 text-[11px] ${notice.ok ? "text-ink-2" : "text-danger"}`}>
          {notice.text}
        </p>
      )}
    </SettingsSection>
  );
}

function WebSearchSection() {
  const [engine, setEngine] = useState("duckduckgo");
  const [searxUrl, setSearxUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keySet, setKeySet] = useState(false);
  const [ready, setReady] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [testQuery, setTestQuery] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<WebSearchTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const applyView = (view: WebSearchConfigView) => {
    setEngine(view.engine);
    setSearxUrl(view.searxngBaseUrl ?? "");
    setKeySet(
      view.engine === "tavily"
        ? view.tavilyKeySet
        : view.engine === "bocha"
          ? view.bochaKeySet
          : false,
    );
    setReady(view.ready);
  };

  useEffect(() => {
    void (async () => {
      try {
        applyView(await getWebSearchConfig());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const needsKey = engine === "tavily" || engine === "bocha";

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      let view = await setWebSearchConfig(
        engine,
        engine === "searxng" ? searxUrl.trim() : null,
      );
      if (needsKey && apiKey.trim()) {
        view = await setWebSearchApiKey(engine, apiKey.trim());
        setApiKey("");
      }
      applyView(view);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      setTestResult(await testWebSearch(testQuery.trim() || "今日新闻"));
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const inputCls =
    "w-full rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-[var(--cf-text-2)]";

  return (
    <SettingsSection
      title="联网搜索"
      description="Agent 的 web_search 工具与对话中的联网搜索都使用这里选择的引擎。"
    >
      <FormRow label="搜索引擎" description="DuckDuckGo 免费无需配置；其余引擎需要 Key 或自建实例">
        <Dropdown
          value={engine}
          onChange={setEngine}
          options={SEARCH_ENGINE_OPTIONS}
          className="w-56"
        />
      </FormRow>

      {needsKey && (
        <div className="px-3 pb-2">
          <label className="mb-1 block text-xs text-ink-2">API Key</label>
          <div className="relative">
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type={showKey ? "text" : "password"}
              placeholder={keySet ? "已配置 · 留空则保持不变" : "粘贴 API Key"}
              spellCheck={false}
              className={`${inputCls} pr-9`}
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-2 hover:text-ink"
            >
              {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-ink-2">
            保存在 Windows 凭据管理器中，不会写入配置文件。保存后可用下方「测试搜索」验证。
          </p>
        </div>
      )}

      {engine === "searxng" && (
        <div className="px-3 pb-2">
          <label className="mb-1 block text-xs text-ink-2">实例地址</label>
          <input
            value={searxUrl}
            onChange={(e) => setSearxUrl(e.target.value)}
            placeholder="https://searx.example.com"
            spellCheck={false}
            className={inputCls}
          />
          <p className="mt-1 text-[11px] text-ink-2">
            需在实例的 settings.yml 中开启 JSON 输出（format: json）。
          </p>
        </div>
      )}

      {loaded && !ready && engine !== "duckduckgo" && (
        <p className="px-4 pb-1 text-[11px] text-danger">
          当前引擎尚未配置完成，联网搜索会返回错误提示。
        </p>
      )}

      <div className="px-3 pb-2 pt-1">
        <label className="mb-1 block text-xs text-ink-2">测试搜索</label>
        <div className="flex items-center gap-2">
          <input
            value={testQuery}
            onChange={(e) => setTestQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void runTest();
              }
            }}
            placeholder="输入关键词（默认：今日新闻）"
            spellCheck={false}
            className={inputCls}
          />
          <button
            type="button"
            onClick={() => void runTest()}
            disabled={testing || !ready}
            className="flex shrink-0 items-center gap-1 rounded-btn border border-line px-3 py-1.5 text-xs text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
          >
            {testing && <Loader2 size={12} className="animate-spin" />}
            测试
          </button>
        </div>
        {testError && <p className="mt-1.5 text-[11px] text-danger">{testError}</p>}
        {testResult && (
          <div className="mt-1.5 space-y-1.5 rounded-btn border border-line bg-panel-2 p-2">
            <p className="text-[11px] text-ink-2">
              {testResult.count} 条结果 · {testResult.elapsedMs} ms
            </p>
            {testResult.results.map((r, i) => (
              <div key={i} className="min-w-0 text-[11px] leading-4">
                <p className="truncate text-ink">{r.title || r.url}</p>
                <p className="truncate text-ink-2">{r.snippet}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !loaded}
          className="flex items-center gap-1 rounded-btn bg-accent px-3 py-1 text-xs font-medium text-accent-fg transition-colors hover:opacity-90 disabled:opacity-40"
        >
          {saved && <Check size={12} />}
          {saving ? "保存中…" : saved ? "已保存" : "保存"}
        </button>
      </div>
      {error && <p className="px-4 pb-2 text-[11px] text-danger">{error}</p>}
    </SettingsSection>
  );
}

function BackgroundImageSection({
  image,
  onUpload,
}: {
  image: string;
  onUpload: (data: string | null) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("读取文件失败"));
        reader.onerror = () => reject(new Error("读取文件失败"));
        reader.readAsDataURL(file);
      });
      onUpload(dataUrl.split(",")[1] ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <SettingsSection
      title="背景图"
      description="建议使用横向图片；背景会自动裁剪并叠加半透明遮罩，保证文字清晰"
    >
      <div className="cf-form-row items-start">
        <div className="flex-1">
          <p className="text-sm font-medium text-ink">背景预览</p>
          <p className="mt-0.5 text-xs text-ink-2">
            {image ? "已启用自定义背景" : "使用默认纯色背景"}
          </p>
        </div>
        <div className="flex w-44 shrink-0 flex-col gap-2">
          <div className="relative h-20 overflow-hidden rounded-btn border border-line bg-panel-2">
            {image ? (
              <img src={image} alt="自定义背景图预览" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center gap-2 text-xs text-ink-2">
                <ImageIcon size={15} /> 尚未设置背景图
              </div>
            )}
            {image && <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/35 to-transparent" />}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="rounded-btn border border-line px-2.5 py-1 text-xs text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
            >
              {uploading ? "上传中…" : image ? "更换背景图" : "上传背景图"}
            </button>
            {image && (
              <button onClick={() => void onUpload(null)} className="text-[11px] text-danger hover:underline">
                移除背景图
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/bmp,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
                e.target.value = "";
              }}
            />
          </div>
          {error && <p className="text-[11px] text-danger">{error}</p>}
        </div>
      </div>
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------------ */
/* Reusable avatar config section (AI or user)                               */
/* ------------------------------------------------------------------------ */

function AvatarSettingsSection() {
  const aiAvatar = useSettingsStore((s) => s.aiAvatar);
  const aiAvatarColor = useSettingsStore((s) => s.aiAvatarColor);
  const aiAvatarImage = useSettingsStore((s) => s.aiAvatarImage);
  const setAiAvatar = useSettingsStore((s) => s.setAiAvatar);
  const setAiAvatarColor = useSettingsStore((s) => s.setAiAvatarColor);
  const setAiAvatarImage = useSettingsStore((s) => s.setAiAvatarImage);
  const userAvatarColor = useSettingsStore((s) => s.userAvatarColor);
  const userAvatarImage = useSettingsStore((s) => s.userAvatarImage);
  const setUserAvatar = useSettingsStore((s) => s.setUserAvatar);
  const setUserAvatarColor = useSettingsStore((s) => s.setUserAvatarColor);
  const setUserAvatarImage = useSettingsStore((s) => s.setUserAvatarImage);

  const aiFileRef = useRef<HTMLInputElement>(null);
  const userFileRef = useRef<HTMLInputElement>(null);
  const [uploadingAi, setUploadingAi] = useState(false);
  const [uploadingUser, setUploadingUser] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const radius = aiAvatar === "circle" ? "50%" : aiAvatar === "rounded" ? "28%" : "20%";

  const shapeOptions: { value: AvatarShape; label: string; icon: React.ReactNode }[] = [
    {
      value: "circle",
      label: "圆形",
      icon: <span className="h-3.5 w-3.5 rounded-full border border-current" />,
    },
    {
      value: "rounded",
      label: "圆角",
      icon: <span className="h-3.5 w-3.5 rounded-md border border-current" />,
    },
    {
      value: "square",
      label: "方形",
      icon: <span className="h-3.5 w-3.5 rounded-sm border border-current" />,
    },
  ];

  const handleFile = async (file: File, target: "ai" | "user") => {
    const setUploading = target === "ai" ? setUploadingAi : setUploadingUser;
    const onUpload = target === "ai" ? setAiAvatarImage : setUserAvatarImage;
    setUploading(true);
    setUploadError(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          if (typeof result === "string") resolve(result);
          else reject(new Error("读取文件失败"));
        };
        reader.onerror = () => reject(new Error("读取文件失败"));
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.split(",")[1] ?? "";
      onUpload(base64);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const Preview = ({
    image,
    color,
    label,
  }: {
    image: string;
    color: string;
    label: string;
  }) =>
    image ? (
      <img
        src={image}
        alt={label}
        className="h-10 w-10 shrink-0 object-cover"
        style={{ borderRadius: radius }}
      />
    ) : (
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center text-xs font-bold text-white"
        style={{ backgroundColor: color, borderRadius: radius }}
      >
        {label}
      </span>
    );

  return (
    <SettingsSection title="头像设置" description="统一设置 AI 助手和你自己的头像外观">
      <div className="cf-form-row items-start">
        <div className="flex-1">
          <p className="text-sm font-medium text-ink">头像预览</p>
          <p className="mt-0.5 text-xs text-ink-2">同时应用于 AI 助手与你自己</p>
        </div>
        <div className="flex w-44 shrink-0 gap-5">
          <div className="flex flex-col items-center gap-1.5">
            <Preview image={aiAvatarImage} color={aiAvatarColor} label="AI" />
            <span className="text-[10px] text-ink-2">AI</span>
            <button
              onClick={() => aiFileRef.current?.click()}
              disabled={uploadingAi}
              className="rounded-btn border border-line px-2 py-0.5 text-[11px] text-ink transition-colors hover:bg-panel disabled:opacity-40"
            >
              {uploadingAi ? "上传中…" : aiAvatarImage ? "更换" : "上传"}
            </button>
            {aiAvatarImage && (
              <button
                onClick={() => void setAiAvatarImage(null)}
                className="text-[10px] text-danger hover:underline"
              >
                移除
              </button>
            )}
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <Preview image={userAvatarImage} color={userAvatarColor} label="我" />
            <span className="text-[10px] text-ink-2">我</span>
            <button
              onClick={() => userFileRef.current?.click()}
              disabled={uploadingUser}
              className="rounded-btn border border-line px-2 py-0.5 text-[11px] text-ink transition-colors hover:bg-panel disabled:opacity-40"
            >
              {uploadingUser ? "上传中…" : userAvatarImage ? "更换" : "上传"}
            </button>
            {userAvatarImage && (
              <button
                onClick={() => void setUserAvatarImage(null)}
                className="text-[10px] text-danger hover:underline"
              >
                移除
              </button>
            )}
          </div>
        </div>
      </div>

      {uploadError && (
        <p className="px-4 pb-2 text-[11px] text-danger">{uploadError}</p>
      )}

      <FormRow label="头像形状" description="使用自定义图片时形状仍生效">
        <VisualPills
          options={shapeOptions}
          value={aiAvatar}
          onChange={(shape) => {
            setAiAvatar(shape);
            setUserAvatar(shape);
          }}
        />
      </FormRow>

      <div className="cf-form-row items-start">
        <div className="flex-1">
          <p className="text-sm font-medium text-ink">AI 头像颜色</p>
        </div>
        <div className="flex w-44 shrink-0 flex-wrap gap-2">
          {AVATAR_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setAiAvatarColor(c)}
              className={`h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 ${
                aiAvatarColor === c ? "border-[var(--cf-accent)]" : "border-transparent"
              }`}
              style={{ backgroundColor: c }}
              title={c}
            />
          ))}
        </div>
      </div>

      <div className="cf-form-row items-start">
        <div className="flex-1">
          <p className="text-sm font-medium text-ink">我的头像颜色</p>
        </div>
        <div className="flex w-44 shrink-0 flex-wrap gap-2">
          {AVATAR_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setUserAvatarColor(c)}
              className={`h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 ${
                userAvatarColor === c ? "border-[var(--cf-accent)]" : "border-transparent"
              }`}
              style={{ backgroundColor: c }}
              title={c}
            />
          ))}
        </div>
      </div>

      <input
        ref={aiFileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/bmp,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file, "ai");
          e.target.value = "";
        }}
      />
      <input
        ref={userFileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/bmp,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file, "user");
          e.target.value = "";
        }}
      />
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------------ */
/* Wake shortcut recorder                                                    */
/* ------------------------------------------------------------------------ */

/** Map a DOM `code` to a Tauri accelerator key name; unsupported keys → null. */
function acceleratorKey(code: string): string | null {
  if (code === "Space") return "Space";
  if (code === "Enter") return "Enter";
  if (code === "Backspace") return "Backspace";
  if (code === "Tab") return "Tab";
  if (code === "ArrowUp") return "Up";
  if (code === "ArrowDown") return "Down";
  if (code === "ArrowLeft") return "Left";
  if (code === "ArrowRight") return "Right";
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1];
  m = /^F([1-9]|1[0-2])$/.exec(code);
  if (m) return `F${m[1]}`;
  return null;
}

/**
 * Records one accelerator.  `kind` selects which chord is being edited:
 * `wake` = show/hide the window, `quick` = the selected-text hotkey (P1-5),
 * which additionally has an on/off switch.
 */
function ShortcutRecorder({ kind = "wake" }: { kind?: "wake" | "quick" }) {
  const [current, setCurrent] = useState<string>("");
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (kind === "quick") {
      void api
        .getQuickAction()
        .then((view) => {
          setCurrent(view.shortcut);
          setEnabled(view.enabled);
        })
        .catch(() => undefined);
    } else {
      void api.getShortcut().then(setCurrent).catch(() => undefined);
    }
  }, [kind]);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      const key = acceleratorKey(e.code);
      if (key) parts.push(key);
      if (parts.length === 0) return;

      const hasModifier = e.ctrlKey || e.altKey || e.shiftKey;
      const isFKey = key !== null && /^F\d/.test(key);
      if (!hasModifier && !isFKey) {
        setError("请包含 Ctrl / Alt / Shift 修饰键，或单独使用 F1–F12");
        setRecording(false);
        return;
      }

      const accel = parts.join("+");
      setRecording(false);
      const request =
        kind === "quick" ? api.setQuickAction(enabled, accel) : api.setShortcut(accel);
      request
        .then((value) => {
          setCurrent(typeof value === "string" ? value : value.shortcut);
          if (typeof value !== "string") setEnabled(value.enabled);
          setError(null);
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, kind, enabled]);

  const toggleEnabled = () => {
    const next = !enabled;
    setEnabled(next);
    void api
      .setQuickAction(next, current || "Alt+Q")
      .then((view) => {
        setCurrent(view.shortcut);
        setError(null);
      })
      .catch((err) => {
        setEnabled(!next);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  return (
    <div className="flex w-full flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="min-w-24 flex-1 rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-center text-xs text-ink">
          {recording ? "按下新快捷键…" : current || (kind === "quick" ? "Alt+Q" : "Alt+Space")}
        </span>
        <button
          onClick={() => {
            setError(null);
            setRecording(!recording);
          }}
          className="rounded-btn border border-line px-2.5 py-1.5 text-xs text-ink transition-colors hover:bg-panel-2"
        >
          {recording ? "取消" : "重新录入"}
        </button>
      </div>
      {kind === "quick" && (
        <button
          onClick={toggleEnabled}
          className={`self-start rounded-btn px-2 py-0.5 text-[11px] transition-colors ${
            enabled
              ? "bg-accent text-accent-fg hover:opacity-90"
              : "border border-line text-ink-2 hover:bg-panel-2"
          }`}
        >
          {enabled ? "划词已启用" : "划词已停用"}
        </button>
      )}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Agent tools tab                                                          */
/* ------------------------------------------------------------------------ */

/** Human-readable name for each builtin tool. */
const TOOL_NAMES: Record<string, string> = {
  get_current_time: "获取当前时间",
  calculate: "计算",
  web_search: "联网搜索",
  read_clipboard: "读取剪贴板",
  write_clipboard: "写入剪贴板",
  select_and_read_text_file: "读取文本文件",
  read_pdf: "读取 PDF",
  capture_screen: "截屏",
  fetch_webpage: "抓取网页",
  open_resource: "打开资源",
};

/** Icon for each builtin tool; falls back to the wrench. */
const TOOL_ICONS: Record<string, typeof Wrench> = {
  get_current_time: Clock,
  calculate: Calculator,
  web_search: Globe,
  read_clipboard: ClipboardPaste,
  write_clipboard: Clipboard,
  select_and_read_text_file: FileText,
  read_pdf: FileType,
  capture_screen: MonitorUp,
  fetch_webpage: LinkIcon,
  open_resource: ExternalLink,
};

const RISK_LABEL: Record<string, { text: string; tone: "auto" | "warn" }> = {
  low: { text: "自动执行", tone: "auto" },
  external_read: { text: "只读外部", tone: "auto" },
  sensitive_read: { text: "敏感读取 · 需确认", tone: "warn" },
  external_action: { text: "外部动作 · 需确认", tone: "warn" },
};

const POLICY_OPTIONS: { value: ToolPolicy; label: string; hint: string }[] = [
  { value: "allow", label: "默认允许", hint: "按工具自身设定自动执行" },
  { value: "confirm", label: "每次确认", hint: "每次调用前都需要你确认" },
  { value: "disabled", label: "禁用", hint: "不会提供给模型" },
];

function AgentToolsTab() {
  const enabled = useSettingsStore((s) => s.defaultEnableTools);
  const setEnabled = useSettingsStore((s) => s.setDefaultEnableTools);
  const thinking = useSettingsStore((s) => s.defaultEnableThinking);
  const setThinking = useSettingsStore((s) => s.setDefaultEnableThinking);
  const [tools, setTools] = useState<ToolInfo[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listTools()
      .then((list) => {
        if (!cancelled) setTools(list);
      })
      .catch((err) => console.error("获取工具列表失败:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  const changePolicy = (name: string, policy: ToolPolicy) => {
    setTools((prev) =>
      prev ? prev.map((t) => (t.name === name ? { ...t, policy } : t)) : prev,
    );
    setToolPolicy(name, policy).catch((err) => {
      console.error("保存工具策略失败:", err);
      void listTools().then(setTools);
    });
  };

  const confirmCount = tools?.filter((t) => t.requiresConfirmation).length ?? 0;
  const disabledCount = tools?.filter((t) => t.policy === "disabled").length ?? 0;

  return (
    <SettingsSection
      title="Agent 工具"
      description="管理模型可调用的工具。聊天输入框中的扳手按钮可以临时切换本次对话是否启用工具。"
    >
      <FormRow
        label="启用 Agent 工具"
        description={enabled ? "模型可自动调用下方工具" : "模型只会直接回答，不会调用工具"}
      >
        <FormSwitch checked={enabled} onChange={setEnabled} />
      </FormRow>

      <FormRow
        label="显示模型思考过程"
        description={
          thinking
            ? "推理模型会先展示思考过程，再输出最终回答"
            : "关闭后不请求思考内容，只输出最终回答"
        }
      >
        <FormSwitch checked={thinking} onChange={setThinking} />
      </FormRow>

      {/* Tool list */}
      <div className="border-t border-line">
        <div className="flex items-center justify-between px-3 py-2">
          <p className="text-[11px] font-medium text-ink">工具列表</p>
          {tools && (
            <span className="text-[10px] text-ink-2">
              {tools.length} 个工具 · {confirmCount} 个需确认 · {disabledCount} 个已禁用
            </span>
          )}
        </div>
        {tools ? (
          <ul>
            {tools.map((tool) => {
              const Icon = TOOL_ICONS[tool.name] ?? Wrench;
              const risk = RISK_LABEL[tool.riskLevel] ?? { text: "需确认", tone: "warn" as const };
              const disabled = tool.policy === "disabled";
              return (
                <li
                  key={tool.name}
                  className={`cf-tool-item ${disabled ? "is-disabled" : ""}`}
                >
                  <Icon size={16} className="mt-0.5 shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium text-ink">
                        {TOOL_NAMES[tool.name] ?? tool.name}
                      </span>
                      <span className="rounded bg-panel-2 px-1.5 py-px text-[10px] text-ink-2">
                        {tool.name}
                      </span>
                      <span
                        className={`shrink-0 rounded px-1.5 py-px text-[10px] ${
                          risk.tone === "warn"
                            ? "bg-[var(--cf-warn-bg,var(--cf-danger-weak,#fde))] text-[var(--cf-danger)]"
                            : "bg-panel-2 text-ink-2"
                        }`}
                      >
                        {risk.text}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-4 text-ink-2">{tool.description}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end">
                    <Dropdown
                      value={tool.policy}
                      onChange={(val) => changePolicy(tool.name, val as ToolPolicy)}
                      className="w-auto min-w-[5.5rem]"
                      title={POLICY_OPTIONS.find((o) => o.value === tool.policy)?.hint}
                      options={POLICY_OPTIONS.map((option) => ({
                        value: option.value,
                        label: option.label,
                      }))}
                    />
                    <span className="mt-1 text-[10px] text-ink-2">
                      {POLICY_OPTIONS.find((o) => o.value === tool.policy)?.hint}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="py-6 text-center text-[11px] text-ink-2">正在加载工具列表…</p>
        )}
      </div>
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------------ */
/* General tab — shortcut + history + about                                  */
/* ------------------------------------------------------------------------ */

function GeneralTab() {
  const historyEnabled = useHistoryStore((s) => s.historyEnabled);
  const setHistoryEnabled = useHistoryStore((s) => s.setHistoryEnabled);
  const hideOnBlur = useSettingsStore((s) => s.hideOnBlur);
  const setHideOnBlur = useSettingsStore((s) => s.setHideOnBlur);
  const rememberWindowPosition = useProvidersStore((s) => s.rememberWindowPosition);
  const setRememberWindowPosition = useProvidersStore((s) => s.setRememberWindowPosition);
  const [confirming, setConfirming] = useState(false);
  const [cleared, setCleared] = useState(false);

  const clearData = async () => {
    await historyApi.clearAllHistory();
    useHistoryStore.getState().setActive(null);
    useChatStore.getState().clearConversation();
    await useHistoryStore.getState().refreshList();
    setConfirming(false);
    setCleared(true);
    setTimeout(() => setCleared(false), 1500);
  };

  return (
    <>
      <SettingsSection title="快捷键" description="唤起 / 隐藏应用的全局快捷键">
        <div className="cf-form-row items-start">
          <div className="flex-1">
            <p className="text-sm font-medium text-ink">唤起快捷键</p>
            <p className="mt-0.5 text-xs text-ink-2">
              录入后立即生效并保存；若与系统或其他软件冲突会提示失败。Esc 取消录入。
            </p>
          </div>
          <div className="flex w-44 shrink-0 flex-col gap-1">
            <ShortcutRecorder />
          </div>
        </div>

        <div className="cf-form-row items-start">
          <div className="flex-1">
            <p className="text-sm font-medium text-ink">划词助手快捷键</p>
            <p className="mt-0.5 text-xs text-ink-2">
              在任意程序里选中文本后按此快捷键：自动复制取词、唤起窗口并给出翻译 /
              解释 / 总结等动作。管理员权限（UAC 提升）的窗口无法取词，这是 Windows 限制。
            </p>
          </div>
          <div className="flex w-44 shrink-0 flex-col gap-1">
            <ShortcutRecorder kind="quick" />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="窗口行为" description="控制窗口的显隐与位置记忆">
        <FormRow label="失焦自动隐藏" description="生成过程中不会隐藏">
          <Dropdown
            value={hideOnBlur ? "on" : "off"}
            onChange={(val) => void setHideOnBlur(val === "on")}
            options={[
              { value: "on", label: "开启" },
              { value: "off", label: "关闭" },
            ]}
          />
        </FormRow>
        <FormRow label="记忆窗口位置" description="适合多显示器场景，位置不可见时自动回退居中">
          <Dropdown
            value={rememberWindowPosition ? "on" : "off"}
            onChange={(val) => void setRememberWindowPosition(val === "on")}
            options={[
              { value: "off", label: "关闭" },
              { value: "on", label: "开启" },
            ]}
          />
        </FormRow>
      </SettingsSection>

      <PresetSection />

      <MemorySection />

      <WebSearchSection />

      <KnowledgeSection />

      <McpSection />

      <BackupSection />

      <ProxySection />

      <SettingsSection title="会话历史" description="控制是否持久化对话记录到本地数据库">
        <FormRow label="本地会话历史" description="关闭后对话仅保留在内存中，重启后丢失">
          <Dropdown
            value={historyEnabled ? "on" : "off"}
            onChange={(val) => void setHistoryEnabled(val === "on")}
            options={[
              { value: "on", label: "记录" },
              { value: "off", label: "不记录" },
            ]}
          />
        </FormRow>
        <div className="flex items-center justify-end gap-2 px-3 py-2">
          {confirming ? (
            <>
              <button
                onClick={() => setConfirming(false)}
                className="rounded-btn border border-line px-3 py-1 text-xs text-ink transition-colors hover:bg-panel-2"
              >
                取消
              </button>
              <button
                onClick={() => void clearData()}
                className="rounded-btn bg-danger px-3 py-1 text-xs text-white transition-opacity hover:opacity-85"
              >
                确认清空全部会话
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              className="rounded-btn border border-line px-3 py-1 text-xs text-danger transition-colors hover:bg-panel-2"
            >
              {cleared ? "已清空" : "清空全部会话数据…"}
            </button>
          )}
        </div>
      </SettingsSection>

      <UpdateSettingsCard />

      <AboutSection />
    </>
  );
}

/* ------------------------------------------------------------------------ */
/* Diagnostics tab — redacted agent-run traces (v2.0 phase 5)                */
/* ------------------------------------------------------------------------ */

function DiagnosticsTab() {
  return (
    <>
      <section>
        <SectionHeader title="诊断信息" />
        <p className="mb-3 text-xs leading-5 text-ink-2">
          查看最近的请求运行记录（脱敏，不含消息内容与密钥），用于排查对话失败等问题。
        </p>
        <DiagnosticsSection />
      </section>
    </>
  );
}

const RUN_STATUS_LABELS: Record<string, string> = {
  completed: "成功",
  failed: "失败",
  cancelled: "已取消",
};

function DiagnosticsSection() {
  const [runs, setRuns] = useState<RunTrace[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setRuns(await diagnosticsApi.listRuns(30));
      setLoaded(true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clear = async () => {
    try {
      await diagnosticsApi.clearRuns();
      setRuns([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <SettingsSection
      title="诊断信息"
      description="最近运行记录（脱敏，不含对话内容、密钥或工具结果）。用于排查模型、网络与工具调用问题。"
      action={
        runs.length > 0 && (
          <button
            onClick={() => void clear()}
            className="text-[11px] text-danger transition-colors hover:opacity-80"
          >
            清空
          </button>
        )
      }
    >
      {error && <p className="px-4 pt-2 text-[11px] text-danger">{error}</p>}
      {!loaded ? (
        <p className="px-4 py-6 text-xs text-ink-2">加载中…</p>
      ) : runs.length === 0 ? (
        <p className="px-4 py-6 text-xs text-ink-2">暂无运行记录。</p>
      ) : (
        <ul>
          {runs.map((r) => (
            <li key={r.id} className="cf-tool-item">
              <Activity size={16} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      r.status === "completed"
                        ? "bg-panel-2 text-success"
                        : r.status === "failed"
                          ? "bg-panel-2 text-danger"
                          : "bg-panel-2 text-ink-2"
                    }`}
                  >
                    {RUN_STATUS_LABELS[r.status] ?? r.status}
                  </span>
                  <span className="truncate text-xs text-ink">{r.modelKey ?? "—"}</span>
                </div>
                <p className="mt-0.5 text-[11px] text-ink-2">
                  {r.durationMs ? `耗时 ${(r.durationMs / 1000).toFixed(1)}s` : "耗时 —"}
                  {r.toolCount > 0 ? ` · 工具 ${r.toolCount}` : ""}
                  {r.retryCount > 0 ? ` · 重试 ${r.retryCount}` : ""}
                  {r.errorCode ? ` · 错误码: ${r.errorCode}` : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------------ */
/* Long-term memory management (v2.0 phase 4)                                */
/* ------------------------------------------------------------------------ */

const MEMORY_CATEGORIES = ["preference", "profile", "project", "constraint", "custom"];
const CATEGORY_LABELS: Record<string, string> = {
  preference: "偏好",
  profile: "个人资料",
  project: "项目背景",
  constraint: "长期约束",
  custom: "自定义",
};

function MemorySection() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Editing state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftCategory, setDraftCategory] = useState("preference");
  const [draftContent, setDraftContent] = useState("");

  const refresh = async () => {
    try {
      setMemories(await memoryApi.listMemories());
      setLoaded(true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startAdd = () => {
    setEditingId("new");
    setDraftCategory("preference");
    setDraftContent("");
  };

  const startEdit = (m: Memory) => {
    setEditingId(m.id);
    setDraftCategory(m.category);
    setDraftContent(m.content);
  };

  const save = async () => {
    const content = draftContent.trim();
    if (!content) return;
    try {
      if (editingId === "new") {
        await memoryApi.createMemory(`mem-${Date.now()}`, draftCategory, content);
      } else if (editingId) {
        await memoryApi.updateMemory(editingId, content, draftCategory);
      }
      setEditingId(null);
      setDraftContent("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleEnabled = async (m: Memory) => {
    try {
      await memoryApi.setMemoryEnabled(m.id, !m.enabled);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    try {
      await memoryApi.deleteMemory(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const clearAll = async () => {
    try {
      await memoryApi.clearMemories();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const inputCls =
    "w-full rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-[var(--cf-text-2)]";

  return (
    <SettingsSection
      title="长期记忆"
      description="长期记忆只在得到你的确认后保存，并会随对话自动注入，帮助助手记住你的偏好与背景。密码、密钥等敏感内容会被拒绝保存。"
      action={
        editingId === null && (
          <button
            onClick={startAdd}
            className="flex items-center gap-1 rounded-btn border border-line px-2 py-1 text-[11px] text-ink transition-colors hover:bg-panel-2"
          >
            <Plus size={11} />
            添加记忆
          </button>
        )
      }
    >
      {error && <p className="px-4 pt-2 text-[11px] text-danger">{error}</p>}

      {editingId !== null && (
        <div className="space-y-3 p-3">
          <div>
            <label className="mb-1 block text-xs text-ink-2">类别</label>
            <Dropdown
              value={draftCategory}
              onChange={(val) => setDraftCategory(val)}
              options={MEMORY_CATEGORIES.map((c) => ({
                value: c,
                label: CATEGORY_LABELS[c] ?? c,
              }))}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-2">内容</label>
            <textarea
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              rows={3}
              placeholder="例如：回答问题时请使用简洁风格，先给结论再给理由。"
              className={inputCls}
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => setEditingId(null)}
              className="rounded-btn border border-line px-3 py-1 text-xs text-ink-2 transition-colors hover:bg-panel-2"
            >
              取消
            </button>
            <button
              onClick={() => void save()}
              className="rounded-btn bg-accent px-3 py-1 text-xs font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-50"
              disabled={!draftContent.trim()}
            >
              保存
            </button>
          </div>
        </div>
      )}

      {!loaded ? (
        <p className="px-4 py-6 text-xs text-ink-2">加载中…</p>
      ) : memories.length === 0 ? (
        <p className="px-4 py-6 text-xs text-ink-2">暂无记忆。</p>
      ) : (
        <ul>
          {memories.map((m) => (
            <li key={m.id} className="cf-tool-item">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-ink-2">
                    {CATEGORY_LABELS[m.category] ?? m.category}
                  </span>
                  {!m.enabled && (
                    <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-danger">
                      已停用
                    </span>
                  )}
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">
                  {m.content}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => void toggleEnabled(m)}
                  title={m.enabled ? "停用" : "启用"}
                  className="cf-icon-btn"
                >
                  {m.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
                </button>
                <button
                  onClick={() => startEdit(m)}
                  title="编辑"
                  className="cf-icon-btn"
                >
                  <Pencil size={13} />
                </button>
                <button
                  onClick={() => void remove(m.id)}
                  title="删除"
                  className="cf-icon-btn danger"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {memories.length > 0 && (
        <div className="flex justify-end px-3 py-2">
          <button
            onClick={() => void clearAll()}
            className="text-[11px] text-danger transition-colors hover:opacity-80"
          >
            清空所有记忆
          </button>
        </div>
      )}
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------------ */
/* Quick command / preset prompt management                                  */
/* ------------------------------------------------------------------------ */

function PresetSection() {
  const presets = useSettingsStore((s) => s.presets);
  const setPresets = useSettingsStore((s) => s.setPresets);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftCommand, setDraftCommand] = useState("");
  const [draftContent, setDraftContent] = useState("");

  const startAdd = () => {
    setEditingId("new");
    setDraftName("");
    setDraftCommand("/");
    setDraftContent("");
  };

  const startEdit = (p: PromptPreset) => {
    setEditingId(p.id);
    setDraftName(p.name);
    setDraftCommand(p.command);
    setDraftContent(p.content);
  };

  const save = async () => {
    const name = draftName.trim();
    const command = draftCommand.trim();
    if (!name || !command || !draftContent.trim()) return;

    if (editingId === "new") {
      const id = `preset-${Date.now()}`;
      await setPresets([...presets, { id, name, command, content: draftContent.trim() }]);
    } else {
      await setPresets(
        presets.map((p) =>
          p.id === editingId ? { ...p, name, command, content: draftContent.trim() } : p,
        ),
      );
    }
    setEditingId(null);
  };

  const remove = async (id: string) => {
    await setPresets(presets.filter((p) => p.id !== id));
  };

  const inputCls =
    "w-full rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-[var(--cf-text-2)]";

  return (
    <SettingsSection
      title="快捷指令"
      description="在输入框中输入 / 即可触发快捷指令，快速填充预设的提示词模板。"
      action={
        editingId === null && (
          <button
            onClick={startAdd}
            className="flex items-center gap-1 rounded-btn border border-line px-2 py-1 text-xs text-ink transition-colors hover:bg-panel-2"
          >
            <Plus size={12} /> 添加
          </button>
        )
      }
    >
      {editingId !== null && (
        <div className="space-y-3 p-3">
          <div>
            <label className="mb-1 block text-xs text-ink-2">名称</label>
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="如：翻译"
              className={inputCls}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-2">触发指令</label>
            <input
              value={draftCommand}
              onChange={(e) => setDraftCommand(e.target.value)}
              placeholder="如：/翻译"
              className={inputCls}
              spellCheck={false}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-2">提示词内容</label>
            <textarea
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              placeholder="如：请将以下内容翻译为中文："
              rows={3}
              className={`${inputCls} resize-none`}
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => setEditingId(null)}
              className="rounded-btn border border-line px-3 py-1 text-xs text-ink-2 transition-colors hover:bg-panel-2"
            >
              取消
            </button>
            <button
              onClick={() => void save()}
              disabled={!draftName.trim() || !draftCommand.trim() || !draftContent.trim()}
              className="flex items-center gap-1 rounded-btn bg-accent px-3 py-1 text-xs font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <Check size={12} /> 保存
            </button>
          </div>
        </div>
      )}

      <div className="space-y-1 p-3">
        {presets.map((p) => (
          <div
            key={p.id}
            className="cf-provider-card flex items-center gap-2 py-2"
          >
            <span className="shrink-0 rounded bg-panel-2 px-1.5 py-px font-mono text-[11px] text-accent">
              {p.command}
            </span>
            <span className="truncate text-xs text-ink">{p.name}</span>
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              <button
                onClick={() => startEdit(p)}
                className="cf-icon-btn h-5 w-5"
                title="编辑"
              >
                <Pencil size={11} />
              </button>
              <button
                onClick={() => void remove(p.id)}
                className="cf-icon-btn danger h-5 w-5"
                title="删除"
              >
                <Trash2 size={11} />
              </button>
            </span>
          </div>
        ))}
        {presets.length === 0 && editingId === null && (
          <p className="rounded-btn border border-dashed border-line px-3 py-3 text-center text-xs text-ink-2">
            暂无快捷指令，点击右上角"添加"创建
          </p>
        )}
      </div>
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------------ */
/* About                                                                     */
/* ------------------------------------------------------------------------ */

function AboutSection() {
  const [version, setVersion] = useState("");

  useEffect(() => {
    void invoke<{ version: string }>("app_info")
      .then((info) => setVersion(info.version))
      .catch(() => undefined);
  }, []);

  return (
    <section className="mt-2 text-center">
      <p className="text-[11px] leading-5 text-ink-2">
        芝麻 v{version} · 全局快捷键唤起 / 隐藏
        <br />
        默认模型可随时在顶部模型选择器中切换
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------------ */

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="mb-2 mt-3 flex items-center justify-between first:mt-0">
      <h2 className="text-xs font-semibold text-ink">{title}</h2>
      {action}
    </div>
  );
}

function Notice({ ok, text }: { ok: boolean; text: string }) {
  return (
    <p
      className={`rounded-btn border px-2.5 py-1.5 text-xs leading-5 ${
        ok
          ? "border-[color-mix(in_srgb,var(--cf-success)_35%,transparent)] text-success"
          : "border-[color-mix(in_srgb,var(--cf-danger)_35%,transparent)] text-danger"
      }`}
    >
      {text}
    </p>
  );
}

/* ------------------------------------------------------------------------ */
/* Modal used for adding / editing providers                                 */
/* ------------------------------------------------------------------------ */

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex w-full max-w-lg flex-col rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <button onClick={onClose} className="cf-icon-btn" title="关闭">
            <X size={14} />
          </button>
        </div>
        <div className="max-h-[80vh] overflow-y-auto p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------------ */
/* Shared settings UI primitives — used to reduce the "generated" look of   */
/* every page looking like a stack of identical pale cards.                 */
/* ------------------------------------------------------------------------ */

function SettingsSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`cf-settings-section ${className ?? ""}`}>
      <div className="cf-settings-section-header">
        <div>
          <h2 className="cf-settings-section-title">{title}</h2>
          {description && <p className="cf-settings-section-desc">{description}</p>}
        </div>
        {action}
      </div>
      <div className="cf-settings-section-body">{children}</div>
    </section>
  );
}

function FormRow({
  label,
  htmlFor,
  description,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`cf-form-row ${className ?? ""}`}>
      <div className="flex-1">
        <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
          {label}
        </label>
        {description && <p className="mt-0.5 text-xs text-ink-2">{description}</p>}
      </div>
      <div className="flex w-44 shrink-0 justify-end">{children}</div>
    </div>
  );
}

function FormSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="cf-switch"
      title={label}
    >
      <span className="cf-switch-knob" />
    </button>
  );
}

function VisualPills<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; icon?: React.ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`cf-pill ${opt.value === value ? "is-active" : ""}`}
        >
          {opt.icon}
          <span>{opt.label}</span>
        </button>
      ))}
    </div>
  );
}
