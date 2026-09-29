import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
  type TuiInputListener,
} from "@earendil-works/pi-tui";
import { panelBottom, panelContent, panelTop } from "../sidebar/panel.ts";
import { installPriorityInputListener, parseSgrMouseEvent } from "../sidebar/resize.ts";
import { TOOL_VIEW_MODES, type ToolViewMode } from "./types.ts";
import type { ToolUsageCount, ToolUsageKind, ToolUsageSnapshot } from "./usage.ts";

export type ToolViewPanelOptions = {
  readonly tui: TUI;
  readonly getDesiredWidth: () => number;
  readonly getMode: () => ToolViewMode | undefined;
  readonly getUsage: () => ToolUsageSnapshot | undefined;
  readonly onSelect: (mode: ToolViewMode) => void;
  readonly showModeSelector?: () => boolean;
  readonly showBottomBorder?: boolean;
};

type LayoutRect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
type LayoutBox = {
  readonly component: Component;
  readonly rect: LayoutRect;
  readonly clip: LayoutRect;
  readonly children: readonly LayoutBox[];
};
type LayoutTui = TUI & { readonly currentLayout?: { readonly root: LayoutBox } };

function contains(rect: LayoutRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function findLayoutBox(box: LayoutBox, component: Component): LayoutBox | undefined {
  if (box.component === component) return box;
  for (const child of box.children) {
    const match = findLayoutBox(child, component);
    if (match) return match;
  }
  return undefined;
}

function modeLabel(mode: ToolViewMode): string {
  switch (mode) {
    case "normal": return "Normal";
    case "compact": return "Compact";
    case "hidden": return "Hidden";
  }
}

function centerText(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "");
  const padding = Math.max(0, width - visibleWidth(clipped));
  const left = Math.floor(padding / 2);
  return `${" ".repeat(left)}${clipped}${" ".repeat(padding - left)}`;
}

function usageText(name: string, exchange: number, session: number, width: number): string {
  const value = `${exchange}/${session}`;
  const nameWidth = Math.max(0, width - visibleWidth(value) - 1);
  if (nameWidth === 0) return truncateToWidth(value, width, "");
  const clippedName = truncateToWidth(name, nameWidth, "…");
  const gap = " ".repeat(Math.max(1, width - visibleWidth(clippedName) - visibleWidth(value)));
  return `${clippedName}${gap}${value}`;
}

export function groupUsageCounts(counts: readonly ToolUsageCount[]): Readonly<Record<ToolUsageKind, readonly ToolUsageCount[]>> {
  return Object.freeze({
    tool: Object.freeze(counts.filter((count) => count.kind === "tool")),
    mcp: Object.freeze(counts.filter((count) => count.kind === "mcp")),
  });
}

/** Clickable single-row selector for tool transcript rendering mode. */
export class ToolViewPanel implements Component {
  private pressedMode: ToolViewMode | undefined;
  private disposed = false;
  private readonly uninstallInput: () => void;

  constructor(
    private readonly theme: Theme,
    private readonly options: ToolViewPanelOptions,
  ) {
    const listener: TuiInputListener = (data) => this.handleMouseInput(data);
    this.uninstallInput = installPriorityInputListener(options.tui, listener);
  }

  private getLayoutBox(): LayoutBox | undefined {
    const root = (this.options.tui as LayoutTui).currentLayout?.root;
    return root ? findLayoutBox(root, this) : undefined;
  }

  private modeAt(x: number, y: number): ToolViewMode | undefined {
    if (this.options.showModeSelector?.() === false) return undefined;
    const box = this.getLayoutBox();
    if (!box || !contains(box.clip, x, y) || !contains(box.rect, x, y)) return undefined;
    if (y - box.rect.y !== 1) return undefined;

    const contentWidth = Math.max(1, Math.min(box.rect.width, this.options.getDesiredWidth()) - 4);
    const contentColumn = x - box.rect.x - 2;
    if (contentColumn < 0 || contentColumn >= contentWidth) return undefined;

    const index = Math.min(
      TOOL_VIEW_MODES.length - 1,
      Math.floor(contentColumn * TOOL_VIEW_MODES.length / contentWidth),
    );
    return TOOL_VIEW_MODES[index];
  }

