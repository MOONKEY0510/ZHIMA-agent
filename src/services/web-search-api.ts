import { invoke } from "@tauri-apps/api/core";

/** Web-search engine settings (P0-3). API keys never cross this boundary. */

export type WebSearchEngine = "duckduckgo" | "tavily" | "bocha" | "searxng";

export interface WebSearchConfigView {
  engine: WebSearchEngine | string;
  searxngBaseUrl: string | null;
  /** Whether a key is stored in the credential manager. */
  tavilyKeySet: boolean;
  bochaKeySet: boolean;
  /** Whether the current engine has everything it needs to run. */
  ready: boolean;
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchTestResult {
  engine: string;
  count: number;
  elapsedMs: number;
  results: WebSearchHit[];
}

export function getWebSearchConfig(): Promise<WebSearchConfigView> {
  return invoke<WebSearchConfigView>("get_web_search_config");
}

export function setWebSearchConfig(
  engine: string,
  searxngBaseUrl: string | null,
): Promise<WebSearchConfigView> {
  return invoke<WebSearchConfigView>("set_web_search_config", {
    engine,
    searxngBaseUrl,
  });
}

/** Store (empty string clears) the API key of a key-based engine. */
export function setWebSearchApiKey(
  engine: string,
  key: string,
): Promise<WebSearchConfigView> {
  return invoke<WebSearchConfigView>("set_web_search_api_key", { engine, key });
}

export function testWebSearch(query: string): Promise<WebSearchTestResult> {
  return invoke<WebSearchTestResult>("test_web_search", { query });
}
