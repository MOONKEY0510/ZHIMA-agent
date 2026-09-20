import { create } from "zustand";
import * as api from "../services/assistants-api";
import type { AssistantView } from "../services/assistants-api";

interface AssistantsState {
  loaded: boolean;
  assistants: AssistantView[];
  /**
   * Assistant bound to the next new conversation.  Opening an existing
   * conversation switches it to that conversation's assistant, so the sidebar
   * always reflects what the current chat uses.
   */
  activeId: string | null;

  load: () => Promise<void>;
  refresh: () => Promise<void>;
  setActive: (id: string | null) => void;
  save: (assistant: AssistantView) => Promise<AssistantView>;
  remove: (id: string) => Promise<void>;
  resetBuiltin: (id: string) => Promise<void>;
}

export const useAssistantsStore = create<AssistantsState>((set) => ({
  loaded: false,
  assistants: [],
  activeId: null,

  load: async () => {
    try {
      const assistants = await api.listAssistants();
      set({ assistants, loaded: true });
    } catch (err) {
      console.error("加载助手失败:", err);
      set({ loaded: true });
    }
  },

  refresh: async () => {
    try {
      set({ assistants: await api.listAssistants() });
    } catch (err) {
      console.error("刷新助手失败:", err);
    }
  },

  setActive: (id) => set({ activeId: id }),

  save: async (assistant) => {
    const saved = await api.upsertAssistant(assistant);
    set((state) => {
      const exists = state.assistants.some((a) => a.id === saved.id);
      return {
        assistants: exists
          ? state.assistants.map((a) => (a.id === saved.id ? saved : a))
          : [...state.assistants, saved],
      };
    });
    return saved;
  },

  remove: async (id) => {
    await api.deleteAssistant(id);
    set((state) => ({
      assistants: state.assistants.filter((a) => a.id !== id),
      activeId: state.activeId === id ? null : state.activeId,
    }));
  },

  resetBuiltin: async (id) => {
    const restored = await api.resetBuiltinAssistant(id);
    set((state) => ({
      assistants: state.assistants.map((a) => (a.id === id ? restored : a)),
    }));
  },
}));

/** The assistant selected for new conversations, if any. */
export function activeAssistant(): AssistantView | null {
  const { assistants, activeId } = useAssistantsStore.getState();
  return assistants.find((a) => a.id === activeId) ?? null;
}

/** Sort order: shipped order for built-ins (0…n), user assistants afterwards. */
export function sortedAssistants(assistants: AssistantView[]): AssistantView[] {
  return [...assistants].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt,
  );
}
