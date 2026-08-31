import { create } from "zustand";
import type { GenerationPrefs, ModelEntry, ProviderView, ProvidersStateView } from "../types";
import * as api from "../services/providers-api";
import { uiPrefsStore } from "./settings-store";

/** Legacy v0.1 provider shape stored by the old settings panel. */
interface LegacyProvider {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

interface ProvidersState {
  loaded: boolean;
  providers: ProviderView[];
  defaultProviderId: string | null;
  defaultModelKey: string | null;
  generation: GenerationPrefs;
  visionProviderId: string | null;
  visionModelKey: string | null;
  imageProviderId: string | null;
  imageModelKey: string | null;
  defaultSystemPrompt: string | null;
  rememberWindowPosition: boolean;
  proxyUrl: string | null;
  useSystemProxy: boolean;

  load: () => Promise<void>;
  refresh: () => Promise<void>;
  select: (providerId: string, modelKey: string) => Promise<void>;
  setGeneration: (temperature: number | null, maxTokens: number | null) => Promise<void>;
  toggleFavorite: (providerId: string, modelKey: string) => Promise<void>;
  toggleVision: (providerId: string, modelKey: string) => Promise<void>;
  setVisionModel: (providerId: string, modelKey: string) => Promise<void>;
  setImageModel: (providerId: string, modelKey: string) => Promise<void>;
  setDefaultSystemPrompt: (prompt: string | null) => Promise<void>;
  setRememberWindowPosition: (enabled: boolean) => Promise<void>;
  setProxy: (proxyUrl: string | null, useSystemProxy: boolean) => Promise<void>;
}

function apply(state: ProvidersStateView) {
  return {
    providers: state.providers,
    defaultProviderId: state.defaultProviderId,
    defaultModelKey: state.defaultModelKey,
    generation: state.generation,
    visionProviderId: state.visionProviderId,
    visionModelKey: state.visionModelKey,
    imageProviderId: state.imageProviderId,
    imageModelKey: state.imageModelKey,
    defaultSystemPrompt: state.defaultSystemPrompt,
    rememberWindowPosition: state.rememberWindowPosition,
    proxyUrl: state.proxyUrl,
    useSystemProxy: state.useSystemProxy,
  };
}

export const useProvidersStore = create<ProvidersState>((set) => ({
  loaded: false,
  providers: [],
  defaultProviderId: null,
  defaultModelKey: null,
  generation: { temperature: null, maxTokens: null },
  visionProviderId: null,
  visionModelKey: null,
  imageProviderId: null,
  imageModelKey: null,
  defaultSystemPrompt: null,
  rememberWindowPosition: false,
  proxyUrl: null,
  useSystemProxy: false,

  load: async () => {
    let state = await api.getProvidersState();

    // One-time migration of the v0.1 single-provider configuration.
    if (state.providers.length === 0) {
      const legacy = await uiPrefsStore.get<LegacyProvider | null>("provider");
      if (legacy?.baseUrl?.trim()) {
        try {
          const provider = await api.upsertProvider({
            name: "默认服务商",
            baseUrl: legacy.baseUrl.trim(),
            apiKey: legacy.apiKey ?? "",
          });
          if (legacy.model?.trim()) {
            await api.addModel(provider.id, legacy.model.trim());
            await api.setDefault(provider.id, legacy.model.trim());
          }
          await uiPrefsStore.delete("provider");
          await uiPrefsStore.save();
          state = await api.getProvidersState();
        } catch {
          // Migration is best-effort; the user can configure manually.
        }
      }
    }

    set({ ...apply(state), loaded: true });
  },

  refresh: async () => {
    const state = await api.getProvidersState();
    set(apply(state));
  },

  select: async (providerId, modelKey) => {
    await api.setDefault(providerId, modelKey);
    set({ defaultProviderId: providerId, defaultModelKey: modelKey });
  },

  setGeneration: async (temperature, maxTokens) => {
    await api.setGeneration(temperature, maxTokens);
    set({ generation: { temperature, maxTokens } });
  },

  toggleFavorite: async (providerId, modelKey) => {
    const view = await api.toggleFavorite(providerId, modelKey);
    set((state) => ({
      providers: state.providers.map((p) => (p.id === view.id ? view : p)),
    }));
  },

  toggleVision: async (providerId, modelKey) => {
    const view = await api.toggleVision(providerId, modelKey);
    set((state) => ({
      providers: state.providers.map((p) => (p.id === view.id ? view : p)),
    }));
  },

  setVisionModel: async (providerId, modelKey) => {
    await api.setVisionModel(providerId, modelKey);
    set({ visionProviderId: providerId, visionModelKey: modelKey });
  },

  setImageModel: async (providerId, modelKey) => {
    await api.setImageModel(providerId, modelKey);
    set({ imageProviderId: providerId, imageModelKey: modelKey });
  },

  setDefaultSystemPrompt: async (prompt) => {
    await api.setDefaultSystemPrompt(prompt);
    set({ defaultSystemPrompt: prompt });
  },

  setRememberWindowPosition: async (enabled) => {
    await api.setRememberWindowPosition(enabled);
    set({ rememberWindowPosition: enabled });
  },

  setProxy: async (proxyUrl, useSystemProxy) => {
    await api.setProxy(proxyUrl, useSystemProxy);
    set({ proxyUrl, useSystemProxy });
  },
}));

/** The currently selected provider (falls back to the first one). */
function currentProvider(): ProviderView | null {
  const { providers, defaultProviderId } = useProvidersStore.getState();
  return (
    providers.find((p) => p.id === defaultProviderId) ?? providers[0] ?? null
  );
}

/** The currently selected model of the current provider. */
export function currentModel(): { provider: ProviderView; model: ModelEntry } | null {
  const provider = currentProvider();
  if (!provider) return null;
  const { defaultProviderId, defaultModelKey } = useProvidersStore.getState();
  const model =
    provider.id === defaultProviderId
      ? provider.models.find((m) => m.modelKey === defaultModelKey) ?? provider.models[0]
      : provider.models[0];
  return model ? { provider, model } : null;
}
