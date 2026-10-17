import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Activity,
  BarChart3,
  Check,
  ChevronDown,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Globe,
  Loader2,
  Pencil,
  Plus,
  Puzzle,
  RefreshCw,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Sparkles,
  Palette,
  Wrench,
  Bot,
  Trash2,
  X,
  UserCircle,
} from "lucide-react";
import { useSettingsStore, type PromptPreset } from "../../stores/settings-store";
import { useProvidersStore } from "../../stores/providers-store";
import { useHistoryStore } from "../../services/history-store";
import { useChatStore } from "../../stores/chat-store";
import * as api from "../../services/providers-api";
import * as historyApi from "../../services/history-api";
import * as memoryApi from "../../services/memory-api";
import type { Memory } from "../../services/memory-api";
import { UpdateSettingsCard } from "../../components/updater/UpdateBanner";
import {
  listTools,
  type ToolInfo,
  type ToolPolicy,
} from "../../services/tools-api";
import { useWindowStore } from "../../stores/window-store";
import {
  assistantToolPolicies,
  isBuiltinAssistant,
  serializeToolPolicies,
  type AssistantView,
} from "../../services/assistants-api";
import {
  deleteSkill,
  formatTriggers,
  importSkillFiles,
  listSkills,
  newSkill,
  parseTriggers,
  upsertSkill,
  type SkillView,
} from "../../services/skills-api";
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
  warmMcpServers,
  type McpServerConfig,
  type McpServerView,
  type McpToolInfo,
  type McpView,
} from "../../services/mcp-api";
import { UsageTab } from "./UsageTab";
import {
  ASSISTANT_ICON_KEYS,
  ASSISTANT_ICON_LABELS,
  AssistantIcon,
  isAssistantIconKey,
} from "../../components/assistant/AssistantIcon";
import { ModelsTab } from "./tabs/models";
import { AppearanceTab } from "./tabs/appearance";
import { AgentToolsTab, POLICY_OPTIONS } from "./tabs/agent-tools";
import { DiagnosticsTab } from "./tabs/diagnostics";

