import { invoke } from "@tauri-apps/api/core";
import type { ProvidersStateView, ProviderView } from "../types";

/** Typed wrappers around the provider management commands. */

export function getProvidersState(): Promise<ProvidersStateView> {
  return invoke<ProvidersStateView>("get_providers_state");
}

export function upsertProvider(args: {
  id?: string | null;
  name: string;
  baseUrl: string;
  /** Empty/null keeps the stored key; a value replaces it. */
  apiKey?: string | null;
}): Promise<ProviderView> {
  return invoke<ProviderView>("upsert_provider", { args });
}

export function deleteProvider(id: string): Promise<void> {
  return invoke("delete_provider", { id });
}

export function setDefault(providerId: string, modelKey: string): Promise<void> {
  return invoke("set_default", { args: { providerId, modelKey } });
}

export function addModel(
  providerId: string,
  modelKey: string,
  displayName?: string,
): Promise<ProviderView> {
  return invoke<ProviderView>("add_model", {
    args: { providerId, modelKey, displayName: displayName ?? null },
  });
}

export function removeModel(providerId: string, modelKey: string): Promise<ProviderView> {
  return invoke<ProviderView>("remove_model", {
    args: { providerId, modelKey },
  });
}

export function toggleFavorite(providerId: string, modelKey: string): Promise<ProviderView> {
  return invoke<ProviderView>("toggle_favorite", {
    args: { providerId, modelKey },
  });
}

export function toggleVision(providerId: string, modelKey: string): Promise<ProviderView> {
  return invoke<ProviderView>("toggle_vision", {
    args: { providerId, modelKey },
  });
}

export function setVisionModel(providerId: string, modelKey: string): Promise<void> {
  return invoke("set_vision_model", { args: { providerId, modelKey } });
}

export function setImageModel(providerId: string, modelKey: string): Promise<void> {
  return invoke("set_image_model", { args: { providerId, modelKey } });
}



export function generateImage(
  providerId: string,
  modelKey: string,
  prompt: string,
  size = "1024x1024",
  width?: number,
  height?: number,
  referenceImages?: string[],
): Promise<string> {
  return invoke<string>("generate_image", {
    request: { providerId, modelKey, prompt, size, width, height, referenceImages },
  });
}

/** Fetch candidate model id list (does NOT write them to config). */
export function fetchModels(providerId: string): Promise<string[]> {
  return invoke<string[]>("fetch_models", { providerId });
}

/** Batch-add the user-selected model ids to a provider. */
export function addModels(providerId: string, modelKeys: string[]): Promise<ProviderView> {
  return invoke<ProviderView>("add_models", {
    args: { providerId, modelKeys },
  });
}

export interface TestEndpointResult {
  ok: boolean;
  message: string;
  models: string[];
}

export function testEndpoint(args: {
  providerId?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
}): Promise<TestEndpointResult> {
  return invoke<TestEndpointResult>("test_endpoint", { args });
}

export function setGeneration(temperature: number | null, maxTokens: number | null): Promise<void> {
  return invoke("set_generation", { args: { temperature, maxTokens } });
}

export function setDefaultSystemPrompt(prompt: string | null): Promise<void> {
  return invoke("set_default_system_prompt", { prompt });
}

export function setRememberWindowPosition(enabled: boolean): Promise<void> {
  return invoke("set_remember_window_position", { enabled });
}

export function saveWindowPosition(x: number, y: number): Promise<void> {
  return invoke("save_window_position", { x, y });
}

export function getRememberWindowPosition(): Promise<boolean> {
  return invoke("get_remember_window_position");
}

export function setProxy(
  proxyUrl: string | null,
  useSystemProxy: boolean,
): Promise<void> {
  return invoke("set_proxy", { proxyUrl, useSystemProxy });
}

export function getShortcut(): Promise<string> {
  return invoke<string>("get_shortcut");
}

export function setShortcut(value: string): Promise<string> {
  return invoke<string>("set_shortcut", { value });
}
