import { readFileSync } from "node:fs";
import { join } from "node:path";

export type McpResourceEntry = {
  readonly name: string;
  readonly description: string;
};

export function mcpResourceEntriesFromConfig(agentDir: string, cwd: string, trusted: boolean): readonly McpResourceEntry[] {
  const paths = [join(agentDir, "mcp.json")];
  if (trusted) paths.push(join(cwd, ".pi", "mcp.json"));
  const rows = new Map<string, McpResourceEntry>();
  for (const path of paths) {
    try {
      const config: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!config || typeof config !== "object" || Array.isArray(config)) continue;
      const servers = (config as { mcpServers?: unknown }).mcpServers;
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
      for (const [name, value] of Object.entries(servers)) {
        if (!name.trim() || !value || typeof value !== "object" || Array.isArray(value)) continue;
        if ((value as { disabled?: unknown }).disabled === true) {
          rows.delete(name);
          continue;
        }
        rows.set(name, { name, description: "Configured MCP server (connection not verified)" });
      }
    } catch { /* Missing or invalid configuration is not fatal. */ }
  }
  return [...rows.values()];
}

export function mergeMcpResourceEntries(configured: readonly McpResourceEntry[], live: readonly McpResourceEntry[]): readonly McpResourceEntry[] {
  const rows = new Map(configured.map((entry) => [entry.name, entry]));
  for (const entry of live) rows.set(entry.name, entry);
  return [...rows.values()];
}

type McpStatusServer = {
  readonly name?: unknown;
  readonly disabled?: unknown;
};

/** Convert the adapter's read-only status snapshot into configured, enabled MCP rows. */
export function mcpResourceEntriesFromStatus(value: unknown): readonly McpResourceEntry[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const snapshot = value as { version?: unknown; servers?: unknown };
  if (snapshot.version !== 1 || !Array.isArray(snapshot.servers)) return [];

  const seen = new Set<string>();
  const rows: McpResourceEntry[] = [];
  for (const rawServer of snapshot.servers) {
    if (typeof rawServer !== "object" || rawServer === null || Array.isArray(rawServer)) continue;
    const server = rawServer as McpStatusServer;
    const name = typeof server.name === "string" ? server.name.trim() : "";
    if (!name || server.disabled === true || seen.has(name)) continue;
    seen.add(name);
    rows.push({
      name,
      description: "MCP server loaded in the current Pi session",
    });
  }
  return rows;
}
