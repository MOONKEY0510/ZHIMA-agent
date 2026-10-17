import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ImageGenView } from "../ImageGenView";
import { useProvidersStore } from "../../../stores/providers-store";
import { useImageGenStore } from "../../../stores/imagegen-store";
import type { ImageGeneration } from "../../../services/imagegen-api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const imageData = "data:image/png;base64,Zml4dHVyZQ==";
const saved: ImageGeneration = Object.freeze({
  id: "fixture", prompt: "测试图像", imageData, sizeLabel: "1024x1792", referenceImagesJson: null, createdAt: 1,
});
const provider = {
  id: "fixture", name: "Fixture", baseUrl: "https://fixture.invalid/v1", apiType: "chat_completions", hasApiKey: true,
  models: [{ modelKey: "gpt-image-1", displayName: "Fixture", supportsVision: false, isFavorite: false, sortOrder: 0 }],
  createdAt: 1, updatedAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  useImageGenStore.setState({ history: [], loaded: false });
  useProvidersStore.setState({ providers: [provider], defaultProviderId: "fixture", defaultModelKey: "gpt-image-1", imageProviderId: "fixture", imageModelKey: "gpt-image-1" });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_image_generations") return [];
    if (command === "generate_image") return imageData;
    if (command === "save_image_generation") return saved;
    return undefined;
  });
});
afterEach(cleanup);

describe("ImageGen UI protocol regressions", () => {
  it("hides unverified options even when a compatible provider uses a familiar model name; fixes count to one", async () => {
    render(<ImageGenView />);
    await waitFor(() => expect(useImageGenStore.getState().loaded).toBe(true));
    for (const label of ["质量", "格式", "透明背景", "审核"]) expect(screen.queryByText(label, { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText(/每次仅生成 1 张/)).toBeInTheDocument();
    expect(screen.getByText(/未声明.*质量.*格式.*透明背景.*审核/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "1" })).not.toBeInTheDocument();
  });

  it("sends actual prompt, size and reference through the real API wrapper without extra options or store mutation", async () => {
    const { container } = render(<ImageGenView />);
    await waitFor(() => expect(useImageGenStore.getState().loaded).toBe(true));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  测试图像  " } });
    fireEvent.click(screen.getByText("尺寸").closest("label")!.querySelector("button")!);
    fireEvent.click(screen.getByRole("button", { name: "9:16" }));
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(["reference"], "fixture.png", { type: "image/png" })] } });
    const reference = await screen.findByAltText("参考图 1");
    const referenceUrl = reference.getAttribute("src");
    fireEvent.click(screen.getByTitle("生成"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_image_generation", expect.anything()));
    expect(invoke).toHaveBeenCalledWith("generate_image", { request: {
      providerId: "fixture", modelKey: "gpt-image-1", prompt: "测试图像", size: "1024x1792",
      width: undefined, height: undefined, referenceImages: [referenceUrl],
    } });
    expect(invoke).toHaveBeenCalledWith("save_image_generation", { request: {
      id: expect.any(String), prompt: "测试图像", imageData, sizeLabel: "1024x1792", referenceImagesJson: JSON.stringify([referenceUrl]),
    } });
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    expect(useImageGenStore.getState().history[0]).toBe(saved);
    expect(saved).not.toHaveProperty("extraParams");
    expect(screen.queryByText(/Cannot add property/)).not.toBeInTheDocument();
  });

  it("does not display unused parameters or invented defaults in historical details", async () => {
    vi.mocked(invoke).mockResolvedValue([{ ...saved, extraParams: { quality: "high", format: "webp", transparent: "true", moderation: "low", count: "4", source: "Not persisted" } }]);
    render(<ImageGenView />);
    fireEvent.click(await screen.findByAltText("测试图像"));
    const detail = within(screen.getByRole("dialog", { name: "生成详情" }));
    for (const label of ["质量", "格式", "透明背景", "审核", "数量", "来源"]) expect(detail.queryByText(label, { exact: true })).not.toBeInTheDocument();
    expect(detail.getByText("尺寸")).toBeInTheDocument();
    expect(detail.getByText("输入内容")).toBeInTheDocument();
  });
});
