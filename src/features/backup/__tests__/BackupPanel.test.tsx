import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BackupPanel } from "../BackupPanel";
import * as api from "../../../services/backup-api";
import { open, save } from "@tauri-apps/plugin-dialog";

const mocks = vi.hoisted(() => ({ importBackup: vi.fn(), importing: false }));
vi.mock("../../../stores/chat-store", () => ({ useChatStore: Object.assign((selector: (state: { importingBackup: boolean }) => unknown) => selector({ importingBackup: mocks.importing }), { getState: () => ({ importBackup: mocks.importBackup }) }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../../../services/backup-api", () => ({ createRestorePoint: vi.fn(), exportData: vi.fn(), listRestorePoints: vi.fn(), previewBackup: vi.fn(), restoreBackupConfig: vi.fn() }));
const counts = { conversations: 1, messages: 2, memories: 3, images: 4, skills: 5, assistants: 6, documents: 7, chunks: 8, summaries: 9, tasks: 10 };
const config: api.PortableConfig = { providers: [], defaultProviderId: null, defaultModelKey: null, visionProviderId: null, visionModelKey: null, imageProviderId: null, imageModelKey: null, generation: { temperature: null, maxTokens: null }, uiPreferences: { theme: "dark" } };
beforeEach(() => {
  vi.clearAllMocks(); mocks.importing = false;
  vi.mocked(api.listRestorePoints).mockResolvedValue([]);
  vi.mocked(api.previewBackup).mockResolvedValue({ ...counts, exportedAt: 1, formatVersion: 2, hasConfig: true });
  vi.mocked(open).mockResolvedValue("D:/fake/backup.json");
  mocks.importBackup.mockResolvedValue({ ...counts, skipped: 0 });
});
async function prepareImport() {
  fireEvent.click(screen.getByRole("button", { name: "导入备份…" }));
  await screen.findByLabelText("导入预览");
}
async function confirmImport() {
  fireEvent.click(screen.getByLabelText("我已核对清单并确认导入方式"));
  fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
  await waitFor(() => expect(mocks.importBackup).toHaveBeenCalled());
}
describe("BackupPanel", () => {
  it("requires preview confirmation and routes import through the chat lock", async () => {
    render(<BackupPanel />); await prepareImport();
    expect(screen.getByRole("button", { name: "确认导入" })).toBeDisabled();
    expect(mocks.importBackup).not.toHaveBeenCalled();
    expect(screen.getByText(/7 份知识文档 \/ 8 个分块/)).toBeInTheDocument();
    await confirmImport();
    expect(mocks.importBackup).toHaveBeenCalledWith("D:/fake/backup.json", "merge");
  });
  it("previews restore points and uses the exact same locked replace path", async () => {
    vi.mocked(api.listRestorePoints).mockResolvedValue([{ id: "point", path: "D:/app/snapshots/point.json", createdAt: 1, bytes: 20 }]);
    render(<BackupPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "预览恢复点" }));
    await screen.findByLabelText("导入预览");
    expect(screen.getByLabelText("替换全部资料")).toBeChecked();
    await confirmImport();
    expect(mocks.importBackup).toHaveBeenCalledWith("D:/app/snapshots/point.json", "replace");
  });
  it("exports safe preferences only when passed and creates full local checkpoints", async () => {
    vi.mocked(save).mockResolvedValue("D:/fake/out.json");
    vi.mocked(api.exportData).mockResolvedValue({ ...counts, path: "D:/fake/out.json", bytes: 10 });
    render(<BackupPanel uiPreferences={{ theme: "dark" }} />);
    fireEvent.click(screen.getByRole("button", { name: "导出备份…" }));
    await waitFor(() => expect(api.exportData).toHaveBeenCalledWith("D:/fake/out.json", { includeImages: true, includeMemories: true, includeConfig: true, uiPreferences: { theme: "dark" } }));
    await waitFor(() => expect(screen.getByRole("button", { name: "创建恢复点" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "创建恢复点" }));
    await waitFor(() => expect(api.createRestorePoint).toHaveBeenCalledWith({ includeImages: true, includeMemories: true, includeConfig: true, uiPreferences: { theme: "dark" } }));
  });
  it("requires separate config consent and discloses partial config/UI failure", async () => {
    mocks.importBackup.mockResolvedValue({ ...counts, skipped: 0, pendingConfig: config });
    vi.mocked(api.restoreBackupConfig).mockResolvedValue({ theme: "dark" });
    const restore = vi.fn().mockRejectedValue(new Error("UI disk error"));
    render(<BackupPanel onRestorePreferences={restore} />);
    await prepareImport(); await confirmImport();
    await screen.findByLabelText("配置恢复确认");
    expect(api.restoreBackupConfig).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "恢复非敏感配置" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("单独确认替换非敏感配置"));
    fireEvent.click(screen.getByRole("button", { name: "恢复非敏感配置" }));
    await screen.findByText(/服务商配置已保存，但 UI 偏好或界面刷新失败/);
    expect(restore).toHaveBeenCalledWith({ theme: "dark" });
    expect(mocks.importBackup).toHaveBeenCalledTimes(1);
  });
  it("keeps preview and reports checkpoint/import failure without claiming success", async () => {
    mocks.importBackup.mockRejectedValue(new Error("恢复点写入失败"));
    render(<BackupPanel />); await prepareImport(); await confirmImport();
    await screen.findByText("恢复点写入失败");
    expect(screen.getByLabelText("导入预览")).toBeInTheDocument();
  });
  it("disables actions while another import owns the lock", async () => {
    mocks.importing = true; render(<BackupPanel />);
    await waitFor(() => expect(api.listRestorePoints).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "创建恢复点" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导入备份…" })).toBeDisabled();
  });
});
