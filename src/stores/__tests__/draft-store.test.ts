import { beforeEach, describe, expect, it } from "vitest";
import { useDraftStore } from "../draft-store";
import { useChatStore } from "../chat-store";
import { useHistoryStore } from "../../services/history-store";

beforeEach(() => {
  useChatStore.setState({ ...useChatStore.getInitialState() });
  useHistoryStore.setState({ activeId: null });
  useDraftStore.getState().reset();
});

describe("memory-only conversation drafts", () => {
  it("isolates saved conversations and removes empty entries", () => {
    useHistoryStore.setState({ activeId: "a" });
    const a = useDraftStore.getState().key;
    useDraftStore.getState().setText(a, "A");
    useHistoryStore.setState({ activeId: "b" });
    const b = useDraftStore.getState().key;
    useDraftStore.getState().setText(b, "B");
    expect(useDraftStore.getState().drafts[a]).toBe("A");
    useDraftStore.getState().setText(b, "");
    expect(useDraftStore.getState().drafts[b]).toBeUndefined();
  });
  it("retires abandoned new-conversation keys", () => {
    const old = useDraftStore.getState().key;
    useDraftStore.getState().setText(old, "abandoned");
    useChatStore.getState().startNewConversation();
    expect(useDraftStore.getState().key).not.toBe(old);
    expect(useDraftStore.getState().drafts[old]).toBeUndefined();
  });
  it("promotes a provisional draft when the same scope receives its saved id", () => {
    const old = useDraftStore.getState().key;
    useDraftStore.getState().setText(old, "next turn");
    const message = { id: "reply", role: "assistant" as const, content: "", status: "streaming" as const, createdAt: 1 };
    useChatStore.setState({ messages: [message], streams: { req: { messageId: "reply", conversationId: "saved", startedAt: 1 } } });
    const promotedKey = useDraftStore.getState().key;
    useChatStore.setState({ streams: {} });
    expect(useDraftStore.getState().key).toBe(promotedKey);
    useHistoryStore.setState({ activeId: "saved" });
    expect(useDraftStore.getState().drafts[useDraftStore.getState().key]).toBe("next turn");
    expect(useDraftStore.getState().drafts[old]).toBeUndefined();
  });
  it("clears all drafts on backup import even without a mounted Composer", () => {
    useDraftStore.getState().setText(useDraftStore.getState().key, "private");
    useChatStore.setState({ importingBackup: true });
    expect(useDraftStore.getState().drafts).toEqual({});
    useDraftStore.getState().setText(useDraftStore.getState().key, "new input after invalidation");
    expect(useDraftStore.getState().drafts[useDraftStore.getState().key]).toBe("new input after invalidation");
  });
});
