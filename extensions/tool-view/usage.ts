import type { ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";

export type ToolUsageKind = "tool" | "mcp";
export type ToolUsageScope = "direct" | "nested";

export type ToolUsageCount = {
  readonly name: string;
  readonly kind: ToolUsageKind;
  /** Omitted for direct tools and MCP aggregates; nested tool calls are explicit. */
  readonly scope?: "nested";
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

type MutableUsageCount = { readonly name: string; readonly kind: ToolUsageKind; readonly scope?: "nested"; count: number };
type MutableCounts = Map<string, MutableUsageCount>;
type RecordedExecution = {
  readonly toolName: string;
  readonly result: unknown;
  readonly id?: string;
  readonly scope: ToolUsageScope;
};
type McpScriptCall = {
  readonly operation?: unknown;
  readonly path?: unknown;
  readonly ok?: unknown;
};

type ParsedUsage = {
  readonly topLevelName?: string;
  readonly mcpServers: readonly string[];
};

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

function countKey(name: string, kind: ToolUsageKind, scope: ToolUsageScope = "direct"): string {
  // MCP groups aggregate both direct and nested invocations by server.
  return `${kind}\0${kind === "mcp" ? "" : scope}\0${name}`;
}

function increment(counts: MutableCounts, name: string, kind: ToolUsageKind, scope: ToolUsageScope = "direct"): void {
  const key = countKey(name, kind, scope);
  const current = counts.get(key);
  if (current) current.count++;
  else counts.set(key, { name, kind, ...(kind === "tool" && scope === "nested" ? { scope: "nested" as const } : {}), count: 1 });
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

/** Pi native MCP tools use mcp__<sanitized-server>__<tool>. Never guess on collisions. */
function nativeMcpServer(toolName: string, knownServers: readonly string[]): string | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  const matches = knownServers.filter((server) => {
    const normalized = server.replace(/[^A-Za-z0-9_]/g, "_");
    return toolName.startsWith(`mcp__${normalized}__`);
  });
  return matches.length === 1 ? matches[0] : undefined;
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

  const nativeServer = nativeMcpServer(topLevelName, knownServers);
  if (nativeServer) return { topLevelName, mcpServers: [nativeServer] };

  if (topLevelName === "mcpScript") {
    return { topLevelName, mcpServers: scriptServers(result, knownServers) };
  }

  const mcpServer = proxyMcpServer(topLevelName, result);
  return { topLevelName, mcpServers: mcpServer ? [mcpServer] : [] };
}

function snapshotCounts(exchangeCounts: MutableCounts, sessionCounts: MutableCounts): ToolUsageSnapshot {
  const groupOrder = (count: Pick<ToolUsageCount, "kind" | "scope">): number =>
    count.kind === "mcp" ? 2 : count.scope === "nested" ? 1 : 0;
  // A finished event may precede its parent result being persisted. Always
  // include live-only rows even when session counts were just rebuilt.
  const keys = new Set([...sessionCounts.keys(), ...exchangeCounts.keys()]);
  return Object.freeze({
    counts: Object.freeze(
      [...keys].map((key) => {
        const entry = sessionCounts.get(key) ?? exchangeCounts.get(key)!;
        return Object.freeze({
          name: entry.name,
          kind: entry.kind,
          ...(entry.scope ? { scope: entry.scope } : {}),
          exchange: exchangeCounts.get(key)?.count ?? 0,
          session: sessionCounts.get(key)?.count ?? 0,
        });
      }).sort((left, right) =>
        groupOrder(left) - groupOrder(right) ||
        right.exchange - left.exchange ||
        right.session - left.session ||
        left.name.localeCompare(right.name)),
    ),
  });
}

/** Rehydrate only bounded, persisted call metadata; never read arguments or output. */
function nestedExecutions(raw: unknown): RecordedExecution[] {
  const calls = asRecord(raw)?.calls;
  if (!Array.isArray(calls)) return [];
  const executions: RecordedExecution[] = [];
  for (const rawCall of calls) {
    const call = asRecord(rawCall);
    const toolName = nonEmptyString(call?.name);
    if (!toolName) continue;
    executions.push({
      toolName, result: undefined, scope: "nested",
      ...(nonEmptyString(call?.id) ? { id: nonEmptyString(call?.id) } : {}),
    });
  }
  return executions;
}

function branchExecutions(entries: readonly unknown[]): RecordedExecution[] {
  const executions: RecordedExecution[] = [];
  for (const value of entries) {
    const entry = asRecord(value);
    if (entry?.type !== "message") continue;
    const message = asRecord(entry.message);
    if (message?.role !== "toolResult") continue;
    const toolName = nonEmptyString(message.toolName);
    if (!toolName) continue;
    executions.push({
      toolName, scope: "direct", result: { details: message.details },
      ...(nonEmptyString(message.toolCallId) ? { id: nonEmptyString(message.toolCallId) } : {}),
    });
    executions.push(...nestedExecutions(message.nestedCalls));
  }
  return executions;
}

export function createToolUsageTracker(
  initialToolNames: Iterable<string> = [],
  getMcpServerNames: () => Iterable<string> = () => [],
): ToolUsageTracker {
  let exchangeCounts: MutableCounts = new Map();
  let sessionCounts: MutableCounts = new Map();
  let exchangeExecutions: RecordedExecution[] = [];
  let recordedIds = new Set<string>();
  for (const name of initialToolNames) increment(sessionCounts, name, "tool");

  const recordExecution = (counts: MutableCounts, execution: RecordedExecution, knownServers: readonly string[]): void => {
    const usage = parseUsage(execution.toolName, execution.result, knownServers);
    if (usage.topLevelName) increment(counts, usage.topLevelName, "tool", execution.scope);
    for (const server of usage.mcpServers) increment(counts, server, "mcp");
  };
  const unique = (executions: readonly RecordedExecution[]): RecordedExecution[] => {
    const seen = new Set<string>();
    return executions.filter((execution) => {
      if (!execution.id) return true;
      if (seen.has(execution.id)) return false;
      seen.add(execution.id);
      return true;
    });
  };

  return {
    startExchange(): void {
      exchangeCounts = new Map();
      exchangeExecutions = [];
    },
    resetSession(entries, mcpServerNames = getMcpServerNames(), options = {}): void {
      const knownServers = [...mcpServerNames];
      const fromBranch = unique(branchExecutions(entries));
      const branchIds = new Set(fromBranch.flatMap((execution) => execution.id ? [execution.id] : []));
      sessionCounts = new Map();
      for (const execution of fromBranch) recordExecution(sessionCounts, execution, knownServers);
      if (options.preserveExchange === true) {
        exchangeCounts = new Map();
        for (const execution of unique(exchangeExecutions)) {
          recordExecution(exchangeCounts, execution, knownServers);
          if (!execution.id || !branchIds.has(execution.id)) recordExecution(sessionCounts, execution, knownServers);
          if (execution.id) branchIds.add(execution.id);
        }
      } else {
        exchangeCounts = new Map();
        exchangeExecutions = [];
      }
      recordedIds = branchIds;
    },
    record(event): void {
      const knownServers = [...getMcpServerNames()];
      const executions: RecordedExecution[] = [{
        toolName: event.toolName,
        result: event.result,
        scope: nonEmptyString(event.parentToolCallId) ? "nested" : "direct",
        ...(nonEmptyString(event.toolCallId) ? { id: nonEmptyString(event.toolCallId) } : {}),
      }];
      // Some integrations attach nestedCalls directly to the end result.
      // The normal Pi event path emits each nested call separately; IDs
      // prevent re-counting the same call when its parent also reports it.
      if (!event.parentToolCallId) executions.push(...nestedExecutions(asRecord(event.result)?.nestedCalls));
      for (const execution of executions) {
        if (execution.id && recordedIds.has(execution.id)) continue;
        if (execution.id) recordedIds.add(execution.id);
        exchangeExecutions.push(execution);
        recordExecution(exchangeCounts, execution, knownServers);
        recordExecution(sessionCounts, execution, knownServers);
      }
    },
    getSnapshot(): ToolUsageSnapshot {
      return snapshotCounts(exchangeCounts, sessionCounts);
    },
  };
}

type UsageName = { readonly name: string; readonly kind: ToolUsageKind };

/** Reconstruct both direct results and persisted Pi nestedCalls from the active branch. */
function usageCountsFromBranch(entries: readonly unknown[], mcpServerNames: Iterable<string> = []): UsageName[] {
  const counts: UsageName[] = [];
  const knownServers = [...mcpServerNames];
  const seen = new Set<string>();
  for (const execution of branchExecutions(entries)) {
    if (execution.id && seen.has(execution.id)) continue;
    if (execution.id) seen.add(execution.id);
    const usage = parseUsage(execution.toolName, execution.result, knownServers);
    if (usage.topLevelName) counts.push({ name: usage.topLevelName, kind: "tool" });
    counts.push(...usage.mcpServers.map((name) => ({ name, kind: "mcp" as const })));
  }
  return counts;
}

export function toolNamesFromBranch(entries: readonly unknown[], mcpServerNames: Iterable<string> = []): string[] {
  return usageCountsFromBranch(entries, mcpServerNames).map((count) => count.name);
}
