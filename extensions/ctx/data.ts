import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";


const knownRoles = new Set(["user", "assistant", "toolResult", "custom", "bashExecution", "compactionSummary", "branchSummary"]);

export const CONTEXT_CATEGORIES = ["System", "Tools", "Messages", "Tool Results", "Summary", "Other"] as const;
export type ContextCategory = typeof CONTEXT_CATEGORIES[number];
export type ImagesWireEstimate = {
  readonly images: number;
  readonly source: "message" | "provider payload" | "unavailable";
};
export type ContextEstimate = {
  readonly categories: readonly { name: ContextCategory; tokens: number | undefined; percent: number | undefined }[];
  readonly total: number;
  readonly imagesWire: ImagesWireEstimate;
  readonly source: "context hook" | "active branch" | "unavailable";
};
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" ? value as RecordValue : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";

function isImageNode(value: RecordValue): boolean {
  return value.type === "image" || value.type === "image_url" || value.type === "input_image";
}

function countImages(value: unknown, source: "message" | "provider payload"): ImagesWireEstimate {
  if (value === undefined || value === null) return { images: 0, source: "unavailable" };
  let images = 0;
  const seen = new WeakSet<object>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (isImageNode(record(node))) images++;
    else for (const child of Object.values(node)) visit(child);
    seen.delete(node);
  };
  visit(value);
  return { images, source };
}

/** Local text heuristic, not a model tokenizer or provider usage measurement. */
export const estimateTextTokens = (value: string): number => Math.ceil(value.length / 4);

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const block = record(item);
    if (block.type === "text") return text(block.text);
    if (block.type === "thinking") return text(block.thinking);
    if (block.type === "toolCall") return text(block.name) + JSON.stringify(block.arguments ?? {});
    // Images, signatures and provider-specific blocks have unknown cost.
    return "";
  }).join("");
}

type ToolDefinition = Pick<ReturnType<ExtensionAPI["getAllTools"]>[number], "name" | "description" | "parameters">;

/** Estimate the active schema fallback when no provider payload has been observed. */
function estimateToolTokens(tools: readonly ToolDefinition[] | undefined): number | undefined {
  if (tools === undefined) return undefined;
  try {
    return tools.reduce((sum, { name, description, parameters }) => {
      if (typeof name !== "string" || typeof description !== "string" || !parameters) {
        throw new Error("Incomplete tool definition");
      }
      return sum + estimateTextTokens(JSON.stringify({ name, description, parameters }));
    }, 0);
  } catch {
    // Unserializable schemas are unknown, never a misleading partial total or zero.
    return undefined;
  }
}

/** Estimate the serialized tools field from the provider-specific request payload. */
export function estimateProviderToolsTokens(payload: unknown): number | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const tools = (payload as Record<string, unknown>).tools;
  if (tools === undefined) return 0;
  try {
    const serialized = JSON.stringify(tools);
    return serialized === undefined ? undefined : estimateTextTokens(serialized);
  } catch {
    return undefined;
  }
}

function activeToolDefinitions(pi: ExtensionAPI): readonly ToolDefinition[] | undefined {
  try {
    const active = [...new Set(pi.getActiveTools())];
    if (active.length === 0) return [];
    const all = new Map(pi.getAllTools().map(tool => [tool.name, tool]));
    const tools = active.map(name => all.get(name));
    if (tools.some(tool => tool === undefined)) return undefined;
    return tools as ToolDefinition[];
  } catch {
    return undefined;
  }
}

export function estimateContext(
  messages: readonly unknown[] | undefined,
  systemPrompt?: string,
  source: ContextEstimate["source"] = "unavailable",
  tools?: readonly ToolDefinition[],
  imagesWire?: ImagesWireEstimate,
): ContextEstimate {
  const counts: Record<ContextCategory, number | undefined> = {
    System: systemPrompt === undefined ? undefined : estimateTextTokens(systemPrompt),
    Tools: estimateToolTokens(tools), Messages: messages ? 0 : undefined,
    "Tool Results": messages ? 0 : undefined, Summary: messages ? 0 : undefined, Other: messages ? 0 : undefined,
  };
  for (const value of messages ?? []) {
    const message = record(value);
    if (message.role === "bashExecution" && message.excludeFromContext) continue;
    const category: ContextCategory = message.role === "toolResult" ? "Tool Results"
      : message.role === "compactionSummary" || message.role === "branchSummary" ? "Summary"
      : message.role === "user" || message.role === "assistant" ? "Messages" : "Other";
    // Let the public SDK supply summary/bash wrappers; retain the original role for attribution.
    // Unknown extension roles safely fall back to observable outer content only.
    const body = knownRoles.has(text(message.role))
      ? convertToLlm([value as Parameters<typeof convertToLlm>[0][number]])
        .map(converted => contentText(converted.content)).join("")
      : contentText(message.content);
    const tokens = estimateTextTokens(body);
    counts[category] = (counts[category] ?? 0) + tokens;
  }
  const total = Object.values(counts).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const percent = (tokens: number | undefined): number | undefined => tokens === undefined || total === 0 ? undefined : tokens / total * 100;
  return {
    total, source,
    imagesWire: imagesWire ?? countImages(messages, "message"),
    categories: CONTEXT_CATEGORIES.map(name => ({ name, tokens: counts[name], percent: percent(counts[name]) })),
  };
}

