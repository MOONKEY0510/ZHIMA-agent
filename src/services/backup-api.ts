import { invoke } from "@tauri-apps/api/core";

/** Strictly filtered again by Rust; never pass a whole settings/config store. */
export type BackupUiPreferences = Record<string, unknown>;
export interface PortableConfig {
  providers: Array<{
    id: string; name: string; baseUrl: string; apiType: string;
    models: Array<{ modelKey: string; displayName: string; isFavorite: boolean; sortOrder: number; supportsVision: boolean }>;
  }>;
  defaultProviderId: string | null;
  defaultModelKey: string | null;
  visionProviderId: string | null;
  visionModelKey: string | null;
  imageProviderId: string | null;
  imageModelKey: string | null;
  generation: { temperature: number | null; maxTokens: number | null };
  uiPreferences?: BackupUiPreferences | null;
}
export interface ExportOptions {
  includeImages: boolean;
  includeMemories: boolean;
  includeConfig?: boolean;
  uiPreferences?: BackupUiPreferences;
}
export interface BackupCounts {
  conversations: number;
  messages: number;
  memories: number;
  images: number;
  skills: number;
  /** Optional for old callers and v1 compatibility. */
  assistants?: number;
  documents?: number;
  chunks?: number;
  summaries?: number;
  tasks?: number;
}
export interface ExportReport extends BackupCounts {
  path: string;
  bytes: number;
}
export interface BackupPreview extends BackupCounts {
  exportedAt: number;
  formatVersion: number;
  hasConfig?: boolean;
  excluded?: string[];
}
export interface ImportReport extends BackupCounts {
  skipped: number;
  /** DB import does not write configuration; a second explicit confirmation is required. */
  pendingConfig?: PortableConfig | null;
}
export interface RestorePoint { id: string; path: string; createdAt: number; bytes: number }
export type ImportStrategy = "merge" | "replace";
export function exportData(path: string, options: ExportOptions): Promise<ExportReport> {
  return invoke<ExportReport>("export_data", { path, options });
}
export function previewBackup(path: string): Promise<BackupPreview> {
  return invoke<BackupPreview>("preview_backup", { path });
}
/** UI restoration MUST call chat-store.importBackup, never this low-level API. */
export function importData(path: string, strategy: ImportStrategy): Promise<ImportReport> {
  return invoke<ImportReport>("import_data", { path, strategy });
}
export function createRestorePoint(options?: ExportOptions): Promise<RestorePoint> {
  return invoke<RestorePoint>("create_restore_point", { options: options ?? null });
}
export function listRestorePoints(): Promise<RestorePoint[]> {
  return invoke<RestorePoint[]>("list_restore_points");
}
export function restoreBackupConfig(config: PortableConfig): Promise<BackupUiPreferences | null> {
  return invoke<BackupUiPreferences | null>("restore_backup_config", { config });
}