  private isInsidePanel(x: number, y: number): boolean {
    const box = this.getLayoutBox();
    return Boolean(box && contains(box.clip, x, y) && contains(box.rect, x, y));
  }

  private handleMouseInput(data: string): { consume: true } | undefined {
    const mouse = parseSgrMouseEvent(data);
    // Let the enclosing ScrollView receive wheel events before any click handling.
    if (!mouse || (mouse.button & 64) !== 0) return undefined;

    const x = mouse.x - 1;
    const y = mouse.y - 1;
    const inside = this.isInsidePanel(x, y);
    const isLeft = (mouse.button & 3) === 0;

    if (mouse.release) {
      const pressed = this.pressedMode;
      if (!pressed) return undefined;
      this.pressedMode = undefined;
      const released = this.modeAt(x, y);
      if (released === pressed) {
        queueMicrotask(() => {
          const currentMode = this.options.getMode();
          if (!this.disposed && currentMode !== undefined && currentMode !== released) {
            this.options.onSelect(released);
          }
        });
      }
      this.options.tui.requestRender();
      return { consume: true };
    }

    if (mouse.motion) {
      if (!this.pressedMode) return undefined;
      if (this.modeAt(x, y) !== this.pressedMode) {
        this.pressedMode = undefined;
        this.options.tui.requestRender();
      }
      return { consume: true };
    }

    if (!inside) return undefined;
    if (!isLeft) return undefined;

    if (this.options.getMode() === undefined) return { consume: true };
    this.pressedMode = this.modeAt(x, y);
    if (this.pressedMode) this.options.tui.requestRender();
    return this.pressedMode ? { consume: true } : undefined;
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, Math.min(width, this.options.getDesiredWidth()));
    const contentWidth = Math.max(1, renderWidth - 4);
    const showModeSelector = this.options.showModeSelector?.() !== false;
    const currentMode = this.options.getMode();
    const connected = currentMode !== undefined;
    const baseWidth = Math.floor(contentWidth / TOOL_VIEW_MODES.length);
    const remainder = contentWidth % TOOL_VIEW_MODES.length;
    const body = TOOL_VIEW_MODES.map((mode, index) => {
      const selected = mode === currentMode;
      const pressed = mode === this.pressedMode;
      const marker = !connected ? "·" : selected ? "●" : "○";
      const segmentWidth = baseWidth + (index < remainder ? 1 : 0);
      const text = centerText(`${marker} ${modeLabel(mode)}`, segmentWidth);
      return pressed
        ? this.theme.fg("warning", text)
        : selected
          ? this.theme.fg("success", text)
          : this.theme.fg("dim", text);
    }).join("");
    const selectorBody = showModeSelector
      ? body
      : this.theme.fg("dim", centerText("View controlled by Fabric", contentWidth));
    const usage = this.options.getUsage();
    const grouped = groupUsageCounts(usage?.counts ?? []);
    const usageRows: string[] = [];
    const appendGroup = (label: "TOOLS" | "MCP", counts: readonly ToolUsageCount[]): void => {
      if (counts.length === 0) return;
      usageRows.push(panelContent(this.theme, label, "accent", contentWidth));
      for (const count of counts) {
        usageRows.push(panelContent(
          this.theme,
          usageText(count.name, count.exchange, count.session, contentWidth),
          count.exchange > 0 ? "accent" : "dim",
          contentWidth,
        ));
      }
    };
    appendGroup("TOOLS", grouped.tool);
    appendGroup("MCP", grouped.mcp);

    const lines = [
      panelTop(this.theme, "TOOL VIEW", renderWidth),
      panelContent(this.theme, selectorBody, "dim", contentWidth),
      ...usageRows,
    ];
    if (this.options.showBottomBorder !== false) lines.push(panelBottom(this.theme, renderWidth));
    return lines.map((line) => truncateToWidth(line, renderWidth, ""));
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pressedMode = undefined;
    this.uninstallInput();
  }
}
