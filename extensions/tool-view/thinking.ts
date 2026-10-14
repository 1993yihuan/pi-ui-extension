import type { MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ToolViewMode } from "./types.ts";

const COMPACT_LINES = 7;
export interface ThinkingDuration {
  ms: number;
  approximate: boolean;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0.1, Math.round(ms / 100) / 10).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function summaryHeader(streaming: boolean, width: number, duration?: ThinkingDuration): string {
  const status = `Thinking · ${streaming ? "Live" : "Done"}`;
  const elapsed = duration && Number.isFinite(duration.ms) && duration.ms >= 0
    ? ` · ${duration.approximate ? "~" : ""}${formatElapsed(duration.ms)}`
    : "";
  return visibleWidth(status + elapsed) <= width ? status + elapsed
    : truncateToWidth(status, Math.max(1, width), "");
}

/**
 * Render-only. Timing comes from Pi's thinking_start/end stream events, not
 * the durationMs field of an entire model response.
 */
export function transformThinkingText(
  markdown: string,
  context: MarkdownTransformContext,
  mode: ToolViewMode,
  getDuration?: (markdown: string, streaming: boolean) => ThinkingDuration | undefined,
): string {
  if (context.messageType !== "assistant-thinking" || mode === "normal") return markdown;
  const width = Math.max(1, context.availableWidth);
  const header = summaryHeader(context.isStreaming, width, getDuration?.(markdown, context.isStreaming));
  if (mode === "hidden" || !context.isStreaming) return header;
  // Streaming can produce a single very long paragraph. Process only its
  // recent suffix instead of repeatedly wrapping the entire growing response.
  // Keep a bounded suffix large enough to cover at least seven wrapped rows.
  const limit = Math.max(64, width * (COMPACT_LINES + 5));
  const suffix = markdown.length > limit ? markdown.slice(-limit) : markdown;
  const rows = suffix.replace(/\r\n?/g, "\n").split("\n")
    .flatMap((line) => wrapTextWithAnsi(line, width));
  const tail = rows.slice(-COMPACT_LINES).filter((line) => line.trim());
  const summary = tail.length === 0 ? "" : markdown.length <= limit && rows.length <= COMPACT_LINES
    ? tail.join("\n")
    : [`… ${truncateToWidth(tail[0]!, Math.max(0, width - 2), "")}`, ...tail.slice(1)].join("\n");
  return summary ? `${header}\n${summary}` : header;
}
