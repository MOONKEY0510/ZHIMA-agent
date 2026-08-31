import { create } from "zustand";
import * as api from "../services/imagegen-api";
import type { ImageGeneration } from "../services/imagegen-api";

let seq = 0;
const nextId = () => `img-${Date.now().toString(36)}-${++seq}`;

interface ImageGenState {
  loaded: boolean;
  history: ImageGeneration[];
  load: () => Promise<void>;
  add: (prompt: string, imageData: string, sizeLabel?: string, referenceImages?: string[]) => Promise<void>;
  remove: (id: string) => Promise<void>;
  clear: () => Promise<void>;
}

export const useImageGenStore = create<ImageGenState>((set) => ({
  loaded: false,
  history: [],

  load: async () => {
    try {
      const history = await api.listImageGenerations();
      set({ history, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  add: async (prompt, imageData, sizeLabel, referenceImages) => {
    const item = await api.saveImageGeneration(nextId(), prompt, imageData, sizeLabel, referenceImages);
    set((state) => ({ history: [item, ...state.history] }));
  },

  remove: async (id) => {
    await api.deleteImageGeneration(id);
    set((state) => ({ history: state.history.filter((g) => g.id !== id) }));
  },

  clear: async () => {
    await api.clearImageGenerations();
    set({ history: [] });
  },
}));
