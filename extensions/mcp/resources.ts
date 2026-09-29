export type McpResourceEntry = {
  readonly name: string;
  readonly description: string;
};

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
