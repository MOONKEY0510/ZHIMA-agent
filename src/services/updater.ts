import { check, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type { Update, DownloadEvent };

/**
 * 检查是否有可用更新。
 * 返回 null 表示当前已是最新版本；否则返回更新信息（含版本号、更新说明）。
 * 服务端清单地址由 tauri.conf.json 的 `plugins.updater.endpoints` 配置。
 */
export async function checkForUpdates(): Promise<Update | null> {
  return check({ timeout: 15000 });
}

/**
 * 下载并静默安装更新，安装完成后重启应用。
 * @param onProgress 进度回调：(已下载字节数, 总字节数)，总字节数可能未知
 */
export async function installAndRelaunch(
  update: Update,
  onProgress?: (received: number, total?: number) => void,
  onInstalling?: () => void,
): Promise<void> {
  let received = 0;
  let total: number | undefined;
  await update.downloadAndInstall((event: DownloadEvent) => {
    if (event.event === "Started") {
      received = 0;
      total = event.data.contentLength;
      onProgress?.(0, total);
    } else if (event.event === "Progress") {
      received += event.data.chunkLength;
      onProgress?.(received, total);
    }
  });
  onInstalling?.();
  await relaunch();
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const value = bytes / 2 ** (10 * i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
