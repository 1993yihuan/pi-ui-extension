import type { Theme } from "@earendil-works/pi-coding-agent";
import { ScrollView, type Component } from "@earendil-works/pi-tui";

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const RESET_STYLE = "\x1b[0m";

class ViewportPadding implements Component {
  constructor(
    private readonly component: Component,
    private readonly getViewportHeight: () => number,
  ) {}

  render(width: number): string[] {
    const contentHeight = this.component.render(width).length;
    const viewportHeight = Math.max(0, Math.floor(this.getViewportHeight()));
    const paddingHeight = Math.max(0, viewportHeight - contentHeight);
    const blankLine = `${RESET_STYLE}${" ".repeat(Math.max(1, width))}`;
    return Array.from({ length: paddingHeight }, () => blankLine);
  }

  invalidate(): void {}
}

class ViewportHeightContent implements Component {
  private readonly padding: ViewportPadding;

  constructor(
    private readonly component: Component,
    private readonly getViewportHeight: () => number,
  ) {
    this.padding = new ViewportPadding(component, getViewportHeight);
  }

  render(width: number): string[] {
    const lines = this.component.render(width);
    const viewportHeight = Math.max(0, Math.floor(this.getViewportHeight()));
    if (lines.length >= viewportHeight) return lines;

    const blankLine = `${RESET_STYLE}${" ".repeat(Math.max(1, width))}`;
    return [
      ...lines,
      ...Array.from({ length: viewportHeight - lines.length }, () => blankLine),
    ];
  }

  invalidate(): void {
    this.component.invalidate();
  }

  [LAYOUT_NODE]() {
    return {
      type: "vstack",
      entries: [
        { component: this.component },
        { component: this.padding },
      ],
      gap: 0,
      align: "stretch",
    };
  }
}

export function createSidebarScrollView(
  component: Component,
  theme: Theme,
  getViewportHeight: () => number = () => 0,
): ScrollView {
  return new ScrollView(new ViewportHeightContent(component, getViewportHeight), {
    follow: "none",
    overscroll: "contain",
    scrollbar: "auto",
    scrollbarTrackStyle: (text: string) => theme.fg("accent", text),
    scrollbarThumbStyle: (text: string) => theme.fg("accent", text),
  });
}
