import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { Composer } from "../Composer";
import { open } from "@tauri-apps/plugin-dialog";
import { parseDocumentPreview, pickDocument } from "../../../services/document-api";
import { useChatStore } from "../../../stores/chat-store";
import { useProvidersStore } from "../../../stores/providers-store";
import { useHistoryStore } from "../../../services/history-store";
import { useAssistantsStore } from "../../../stores/assistants-store";
import { useWindowStore } from "../../../stores/window-store";
import { DEFAULT_PRESETS, useSettingsStore } from "../../../stores/settings-store";
import { readClipboardText } from "../../../services/tools-api";
import { listSkills } from "../../../services/skills-api";
import { listen } from "@tauri-apps/api/event";
import { useDraftStore } from "../../../stores/draft-store";

vi.mock("../../../services/tools-api", () => ({ readClipboardText: vi.fn(), listTools: vi.fn().mockResolvedValue([]) }));
vi.mock("../../../services/skills-api", () => ({ listSkills: vi.fn().mockResolvedValue([]) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: vi.fn().mockResolvedValue(() => {}) }) }));
vi.mock("../../model-picker/ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("../../../services/document-api", () => ({
  pickDocument: vi.fn().mockResolvedValue("fixture.txt"),
  parseDocumentPreview: vi.fn().mockResolvedValue({ name: "fixture.txt", chars: 7, text: "fixture", truncated: false }),
}));

