import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useChatStore } from "../../stores/chat-store";
import { SettingsSection } from "../settings/ui";
import {
  createRestorePoint, exportData, listRestorePoints, previewBackup, restoreBackupConfig,
  type BackupCounts, type BackupPreview, type BackupUiPreferences, type ImportStrategy,
  type PortableConfig, type RestorePoint,
} from "../../services/backup-api";

export interface BackupPanelProps {
  uiPreferences?: BackupUiPreferences;
  onRestorePreferences?: (preferences: BackupUiPreferences) => Promise<void>;
  /** Reload provider/config views after explicit configuration restoration. */
  onConfigRestored?: () => Promise<void>;
}
const button = "cf-btn-secondary shrink-0 whitespace-nowrap !text-ui";
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function counts(value: BackupCounts) {
  return `${value.conversations} 个会话 · ${value.messages} 条消息 · ${value.memories} 条记忆 · ${value.skills} 个技能 · ${value.images} 张图片 · ${value.assistants ?? 0} 个助手 · ${value.documents ?? 0} 份知识文档 / ${value.chunks ?? 0} 个分块 · ${value.summaries ?? 0} 个摘要 · ${value.tasks ?? 0} 个待办`;
}

export function BackupPanel({ uiPreferences, onRestorePreferences, onConfigRestored }: BackupPanelProps) {
  const importing = useChatStore((s) => s.importingBackup);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [includeImages, setIncludeImages] = useState(true);
  const [includeMemories, setIncludeMemories] = useState(true);
  const [includeConfig, setIncludeConfig] = useState(true);
  const [points, setPoints] = useState<RestorePoint[]>([]);
  const [pending, setPending] = useState<{ path: string; preview: BackupPreview } | null>(null);
  const [strategy, setStrategy] = useState<ImportStrategy>("merge");
  const [confirmed, setConfirmed] = useState(false);
  const [pendingConfig, setPendingConfig] = useState<PortableConfig | null>(null);
  const [configConfirmed, setConfigConfirmed] = useState(false);
  const disabled = busy || importing;
  const refresh = async () => setPoints(await listRestorePoints());
  useEffect(() => { void listRestorePoints().then(setPoints).catch((e) => setMessage(`恢复点列表读取失败：${errorText(e)}`)); }, []);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setMessage("");
    try { await work(); } catch (e) { setMessage(errorText(e)); } finally { setBusy(false); }
  };
  const preview = async (path: string, mode: ImportStrategy) => {
    const value = await previewBackup(path);
    setPending({ path, preview: value }); setStrategy(mode); setConfirmed(false);
  };
  const doImport = async () => {
    if (!pending || !confirmed) return;
    const report = await useChatStore.getState().importBackup(pending.path, strategy);
    setPending(null); setConfirmed(false);
    setPendingConfig(report.pendingConfig ?? null); setConfigConfirmed(false);
    setMessage(`资料导入完成：${counts(report)}，跳过 ${report.skipped} 条。配置尚未修改。`);
    try { await refresh(); } catch (e) { setMessage(`资料导入完成，但恢复点列表刷新失败：${errorText(e)}`); }
  };
  const restoreConfig = async () => {
    if (!pendingConfig || !configConfirmed) return;
    const prefs = await restoreBackupConfig(pendingConfig);
    // Deliberately separate persistence domains. Never imply DB rollback or
    // silently swallow a UI/store error after the config file has committed.
    setPendingConfig(null); setConfigConfirmed(false);
    try {
      if (prefs && onRestorePreferences) await onRestorePreferences(prefs);
      if (onConfigRestored) await onConfigRestored();
      setMessage(prefs && !onRestorePreferences
        ? "服务商配置已恢复；当前入口未提供 UI 偏好恢复器，UI 偏好未恢复。资料不受影响。"
        : "非敏感配置已恢复。API Key、MCP 与机器专属设置保持原状。");
    } catch (e) {
      setMessage(`服务商配置已保存，但 UI 偏好或界面刷新失败：${errorText(e)}。资料导入保持成功；请重新检查设置，不会自动重试或回滚。`);
    }
  };

  return <SettingsSection title="数据备份与恢复点" ariaLabel="数据备份"
    description="完整指资料、助手及白名单非敏感配置，不是系统镜像。备份是明文，可能包含私密会话、记忆和文档，请妥善保管。">
    <div className="space-y-4">
    <p className="text-ui text-ink-2">不包含 API Key、代理认证、MCP 启动命令/参数/env、自动执行授权、头像/背景二进制与路径、诊断日志。带认证或查询参数的服务商 URL 会被拒绝。</p>
    <div className="flex flex-wrap gap-3 text-ui text-ink">
      <label><input type="checkbox" checked={includeMemories} disabled={disabled} onChange={(e) => setIncludeMemories(e.target.checked)} /> 包含长期记忆</label>
      <label><input type="checkbox" checked={includeImages} disabled={disabled} onChange={(e) => setIncludeImages(e.target.checked)} /> 包含生成图片</label>
      <label><input type="checkbox" checked={includeConfig} disabled={disabled} onChange={(e) => setIncludeConfig(e.target.checked)} /> 包含非敏感配置</label>
    </div>
    <div className="flex flex-wrap gap-2">
      <button className={button} disabled={disabled} onClick={() => void run(async () => {
        const path = await save({ title: "导出芝麻数据", defaultPath: `zhima-backup-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
        if (!path) return;
        const report = await exportData(path, { includeImages, includeMemories, includeConfig, uiPreferences });
        setMessage(`已导出 ${counts(report)}（${(report.bytes / 1024).toFixed(1)} KB）。`);
      })}>导出备份…</button>
      <button className={button} disabled={disabled} onClick={() => void run(async () => {
        const path = await open({ title: "选择芝麻备份", multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
        if (typeof path === "string") await preview(path, "merge");
      })}>导入备份…</button>
      <button className={button} disabled={disabled} onClick={() => void run(async () => {
        await createRestorePoint({ includeImages: true, includeMemories: true, includeConfig: true, uiPreferences });
        await refresh(); setMessage("完整资料恢复点已创建，仅保留最近 5 个。");
      })}>创建恢复点</button>
      <button className={button} disabled={disabled} onClick={() => void run(refresh)}>刷新恢复点</button>
    </div>
    <p className="text-ui text-ink-2">恢复点仅存于应用数据目录 snapshots，最多 256 MiB，保留最近 5 个。替换前自动创建，创建失败则禁止替换。自动恢复点不含前端 UI 偏好；手动创建会包含入口传入的偏好。</p>
    <ul className="space-y-1 text-ui">{points.map((point) => <li key={point.id} className="flex flex-wrap items-center justify-between gap-2 rounded-btn border border-line bg-panel p-3">
      <span>{new Date(point.createdAt).toLocaleString()} · {(point.bytes / 1024).toFixed(1)} KB</span>
      <button className={button} disabled={disabled} onClick={() => void run(() => preview(point.path, "replace"))}>预览恢复点</button>
    </li>)}</ul>
    {pending && <div className="space-y-2 rounded-btn border border-line p-3" aria-label="导入预览">
      <p className="text-ui">备份清单：{counts(pending.preview)}</p>
      <p className="text-ui">导出于 {new Date(pending.preview.exportedAt).toLocaleString()} · v{pending.preview.formatVersion} · {pending.preview.hasConfig ? "含待单独确认的非敏感配置" : "无配置"}</p>
      <p className="text-ui text-ink-2">排除项：{pending.preview.excluded?.join("；") ?? "旧格式未携带扩展资料与配置"}</p>
      <label className="mr-3 text-ui"><input type="radio" checked={strategy === "merge"} disabled={disabled} onChange={() => { setStrategy("merge"); setConfirmed(false); }} /> 合并（同 ID 保留现有数据）</label>
      <label className="text-ui"><input type="radio" checked={strategy === "replace"} disabled={disabled} onChange={() => { setStrategy("replace"); setConfirmed(false); }} /> 替换全部资料</label>
      {strategy === "replace" && <p className="text-ui text-danger">替换会清空全部会话、记忆、技能、图片、助手、知识库、摘要和待办；旧备份缺少的类别也会被清空。替换前必须成功保存恢复点。</p>}
      <label className="block text-ui"><input type="checkbox" checked={confirmed} disabled={disabled} onChange={(e) => setConfirmed(e.target.checked)} /> 我已核对清单并确认导入方式</label>
      <div className="cf-settings-actions"><button className={button} disabled={disabled || !confirmed} onClick={() => void run(doImport)}>确认导入</button><button className={button} disabled={disabled} onClick={() => setPending(null)}>取消导入</button></div>
    </div>}
    {pendingConfig && <div className="space-y-2 rounded-btn border border-line p-3" aria-label="配置恢复确认">
      <p className="text-ui">资料已导入；配置尚未修改。可选恢复 {pendingConfig.providers.length} 个服务商及模型、默认选择、生成参数和 UI 偏好。配置与资料不是跨文件原子事务，配置失败不会撤销已成功导入的资料。</p>
      <ul className="text-ui">{pendingConfig.providers.map((provider) => <li key={provider.id}>{provider.name} · {provider.baseUrl} · {provider.models.length} 个模型</li>)}</ul>
      <p className="text-ui text-danger">请核对服务地址。相同服务商 ID 可能继续使用本机已保存的凭据；只恢复可信来源的配置。</p>
      <label className="block text-ui"><input type="checkbox" checked={configConfirmed} disabled={disabled} onChange={(e) => setConfigConfirmed(e.target.checked)} /> 单独确认替换非敏感配置</label>
      <button className={button} disabled={disabled || !configConfirmed} onClick={() => void run(restoreConfig)}>恢复非敏感配置</button>
      <button className={button} disabled={disabled} onClick={() => { setPendingConfig(null); setMessage("资料导入完成，已跳过配置恢复。"); }}>跳过配置恢复</button>
    </div>}
    {message && <p role="status" className="text-ui text-ink-2">{message}</p>}
    </div>
  </SettingsSection>;
}