/** Only compaction-applied active entries; never reads JSONL or tool details. */
export function messagesFromContextEntries(entries: readonly unknown[]): unknown[] {
  return entries.flatMap((value): unknown[] => {
    const entry = record(value);
    if (entry.type === "message") return [entry.message];
    if (entry.type === "compaction") return [{ role: "compactionSummary", summary: entry.summary }];
    if (entry.type === "branch_summary") return [{ role: "branchSummary", summary: entry.summary }];
    if (entry.type === "custom_message") return [{ role: "custom", content: entry.content }];
    return [];
  });
}

export function installContextEstimates(pi: ExtensionAPI, onChange: () => void): {
  getSnapshot(): ContextEstimate;
  getDelta(): number | undefined;
  resetDelta(): void;
} {
  let snapshot = estimateContext(undefined);
  let settledTotal: number | undefined;
  let delta: number | undefined;
  let latestProviderImagesWire: ImagesWireEstimate | undefined;
  let latestProviderToolsTokens: number | undefined;
  const restore = (ctx: ExtensionContext, keepProviderMeasurement = false): void => {
    if (!keepProviderMeasurement) {
      latestProviderImagesWire = undefined;
      latestProviderToolsTokens = undefined;
    }
    const messages = messagesFromContextEntries(ctx.sessionManager.buildContextEntries());
    snapshot = estimateContext(messages, ctx.getSystemPrompt(), "active branch", activeToolDefinitions(pi), latestProviderImagesWire);
    if (keepProviderMeasurement && latestProviderToolsTokens !== undefined) {
      const categories = snapshot.categories.map((category) =>
        category.name === "Tools" ? { ...category, tokens: latestProviderToolsTokens } : category,
      );
      const total = categories.reduce((sum, category) => sum + (category.tokens ?? 0), 0);
      const percent = (tokens: number | undefined): number | undefined =>
        tokens === undefined || total === 0 ? undefined : tokens / total * 100;
      snapshot = {
        ...snapshot,
        total,
        categories: categories.map((category) => ({ ...category, percent: percent(category.tokens) })),
      };
    }
    onChange();
  };
  // A run is one user question, measured against the total left by the previous
  // settled run, so compaction losses surface as a negative delta.
  const measure = (ctx: ExtensionContext, settled: boolean): void => {
    restore(ctx, true);
    delta = settledTotal === undefined ? undefined : snapshot.total - settledTotal;
    if (settled) settledTotal = snapshot.total;
  };
  const resetDelta = (ctx: ExtensionContext): void => {
    restore(ctx);
    settledTotal = snapshot.total;
    delta = undefined;
  };
  pi.on("context", (event, ctx) => {
    latestProviderImagesWire = undefined;
    latestProviderToolsTokens = undefined;
    snapshot = estimateContext(event.messages, ctx.getSystemPrompt(), "context hook", activeToolDefinitions(pi));
    onChange();
  });
  pi.on("before_provider_request", (event) => {
    latestProviderImagesWire = countImages(event.payload, "provider payload");
    const tools = estimateProviderToolsTokens(event.payload);
    latestProviderToolsTokens = tools;
    const categories = snapshot.categories.map((category) =>
      category.name === "Tools" ? { ...category, tokens: tools } : category,
    );
    const total = categories.reduce((sum, category) => sum + (category.tokens ?? 0), 0);
    const percent = (tokens: number | undefined): number | undefined =>
      tokens === undefined || total === 0 ? undefined : tokens / total * 100;
    snapshot = {
      ...snapshot,
      total,
      categories: categories.map((category) => ({ ...category, percent: percent(category.tokens) })),
      imagesWire: latestProviderImagesWire,
    };
    onChange();
  });
  pi.on("session_start", (_event, ctx) => resetDelta(ctx));
  pi.on("session_tree", (_event, ctx) => resetDelta(ctx));
  pi.on("session_compact", (_event, ctx) => resetDelta(ctx));
  pi.on("agent_settled", (_event, ctx) => measure(ctx, true));
  pi.on("turn_end", (_event, ctx) => measure(ctx, false));
  pi.on("session_shutdown", () => {
    latestProviderImagesWire = undefined;
    latestProviderToolsTokens = undefined;
    snapshot = estimateContext(undefined);
    settledTotal = undefined;
    delta = undefined;
  });
  return { getSnapshot: () => snapshot, getDelta: () => delta, resetDelta: () => settledTotal = snapshot.total };
}