const provider = {
  id: "p1", name: "Fixture", baseUrl: "https://fixture.invalid/v1", apiType: "chat_completions", hasApiKey: true,
  models: [{ modelKey: "m1", displayName: "Fixture model", supportsVision: true, isFavorite: false, sortOrder: 0 }],
  createdAt: 1, updatedAt: 1,
};
const targets = [{ providerId: "p1", modelKey: "m1" }, { providerId: "p2", modelKey: "m1" }];
const input = () => screen.getByRole("textbox");
const submit = () => fireEvent.keyDown(input(), { key: "Enter" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockResolvedValue(undefined);
  vi.mocked(open).mockReset();
  vi.mocked(pickDocument).mockResolvedValue("fixture.txt");
  vi.mocked(parseDocumentPreview).mockReset().mockResolvedValue({ name: "fixture.txt", chars: 7, text: "fixture", totalChars: 7, truncated: false });
  useChatStore.setState({ ...useChatStore.getInitialState() });
  useHistoryStore.setState({ historyEnabled: false, activeId: null, conversations: [] });
  useDraftStore.getState().reset();
  useAssistantsStore.setState({ assistants: [], activeId: null });
  useProvidersStore.setState({ providers: [provider, { ...provider, id: "p2" }], defaultProviderId: "p1", defaultModelKey: "m1" });
  useWindowStore.setState({ view: "chat", openSettings: vi.fn() });
  useSettingsStore.setState({ defaultEnableTools: false, presets: DEFAULT_PRESETS });
  vi.mocked(readClipboardText).mockReset().mockResolvedValue("clipboard fixture");
  vi.mocked(listSkills).mockReset().mockResolvedValue([]);
});
afterEach(async () => {
  await act(async () => { await vi.dynamicImportSettled(); });
  cleanup();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fileAction(label = "汇总文件内容") {
  fireEvent.click(screen.getByTitle("快捷操作（剪贴板 / 文件）"));
  await act(async () => { fireEvent.click(screen.getByText(label)); });
}

describe("Composer session drafts and document batches", () => {
  it("restores text per conversation and after settings unmount without restoring attachments", async () => {
    useHistoryStore.setState({ activeId: "a" });
    const first = render(<Composer />);
    fireEvent.change(input(), { target: { value: "A draft" } });
    await stageAttachments(first.container);
    act(() => useHistoryStore.setState({ activeId: "b" }));
    expect(input()).toHaveValue("");
    expect(screen.queryByText("fixture.txt")).not.toBeInTheDocument();
    fireEvent.change(input(), { target: { value: "B draft" } });
    act(() => useHistoryStore.setState({ activeId: "a" }));
    expect(input()).toHaveValue("A draft");
    first.unmount();
    render(<Composer />);
    expect(input()).toHaveValue("A draft");
    expect(screen.queryByText("fixture.txt")).not.toBeInTheDocument();
  });

  it("parses selected files into source-labelled attachment blocks, not path instructions", async () => {
    vi.mocked(open).mockResolvedValue(["/fixtures/one.txt", "/fixtures/two.txt"]);
    vi.mocked(parseDocumentPreview).mockImplementation(async (path) => ({ name: path.split("/").pop()!, text: `body ${path.split("/").pop()}`, chars: 12, totalChars: 12, truncated: false }));
    render(<Composer />);
    await fileAction("对比文件");
    await waitFor(() => expect(parseDocumentPreview).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTitle("发送（Enter）")).not.toBeDisabled());
    submit();
    const content = useChatStore.getState().messages[0].content;
    expect(content).toContain("【附件：one.txt】\nbody one.txt");
    expect(content).toContain("【附件：two.txt】\nbody two.txt");
    expect(content).not.toContain("/fixtures/");
    expect(content).not.toContain("请使用文件读取工具");
  });

  it("blocks sending during selection and parsing and preserves input typed while picking", async () => {
    const picking = deferred<string[]>();
    const parsing = deferred<Awaited<ReturnType<typeof parseDocumentPreview>>>();
    vi.mocked(open).mockReturnValue(picking.promise);
    vi.mocked(parseDocumentPreview).mockReturnValue(parsing.promise);
    render(<Composer />);
    fireEvent.change(input(), { target: { value: "before" } });
    await fileAction();
    submit();
    expect(useChatStore.getState().messages).toEqual([]);
    fireEvent.change(input(), { target: { value: "new input" } });
    await act(async () => picking.resolve(["pending.txt"]));
    submit();
    expect(useChatStore.getState().messages).toEqual([]);
    await act(async () => parsing.resolve({ name: "pending.txt", text: "body", chars: 4, totalChars: 4, truncated: false }));
    expect(input()).toHaveValue("new input");
  });

  it("keeps a cancelled picker draft and accepts sending again", async () => {
    vi.mocked(open).mockResolvedValue(null);
    render(<Composer />);
    fireEvent.change(input(), { target: { value: "keep me" } });
    await fileAction();
    expect(input()).toHaveValue("keep me");
    expect(screen.getByTitle("发送（Enter）")).not.toBeDisabled();
    expect(parseDocumentPreview).not.toHaveBeenCalled();
  });

  it("discards a late single-document picker after conversation navigation", async () => {
    const picking = deferred<string | null>();
    vi.mocked(pickDocument).mockReturnValue(picking.promise);
    render(<Composer />);
    fireEvent.click(screen.getByTitle("添加附件：图片或文档（也可以直接把文件拖进窗口）"));
    fireEvent.click(screen.getByText("添加文档"));
    act(() => useChatStore.getState().startNewConversation());
    fireEvent.change(input(), { target: { value: "new conversation" } });
    await act(async () => picking.resolve("stale.txt"));
    expect(parseDocumentPreview).not.toHaveBeenCalled();
    expect(input()).toHaveValue("new conversation");
  });

  it("clears all old drafts and attachments when backup import begins", async () => {
    const { container } = render(<Composer />);
    fireEvent.change(input(), { target: { value: "before import" } });
    await stageAttachments(container);
    act(() => useChatStore.setState({ importingBackup: true }));
    expect(input()).toHaveValue("");
    expect(screen.queryByText("fixture.txt")).not.toBeInTheDocument();
    expect(screen.queryByAltText("附件 1")).not.toBeInTheDocument();
    expect(useDraftStore.getState().drafts).toEqual({});
  });

  it.each(["single", "compare"])("keeps next-turn text through new-conversation ID promotion in %s mode", async (mode) => {
    const setup = deferred<unknown>();
    vi.mocked(invoke).mockImplementation((command) => command.startsWith("chat_send") ? setup.promise as Promise<never> : Promise.resolve(command === "history_list_conversations" ? [] : undefined));
    useHistoryStore.setState({ historyEnabled: true, refreshList: vi.fn().mockResolvedValue(undefined) });
    if (mode === "compare") useChatStore.setState({ compareTargets: targets });
    render(<Composer />);
    fireEvent.change(input(), { target: { value: "accepted first" } });
    submit();
    expect(input()).toHaveValue("");
    const key = useDraftStore.getState().key;
    expect(key).toMatch(/^conversation:/);
    fireEvent.change(input(), { target: { value: "next turn" } });
    await act(async () => setup.resolve(undefined));
    expect(input()).toHaveValue("next turn");
    expect(useDraftStore.getState().key).toBe(key);
  });

  it("preserves another conversation's draft when this one is accepted", async () => {
    useHistoryStore.setState({ activeId: "a" });
    render(<Composer />);
    fireEvent.change(input(), { target: { value: "A unsent" } });
    act(() => useHistoryStore.setState({ activeId: "b" }));
    fireEvent.change(input(), { target: { value: "B sent" } });
    await act(async () => submit());
    act(() => useHistoryStore.setState({ activeId: "a" }));
    expect(input()).toHaveValue("A unsent");
  });

  it("shows individual failure and truncation and sends only successful bodies", async () => {
    vi.mocked(open).mockResolvedValue(["ok.txt", "bad.txt"]);
    vi.mocked(parseDocumentPreview).mockImplementation(async (path) => {
      if (path === "bad.txt") throw new Error("fixture failure");
      return { name: path, text: "partial body", chars: 12, totalChars: 100, truncated: true };
    });
    render(<Composer />);
    await fileAction("提取任务");
    expect(screen.getByText("解析失败")).toBeInTheDocument();
    expect(screen.getByText("fixture failure")).toBeInTheDocument();
    expect(screen.getByText(/已截断/)).toBeInTheDocument();
    expect(screen.getByText("预览正文")).toBeInTheDocument();
    await act(async () => submit());
    const content = useChatStore.getState().messages[0].content;
    expect(content).toContain("【附件：ok.txt】");
    expect(content).toContain("未包含全文");
    expect(content).not.toContain("【附件：bad.txt】");
  });

  it.each(["picker", "parser"])("discards a stale %s after switching away and back", async (phase) => {
    const picking = deferred<string[]>();
    const parsing = deferred<Awaited<ReturnType<typeof parseDocumentPreview>>>();
    vi.mocked(open).mockReturnValue(picking.promise);
    vi.mocked(parseDocumentPreview).mockReturnValue(parsing.promise);
    useHistoryStore.setState({ activeId: "a" });
    render(<Composer />);
    await fileAction();
    if (phase === "parser") await act(async () => picking.resolve(["stale.txt"]));
    act(() => useHistoryStore.setState({ activeId: "b" }));
    fireEvent.change(input(), { target: { value: "B new" } });
    act(() => useHistoryStore.setState({ activeId: "a" }));
    fireEvent.change(input(), { target: { value: "A new" } });
    await act(async () => {
      picking.resolve(["stale.txt"]);
      parsing.resolve({ name: "stale.txt", text: "old body", chars: 8, totalChars: 8, truncated: false });
    });
    expect(input()).toHaveValue("A new");
    expect(screen.queryByText("stale.txt")).not.toBeInTheDocument();
  });
});

describe("desktop action safety regressions", () => {
  const preset = { id: "fixture-action", name: "测试桌面动作", command: "/fixture", content: "兼容正文", desktopAction: { source: "clipboard" as const, template: "处理 {{input}}", skillIds: [] as string[], output: "copy" as const } };
  const install = () => useSettingsStore.setState({ presets: [preset] });

  it("appends clipboard templates, waits for explicit send and never arms clipboard writeback", async () => {
    install();
    render(<Composer />);
    fireEvent.change(input(), { target: { value: "existing draft" } });
    await fileAction("测试桌面动作");
    expect(input()).toHaveValue("existing draft\n\n处理 clipboard fixture");
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().clipboardWriteback).toBeNull();
    expect(screen.getByText(/使用回答的复制按钮/)).toBeInTheDocument();
    expect(screen.getByText("联网搜索")).toHaveAttribute("aria-pressed", "false");
  });

  it.each(["edit", "navigate"])("ignores late action clipboard reads after %s", async (mode) => {
    install();
    const pending = deferred<string>();
    vi.mocked(readClipboardText).mockReturnValue(pending.promise);
    useHistoryStore.setState({ activeId: "a" });
    render(<Composer />);
    await fileAction("测试桌面动作");
    if (mode === "navigate") {
      act(() => useHistoryStore.setState({ activeId: "b" }));
      act(() => useHistoryStore.setState({ activeId: "a" }));
    }
    fireEvent.change(input(), { target: { value: "new input" } });
    await act(async () => pending.resolve("stale"));
    expect(input()).toHaveValue("new input");
  });

  it("uses captured selection for configured actions and keeps every existing draft byte", async () => {
    useSettingsStore.setState({ presets: [{ ...preset, desktopAction: { ...preset.desktopAction, source: "selection" } }] });
    render(<Composer />);
    fireEvent.change(input(), { target: { value: "original draft" } });
    await waitFor(() => expect(listen).toHaveBeenCalledWith("quick-action", expect.any(Function)));
    const handler = vi.mocked(listen).mock.calls.find(([event]) => event === "quick-action")![1];
    act(() => handler({ event: "quick-action", id: 1, payload: "selected input" }));
    const before = (input() as HTMLTextAreaElement).value;
    await act(async () => fireEvent.click(screen.getByText("测试桌面动作")));
    expect(input()).toHaveValue(`${before}\n\n处理 selected input`);
    expect(readClipboardText).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it("ignores an older action request even when the draft revision did not change", async () => {
    install();
    const first = deferred<string>();
    const second = deferred<string>();
    vi.mocked(readClipboardText).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<Composer />);
    fireEvent.change(input(), { target: { value: "/fixture" } });
    submit();
    submit();
    await act(async () => first.resolve("older"));
    expect(input()).toHaveValue("/fixture");
    await act(async () => second.resolve("latest"));
    expect(input()).toHaveValue("/fixture\n\n处理 latest");
  });

  it("preserves edited selection drafts and avoids legacy automatic clipboard writeback", async () => {
    render(<Composer />);
    await waitFor(() => expect(listen).toHaveBeenCalledWith("quick-action", expect.any(Function)));
    const handler = vi.mocked(listen).mock.calls.find(([event]) => event === "quick-action")![1];
    act(() => handler({ event: "quick-action", id: 1, payload: "selection fixture" }));
    fireEvent.change(input(), { target: { value: "edited draft" } });
    fireEvent.click(screen.getByText("翻译"));
    expect((input() as HTMLTextAreaElement).value).toContain("edited draft");
    expect((input() as HTMLTextAreaElement).value).toContain("selection fixture");
    expect(useChatStore.getState().clipboardWriteback).toBeNull();
  });

  const assistant = { id: "target-assistant", name: "Fixture assistant", icon: null, description: null, systemPrompt: "fixture prompt", providerId: null, modelKey: null, toolPoliciesJson: null, sortOrder: 0, createdAt: 1, updatedAt: 1 };
  const skill = { id: "fixture-skill", name: "Fixture skill", description: "", content: "fixture instructions", triggers: [], enabled: true, sortOrder: 0, createdAt: 1, updatedAt: 1 };

  it("requires an explicit new chat for another assistant and preserves the bound chat draft", async () => {
    useHistoryStore.setState({ activeId: "bound-chat" });
    useAssistantsStore.setState({ assistants: [assistant], activeId: null });
    useSettingsStore.setState({ presets: [{ ...preset, desktopAction: { ...preset.desktopAction, assistantId: assistant.id, skillIds: [skill.id] } }] });
    vi.mocked(listSkills).mockResolvedValue([skill]);
    render(<Composer />);
    fireEvent.change(input(), { target: { value: "bound draft" } });
    await fileAction("测试桌面动作");
    expect(useAssistantsStore.getState().activeId).toBeNull();
    expect(input()).toHaveValue("bound draft");
    expect(screen.getByText(/必须新建会话才能生效/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("新建会话并填入（保留原草稿）"));
    expect(useHistoryStore.getState().activeId).toBeNull();
    expect(useAssistantsStore.getState().activeId).toBe(assistant.id);
    expect(useDraftStore.getState().drafts["conversation:bound-chat"]).toBe("bound draft");
    expect(input()).toHaveValue("bound draft\n\n处理 clipboard fixture");
    expect(screen.getByText("Fixture skill")).toBeInTheDocument();
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it("sends with the action assistant's provider, model and prompt rather than an old manual model", async () => {
    useHistoryStore.setState({ activeId: "bound-chat" });
    useChatStore.setState({ draftSelection: { providerId: "p1", modelKey: "m1" } });
    const target = { ...assistant, providerId: "p2", modelKey: "target-model" };
    useProvidersStore.setState({ providers: [provider, { ...provider, id: "p2", models: [{ ...provider.models[0], modelKey: "target-model" }] }] });
    useAssistantsStore.setState({ assistants: [target], activeId: null });
    useSettingsStore.setState({ presets: [{ ...preset, desktopAction: { ...preset.desktopAction, assistantId: target.id } }] });
    render(<Composer />);
    await fileAction("测试桌面动作");
    fireEvent.click(screen.getByText("新建会话并填入（保留原草稿）"));
    await act(async () => submit());
    expect(invoke).toHaveBeenCalledWith("chat_send", expect.objectContaining({ request: expect.objectContaining({ providerId: "p2", modelKey: "target-model", systemPrompt: "fixture prompt" }) }));
    expect(useChatStore.getState().draftSelection).toBeNull();
  });

  it.each(["clipboard", "skills", "confirmation"])("invalidates action after skill removal during %s without restoring removed skills", async (phase) => {
    useHistoryStore.setState({ activeId: "bound-chat" });
    useAssistantsStore.setState({ assistants: [assistant], activeId: null });
    useSettingsStore.setState({ presets: [{ ...preset, desktopAction: { ...preset.desktopAction, assistantId: assistant.id, skillIds: [skill.id] } }] });
    vi.mocked(listSkills).mockResolvedValue([skill]);
    render(<Composer />);
    fireEvent.change(input(), { target: { value: "preserved draft" } });
    fireEvent.click(screen.getByTitle("选择技能：选中的技能对当前对话持续生效"));
    await screen.findByText("Fixture skill");
    fireEvent.click(screen.getByText("Fixture skill"));
    fireEvent.click(screen.getByTitle("选择技能：选中的技能对当前对话持续生效"));
    const clipboard = deferred<string>();
    const skills = deferred<Awaited<ReturnType<typeof listSkills>>>();
    if (phase === "clipboard") vi.mocked(readClipboardText).mockReturnValueOnce(clipboard.promise);
    if (phase === "skills") vi.mocked(listSkills).mockReturnValueOnce(skills.promise);
    await fileAction("测试桌面动作");
    fireEvent.click(screen.getByTitle("取消激活"));
    await act(async () => { clipboard.resolve("captured"); skills.resolve([skill]); });
    if (phase === "confirmation") fireEvent.click(screen.getByText("新建会话并填入（保留原草稿）"));
    expect(screen.getByText(/技能选择已更新，请重新选择动作/)).toBeInTheDocument();
    expect(screen.queryByTitle("取消激活")).not.toBeInTheDocument();
    expect(input()).toHaveValue("preserved draft");
    expect(useHistoryStore.getState().activeId).toBe("bound-chat");
    expect(useAssistantsStore.getState().activeId).toBeNull();
  });

  it("changes context input revision on image additions and removals without exposing image content", async () => {
    const revisions: string[] = [];
    const { container } = render(<Composer renderContextPreview={(context) => { revisions.push((context as unknown as { inputRevision: string }).inputRevision); return null; }} />);
    const initial = revisions[revisions.length - 1];
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(["private image bytes"], "private.png", { type: "image/png" })] } });
    const image = await screen.findByAltText("附件 1");
    const added = revisions[revisions.length - 1];
    expect(typeof added).toBe("string");
    expect(added).not.toBe(initial);
    expect(added).not.toContain("data:");
    expect(added).not.toContain("private");
    fireEvent.click(image.parentElement!.querySelector("button")!);
    const removed = revisions[revisions.length - 1];
    expect(removed).not.toBe(added);
    expect(removed).not.toBe(initial);
  });

  it("does not discard attachments when an action requires a new assistant", async () => {
    useHistoryStore.setState({ activeId: "bound-chat" });
    useAssistantsStore.setState({ assistants: [assistant], activeId: null });
    useSettingsStore.setState({ presets: [{ ...preset, desktopAction: { ...preset.desktopAction, assistantId: assistant.id } }] });
    const { container } = render(<Composer />);
    await stageAttachments(container);
    await fileAction("测试桌面动作");
    expect(screen.getByText("新建会话并填入（保留原草稿）")).toBeDisabled();
    expect(screen.getByAltText("附件 1")).toBeInTheDocument();
    expect(screen.getByText("fixture.txt")).toBeInTheDocument();
  });

  it("rejects stale assistant confirmation after new input", async () => {
    useHistoryStore.setState({ activeId: "bound-chat" });
    useAssistantsStore.setState({ assistants: [assistant], activeId: null });
    useSettingsStore.setState({ presets: [{ ...preset, desktopAction: { ...preset.desktopAction, assistantId: assistant.id } }] });
    render(<Composer />);
    await fileAction("测试桌面动作");
    fireEvent.change(input(), { target: { value: "updated draft" } });
    fireEvent.click(screen.getByText("新建会话并填入（保留原草稿）"));
    expect(input()).toHaveValue("updated draft");
    expect(useAssistantsStore.getState().activeId).toBeNull();
    expect(useHistoryStore.getState().activeId).toBe("bound-chat");
  });

  it("does not enable missing or disabled skills or mutate drafts on unavailable assistants", async () => {
    useSettingsStore.setState({ presets: [{ ...preset, desktopAction: { ...preset.desktopAction, skillIds: [skill.id] } }] });
    vi.mocked(listSkills).mockResolvedValue([{ ...skill, enabled: false }]);
    render(<Composer />);
    fireEvent.change(input(), { target: { value: "untouched" } });
    await fileAction("测试桌面动作");
    expect(input()).toHaveValue("untouched");
    expect(screen.getByText(/不可用或已禁用技能/)).toBeInTheDocument();
    expect(screen.getByTitle("开启 Agent 工具")).toHaveAttribute("aria-pressed", "false");
  });

  it("passes the prepared attachment body and current options to the context preview slot", async () => {
    const preview = vi.fn(() => <span>preview fixture</span>);
    const { container } = render(<Composer renderContextPreview={preview} />);
    fireEvent.change(input(), { target: { value: "question" } });
    await stageAttachments(container);
    const last = preview.mock.calls[preview.mock.calls.length - 1] as unknown as [{ text: string; skillIds: string[]; disabled: boolean; enableThinking: boolean; thinkingEffort: string }];
    expect(last[0].text).toContain("【附件：fixture.txt】\nfixture");
    expect(last[0].text).toContain("question");
    expect(last[0].disabled).toBe(false);
    expect(last[0].skillIds).toEqual([]);
    expect(last[0].enableThinking).toBe(useSettingsStore.getState().defaultEnableThinking);
    expect(last[0].thinkingEffort).toBe(useSettingsStore.getState().defaultThinkingEffort);
  });

  it("keeps legacy slash presets working without reading the clipboard", () => {
    useSettingsStore.setState({ presets: [{ id: "legacy", name: "旧指令", command: "/old", content: "old body" }] });
    render(<Composer />);
    fireEvent.change(input(), { target: { value: "/old" } });
    submit();
    expect(input()).toHaveValue("old body\n");
    expect(readClipboardText).not.toHaveBeenCalled();
  });
});

