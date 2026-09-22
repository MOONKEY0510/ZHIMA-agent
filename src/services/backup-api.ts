import { invoke } from "@tauri-apps/api/core";

/**
 * Data backup commands (P0-4): conversations, messages, memories and (opt.)
 * generated images.  The file path is chosen with the native dialog; API keys
 * are never part of a backup.
 */

export interface ExportOptions {
  /** Generated images are base64 payloads and can make the file large. */
  includeImages: boolean;
  includeMemories: boolean;
}

export interface ExportReport {
  path: string;
  conversations: number;
  messages: number;
  memories: number;
  images: number;
  skills: number;
  bytes: number;
}

export interface BackupPreview {
  exportedAt: number;
  formatVersion: number;
  conversations: number;
  messages: number;
  memories: number;
  images: number;
  skills: number;
}

export interface ImportReport {
  conversations: number;
  messages: number;
  memories: number;
  images: number;
  skills: number;
  /** Rows left alone because they already existed (merge only). */
  skipped: number;
}

export type ImportStrategy = "merge" | "replace";

export function exportData(path: string, options: ExportOptions): Promise<ExportReport> {
  return invoke<ExportReport>("export_data", { path, options });
}

export function previewBackup(path: string): Promise<BackupPreview> {
  return invoke<BackupPreview>("preview_backup", { path });
}

export function importData(path: string, strategy: ImportStrategy): Promise<ImportReport> {
  return invoke<ImportReport>("import_data", { path, strategy });
}
