import { useEffect, useState } from "react";
import { useSettingsStore, type DesktopActionConfig, type PromptPreset } from "../../stores/settings-store";
import { useAssistantsStore, sortedAssistants } from "../../stores/assistants-store";
import { listSkills, type SkillView } from "../../services/skills-api";
import { DEFAULT_DESKTOP_PRESETS } from "./desktop-actions";
import { SettingsSection } from "../settings/ui";

const fieldClass = "cf-input";
const buttonClass = "cf-btn-secondary !px-2.5 !py-1.5 !text-ui";
type ActionPreset = PromptPreset & { desktopAction: DesktopActionConfig };

/** Standalone settings section. UI prefs only: no providers, credentials or runtime captures. */
export function DesktopActionsSettings() {
  const presets = useSettingsStore((state) => state.presets);
  const assistants = useAssistantsStore((state) => state.assistants);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [draft, setDraft] = useState<ActionPreset | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    listSkills().then((all) => { if (current) setSkills(all.filter((skill) => skill.enabled)); }).catch(() => { if (current) setError("技能列表暂不可用；已配置的技能 ID 将保留。"); });
    return () => { current = false; };
  }, []);
  const actions = presets.filter((p): p is ActionPreset => !!p.desktopAction);
  const persist = async (next: PromptPreset[], close = false) => {
    setBusy(true);
    setError(null);
    try {
      await useSettingsStore.getState().setPresets(next);
      if (close) setDraft(null);
      setDeleting(null);
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };
  const patchAction = (patch: Partial<DesktopActionConfig>) => setDraft((prev) => prev ? { ...prev, desktopAction: { ...prev.desktopAction, ...patch } } : prev);
  const move = (id: string, delta: number) => {
    const index = actions.findIndex((p) => p.id === id);
    const other = actions[index + delta];
    if (!other) return;
    const next = [...presets];
    const a = next.findIndex((p) => p.id === id), b = next.findIndex((p) => p.id === other.id);
    [next[a], next[b]] = [next[b], next[a]];
    void persist(next);
  };
  const save = () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.desktopAction.template.includes("{{input}}")) { setError("请填写名称，模板需包含 {{input}}。"); return; }
    if (draft.command && (!draft.command.startsWith("/") || /\s/.test(draft.command) || presets.some((p) => p.id !== draft.id && p.command === draft.command))) { setError("指令需以 / 开头、不含空白且不能重复。"); return; }
    const next = { ...draft, name: draft.name.trim(), content: draft.desktopAction.template.replaceAll("{{input}}", "").trim() };
    void persist(presets.some((p) => p.id === next.id) ? presets.map((p) => p.id === next.id ? next : p) : [...presets, next], true);
  };
  return <SettingsSection title="桌面动作" ariaLabel="桌面动作设置"
    description="与快捷指令共享模板，并非两份独立配置。此入口管理选中文本 / 剪贴板来源、助手与技能；同名条目无需重复创建。"
    action={<>
      <button type="button" className={buttonClass} disabled={busy} onClick={() => { setError(null); setDraft({ id: crypto.randomUUID(), name: "", command: "", content: "", desktopAction: { source: "clipboard", template: "{{input}}", skillIds: [], output: "display" } }); }}>新建动作</button>
      <button type="button" className={buttonClass} disabled={busy} onClick={() => void persist([...presets, ...DEFAULT_DESKTOP_PRESETS.filter((p) => !presets.some((existing) => existing.id === p.id || existing.command === p.command))])}>添加内置样例</button>
    </>}>
    <div className="space-y-4">
    <p className="text-meta leading-6 text-ink-2">读取选中文本或剪贴板后，仅追加到草稿，检查后自行发送；不自动联网、复制或回填原应用。需要复制时使用回答的复制按钮。工具权限沿用现有确认规则。</p>
    {error && <p role="alert" className="text-ui text-danger">{error}</p>}
    {actions.length === 0 && <p className="cf-settings-empty">暂无桌面动作。新建动作或添加内置样例后，即可使用选中文本与剪贴板入口。</p>}
    <ul className="space-y-3" aria-label="桌面动作列表">
    {actions.map((p, index) => <li key={p.id} className="cf-settings-action-card space-y-3 text-ui">
      <div className="min-w-0">
        <p className="break-words font-medium text-ink">{p.name}</p>
        <p className="mt-1 break-words text-meta leading-5 text-ink-2">{p.command && <span className="mr-2 font-mono text-accent">{p.command}</span>}{p.desktopAction.source === "selection" ? "划词" : "剪贴板"} · {p.desktopAction.output === "copy" ? "手动复制回答" : "显示回答"}</p>
      </div>
      <div className="cf-settings-actions">
      <button type="button" className={buttonClass} disabled={busy} aria-label={`${p.desktopAction.favorite ? "取消收藏" : "收藏"} ${p.name}`} aria-pressed={!!p.desktopAction.favorite} onClick={() => void persist(presets.map((item) => item.id === p.id ? { ...p, desktopAction: { ...p.desktopAction, favorite: !p.desktopAction.favorite } } : item))}>{p.desktopAction.favorite ? "已收藏" : "收藏"}</button>
      <button type="button" className={buttonClass} disabled={busy || index === 0} aria-label={`上移 ${p.name}`} onClick={() => move(p.id, -1)}>上移</button>
      <button type="button" className={buttonClass} disabled={busy || index === actions.length - 1} aria-label={`下移 ${p.name}`} onClick={() => move(p.id, 1)}>下移</button>
      <button type="button" className={buttonClass} disabled={busy} aria-label={`编辑 ${p.name}`} onClick={() => { setError(null); setDraft({ ...p, desktopAction: { ...p.desktopAction, skillIds: [...p.desktopAction.skillIds] } }); }}>编辑</button>
      <button type="button" className={buttonClass} disabled={busy} aria-label={`删除 ${p.name}`} onClick={() => setDeleting(p.id)}>删除</button>
      </div>
      {deleting === p.id && <div className="cf-settings-actions border-t border-line pt-3"><span className="text-ink-2">确认删除此动作？</span><button type="button" className={`${buttonClass} text-danger`} disabled={busy} onClick={() => void persist(presets.filter((item) => item.id !== p.id))}>确认删除</button><button type="button" className={buttonClass} onClick={() => setDeleting(null)}>取消</button></div>}
    </li>)}
    </ul>
    {draft && <fieldset disabled={busy} className="cf-settings-editor space-y-4">
      <legend>{presets.some((p) => p.id === draft.id) ? "编辑动作" : "新建动作"}</legend>
      <label className="cf-settings-field">名称<input className={fieldClass} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
      <label className="cf-settings-field">指令（可选）<input className={fieldClass} value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} /></label>
      <label className="cf-settings-field">来源<select className={fieldClass} value={draft.desktopAction.source} onChange={(e) => patchAction({ source: e.target.value as DesktopActionConfig["source"] })}><option value="selection">选中文本</option><option value="clipboard">剪贴板</option></select></label>
      <label className="cf-settings-field">模板<textarea rows={4} className={fieldClass} value={draft.desktopAction.template} onChange={(e) => patchAction({ template: e.target.value })} /></label>
      <p className="text-meta text-ink-2">用 {"{{input}}"} 放置原文。模板随 UI 设置导出，请勿填写密钥。</p>
      <label className="cf-settings-field">助手<select className={fieldClass} value={draft.desktopAction.assistantId ?? ""} onChange={(e) => patchAction({ assistantId: e.target.value || undefined })}><option value="">沿用当前助手</option>{draft.desktopAction.assistantId && !assistants.some((a) => a.id === draft.desktopAction.assistantId) && <option value={draft.desktopAction.assistantId}>不可用：{draft.desktopAction.assistantId}</option>}{sortedAssistants(assistants).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <p className="text-meta text-ink-2">更换已有会话的助手时会明确要求新建会话；不会假装修改已有绑定。</p>
      <fieldset className="space-y-2 border-t border-line pt-3"><legend className="cf-field-label">技能（沿用现有启用与权限规则）</legend>{skills.length === 0 && draft.desktopAction.skillIds.length === 0 && <p className="text-meta text-ink-2">暂无已启用技能，可在「技能」页管理。</p>}{skills.map((skill) => <label key={skill.id} className="mr-3 inline-flex items-center gap-1"><input type="checkbox" checked={draft.desktopAction.skillIds.includes(skill.id)} onChange={(e) => patchAction({ skillIds: e.target.checked ? [...draft.desktopAction.skillIds, skill.id] : draft.desktopAction.skillIds.filter((id) => id !== skill.id) })} />{skill.name}</label>)}{draft.desktopAction.skillIds.filter((id) => !skills.some((skill) => skill.id === id)).map((id) => <label key={id} className="cf-settings-field"><input type="checkbox" checked onChange={() => patchAction({ skillIds: draft.desktopAction.skillIds.filter((value) => value !== id) })} />不可用技能：{id}（取消勾选移除）</label>)}</fieldset>
      <label className="cf-settings-field">输出<select className={fieldClass} value={draft.desktopAction.output} onChange={(e) => patchAction({ output: e.target.value as DesktopActionConfig["output"] })}><option value="display">显示回答</option><option value="copy">显式复制（使用回答复制按钮）</option></select></label>
      <div className="cf-settings-actions border-t border-line pt-4"><button type="button" className="cf-btn-primary !text-ui" onClick={save}>保存动作</button><button type="button" className={buttonClass} onClick={() => setDraft(null)}>取消编辑</button></div>
    </fieldset>}
    </div>
  </SettingsSection>;
}
