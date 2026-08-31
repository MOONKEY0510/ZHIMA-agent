import { create } from "zustand";
import * as api from "./history-api";
import type { Conversation } from "./history-api";
import { uiPrefsStore } from "../stores/settings-store";
import { useChatStore } from "../stores/chat-store";

export type { Conversation } from "./history-api";

const HISTORY_ENABLED_KEY = "historyEnabled";

interface HistoryState {
  loaded: boolean;
  historyEnabled: boolean;
  conversations: Conversation[];
  activeId: string | null;

  load: () => Promise<void>;
  refreshList: () => Promise<void>;
  setActive: (id: string | null) => void;
  setHistoryEnabled: (value: boolean) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  loaded: false,
  historyEnabled: true,
  conversations: [],
  activeId: null,

  load: async () => {
    const enabled = (await uiPrefsStore.get<boolean | null>(HISTORY_ENABLED_KEY)) ?? true;
    set({ historyEnabled: enabled });
    if (enabled) {
      const conversations = await api.listConversations();
      set({ conversations });
    }
    set({ loaded: true });
  },

  refreshList: async () => {
    if (!get().historyEnabled) return;
    const conversations = await api.listConversations();
    set({ conversations });
  },

  setActive: (id) => set({ activeId: id }),

  setHistoryEnabled: async (value) => {
    await uiPrefsStore.set(HISTORY_ENABLED_KEY, value);
    await uiPrefsStore.save();
    set({ historyEnabled: value, ...(value ? {} : { activeId: null }) });
    if (value) await get().refreshList();
  },

  rename: async (id, title) => {
    await api.renameConversation(id, title);
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, title } : c,
      ),
    }));
  },

  remove: async (id) => {
    await api.deleteConversation(id);
    const wasActive = get().activeId === id;
    set((state) => ({
      conversations: state.conversations.filter((c) => c.id !== id),
      activeId: state.activeId === id ? null : state.activeId,
    }));
    // If the deleted conversation was the one currently displayed, reset the
    // chat view to a fresh empty state so the old messages don't linger.
    if (wasActive) {
      useChatStore.getState().clearConversation();
    }
  },
}));
