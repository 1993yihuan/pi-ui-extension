import type { ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";

export type ToolUsageKind = "tool" | "mcp";

export type ToolUsageCount = {
  readonly name: string;
  readonly kind: ToolUsageKind;
  /** Calls made while answering the current user question. */
  readonly exchange: number;
  readonly session: number;
};

export type ToolUsageSnapshot = {
  readonly counts: readonly ToolUsageCount[];
};

export type ToolUsageTracker = {
  startExchange(): void;
  resetSession(
    entries: readonly unknown[],
    mcpServerNames?: Iterable<string>,
    options?: { readonly preserveExchange?: boolean },
  ): void;
  record(event: ToolExecutionEndEvent): void;
  getSnapshot(): ToolUsageSnapshot;
};

type MutableUsageCount = { readonly name: string; readonly kind: ToolUsageKind; count: number };
type MutableCounts = Map<string, MutableUsageCount>;
type RecordedExecution = { readonly toolName: string; readonly result: unknown };
type McpScriptCall = {
  readonly operation?: unknown;
  readonly path?: unknown;
  readonly ok?: unknown;
};

type ParsedUsage = {
  readonly topLevelName?: string;
  readonly mcpServers: readonly string[];
};

type FabricOperation = {
  readonly ref?: unknown;
  readonly provider?: unknown;
  readonly action?: unknown;
  readonly args?: unknown;
};

const FABRIC_EXEC_TOOL = "fabric_exec";
const FABRIC_NESTED_TOOL_CALL_ID_PREFIX = "fabric_";
const MCP_PROXY_TOOLS = new Set(["mcp", "mcpScript"]);
const CONTEXT_MODE_TOOL_NAMES = new Set([
  "ctx_execute",
  "ctx_execute_file",
  "ctx_index",
  "ctx_search",
  "ctx_fetch_and_index",
  "ctx_batch_execute",
  "ctx_stats",
  "ctx_doctor",
  "ctx_upgrade",
  "ctx_purge",
  "ctx_insight",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function countKey(name: string, kind: ToolUsageKind): string {
  return `${kind}\0${name}`;
}

function increment(counts: MutableCounts, name: string, kind: ToolUsageKind, amount = 1): void {
  if (amount <= 0) return;
  const key = countKey(name, kind);
  const current = counts.get(key);
  if (current) current.count += amount;
  else counts.set(key, { name, kind, count: amount });
}

function contextModeServer(toolName: string): string | undefined {
  return CONTEXT_MODE_TOOL_NAMES.has(toolName) ? "context-mode" : undefined;
}

function sanitizedServerName(serverName: string): string {
  return Array.from(serverName, (character) => /^[A-Za-z0-9_-]$/.test(character)
    ? character
    : `_${character.codePointAt(0)!.toString(16)}_`).join("");
}

function resolveScriptServer(path: string, knownServers: readonly string[]): string | undefined {
  const matches = knownServers.flatMap((server) => {
    const sanitized = sanitizedServerName(server);
    const shortBase = server.replace(/-?mcp$/i, "");
    const short = sanitizedServerName(shortBase || "mcp");
    return [...new Set([`${sanitized}_`, `${short}_`, `mcp__${sanitized}_`])]
      .filter((prefix) => path.startsWith(prefix))
      .map((prefix) => ({ server, prefix }));
  });
  const longest = matches.reduce((length, match) => Math.max(length, match.prefix.length), 0);
  const candidates = new Set(matches.filter((match) => match.prefix.length === longest).map((match) => match.server));
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

function scriptServers(result: unknown, knownServers: readonly string[]): string[] {
  const details = asRecord(asRecord(result)?.details);
  if (details?.mode !== "script" || !Array.isArray(details.calls)) return [];

  const servers: string[] = [];
  for (const call of details.calls as McpScriptCall[]) {
    if (call.operation !== "call") continue;
    const path = nonEmptyString(call.path);
    if (!path) continue;
    const knownServer = resolveScriptServer(path, knownServers);
    if (knownServer) {
      servers.push(knownServer);
      continue;
    }
    // Without an authoritative server list the flattened MCP path cannot be
    // reversed safely (server names and tool names can both contain `_`).
    // Keep the top-level mcpScript count and wait for a later status-driven
    // session rebuild rather than permanently attributing it to a wrong name.
  }
  return servers;
}

function directMcpServer(result: unknown): string | undefined {
  return nonEmptyString(asRecord(asRecord(result)?.details)?.server);
}

function proxyMcpServer(toolName: string, result: unknown): string | undefined {
  if (!MCP_PROXY_TOOLS.has(toolName)) return undefined;
  return directMcpServer(result);
}

function parseUsage(toolName: string, result: unknown, knownServers: readonly string[]): ParsedUsage {
  const topLevelName = toolName.trim() || "tool";
  const contextServer = contextModeServer(topLevelName);
  if (contextServer) return { topLevelName, mcpServers: [contextServer] };

  if (topLevelName === "mcpScript") {
    return { topLevelName, mcpServers: scriptServers(result, knownServers) };
  }

  const mcpServer = proxyMcpServer(topLevelName, result);
  return { topLevelName, mcpServers: mcpServer ? [mcpServer] : [] };
}

function fabricOperationUsage(value: unknown, knownServers: readonly string[]): ParsedUsage | undefined {
  const operation = asRecord(value) as FabricOperation | undefined;
  const ref = nonEmptyString(operation?.ref);
  if (!ref) return undefined;
  const provider = nonEmptyString(operation?.provider) ?? ref.split(".", 1)[0];
  const action = nonEmptyString(operation?.action);

  if (provider === "mcp" || ref.startsWith("mcp.")) {
    const suffix = ref.startsWith("mcp.") ? ref.slice(4) : action ?? "";
    if (suffix.startsWith("$")) {
      const server = suffix === "$call" ? nonEmptyString(asRecord(operation?.args)?.server) : undefined;
      return server
        ? { mcpServers: [server] }
        : { topLevelName: ref, mcpServers: [] };
    }
    const separator = suffix.indexOf(".");
    const server = separator > 0 ? suffix.slice(0, separator) : undefined;
    return server ? { mcpServers: [server] } : { topLevelName: ref, mcpServers: [] };
  }

  if (provider === "pi" || ref.startsWith("pi.")) {
    return parseUsage(action ?? ref.slice(3), undefined, knownServers);
  }
  if (provider === "extensions" || ref.startsWith("extensions.")) {
    return parseUsage(action ?? ref.slice("extensions.".length), undefined, knownServers);
  }
  return parseUsage(ref, undefined, knownServers);
}

function fabricNestedUsages(result: unknown, knownServers: readonly string[]): ParsedUsage[] {
  const details = asRecord(asRecord(result)?.details);
  const trace = asRecord(details?.trace);
  const operations = Array.isArray(trace?.operations)
    ? trace.operations
    : Array.isArray(details?.audits)
      ? details.audits
      : [];
  return operations
    .map((operation) => fabricOperationUsage(operation, knownServers))
    .filter((usage): usage is ParsedUsage => usage !== undefined);
}

function parseUsages(toolName: string, result: unknown, knownServers: readonly string[]): ParsedUsage[] {
  const topLevel = parseUsage(toolName, result, knownServers);
  return toolName === FABRIC_EXEC_TOOL
    ? [topLevel, ...fabricNestedUsages(result, knownServers)]
    : [topLevel];
}

function snapshotCounts(exchangeCounts: MutableCounts, sessionCounts: MutableCounts): ToolUsageSnapshot {
  const kindOrder: Record<ToolUsageKind, number> = { tool: 0, mcp: 1 };
  return Object.freeze({
    counts: Object.freeze(
      [...sessionCounts.values()]
        .map(({ name, kind, count: session }) => Object.freeze({
          name,
          kind,
          exchange: exchangeCounts.get(countKey(name, kind))?.count ?? 0,
          session,
        }))
        .sort((left, right) => kindOrder[left.kind] - kindOrder[right.kind] || right.exchange - left.exchange || right.session - left.session || left.name.localeCompare(right.name)),
    ),
  });
}

export function createToolUsageTracker(
  initialToolNames: Iterable<string> = [],
  getMcpServerNames: () => Iterable<string> = () => [],
): ToolUsageTracker {
  let exchangeCounts: MutableCounts = new Map();
  let sessionCounts: MutableCounts = new Map();
  let exchangeExecutions: RecordedExecution[] = [];
  for (const name of initialToolNames) increment(sessionCounts, name, "tool");

  const recordParsed = (counts: MutableCounts, usage: ParsedUsage): void => {
    if (usage.topLevelName) increment(counts, usage.topLevelName, "tool");
    for (const server of usage.mcpServers) increment(counts, server, "mcp");
  };

  const recordExecution = (counts: MutableCounts, execution: RecordedExecution, knownServers: readonly string[]): void => {
    for (const usage of parseUsages(execution.toolName, execution.result, knownServers)) {
      recordParsed(counts, usage);
    }
  };

  return {
    startExchange(): void {
      exchangeCounts = new Map();
      exchangeExecutions = [];
    },
    resetSession(entries, mcpServerNames = getMcpServerNames(), options = {}): void {
      const knownServers = [...mcpServerNames];
      sessionCounts = new Map();
      for (const count of usageCountsFromBranch(entries, knownServers)) {
        increment(sessionCounts, count.name, count.kind);
      }
      if (options.preserveExchange === true) {
        exchangeCounts = new Map();
        for (const execution of exchangeExecutions) {
          recordExecution(exchangeCounts, execution, knownServers);
        }
      } else {
        exchangeCounts = new Map();
        exchangeExecutions = [];
      }
    },
    record(event): void {
      // Fabric persists every nested operation in the outer result trace. Ignore
      // replayed nested lifecycle events here, then count the trace once when
      // fabric_exec ends so Pi tools, captured extensions and MCP calls cannot
      // disappear or be double-counted depending on provider implementation.
      if (event.toolCallId.startsWith(FABRIC_NESTED_TOOL_CALL_ID_PREFIX)) return;
      const execution = { toolName: event.toolName, result: event.result };
      exchangeExecutions.push(execution);
      const knownServers = [...getMcpServerNames()];
      recordExecution(exchangeCounts, execution, knownServers);
      recordExecution(sessionCounts, execution, knownServers);
    },
    getSnapshot(): ToolUsageSnapshot {
      return snapshotCounts(exchangeCounts, sessionCounts);
    },
  };
}

type UsageName = { readonly name: string; readonly kind: ToolUsageKind };

/** Reconstruct completed tool and MCP-server totals from the active branch. */
function usageCountsFromBranch(entries: readonly unknown[], mcpServerNames: Iterable<string> = []): UsageName[] {
  const counts: UsageName[] = [];
  const knownServers = [...mcpServerNames];
  for (const value of entries) {
    const entry = asRecord(value);
    if (entry?.type !== "message") continue;
    const message = asRecord(entry.message);
    if (message?.role !== "toolResult") continue;
    const toolName = nonEmptyString(message.toolName);
    if (!toolName) continue;
    for (const usage of parseUsages(toolName, { details: message.details }, knownServers)) {
      if (usage.topLevelName) counts.push({ name: usage.topLevelName, kind: "tool" });
      counts.push(...usage.mcpServers.map((name) => ({ name, kind: "mcp" as const })));
    }
  }
  return counts;
}

export function toolNamesFromBranch(entries: readonly unknown[], mcpServerNames: Iterable<string> = []): string[] {
  return usageCountsFromBranch(entries, mcpServerNames).map((count) => count.name);
}
