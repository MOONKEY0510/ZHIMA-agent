import { create } from "zustand";
import { useChatStore } from "./chat-store";
import { useHistoryStore } from "../services/history-store";

// Text only, deliberately not persisted. Attachments belong to a mounted Composer.
interface DraftState {
  key: string;
  scope: number;
  drafts: Record<string, string>;
  setText: (key: string, text: string) => void;
  reset: () => void;
}
function identity() {
  const chat = useChatStore.getState();
  const stream = Object.values(chat.streams).find((item) =>
    item.conversationId && chat.messages.some((message) => message.id === item.messageId));
  const activeId = useHistoryStore.getState().activeId;
  const id = activeId ?? stream?.conversationId;
  return { activeId, key: id ? `conversation:${id}` : `new:${chat.approvalSessionId}:${chat.conversationNonce}`, streamId: stream?.conversationId, navigation: chat.approvalSessionId, nonce: chat.conversationNonce };
}
let previous = identity();
export const useDraftStore = create<DraftState>((set) => ({
  key: previous.key,
  scope: 0,
  drafts: {},
  setText: (key, text) => {
    set((state) => {
      const drafts = { ...state.drafts };
      if (text) drafts[key] = text;
      else delete drafts[key];
      return { drafts };
    });
  },
  reset: () => {
    previous = identity();
    set((state) => ({ key: previous.key, drafts: {}, scope: state.scope + 1 }));
  },
}));

function synchronize() {
  const next = identity();
  const state = useDraftStore.getState();
  const navigated = previous.navigation !== next.navigation || previous.nonce !== next.nonce;
  // A reserved stream may finish/fail before history sets activeId. Keep that
  // conversation's identity until explicit navigation, including settings remounts.
  if (!navigated && !next.activeId && !previous.activeId && next.key.startsWith("new:") && state.key.startsWith("conversation:")) next.key = state.key;
  if (next.key === state.key && !navigated) { previous = next; return; }
  // send reserves a visible stream before onAccepted; adopt its saved ID without
  // remounting or losing text typed while the history transaction is pending.
  const promoted = !navigated && state.key.startsWith("new:") && next.key === `conversation:${next.streamId}`;
  const drafts = { ...state.drafts };
  if (state.key.startsWith("new:") && state.key !== next.key) {
    if (promoted && drafts[state.key] && !drafts[next.key]) drafts[next.key] = drafts[state.key];
    delete drafts[state.key];
  }
  previous = next;
  useDraftStore.setState({ key: next.key, drafts, scope: state.scope + (promoted ? 0 : 1) });
}
// One-way subscriptions keep invalidation alive while settings unmount Composer.
useChatStore.subscribe((state, old) => {
  if (state.importingBackup && !old.importingBackup) useDraftStore.getState().reset();
  else synchronize();
});
useHistoryStore.subscribe(synchronize);
