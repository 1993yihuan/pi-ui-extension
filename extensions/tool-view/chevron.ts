import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";

/** Single-column terminal chevrons, colored via the active Pi theme. */
export const COLLAPSED_CHEVRON = "›";
export const EXPANDED_CHEVRON = "⌄";
const CALL_INDENT = "  ";
const RESULT_INDENT = "    ";

export function chevronPrefix(theme: Theme, expanded: boolean): string {
  return theme.fg("accent", expanded ? EXPANDED_CHEVRON : COLLAPSED_CHEVRON) + "  ";
}

/** Indent each Compact tool beneath the preceding Thinking without grouping messages. */
export function compactCallPrefix(theme: Theme, expanded: boolean): string {
  return CALL_INDENT + chevronPrefix(theme, expanded);
}

/**
 * Claude-style result branch, drawn inside a single result component.
 * On narrow terminals the branch is omitted to preserve the status and data.
 */
export function withCompactResultBranch(result: Component, theme: Theme): Component {
  const prefix = RESULT_INDENT + theme.fg("dim", "⎿") + "  ";
  const prefixWidth = visibleWidth(prefix);
  return {
    render(width: number) {
      if (width <= 0) return [];
      const showBranch = width >= prefixWidth + 8;
      const rows = result.render(width - (showBranch ? prefixWidth : 0));
      return showBranch ? rows.map((row) => prefix + row) : rows;
    },
    invalidate() { result.invalidate(); },
  };
}

/**
 * Only used when a built-in tool is expanded and Pi's native renderer is
 * already active. Decorate its header without replacing the native component,
 * its content, or its mouse routing. Never applied to Normal/Hidden/third party.
 */
export function withNativeChevron(native: Component, theme: Theme, expanded: boolean): Component {
  const prefix = compactCallPrefix(theme, expanded);
  const indent = visibleWidth(prefix);
  return {
    render(width: number) {
      if (width <= 0) return [];
      if (width <= indent) return native.render(width);
      const innerWidth = width - indent;
      return native.render(innerWidth).map((line, index) =>
        (index === 0 ? prefix : " ".repeat(indent)) +
          truncateToWidth(line, innerWidth, ""),
      );
    },
    invalidate() { native.invalidate(); },
    handleMouse(event: TuiMouseEvent) {
      if (event.x < indent || event.width <= indent) return undefined;
      const handler = (native as Component & {
        handleMouse?: (event: TuiMouseEvent) => unknown;
      }).handleMouse;
      if (typeof handler !== "function") return undefined;
      return handler.call(native, { ...event, x: event.x - indent, width: event.width - indent }) as
        { handled?: boolean } | undefined;
    },
  };
}
