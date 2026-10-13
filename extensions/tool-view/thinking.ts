import type { MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ToolViewMode } from "./types.ts";

const COMPACT_LINES = 3;

/**
 * Render-only: the original thinking text in Pi's message/session is unchanged.
 * Pi invokes the transformer only for assistant-thinking Markdown blocks.
 */
export function transformThinkingText(
  markdown: string,
  context: MarkdownTransformContext,
  mode: ToolViewMode,
): string {
  if (context.messageType !== "assistant-thinking" || mode === "normal") return markdown;
  if (mode === "hidden") return "Thinking · Hidden";
  if (!context.isStreaming) return "Thinking · Done";

  const width = Math.max(1, context.availableWidth);
  // Streaming can produce a single very long paragraph. Process only its
  // recent suffix instead of repeatedly wrapping the entire growing response.
  // Eight terminal widths give ample room for the latest three visual rows.
  const limit = Math.max(64, width * 8);
  const suffix = markdown.length > limit ? markdown.slice(-limit) : markdown;
  const rows = suffix.replace(/\r\n?/g, "\n").split("\n")
    .flatMap((line) => wrapTextWithAnsi(line, width));
  const tail = rows.slice(-COMPACT_LINES).filter((line) => line.trim());
  if (tail.length === 0) return "Thinking…";
  if (markdown.length <= limit && rows.length <= COMPACT_LINES) return tail.join("\n");
  // Keep the entire summary at three terminal rows, including the ellipsis.
  return [`… ${truncateToWidth(tail[0]!, Math.max(0, width - 2), "")}`, ...tail.slice(1)].join("\n");
}
