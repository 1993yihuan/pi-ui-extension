import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

export type SidebarPanelLayoutContext = {
  readonly terminalRows: number;
  readonly terminalColumns: number;
};

export type SidebarPanelLayout = {
  readonly basis?: number | "auto";
  readonly grow?: number;
  readonly shrink?: number;
  readonly minSize?: number;
  readonly maxSize?: number | ((context: SidebarPanelLayoutContext) => number);
};

export type SidebarPanelContext = {
  readonly tui: TUI;
  readonly theme: Theme;
  readonly getDesiredWidth: () => number;
};

export type SidebarPanelInstance<State = unknown> = {
  readonly component: Component;
  update?(state: State): void;
  refresh?(): void;
  dispose?(): void;
};

export type SidebarPanelDefinition<State = unknown> = {
  readonly id: string;
  readonly layout?: SidebarPanelLayout;
  create(context: SidebarPanelContext): SidebarPanelInstance<State>;
};

