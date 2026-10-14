import type { MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ToolViewMode } from "./types.ts";

const COMPACT_LINES = 3;
const DIM_START = "\x1b[2m";
const DIM_END = "\x1b[22m";

/** Keep the action on one terminal row, degrading from a label to a glyph. */
export function thinkingActionHeader(isStreaming: boolean, expanded: boolean, width: number): string {
  const title = `Thinking · ${isStreaming ? "Live" : "Done"}`;
  const action = expanded ? "▾ Collapse" : "▸ Expand";
  const glyph = expanded ? "▾" : "▸";
  const space = width >= visibleWidth(title) + visibleWidth(action) + 3 ? "   " : " ";
  if (width >= visibleWidth(title) + visibleWidth(action) + space.length) {
    return `${title}${space}${DIM_START}${action}${DIM_END}`;
  }
  if (width >= visibleWidth(title) + 2) {
    return `${title} ${DIM_START}${glyph}${DIM_END}`;
  }
  return truncateToWidth(title, Math.max(1, width), "");
}

/**
 * Render-only: the original thinking text in Pi's message/session is unchanged.
 * Pi invokes the transformer only for assistant-thinking Markdown blocks.
 */
export function transformThinkingText(
  markdown: string,
  context: MarkdownTransformContext,
  mode: ToolViewMode,
  clickable = false,
): string {
  if (context.messageType !== "assistant-thinking" || mode === "normal") return markdown;
  if (mode === "hidden") return "Thinking · Hidden";
  if (!context.isStreaming) {
    return clickable ? thinkingActionHeader(false, false, Math.max(1, context.availableWidth)) : "Thinking · Done";
  }

  const width = Math.max(1, context.availableWidth);
  // Streaming can produce a single very long paragraph. Process only its
  // recent suffix instead of repeatedly wrapping the entire growing response.
  // Eight terminal widths give ample room for the latest three visual rows.
  const limit = Math.max(64, width * 8);
  const suffix = markdown.length > limit ? markdown.slice(-limit) : markdown;
  const rows = suffix.replace(/\r\n?/g, "\n").split("\n")
    .flatMap((line) => wrapTextWithAnsi(line, width));
  const tail = rows.slice(-COMPACT_LINES).filter((line) => line.trim());
  const summary = tail.length === 0 ? "" : markdown.length <= limit && rows.length <= COMPACT_LINES
    ? tail.join("\n")
    : [`… ${truncateToWidth(tail[0]!, Math.max(0, width - 2), "")}`, ...tail.slice(1)].join("\n");
  if (!clickable) return summary || "Thinking…";
  const heading = thinkingActionHeader(true, false, width);
  return summary ? `${heading}\n${summary}` : heading;
}