async function stageAttachments(container: HTMLElement) {
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [new File(["fixture"], "fixture.png", { type: "image/png" })] },
  });
  await screen.findByAltText("附件 1");
  fireEvent.click(screen.getByTitle("添加附件：图片或文档（也可以直接把文件拖进窗口）"));
  fireEvent.click(screen.getByText("添加文档"));
  await screen.findByText("fixture.txt");
}

describe("Composer acceptance regressions (real store)", () => {
  it("keeps Composer mounted on missing key rather than navigating away and losing its local draft", () => {
    useProvidersStore.setState({ providers: [{ ...provider, hasApiKey: false }] });
    useWindowStore.setState({ openSettings: () => useWindowStore.setState({ view: "settings" }) });
    function ViewHost() {
      const view = useWindowStore((state) => state.view);
      return view === "chat" ? <Composer /> : <p>设置视图</p>;
    }
    render(<ViewHost />);
    fireEvent.change(input(), { target: { value: "不得卸载的草稿" } });
    submit();
    expect(screen.queryByRole("textbox")).toHaveValue("不得卸载的草稿");
    expect(screen.getByText(/请先在设置中配置模型和 API Key/)).toBeInTheDocument();
  });

  it("retains text, images, documents and one-shot options when comparison rejects images", async () => {
    const { container } = render(<Composer />);
    fireEvent.change(input(), { target: { value: "保留草稿" } });
    await stageAttachments(container);
    fireEvent.click(screen.getByText("联网搜索"));
    fireEvent.click(screen.getByTitle("开启 Agent 工具"));
    act(() => useChatStore.getState().setCompareTargets(targets));
    submit();
    expect(input()).toHaveValue("保留草稿");
    expect(screen.getByAltText("附件 1")).toBeInTheDocument();
    expect(screen.getByText("fixture.txt")).toBeInTheDocument();
    expect(screen.getByText("联网搜索")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTitle("对比模式下不启用 Agent 工具")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("对比模式下不支持图片，请先移除图片或关闭对比")).toBeInTheDocument();
    expect(useChatStore.getState().messages).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["single", "compare"])("retains draft for missing API key in %s mode", (mode) => {
    useProvidersStore.setState({ providers: [{ ...provider, hasApiKey: false }, { ...provider, id: "p2" }] });
    if (mode === "compare") useChatStore.setState({ compareTargets: targets });
    render(<Composer />);
    fireEvent.change(input(), { target: { value: "缺 key 草稿" } });
    submit();
    expect(input()).toHaveValue("缺 key 草稿");
    expect(useWindowStore.getState().openSettings).not.toHaveBeenCalled();
    expect(screen.getByText(/请先在设置中配置模型和 API Key/)).toBeInTheDocument();
    expect(useChatStore.getState().messages).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses the conversation-bound model's key validation rather than the global default", () => {
    useChatStore.setState({ draftSelection: { providerId: "p2", modelKey: "m1" } });
    useProvidersStore.setState({ providers: [provider, { ...provider, id: "p2", hasApiKey: false }] });
    render(<Composer />);
    fireEvent.change(input(), { target: { value: "绑定模型草稿" } });
    submit();
    expect(input()).toHaveValue("绑定模型草稿");
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["single", "compare"])("retains draft under the backup import lock in %s mode", (mode) => {
    useChatStore.setState({ importingBackup: true, compareTargets: mode === "compare" ? targets : [] });
    render(<Composer />);
    fireEvent.change(input(), { target: { value: "导入期间草稿" } });
    submit();
    expect(input()).toHaveValue("导入期间草稿");
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["single", "compare"])("clears an accepted %s draft immediately and never overwrites new input on late failure", async (mode) => {
    let reject!: (reason: Error) => void;
    const pending = new Promise((_, rej) => { reject = rej; });
    vi.mocked(invoke).mockImplementation((command) => command.startsWith("chat_send") ? pending as Promise<never> : Promise.resolve(undefined));
    if (mode === "compare") useChatStore.setState({ compareTargets: targets });
    render(<Composer />);
    fireEvent.change(input(), { target: { value: "已接受" } });
    submit();
    expect(input()).toHaveValue("");
    expect(useChatStore.getState().messages[0].content).toBe("已接受");
    fireEvent.change(input(), { target: { value: "新的草稿" } });
    await act(async () => { reject(new Error("fixture failure")); });
    await waitFor(() => expect(useChatStore.getState().messages[1].status).toBe("error"));
    expect(input()).toHaveValue("新的草稿");
  });
});
