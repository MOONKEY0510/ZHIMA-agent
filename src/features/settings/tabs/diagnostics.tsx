import { useEffect, useState } from "react";
import {
  Activity,
} from "lucide-react";
import * as diagnosticsApi from "../../../services/diagnostics-api";
import type { RunTrace } from "../../../services/diagnostics-api";
import { SectionHeader, SettingsSection } from "../ui";

export function DiagnosticsTab() {
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
            className="text-ui text-danger transition-colors hover:opacity-80"
          >
            清空
          </button>
        )
      }
    >
      {error && <p className="px-4 pt-2 text-ui text-danger">{error}</p>}
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
                    className={`rounded px-1.5 py-0.5 text-meta ${
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
                <p className="mt-0.5 text-ui text-ink-2">
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
