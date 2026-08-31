import { useEffect, useState } from "react";
import { Download, Loader2, RefreshCw, X } from "lucide-react";
import {
  checkForUpdates,
  installAndRelaunch,
  formatBytes,
  type Update,
} from "../../services/updater";

type BannerState =
  | { kind: "hidden" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; received: number; total?: number }
  | { kind: "installing" }
  | { kind: "error"; message: string };

/**
 * 启动后静默检查更新；发现新版本时在窗口顶部弹出可交互的更新提示。
 */
export function UpdateBanner() {
  const [state, setState] = useState<BannerState>({ kind: "hidden" });

  useEffect(() => {
    let cancelled = false;
    // 启动几秒后再检查，避免影响首屏加载。
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const update = await checkForUpdates();
          if (cancelled || !update) return;
          setState({ kind: "available", update });
        } catch {
          // 检查失败保持静默，不打扰用户（可在设置页手动检查）
        }
      })();
    }, 4000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const startDownload = async (update: Update) => {
    setState({ kind: "downloading", received: 0 });
    try {
      await installAndRelaunch(
        update,
        (received, total) => setState({ kind: "downloading", received, total }),
        () => setState({ kind: "installing" }),
      );
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  if (state.kind === "hidden") return null;

  const progress =
    state.kind === "downloading" && state.total
      ? Math.min(100, Math.round((state.received / state.total) * 100))
      : 0;

  return (
    <div className="absolute left-1/2 top-12 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2">
      <div className="rounded-btn border border-line bg-panel-2 p-3 shadow-xl">
        {state.kind === "available" && (
          <>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-ink">
                  发现新版本 v{state.update.version}
                </p>
                {state.update.body && (
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-[11px] leading-4 text-ink-2">
                    {state.update.body}
                  </p>
                )}
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => void startDownload(state.update)}
                    className="flex items-center gap-1 rounded-btn bg-accent px-3 py-1.5 text-xs text-accent-fg transition-opacity hover:opacity-85"
                  >
                    <Download size={12} />
                    更新
                  </button>
                  <button
                    onClick={() => setState({ kind: "hidden" })}
                    className="rounded-btn border border-line px-3 py-1.5 text-xs text-ink-2 transition-colors hover:bg-panel hover:text-ink"
                  >
                    稍后
                  </button>
                </div>
              </div>
              <button
                onClick={() => setState({ kind: "hidden" })}
                className="shrink-0 rounded p-1 text-ink-2 transition-colors hover:bg-panel hover:text-ink"
              >
                <X size={13} />
              </button>
            </div>
          </>
        )}

        {(state.kind === "downloading" || state.kind === "installing") && (
          <div className="flex items-center gap-2">
            <Loader2 size={14} className="shrink-0 animate-spin text-accent" />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-ink">
                {state.kind === "installing"
                  ? "正在安装并重启…"
                  : `正在下载更新 ${state.total ? `${formatBytes(state.received)} / ${formatBytes(state.total)}` : formatBytes(state.received)}`}
              </p>
              {state.kind === "downloading" && state.total ? (
                <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-panel">
                  <div
                    className="h-full rounded-full bg-accent transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              ) : null}
            </div>
          </div>
        )}

        {state.kind === "error" && (
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-danger">更新失败</p>
              <p className="mt-1 break-words text-[11px] leading-4 text-ink-2">
                {state.message}
              </p>
              <button
                onClick={() => setState({ kind: "hidden" })}
                className="mt-2 rounded-btn border border-line px-3 py-1 text-[11px] text-ink-2 transition-colors hover:bg-panel hover:text-ink"
              >
                关闭
              </button>
            </div>
            <button
              onClick={() => setState({ kind: "hidden" })}
              className="shrink-0 rounded p-1 text-ink-2 transition-colors hover:bg-panel hover:text-ink"
            >
              <X size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 设置页用的"检查更新"按钮 + 状态。手动检查结果展示在此处。
 */
export function UpdateSettingsCard() {
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<Update | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const doCheck = async () => {
    setChecking(true);
    setMessage(null);
    setUpdate(null);
    try {
      const found = await checkForUpdates();
      if (found) {
        setUpdate(found);
        setMessage({
          ok: true,
          text: `发现新版本 v${found.version}，点击"立即更新"下载安装。`,
        });
      } else {
        setMessage({ ok: true, text: "已是最新版本。" });
      }
    } catch (e) {
      setMessage({
        ok: false,
        text: `检查失败：${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setChecking(false);
    }
  };

  const doInstall = async (u: Update) => {
    setBusy(true);
    setMessage(null);
    try {
      await installAndRelaunch(u, undefined, () => setBusy(true));
    } catch (e) {
      setMessage({
        ok: false,
        text: `更新失败：${e instanceof Error ? e.message : String(e)}`,
      });
      setBusy(false);
    }
  };

  return (
    <section className="cf-settings-section">
      <div className="cf-settings-section-header">
        <div>
          <h2 className="cf-settings-section-title">软件更新</h2>
          <p className="cf-settings-section-desc">
            从更新服务器检查并下载新版本。下载完成安装后应用会自动重启。
          </p>
        </div>
      </div>
      <div className="cf-settings-section-body">
        <div className="cf-form-row">
          <div className="flex-1">
            <p className="text-sm font-medium text-ink">检查更新</p>
            <p className="mt-0.5 text-xs text-ink-2">点击按钮检查是否有可用新版本</p>
          </div>
          <div className="flex w-44 shrink-0 items-center justify-end">
            <button
              onClick={() => void doCheck()}
              disabled={checking || busy}
              className="flex items-center gap-1.5 rounded-btn bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {checking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {checking ? "检查中…" : "检查更新"}
            </button>
          </div>
        </div>

        {update && (
          <div className="cf-form-row items-start">
            <div className="flex-1">
              <p className="text-sm font-medium text-ink">发现新版本 v{update.version}</p>
              {update.body && (
                <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-4 text-ink-2">
                  {update.body}
                </p>
              )}
            </div>
            <div className="flex w-44 shrink-0 items-center justify-end">
              <button
                onClick={() => void doInstall(update)}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-btn border border-line px-3 py-1.5 text-xs text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                {busy ? "更新中…" : "立即更新"}
              </button>
            </div>
          </div>
        )}

        {message && !update && (
          <p className={`px-4 py-2 text-[11px] ${message.ok ? "text-success" : "text-danger"}`}>
            {message.text}
          </p>
        )}
      </div>
    </section>
  );
}