type SettingsTab =
  | "models"
  | "appearance"
  | "tools"
  | "skills"
  | "usage"
  | "diagnostics"
  | "general"
  | "persona"
  | "context"
  | "integrations"
  | "data";

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
        className="flex w-full items-center justify-between gap-2 rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-left text-ui text-ink outline-none transition-colors hover:bg-panel focus:border-accent disabled:opacity-40"
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
              className={`block w-full px-2.5 py-1.5 text-left text-ui transition-colors ${
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
  { id: "context", label: "上下文与记忆", icon: Sparkles },
  { id: "tools", label: "Agent 工具", icon: Bot },
  { id: "skills", label: "技能", icon: Puzzle },
  { id: "integrations", label: "网络与集成", icon: Globe },
  { id: "data", label: "数据与存储", icon: Database },
  { id: "usage", label: "用量统计", icon: BarChart3 },
  { id: "diagnostics", label: "诊断信息", icon: Activity },
  { id: "general", label: "通用", icon: Wrench },
];

/* Sidebar grouping — Claude's settings page splits the list into two
 * clusters: what the AI does, and how the app behaves. */
const NAV_GROUPS: { label: string; tabs: SettingsTab[] }[] = [
  {
    label: "AI 行为",
    tabs: ["models", "persona", "context", "tools", "skills", "integrations"],
  },
  {
    label: "应用",
    tabs: ["appearance", "data", "usage", "diagnostics", "general"],
  },
];

export function SettingsPanel() {
  // The composer can request a specific section (e.g. "skills") when opening.
  const [tab, setTab] = useState<SettingsTab>(() => {
    const requested = useWindowStore.getState().settingsTab;
    return requested && TABS.some((t) => t.id === requested)
      ? (requested as SettingsTab)
      : "models";
  });
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
        className="relative flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-panel-2 px-3 py-4"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-3 right-3 rounded-btn bg-panel shadow-sm transition-[top,height] duration-200 ease-out"
          style={{ top: marker.top, height: marker.height }}
        />
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="cf-settings-nav-group">{group.label}</p>
            {group.tabs.map((tabId) => {
              const t = TABS.find((x) => x.id === tabId)!;
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  data-tab={t.id}
                  onClick={() => go(t.id)}
                  className={`relative z-10 flex w-full items-center gap-2.5 rounded-btn px-2.5 py-2 text-ui transition-colors duration-150 ${
                    active
                      ? "font-medium text-ink before:absolute before:left-0 before:top-1/2 before:h-4 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-[var(--cf-accent)]"
                      : "text-ink-2 hover:text-ink"
                  }`}
                >
                  <Icon size={15} strokeWidth={active ? 2.25 : 1.75} />
                  <span className="min-w-0 flex-1 truncate text-left">{t.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Tab content. Keyed by tab so every switch replays the enter
          animation from a clean mount. */}
      <div className="min-w-0 flex-1 overflow-y-auto px-8 pb-8 pt-6">
        <div
          key={tab}
          className={`cf-settings-page mx-auto w-full max-w-2xl ${
            direction === 1 ? "cf-page-enter-next" : "cf-page-enter-prev"
          }`}
        >
          {/* Page header: the active tab name, mirroring Claude's settings
              page which always shows the current section title at the top. */}
          <header className="mb-6">
            <h1 className="font-display text-[1.5rem] font-semibold leading-8 tracking-[-0.005em] text-ink">
              {TABS.find((t) => t.id === tab)?.label}
            </h1>
          </header>

          {tab === "models" && <ModelsTab />}
          {tab === "appearance" && <AppearanceTab />}
          {tab === "persona" && <PersonaTab />}
          {tab === "context" && <ContextTab />}
          {tab === "tools" && <AgentToolsTab />}
          {tab === "skills" && <SkillsTab />}
          {tab === "integrations" && <IntegrationsTab />}
          {tab === "data" && <DataTab />}
          {tab === "usage" && <UsageTab />}
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


/* ------------------------------------------------------------------------ */
/* Provider list                                                             */
/* ------------------------------------------------------------------------ */


/* ------------------------------------------------------------------------ */
/* Provider create / edit form                                               */
/* ------------------------------------------------------------------------ */


/* ------------------------------------------------------------------------ */
/* Model management inside the provider edit form                            */
/* ------------------------------------------------------------------------ */


/* ------------------------------------------------------------------------ */
/* Generation parameters                                                     */
/* ------------------------------------------------------------------------ */


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
    icon: "sparkles",
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
              <span className="flex items-center gap-1.5 text-meta text-ink">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accent/10 text-accent">
                  <AssistantIcon icon={a.icon} size={13} />
                </span>
                <span className="truncate font-medium">{a.name}</span>
                {activeId === a.id && <Check size={12} className="shrink-0 text-success" />}
              </span>
              <span className="line-clamp-2 text-meta leading-4 text-ink-2">
                {a.description || a.systemPrompt.slice(0, 40)}
              </span>
              <span className="truncate text-meta text-ink-2/80">{modelLabel(a)}</span>
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
        <p className="text-ui text-ink-2">
          内置助手可编辑并随时恢复默认；删除自定义助手后，其会话回到全局默认。
        </p>
        <button
          type="button"
          onClick={() => setDraft(newDraft())}
          className="flex shrink-0 items-center gap-1 rounded-btn border border-line px-2 py-1 text-meta text-ink transition-colors hover:bg-panel-2"
        >
          <Plus size={12} /> 新建助手
        </button>
      </div>

      {error && <p className="px-4 pb-2 text-ui text-danger">{error}</p>}

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
  const [icon, setIcon] = useState(initial.icon ?? "sparkles");
  const [description, setDescription] = useState(initial.description ?? "");
  const [prompt, setPrompt] = useState(initial.systemPrompt);
  const [providerId, setProviderId] = useState(initial.providerId ?? "");
  const [modelKey, setModelKey] = useState(initial.modelKey ?? "");
  // Tool-policy overrides: only the tools listed here differ from the global
  // policy; the stricter of the two always wins at chat time.
  const [policies, setPolicies] = useState<Record<string, ToolPolicy>>(() =>
    assistantToolPolicies(initial),
  );
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const models = providers.find((p) => p.id === providerId)?.models ?? [];

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
        toolPoliciesJson: serializeToolPolicies(policies),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    "w-full rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-ui text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-accent";

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-meta text-ink-2">图标</label>
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap gap-1">
            {ASSISTANT_ICON_KEYS.map((key) => {
              const selected = icon === key;
              return (
                <button
                  key={key}
                  type="button"
                  title={ASSISTANT_ICON_LABELS[key]}
                  onClick={() => setIcon(key)}
                  className={`grid h-7 w-7 place-items-center rounded-btn border transition-colors ${
                    selected
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-line text-ink-2 hover:bg-panel-2 hover:text-ink"
                  }`}
                >
                  <AssistantIcon icon={key} size={15} />
                </button>
              );
            })}
          </div>
          <input
            value={isAssistantIconKey(icon) ? "" : icon}
            onChange={(e) => setIcon(e.target.value)}
            placeholder="自定义"
            title="也可以填入 emoji 或单个字符"
            className={`${inputCls} w-16 shrink-0 text-center`}
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-meta text-ink-2">名称</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：周报助手"
          className={inputCls}
        />
      </div>

      <div>
        <label className="mb-1 block text-meta text-ink-2">简介（可选）</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="一句话说明这个助手擅长什么"
          className={inputCls}
        />
      </div>

      <div>
        <label className="mb-1 block text-meta text-ink-2">系统提示词</label>
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
          <label className="mb-1 block text-meta text-ink-2">服务商</label>
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
          <label className="mb-1 block text-meta text-ink-2">模型</label>
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

      <details className="rounded-btn border border-line px-3 py-2">
        <summary className="cursor-pointer text-meta text-ink-2">
          工具策略（可选）
          {Object.keys(policies).length > 0 && (
            <span className="ml-1 text-accent">已设置 {Object.keys(policies).length} 项</span>
          )}
        </summary>
        <p className="mt-1.5 text-ui leading-4 text-ink-2">
          未设置的跟随全局设置；与全局冲突时始终采用更严格的一项（全局禁用无法被助手放开）。
        </p>
        <div className="mt-2 space-y-1.5">
          {tools.length === 0 ? (
            <p className="text-ui text-ink-2">正在加载工具列表…</p>
          ) : (
            tools.map((tool) => (
              <div key={tool.name} className="flex items-center gap-2">
                <span
                  className="min-w-0 flex-1 truncate text-ui text-ink"
                  title={tool.description}
                >
                  {tool.name}
                </span>
                <Dropdown
                  value={policies[tool.name] ?? ""}
                  onChange={(value) =>
                    setPolicies((prev) => {
                      const next = { ...prev };
                      if (!value) delete next[tool.name];
                      else next[tool.name] = value as ToolPolicy;
                      return next;
                    })
                  }
                  className="w-auto min-w-[6.5rem]"
                  options={[
                    { value: "", label: "跟随全局" },
                    ...POLICY_OPTIONS.map((option) => ({
                      value: option.value,
                      label: option.label,
                    })),
                  ]}
                />
              </div>
            ))
          )}
        </div>
      </details>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="rounded-btn border border-line px-3 py-1.5 text-meta text-ink-2 transition-colors hover:bg-panel-2"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={saving || !name.trim() || !prompt.trim()}
          className="cf-btn-primary"
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
          className="w-full resize-none rounded-btn border border-line bg-panel-2 px-3 py-2 text-ui text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-accent"
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          {value.trim() && (
            <button
              onClick={() => void clear()}
              className="cf-btn-secondary"
            >
              清除
            </button>
          )}
          <button
            onClick={() => void save()}
            className="cf-btn-primary"
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


/* ------------------------------------------------------------------------ */
/* Image generation model configuration                                      */
/* ------------------------------------------------------------------------ */


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
/* Skills tab — user-authored instruction packages (v19, 自定义技能)          */
/* ------------------------------------------------------------------------ */

function SkillsTab() {
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<SkillView | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      setSkills(await listSkills());
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
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

  const inputCls =
    "w-full rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-ui text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-accent";

  const doImport = async () => {
    setNotice(null);
    let picked: string | string[] | null = null;
    try {
      picked = await openDialog({
        title: "导入技能",
        multiple: true,
        filters: [
          {
            name: "技能文件（SKILL.md / JSON / ZIP）",
            extensions: ["md", "markdown", "txt", "json", "zip"],
          },
        ],
      });
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;

    setBusy(true);
    try {
      const report = await importSkillFiles(paths);
      await refresh();
      const parts: string[] = [];
      if (report.created > 0) parts.push(`新增 ${report.created} 个`);
      if (report.updated > 0) parts.push(`更新 ${report.updated} 个`);
      if (report.failed.length > 0) parts.push(`失败 ${report.failed.length} 个`);
      setNotice({
        ok: report.failed.length === 0,
        text: `导入完成：${parts.join(" · ") || "没有变化"}${
          report.failed.length > 0 ? `\n${report.failed.join("\n")}` : ""
        }`,
      });
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title="技能"
      description="导入或编写技能（支持 Claude Skills 的 SKILL.md 格式）：对话命中触发词时，AI 会按技能说明执行。技能的名称与描述随每次对话发送；完整说明仅在触发时注入，以节省上下文。"
      action={
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void doImport()}
            className="cf-btn-secondary"
          >
            导入技能
          </button>
          <button
            type="button"
            disabled={editing !== null}
            onClick={() => setEditing(newSkill())}
            className="cf-btn-primary"
          >
            新建
          </button>
        </div>
      }
    >
      {notice && (
        <div
          className={`mb-3 whitespace-pre-line rounded-btn border px-3 py-2 text-ui leading-5 ${
            notice.ok
              ? "border-line text-ink-2"
              : "border-[color-mix(in_srgb,var(--cf-danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--cf-danger)_8%,transparent)] text-danger"
          }`}
        >
          {notice.text}
        </div>
      )}

      {loading && (
        <div className="py-10 text-center text-ui text-ink-2">正在加载技能…</div>
      )}

      {!loading && skills.length === 0 && editing === null && (
        <div className="py-12 text-center">
          <p className="text-[0.9375rem] leading-6 text-ink">
            还没有技能
          </p>
          <p className="mt-1.5 text-[0.8125rem] leading-5 text-ink-2">
            点击「导入技能」导入 SKILL.md / JSON / ZIP 文件，
            <br />
            或点击「新建」从头编写一个，例如「周报助手」。
          </p>
        </div>
      )}

      {skills.map((skill) => (
        <div key={skill.id} className="mx-3 mb-2 rounded-btn border border-line bg-panel p-2.5">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-meta text-ink">{skill.name}</span>
            <Dropdown
              value={skill.enabled ? "on" : "off"}
              onChange={(value) =>
                void run("切换启用状态", async () => {
                  await upsertSkill({ ...skill, enabled: value === "on" });
                  await refresh();
                })
              }
              options={[
                { value: "on", label: "启用" },
                { value: "off", label: "禁用" },
              ]}
              className="w-20 shrink-0"
            />
          </div>
          {skill.description && (
            <p className="mt-1 text-ui text-ink-2">{skill.description}</p>
          )}
          <p className="mt-1 text-meta text-ink-2">
            {skill.triggers.length > 0
              ? `触发词：${skill.triggers.join("、")}`
              : "常驻技能：每次对话都会注入完整说明"}
          </p>
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditing({ ...skill })}
              className="rounded-btn border border-line px-2 py-1 text-ui text-ink-2 transition-colors hover:bg-panel-2 disabled:opacity-40"
            >
              编辑
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run("删除技能", async () => {
                  await deleteSkill(skill.id);
                  if (editing?.id === skill.id) setEditing(null);
                  await refresh();
                })
              }
              className="rounded-btn border border-line px-2 py-1 text-ui text-danger transition-colors hover:bg-panel-2 disabled:opacity-40"
            >
              删除
            </button>
          </div>
        </div>
      ))}

      {editing && (
        <div className="mx-3 mb-2 space-y-2 rounded-btn border border-line bg-panel-2 p-2.5">
          <input
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            placeholder="名称，例如：周报助手"
            className={inputCls}
          />
          <input
            value={editing.description}
            onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            placeholder="一句话说明用途（常驻注入，保持简短）"
            className={inputCls}
          />
          <input
            value={formatTriggers(editing.triggers)}
            onChange={(e) =>
              setEditing({ ...editing, triggers: parseTriggers(e.target.value) })
            }
            placeholder="触发词，逗号分隔，例如：周报，weekly；留空 = 每次对话都生效"
            className={inputCls}
          />
          <textarea
            value={editing.content}
            onChange={(e) => setEditing({ ...editing, content: e.target.value })}
            rows={7}
            placeholder={"技能说明（触发后注入给 AI 的指令），例如：\n把零散记录整理为周报，按「本周完成 / 进行中 / 下周计划」组织，语言简洁。"}
            className={`${inputCls} resize-y leading-5`}
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded-btn border border-line px-2 py-1 text-ui text-ink-2 transition-colors hover:bg-panel"
            >
              取消
            </button>
            <button
              type="button"
              disabled={busy || !editing.name.trim() || !editing.content.trim()}
              onClick={() =>
                void run("保存技能", async () => {
                  await upsertSkill(editing);
                  setEditing(null);
                  await refresh();
                })
              }
              className="rounded-btn bg-accent px-2.5 py-1 text-ui font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              保存
            </button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------------ */
/* Appearance tab — theme + avatar + hide-on-blur                            */
/* ------------------------------------------------------------------------ */


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
    "w-full rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-ui text-ink outline-none transition-colors focus:border-accent";

  return (
    <SettingsSection
      title="网络加速"
      description="通过本地代理转发 API 请求，可显著改善直连海外服务的速度与稳定性。"
    >
      <div className="p-3">
        <label className="mb-1 block text-meta text-ink-2">代理地址</label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="例如：http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
          spellCheck={false}
          className={inputCls}
        />
        <p className="mt-1 text-ui text-ink-2">
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
            className="rounded-btn border border-line px-2.5 py-1 text-meta text-ink-2 transition-colors hover:bg-panel-2"
          >
            清除
          </button>
        )}
        <button
          onClick={() => void save()}
          disabled={saving}
          className="cf-btn-primary"
        >
          {saved && <Check size={12} />}
          {saving ? "应用中…" : saved ? "已应用" : "应用"}
        </button>
      </div>
      {error && <p className="px-4 pb-2 text-ui text-danger">{error}</p>}
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

/** Per-engine guidance shown in the settings panel (free tier + signup). */
const ENGINE_HINTS: Record<
  string,
  { summary: string; url?: string; linkLabel?: string }
> = {
  duckduckgo: {
    summary:
      "免费无需配置，但自动化请求容易被反爬验证拦截；若测试经常失败，建议切换到下方任一注册制引擎（均有免费额度）。",
  },
  tavily: {
    summary: "国际主流 AI 搜索 API：每月 1000 次免费额度，注册无需信用卡。",
    url: "https://app.tavily.com/home",
    linkLabel: "前往 tavily.com 注册获取 Key",
  },
  bocha: {
    summary: "国内服务：直连速度快、中文搜索质量好，注册即赠免费调用额度。",
    url: "https://open.bochaai.com/",
    linkLabel: "前往 open.bochaai.com 注册获取 Key",
  },
  searxng: {
    summary:
      "自建实例免费不限量；公共实例普遍限流或已关闭 JSON 输出，建议自行搭建。",
    url: "https://docs.searxng.org/",
    linkLabel: "查看自建部署文档",
  },
};

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
        }${report.skills ? ` · ${report.skills} 个技能` : ""}${
          report.images ? ` · ${report.images} 张图片` : ""
        }（${(report.bytes / 1024).toFixed(1)} KB）`,
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
      const report = await useChatStore.getState().importBackup(pendingPath, strategy);
      setMessage({
        ok: true,
        text: `导入完成：新增 ${report.conversations} 个会话 · ${report.messages} 条消息 · ${report.memories} 条记忆${
          report.skills ? ` · ${report.skills} 个技能` : ""
        }${report.skipped > 0 ? `，跳过 ${report.skipped} 条已存在内容` : ""}`,
      });
      setPendingPath(null);
      setPreview(null);
      setConfirming(false);
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsSection
      title="数据备份"
      description="导出/导入会话、记忆、技能与生成图片。备份中不包含 API Key，换机器后需要重新填写。"
    >
      <div className="space-y-2 px-3 pb-2 pt-1">
        <label className="flex items-center gap-2 text-meta text-ink">
          <input
            type="checkbox"
            checked={includeMemories}
            onChange={(e) => setIncludeMemories(e.target.checked)}
            className="rounded border-line"
          />
          包含长期记忆
        </label>
        <label className="flex items-center gap-2 text-meta text-ink">
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
          className="flex items-center gap-1.5 rounded-btn border border-line px-3 py-1.5 text-meta text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
        >
          {busy === "export" && <Loader2 size={12} className="animate-spin" />}
          导出备份…
        </button>
        <button
          type="button"
          onClick={() => void pickImportFile()}
          disabled={busy !== null}
          className="flex items-center gap-1.5 rounded-btn border border-line px-3 py-1.5 text-meta text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
        >
          {busy === "import" && <Loader2 size={12} className="animate-spin" />}
          导入备份…
        </button>
      </div>

      {preview && (
        <div className="mx-3 mb-2 rounded-btn border border-line bg-panel-2 p-2.5">
          <p className="text-meta text-ink">
            该备份包含 {preview.conversations} 个会话 · {preview.messages} 条消息 ·{" "}
            {preview.memories} 条记忆
            {preview.skills > 0 ? ` · ${preview.skills} 个技能` : ""}
            {preview.images > 0 ? ` · ${preview.images} 张图片` : ""}
          </p>
          <p className="mt-0.5 text-ui text-ink-2">
            导出于 {new Date(preview.exportedAt).toLocaleString("zh-CN")}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-ui text-ink">
              <input
                type="radio"
                checked={strategy === "merge"}
                onChange={() => setStrategy("merge")}
                className="border-line"
              />
              合并（保留现有数据）
            </label>
            <label className="flex items-center gap-1.5 text-ui text-ink">
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
            <p className="mt-1.5 text-ui text-danger">
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
                  className="rounded-btn bg-danger px-2.5 py-1 text-ui text-white transition-opacity hover:opacity-85 disabled:opacity-40"
                >
                  确认导入
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded-btn border border-line px-2.5 py-1 text-ui text-ink-2 transition-colors hover:bg-panel"
                >
                  取消
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  className="rounded-btn bg-accent px-2.5 py-1 text-ui font-medium text-accent-fg transition-opacity hover:opacity-90"
                >
                  开始导入
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPreview(null);
                    setPendingPath(null);
                  }}
                  className="rounded-btn border border-line px-2.5 py-1 text-ui text-ink-2 transition-colors hover:bg-panel"
                >
                  取消
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {message && (
        <p className={`px-4 pb-2 text-ui ${message.ok ? "text-ink-2" : "text-danger"}`}>
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
    // Servers start on demand, so opening the panel is the trigger. The list
    // is re-read once they are up, so the tools appear without a manual reload.
    void warmMcpServers()
      .then(() => refresh())
      .catch(() => undefined);
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
    "w-full rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-ui text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-accent";

  return (
    <SettingsSection
      title="MCP 服务器"
      description="接入 Model Context Protocol 工具服务器（stdio）。其工具会出现在 Agent 工具列表中，且默认每次调用都需要确认。"
    >
      <div className="mx-3 mb-2 rounded-btn border border-[color-mix(in_srgb,var(--cf-danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--cf-danger)_8%,transparent)] px-2.5 py-1.5 text-ui leading-5 text-danger">
        MCP 服务器会在本机执行任意代码（与你当前用户权限相同）。仅添加你信任来源的服务器。
      </div>

      {servers.map((server) => (
        <div key={server.id} className="mx-3 mb-2 rounded-btn border border-line bg-panel p-2.5">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-meta text-ink">{server.name}</span>
            <span className="shrink-0 text-meta text-ink-2">{server.tools.length} 个工具</span>
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
          <p className="mt-1 break-all font-mono text-meta text-ink-2">{server.commandLine}</p>

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
              className="rounded-btn border border-line px-2 py-1 text-ui text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
            >
              测试连接
            </button>
            <button
              type="button"
              onClick={() => setEditing({ ...server })}
              className="rounded-btn border border-line px-2 py-1 text-ui text-ink-2 transition-colors hover:bg-panel-2"
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
              className="rounded-btn border border-line px-2 py-1 text-ui text-danger transition-colors hover:bg-panel-2 disabled:opacity-40"
            >
              删除
            </button>
            {toolsFor[server.id] && (
              <span className="text-meta text-ink-2">
                发现 {toolsFor[server.id].length} 个工具
              </span>
            )}
          </div>

          {toolsFor[server.id] && toolsFor[server.id].length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {toolsFor[server.id].map((tool) => (
                <li key={tool.qualified} className="truncate text-meta text-ink-2" title={tool.description}>
                  · {tool.toolName} → {tool.qualified}
                </li>
              ))}
            </ul>
          )}

          {server.tools.length > 0 && !toolsFor[server.id] && (
            <ul className="mt-1.5 space-y-0.5">
              {server.tools.map((tool) => (
                <li key={tool.qualified} className="truncate text-meta text-ink-2" title={tool.description}>
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
            className={`${inputCls} resize-none font-mono text-ui leading-5`}
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
            className={`${inputCls} resize-none font-mono text-ui leading-5`}
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded-btn border border-line px-2 py-1 text-ui text-ink-2 transition-colors hover:bg-panel"
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
              className="rounded-btn bg-accent px-2.5 py-1 text-ui font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              保存并连接
            </button>
          </div>
        </div>
      ) : (
        <div className="mb-3 space-y-3">
          <div>
            <label className="cf-field-label">从 JSON 粘贴</label>
            <div className="flex items-center gap-2">
              <input
                value={jsonDraft}
                onChange={(e) => setJsonDraft(e.target.value)}
                placeholder='{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","D:\\docs"]}'
                spellCheck={false}
                className={`${inputCls} font-mono text-ui`}
              />
              <button
                type="button"
                disabled={!jsonDraft.trim()}
                onClick={() => void applyJson()}
                className="cf-btn-secondary shrink-0"
              >
                解析
              </button>
            </div>
            <p className="mt-1 text-meta text-ink-3">
              粘贴服务器配置 JSON，自动填充下方表单。
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEditing(emptyServer())}
            className="cf-btn-secondary"
          >
            <Plus size={13} /> 手动添加服务器
          </button>
        </div>
      )}

      {notice && (
        <p className={`px-4 pb-2 text-ui ${notice.ok ? "text-ink-2" : "text-danger"}`}>
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
    "w-full rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-ui text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-accent";

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

      <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-2 text-ui text-ink-2">
        <span>
          共 {view?.documents ?? documents.length} 篇 · {view?.chunks ?? 0} 个片段
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void addFile()}
            disabled={busy}
            className="flex items-center gap-1 rounded-btn border border-line px-2 py-1 text-ui text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />} 导入文件
          </button>
          <button
            type="button"
            onClick={() => setPasteOpen((v) => !v)}
            className="rounded-btn border border-line px-2 py-1 text-ui text-ink transition-colors hover:bg-panel-2"
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
          className="shrink-0 rounded-btn border border-line px-2.5 py-1.5 text-meta text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
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
              className="rounded-btn border border-line px-2 py-1 text-ui text-ink-2 transition-colors hover:bg-panel"
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
              className="rounded-btn bg-accent px-2.5 py-1 text-ui font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
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
              <span className="min-w-0 flex-1 truncate text-meta text-ink" title={doc.sourceRef ?? doc.title}>
                {doc.title}
              </span>
              <span className="cf-provider-badge shrink-0">
                {KB_SOURCE_LABELS[doc.sourceType] ?? doc.sourceType}
              </span>
              <span className="shrink-0 text-meta text-ink-2">{doc.chunkCount} 片段</span>
              {confirmingId === doc.id ? (
                <button
                  type="button"
                  onClick={() => {
                    void run("删除", () => deleteKbDocument(doc.id));
                    setConfirmingId(null);
                  }}
                  className="shrink-0 text-ui text-danger"
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
        <label className="mb-1 block text-meta text-ink-2">检索测试</label>
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
            className="shrink-0 rounded-btn border border-line px-2.5 py-1.5 text-meta text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
          >
            检索
          </button>
        </div>
        {hits && (
          <div className="mt-1.5 space-y-1.5">
            {hits.length === 0 && <p className="text-ui text-ink-2">没有命中片段</p>}
            {hits.map((hit, index) => (
              <div
                key={`${hit.documentId}-${hit.seq}-${index}`}
                className="rounded-btn border border-line bg-panel-2 px-2 py-1.5 text-ui leading-5"
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
        <p className={`px-4 pb-2 text-ui ${notice.ok ? "text-ink-2" : "text-danger"}`}>
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
    "w-full rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-ui text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-accent";

  const hint = ENGINE_HINTS[engine] ?? ENGINE_HINTS.duckduckgo;

  return (
    <SettingsSection
      title="联网搜索"
      description="Agent 的 web_search 工具与对话中的联网搜索都使用这里选择的引擎。"
    >
      <FormRow label="搜索引擎" description={hint.summary}>
        <Dropdown
          value={engine}
          onChange={setEngine}
          options={SEARCH_ENGINE_OPTIONS}
          className="w-56"
        />
      </FormRow>

      {needsKey && (
        <div className="px-3 pb-2">
          <label className="mb-1 block text-meta text-ink-2">API Key</label>
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
          <p className="mt-1 text-ui text-ink-2">
            保存在 Windows 凭据管理器中，不会写入配置文件。保存后可用下方「测试搜索」验证。
          </p>
          {hint.url && (
            <button
              type="button"
              onClick={() => void openUrl(hint.url!).catch(() => undefined)}
              className="mt-1 flex items-center gap-1 text-ui text-accent transition-opacity hover:opacity-80"
            >
              <ExternalLink size={11} />
              {hint.linkLabel}
            </button>
          )}
        </div>
      )}

      {engine === "duckduckgo" && (
        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={() => setEngine("bocha")}
            className="text-ui text-accent underline underline-offset-2 transition-opacity hover:opacity-80"
          >
            点此改用「博查」：国内直连、注册送免费额度（也可选 Tavily，每月 1000 次免费）
          </button>
        </div>
      )}

      {engine === "searxng" && (
        <div className="px-3 pb-2">
          <label className="mb-1 block text-meta text-ink-2">实例地址</label>
          <input
            value={searxUrl}
            onChange={(e) => setSearxUrl(e.target.value)}
            placeholder="https://searx.example.com"
            spellCheck={false}
            className={inputCls}
          />
          <p className="mt-1 text-ui text-ink-2">
            需在实例的 settings.yml 中开启 JSON 输出（format: json）。
          </p>
        </div>
      )}

      {loaded && !ready && engine !== "duckduckgo" && (
        <p className="px-4 pb-1 text-ui text-danger">
          当前引擎尚未配置完成，联网搜索会返回错误提示。
        </p>
      )}

      <div className="px-3 pb-2 pt-1">
        <label className="mb-1 block text-meta text-ink-2">测试搜索</label>
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
            className="flex shrink-0 items-center gap-1 rounded-btn border border-line px-3 py-1.5 text-meta text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
          >
            {testing && <Loader2 size={12} className="animate-spin" />}
            测试
          </button>
        </div>
        {testError && <p className="mt-1.5 text-ui text-danger">{testError}</p>}
        {testResult && (
          <div className="mt-1.5 space-y-1.5 rounded-btn border border-line bg-panel-2 p-2">
            <p className="text-ui text-ink-2">
              {testResult.count} 条结果 · {testResult.elapsedMs} ms
            </p>
            {testResult.results.map((r, i) => (
              <div key={i} className="min-w-0 text-ui leading-4">
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
          className="cf-btn-primary"
        >
          {saved && <Check size={12} />}
          {saving ? "保存中…" : saved ? "已保存" : "保存"}
        </button>
      </div>
      {error && <p className="px-4 pb-2 text-ui text-danger">{error}</p>}
    </SettingsSection>
  );
}


/* ------------------------------------------------------------------------ */
/* Reusable avatar config section (AI or user)                               */
/* ------------------------------------------------------------------------ */


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
        <span className="min-w-24 flex-1 rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-center text-meta text-ink">
          {recording ? "按下新快捷键…" : current || (kind === "quick" ? "Alt+Q" : "Alt+Space")}
        </span>
        <button
          onClick={() => {
            setError(null);
            setRecording(!recording);
          }}
          className="rounded-btn border border-line px-2.5 py-1.5 text-meta text-ink transition-colors hover:bg-panel-2"
        >
          {recording ? "取消" : "重新录入"}
        </button>
      </div>
      {kind === "quick" && (
        <button
          onClick={toggleEnabled}
          className={`self-start rounded-btn px-2 py-0.5 text-ui transition-colors ${
            enabled
              ? "bg-accent text-accent-fg hover:opacity-90"
              : "border border-line text-ink-2 hover:bg-panel-2"
          }`}
        >
          {enabled ? "划词已启用" : "划词已停用"}
        </button>
      )}
      {error && <p className="mt-1 text-meta text-danger">{error}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Agent tools tab                                                          */
/* ------------------------------------------------------------------------ */

/** Human-readable name for each builtin tool. */
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
            <p className="text-ui font-medium text-ink">唤起快捷键</p>
            <p className="mt-0.5 text-meta text-ink-2">
              录入后立即生效并保存；若与系统或其他软件冲突会提示失败。Esc 取消录入。
            </p>
          </div>
          <div className="flex w-44 shrink-0 flex-col gap-1">
            <ShortcutRecorder />
          </div>
        </div>

        <div className="cf-form-row items-start">
          <div className="flex-1">
            <p className="text-ui font-medium text-ink">划词助手快捷键</p>
            <p className="mt-0.5 text-meta text-ink-2">
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

      <SettingsSection
        title="会话历史"
        description="控制是否持久化对话记录到本地数据库（侧栏最多列出最近 200 个会话，消息搜索最多返回 30 条命中）"
      >
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
                className="cf-btn-secondary"
              >
                取消
              </button>
              <button
                onClick={() => void clearData()}
                className="rounded-btn bg-danger px-3 py-1 text-ui font-medium text-white transition-opacity hover:opacity-90"
              >
                确认清空全部会话
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              className="rounded-btn border border-line bg-transparent px-3 py-1 text-ui text-danger transition-colors hover:bg-[color-mix(in_srgb,var(--cf-danger)_8%,transparent)]"
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
/* Context tab — prompt presets + long-term memory                          */
/* ------------------------------------------------------------------------ */

function ContextTab() {
  return (
    <>
      <PresetSection />
      <MemorySection />
    </>
  );
}

/* ------------------------------------------------------------------------ */
/* Integrations tab — network, search, MCP                                   */
/* ------------------------------------------------------------------------ */

function IntegrationsTab() {
  return (
    <>
      <ProxySection />
      <WebSearchSection />
      <McpSection />
    </>
  );
}

/* ------------------------------------------------------------------------ */
/* Data tab — knowledge base + backup                                        */
/* ------------------------------------------------------------------------ */

function DataTab() {
  return (
    <>
      <KnowledgeSection />
      <BackupSection />
    </>
  );
}

/* ------------------------------------------------------------------------ */
/* Diagnostics tab — redacted agent-run traces (v2.0 phase 5)                */
/* ------------------------------------------------------------------------ */


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
    "w-full rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-ui text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-accent";

  return (
    <SettingsSection
      title="长期记忆"
      description="长期记忆只在得到你的确认后保存，并会随对话自动注入，帮助助手记住你的偏好与背景。密码、密钥等敏感内容会被拒绝保存。"
      action={
        editingId === null && (
          <button
            onClick={startAdd}
            className="flex items-center gap-1 rounded-btn border border-line px-2 py-1 text-ui text-ink transition-colors hover:bg-panel-2"
          >
            <Plus size={11} />
            添加记忆
          </button>
        )
      }
    >
      {error && <p className="px-4 pt-2 text-ui text-danger">{error}</p>}

      {editingId !== null && (
        <div className="space-y-3 p-3">
          <div>
            <label className="mb-1 block text-meta text-ink-2">类别</label>
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
            <label className="mb-1 block text-meta text-ink-2">内容</label>
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
              className="cf-btn-secondary"
            >
              取消
            </button>
            <button
              onClick={() => void save()}
              className="cf-btn-primary"
              disabled={!draftContent.trim()}
            >
              保存
            </button>
          </div>
        </div>
      )}

      {!loaded ? (
        <p className="px-4 py-6 text-meta text-ink-2">加载中…</p>
      ) : memories.length === 0 ? (
        <p className="px-4 py-6 text-meta text-ink-2">暂无记忆。</p>
      ) : (
        <ul>
          {memories.map((m) => (
            <li key={m.id} className="cf-tool-item">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-panel-2 px-1.5 py-0.5 text-meta text-ink-2">
                    {CATEGORY_LABELS[m.category] ?? m.category}
                  </span>
                  {!m.enabled && (
                    <span className="rounded bg-panel-2 px-1.5 py-0.5 text-meta text-danger">
                      已停用
                    </span>
                  )}
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-ui text-ink">
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
            className="text-ui text-danger transition-colors hover:opacity-80"
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
    "w-full rounded-btn border border-line bg-panel-2 px-2.5 py-1.5 text-ui text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-accent";

  return (
    <SettingsSection
      title="快捷指令"
      description="在输入框中输入 / 即可触发快捷指令，快速填充预设的提示词模板。"
      action={
        editingId === null && (
          <button
            onClick={startAdd}
            className="flex items-center gap-1 rounded-btn border border-line px-2 py-1 text-meta text-ink transition-colors hover:bg-panel-2"
          >
            <Plus size={12} /> 添加
          </button>
        )
      }
    >
      {editingId !== null && (
        <div className="space-y-3 p-3">
          <div>
            <label className="mb-1 block text-meta text-ink-2">名称</label>
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="如：翻译"
              className={inputCls}
            />
          </div>
          <div>
            <label className="mb-1 block text-meta text-ink-2">触发指令</label>
            <input
              value={draftCommand}
              onChange={(e) => setDraftCommand(e.target.value)}
              placeholder="如：/翻译"
              className={inputCls}
              spellCheck={false}
            />
          </div>
          <div>
            <label className="mb-1 block text-meta text-ink-2">提示词内容</label>
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
              className="cf-btn-secondary"
            >
              取消
            </button>
            <button
              onClick={() => void save()}
              disabled={!draftName.trim() || !draftCommand.trim() || !draftContent.trim()}
              className="cf-btn-primary"
            >
              <Check size={13} /> 保存
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
            <span className="shrink-0 rounded bg-panel-2 px-1.5 py-px font-mono text-ui text-accent">
              {p.command}
            </span>
            <span className="truncate text-meta text-ink">{p.name}</span>
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
          <p className="rounded-btn border border-dashed border-line px-3 py-3 text-center text-meta text-ink-2">
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
      <p className="text-ui leading-5 text-ink-2">
        芝麻 v{version} · 全局快捷键唤起 / 隐藏
        <br />
        默认模型可随时在顶部模型选择器中切换
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------------ */


function Notice({ ok, text }: { ok: boolean; text: string }) {
  return (
    <p
      className={`rounded-btn border px-2.5 py-1.5 text-meta leading-5 ${
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
          <h3 className="text-ui font-semibold text-ink">{title}</h3>
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
        <label htmlFor={htmlFor} className="block text-ui font-medium text-ink">
          {label}
        </label>
        {description && <p className="mt-0.5 text-meta text-ink-2">{description}</p>}
      </div>
      <div className="flex w-44 shrink-0 justify-end">{children}</div>
    </div>
  );
}


