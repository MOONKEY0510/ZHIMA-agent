import { useEffect, useState } from "react";
import {
  Calculator,
  Clipboard,
  ClipboardPaste,
  Clock,
  ExternalLink,
  FileText,
  FileType,
  Globe,
  LinkIcon,
  MonitorUp,
  Wrench,
} from "lucide-react";
import { useSettingsStore } from "../../../stores/settings-store";
import { listTools, setToolPolicy, type ToolInfo, type ToolPolicy } from "../../../services/tools-api";
import { Dropdown, SettingsSection, FormRow, FormSwitch } from "../ui";

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
  mcp: { text: "MCP 服务器 · 每次确认", tone: "warn" },
};


export const POLICY_OPTIONS: { value: ToolPolicy; label: string; hint: string }[] = [
  { value: "allow", label: "按工具默认", hint: "按工具自身设定确认或执行" },
  { value: "confirm", label: "每次确认", hint: "普通工具调用每次都需确认" },
  { value: "always_allow", label: "永久允许", hint: "普通调用免确认；敏感数据外发仍需确认" },
  { value: "disabled", label: "禁用", hint: "不会提供给模型" },
];


export function AgentToolsTab() {
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
          <p className="text-ui font-medium text-ink">工具列表</p>
          {tools && (
            <span className="text-meta text-ink-2">
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
                      <span className="rounded bg-panel-2 px-1.5 py-px text-meta text-ink-2">
                        {tool.name}
                      </span>
                      <span
                        className={`shrink-0 rounded px-1.5 py-px text-meta ${
                          risk.tone === "warn"
                            ? "bg-[var(--cf-warn-bg,var(--cf-danger-weak,#fde))] text-[var(--cf-danger)]"
                            : "bg-panel-2 text-ink-2"
                        }`}
                      >
                        {risk.text}
                      </span>
                    </div>
                    <p className="mt-1 text-ui leading-4 text-ink-2">{tool.description}</p>
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
                    <span className="mt-1 text-meta text-ink-2">
                      {POLICY_OPTIONS.find((o) => o.value === tool.policy)?.hint}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="py-6 text-center text-ui text-ink-2">正在加载工具列表…</p>
        )}
      </div>
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------------ */
/* General tab — shortcut + history + about                                  */
/* ------------------------------------------------------------------------ */

