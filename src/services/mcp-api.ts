import { invoke } from "@tauri-apps/api/core";

/** MCP server management (P1-10). */

export interface McpToolInfo {
  serverId: string;
  serverName: string;
  /** Name the server uses. */
  toolName: string;
  /** Registry name the model sees: `mcp_<server>_<tool>`. */
  qualified: string;
  description: string;
}

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

export interface McpServerView extends McpServerConfig {
  /** Ready-to-display command line. */
  commandLine: string;
  /** Tools discovered on the last refresh. */
  tools: McpToolInfo[];
}

export interface McpView {
  servers: McpServerView[];
}

export function listMcpServers(): Promise<McpView> {
  return invoke<McpView>("list_mcp_servers");
}

/**
 * Start the enabled servers on demand (they no longer launch at app start).
 *
 * Idempotent: resolves immediately when tools are already cached or when no
 * server is enabled, and a concurrent call never starts a second warm-up.
 */
export function warmMcpServers(): Promise<void> {
  return invoke("warm_mcp_servers");
}

/** Create (empty id) or update a server; refreshes the tool list. */
export function upsertMcpServer(server: McpServerConfig): Promise<McpView> {
  return invoke<McpView>("upsert_mcp_server", { server });
}

export function deleteMcpServer(id: string): Promise<McpView> {
  return invoke<McpView>("delete_mcp_server", { id });
}

export function setMcpServerEnabled(id: string, enabled: boolean): Promise<McpView> {
  return invoke<McpView>("set_mcp_server_enabled", { id, enabled });
}

export function testMcpServer(id: string): Promise<McpToolInfo[]> {
  return invoke<McpToolInfo[]>("test_mcp_server", { id });
}

/** Parse a pasted `{ "command": …, "args": […] }` snippet. */
export function parseMcpJson(json: string): Promise<McpServerConfig> {
  return invoke<McpServerConfig>("parse_mcp_json", { json });
}
