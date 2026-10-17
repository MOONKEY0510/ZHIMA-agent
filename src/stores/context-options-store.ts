import { create } from "zustand";
import type { ContextExclusions } from "../types";

export const EMPTY_CONTEXT_EXCLUSIONS: ContextExclusions = { memoryIds: [], knowledgeDocumentIds: [] };
const copy = (value: ContextExclusions): ContextExclusions => ({
  memoryIds: [...value.memoryIds], knowledgeDocumentIds: [...value.knowledgeDocumentIds],
});

/** Ephemeral only. No imports from chat-store, no persistence and no data deletion. */
export const useContextOptionsStore = create<{
  drafts: Record<string, ContextExclusions>;
  turns: Record<string, ContextExclusions>;
  toggle: (scope: string, kind: keyof ContextExclusions, id: string) => void;
  capture: (scope: string, userId: string) => ContextExclusions;
  reset: () => void;
}>((set, get) => ({
  drafts: {}, turns: {},
  toggle: (scope, kind, id) => set((state) => {
    const current = state.drafts[scope] ?? EMPTY_CONTEXT_EXCLUSIONS;
    return { drafts: { ...state.drafts, [scope]: { ...current,
      [kind]: current[kind].includes(id) ? current[kind].filter((item) => item !== id) : [...current[kind], id],
    } } };
  }),
  capture: (scope, userId) => {
    const exclusions = copy(get().drafts[scope] ?? EMPTY_CONTEXT_EXCLUSIONS);
    set((state) => {
      const { [scope]: _consumed, ...drafts } = state.drafts;
      return { drafts, turns: { ...state.turns, [userId]: exclusions } };
    });
    return exclusions;
  },
  reset: () => set({ drafts: {}, turns: {} }),
}));
