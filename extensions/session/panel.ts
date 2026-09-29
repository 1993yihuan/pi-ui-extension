import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
  type TuiInputListener,
} from "@earendil-works/pi-tui";
import { panelBottom, panelContent } from "../sidebar/panel.ts";
import { installPriorityInputListener, parseSgrMouseEvent } from "../sidebar/resize.ts";

const MAX_VISIBLE_SESSIONS = 5;
const SESSION_ACTION_WIDTH = 4;
const SESSION_TITLE_CELLS = " SESSIONS ↻ ".length;
const CLEAR_OTHERS_CELL = " ⊗ ";

export type SessionListItem = {
  readonly id: string;
  readonly title: string;
  readonly modified: Date;
  readonly messageCount: number;
  readonly current: boolean;
};

export type ResourceButtonId = "agents" | "skills" | "extensions" | "mcp";

export type SessionPanelOptions = {
  readonly tui: TUI;
  readonly getDesiredWidth: () => number;
  readonly loadSessions: () => Promise<readonly SessionListItem[]>;
  readonly onSelect: (session: SessionListItem) => void;
  readonly onRename: (session: SessionListItem) => void;
  readonly onDelete: (session: SessionListItem) => void;
  readonly onDeleteOthers: () => void;
  readonly onOpenResources: (button: ResourceButtonId) => void;
  readonly now?: () => number;
};

const RESOURCE_BUTTONS: ReadonlyArray<{ id: ResourceButtonId; label: string }> = [
  { id: "agents", label: "AGENTS.md" },
  { id: "skills", label: "Skills" },
  { id: "extensions", label: "Extensions" },
  { id: "mcp", label: "MCP" },
];

type SessionRowAction = "select" | "rename" | "delete";
type SessionActionTarget = {
  readonly session: SessionListItem;
  readonly action: SessionRowAction;
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

function normalizeTitle(title: string): string {
  const plainText = stripTerminalSequences(title).replace(/[\u0000-\u001f\u007f]/g, " ");
  return plainText.replace(/\s+/g, " ").trim() || "(untitled session)";
}

function formatRelativeTime(modified: Date, now: number): string {
  const elapsedMs = Math.max(0, now - modified.getTime());
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d` : `${Math.floor(days / 30)}mo`;
}

function padToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/**
 * Content-column span of the clear-others button on the title row, or undefined
 * when the panel is too narrow to render it.
 */
function clearOthersSpan(renderWidth: number): { readonly start: number; readonly end: number } | undefined {
  const innerWidth = Math.max(1, renderWidth - 2);
  if (innerWidth < SESSION_TITLE_CELLS + CLEAR_OTHERS_CELL.length + 2) return undefined;
  const glyphStart = innerWidth - CLEAR_OTHERS_CELL.length - 1;
  return { start: glyphStart - 1, end: glyphStart + CLEAR_OTHERS_CELL.length - 2 };
}

/** Title row with a right-aligned ⊗ button that trashes every other session. */
function renderSessionTitleRow(theme: Theme, title: string, renderWidth: number, clearPressed: boolean): string {
  const innerWidth = Math.max(1, renderWidth - 2);
  const span = clearOthersSpan(renderWidth);
  const reserved = span ? CLEAR_OTHERS_CELL.length + 1 : 0;
  const borderWidth = Math.max(0, innerWidth - SESSION_TITLE_CELLS - reserved);
  const left = Math.floor(borderWidth / 2);
  const right = borderWidth - left;
  const border = theme.fg("accent", `╭${"─".repeat(left)} ${title} ${"─".repeat(right)}`);
  if (!span) return `${border}${theme.fg("accent", "╮")}`;
  return border +
    theme.fg(clearPressed ? "warning" : "accent", CLEAR_OTHERS_CELL) +
    theme.fg("accent", "─╮");
}

function formatSessionSummary(session: SessionListItem, width: number, now: number): string {
  const marker = session.current ? "● " : "○ ";
  const metadata = `${session.messageCount} · ${formatRelativeTime(session.modified, now)}`;
  const fixedWidth = visibleWidth(marker) + visibleWidth(metadata) + 1;
  if (fixedWidth >= width) {
    return truncateToWidth(`${marker}${normalizeTitle(session.title)}`, width, "");
  }

  const titleWidth = width - fixedWidth;
  const title = truncateToWidth(normalizeTitle(session.title), titleWidth, "…");
  return `${marker}${padToWidth(title, titleWidth)} ${metadata}`;
}

function formatSessionRow(session: SessionListItem, contentWidth: number, now: number): string {
  if (contentWidth <= SESSION_ACTION_WIDTH) {
    return formatSessionSummary(session, contentWidth, now);
  }
  const summaryWidth = contentWidth - SESSION_ACTION_WIDTH;
  const summary = padToWidth(formatSessionSummary(session, summaryWidth, now), summaryWidth);
  return `${summary} ✎ ${session.current ? "·" : "×"}`;
}

function sameTarget(left: SessionActionTarget | undefined, right: SessionActionTarget | undefined): boolean {
  return Boolean(left && right && left.session.id === right.session.id && left.action === right.action);
}

/** Recent-session panel: click the title to refresh, a row to switch, ✎ to rename, × to delete, or ⊗ to trash every other session. */
export class SessionPanel implements Component {
  private pressedResource: ResourceButtonId | undefined;
  private clearPressed = false;

  private sessions: readonly SessionListItem[] = [];
  private loading = true;
  private disposed = false;
  private loadInFlight = false;
  private refreshPending = false;
  private refreshPressed = false;
  private pressedTarget: SessionActionTarget | undefined;
  private readonly uninstallInput: () => void;

  constructor(
    private readonly theme: Theme,
    private readonly options: SessionPanelOptions,
  ) {
    const listener: TuiInputListener = (data) => this.handleMouseInput(data);
    this.uninstallInput = installPriorityInputListener(options.tui, listener);
  }

  private getLayoutBox(): LayoutBox | undefined {
    const root = (this.options.tui as LayoutTui).currentLayout?.root;
    return root ? findLayoutBox(root, this) : undefined;
  }

  private sessionAt(box: LayoutBox, x: number, y: number): SessionListItem | undefined {
    if (!contains(box.clip, x, y) || !contains(box.rect, x, y)) return undefined;
    const row = y - box.rect.y - 1;
    return row >= 0 && row < this.sessions.length ? this.sessions[row] : undefined;
  }

  /** Buttons row sits after the session list: title(1) + up to 5 rows + spacing. */
  private resourceButtonAt(box: LayoutBox, x: number, y: number): ResourceButtonId | undefined {
    // Render rows: title(1) + sessions/listing (1..5 rows) + buttons(1). The
    // button row is the last content row, i.e. rect.height - 2.
    if (y - box.rect.y !== Math.max(2, box.rect.height - 2)) return undefined;
    const renderWidth = Math.max(1, Math.min(box.rect.width, this.options.getDesiredWidth()));
    const contentWidth = Math.max(1, renderWidth - 4);
    const contentColumn = x - box.rect.x - 2;
    if (contentColumn < 0 || contentColumn >= contentWidth) return undefined;
    const index = Math.min(
      RESOURCE_BUTTONS.length - 1,
      Math.floor(contentColumn * RESOURCE_BUTTONS.length / contentWidth),
    );
    return RESOURCE_BUTTONS[index]!.id;
  }

  private targetAt(x: number, y: number): SessionActionTarget | undefined {
    const box = this.getLayoutBox();
    if (!box) return undefined;
    const session = this.sessionAt(box, x, y);
    if (!session) return undefined;

    const renderWidth = Math.max(1, Math.min(box.rect.width, this.options.getDesiredWidth()));
    const contentWidth = Math.max(1, renderWidth - 4);
    const contentColumn = x - box.rect.x - 2;
    if (contentColumn < 0 || contentColumn >= contentWidth) return undefined;
    if (contentWidth <= SESSION_ACTION_WIDTH || contentColumn < contentWidth - SESSION_ACTION_WIDTH) {
      return { session, action: "select" };
    }
    if (contentColumn < contentWidth - 2) return { session, action: "rename" };
    return session.current ? undefined : { session, action: "delete" };
  }

  private isInsidePanel(x: number, y: number): boolean {
    const box = this.getLayoutBox();
    return Boolean(box && contains(box.clip, x, y) && contains(box.rect, x, y));
  }

  private isRefreshTarget(x: number, y: number): boolean {
    const box = this.getLayoutBox();
    return Boolean(
      box &&
      contains(box.clip, x, y) &&
      contains(box.rect, x, y) &&
      y === box.rect.y &&
      !this.isClearOthersTarget(x, y),
    );
  }

  private isClearOthersTarget(x: number, y: number): boolean {
    const box = this.getLayoutBox();
    if (!box || !contains(box.clip, x, y) || !contains(box.rect, x, y)) return false;
    if (y !== box.rect.y) return false;
    const renderWidth = Math.max(1, Math.min(box.rect.width, this.options.getDesiredWidth()));
    const span = clearOthersSpan(renderWidth);
    if (!span) return false;
    const contentColumn = x - box.rect.x - 2;
    return contentColumn >= span.start && contentColumn <= span.end;
  }

  private invoke(target: SessionActionTarget): void {
    switch (target.action) {
      case "select":
        if (!target.session.current) this.options.onSelect(target.session);
        return;
      case "rename":
        this.options.onRename(target.session);
        return;
      case "delete":
        this.options.onDelete(target.session);
    }
  }

  private handleMouseInput(data: string): { consume: true } | undefined {
    const mouse = parseSgrMouseEvent(data);
    if (!mouse) return undefined;

    // SGR coordinates are one-based; Pi's layout frame uses zero-based coordinates.
    const x = mouse.x - 1;
    const y = mouse.y - 1;
    const inside = this.isInsidePanel(x, y);
    const isWheel = (mouse.button & 64) !== 0;
    const isLeft = (mouse.button & 3) === 0;

    if (mouse.release) {
      if (this.pressedResource) {
        const pressed = this.pressedResource;
        this.pressedResource = undefined;
        const box = this.getLayoutBox();
        const released = box ? this.resourceButtonAt(box, x, y) : undefined;
        if (released === pressed) {
          queueMicrotask(() => {
            if (!this.disposed) this.options.onOpenResources(pressed);
          });
        }
        this.options.tui.requestRender();
        return { consume: true };
      }
      if (this.clearPressed) {
        this.clearPressed = false;
        if (this.isClearOthersTarget(x, y)) {
          queueMicrotask(() => {
            if (!this.disposed) this.options.onDeleteOthers();
          });
        }
        this.options.tui.requestRender();
        return { consume: true };
      }
      if (this.refreshPressed) {
        this.refreshPressed = false;
        if (this.isRefreshTarget(x, y)) {
          queueMicrotask(() => {
            if (!this.disposed) this.refresh();
          });
        }
        this.options.tui.requestRender();
        return { consume: true };
      }

      const pressed = this.pressedTarget;
      if (!pressed) return undefined;
      this.pressedTarget = undefined;
      const released = this.targetAt(x, y);
      if (sameTarget(pressed, released) && released) {
        queueMicrotask(() => {
          if (!this.disposed) this.invoke(released);
        });
      }
      this.options.tui.requestRender();
      return { consume: true };
    }

    if (mouse.motion) {
      if (this.refreshPressed) {
        if (!this.isRefreshTarget(x, y)) {
          this.refreshPressed = false;
          this.options.tui.requestRender();
        }
        return { consume: true };
      }
      if (this.clearPressed) {
        if (!this.isClearOthersTarget(x, y)) {
          this.clearPressed = false;
          this.options.tui.requestRender();
        }
        return { consume: true };
      }
      if (this.pressedResource) {
        const box = this.getLayoutBox();
        if (!box || this.resourceButtonAt(box, x, y) !== this.pressedResource) {
          this.pressedResource = undefined;
          this.options.tui.requestRender();
        }
        return { consume: true };
      }
      if (!this.pressedTarget) return undefined;
      if (!sameTarget(this.pressedTarget, this.targetAt(x, y))) {
        this.pressedTarget = undefined;
        this.options.tui.requestRender();
      }
      return { consume: true };
    }

    if (!inside) return undefined;
    // Do not let wheel events over the fixed session panel scroll the main transcript.
    if (isWheel) return { consume: true };
    if (!isLeft) return undefined;

    if (this.isClearOthersTarget(x, y)) {
      this.clearPressed = true;
      this.options.tui.requestRender();
      return { consume: true };
    }

    if (this.isRefreshTarget(x, y)) {
      this.refreshPressed = true;
      this.options.tui.requestRender();
      return { consume: true };
    }

    const box = this.getLayoutBox();
    const resourceButton = box ? this.resourceButtonAt(box, x, y) : undefined;
    if (resourceButton) {
      this.pressedResource = resourceButton;
      this.options.tui.requestRender();
      return { consume: true };
    }

    this.pressedTarget = this.targetAt(x, y);
    if (this.pressedTarget) this.options.tui.requestRender();
    return this.pressedTarget ? { consume: true } : undefined;
  }

  refresh(): void {
    if (this.disposed) return;
    if (this.loadInFlight) {
      this.refreshPending = true;
      return;
    }

    this.loadInFlight = true;
    if (this.sessions.length === 0) this.loading = true;
    this.options.tui.requestRender();
    void this.options.loadSessions()
      .then((sessions) => {
        if (this.disposed) return;
        this.sessions = sessions.slice(0, MAX_VISIBLE_SESSIONS);
        this.loading = false;
      })
      .catch(() => {
        if (this.disposed) return;
        this.sessions = [];
        this.loading = false;
      })
      .finally(() => {
        this.loadInFlight = false;
        if (this.disposed) return;
        this.options.tui.requestRender();
        if (this.refreshPending) {
          this.refreshPending = false;
          this.refresh();
        }
      });
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, Math.min(width, this.options.getDesiredWidth()));
    const contentWidth = Math.max(1, renderWidth - 4);
    const now = this.options.now?.() ?? Date.now();
    const body = this.sessions.length > 0
      ? this.sessions.map((session) => panelContent(
          this.theme,
          formatSessionRow(session, contentWidth, now),
          this.pressedTarget?.session.id === session.id
            ? "warning"
            : session.current
              ? "accent"
              : "dim",
          contentWidth,
        ))
      : [panelContent(
          this.theme,
          this.loading ? "Loading sessions…" : "No saved sessions",
          "dim",
          contentWidth,
        )];

    const contentWidthButtons = Math.max(1, renderWidth - 4);
    const baseWidth = Math.floor(contentWidthButtons / RESOURCE_BUTTONS.length);
    const remainder = contentWidthButtons % RESOURCE_BUTTONS.length;
    const buttonRow = RESOURCE_BUTTONS.map((button, index) => {
      const segmentWidth = baseWidth + (index < remainder ? 1 : 0);
      const clipped = truncateToWidth(button.label, Math.max(0, segmentWidth), "");
      const padding = Math.max(0, segmentWidth - visibleWidth(clipped));
      const text = " ".repeat(Math.floor(padding / 2)) + clipped + " ".repeat(padding - Math.floor(padding / 2));
      return this.pressedResource === button.id
        ? this.theme.fg("warning", text)
        : this.theme.fg("accent", text);
    }).join("");
    const resourceRow = panelContent(this.theme, buttonRow, "accent", contentWidthButtons);

    const divider = this.theme.fg("dim", `├${"─".repeat(Math.max(1, renderWidth - 2))}┤`);
    return [
      renderSessionTitleRow(this.theme, this.loading || this.loadInFlight ? "SESSIONS …" : "SESSIONS ↻", renderWidth, this.clearPressed),
      ...body,
      divider,
      resourceRow,
      panelBottom(this.theme, renderWidth),
    ].map((line) => truncateToWidth(line, renderWidth, ""));
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.refreshPressed = false;
    this.clearPressed = false;
    this.pressedResource = undefined;
    this.pressedTarget = undefined;
    this.uninstallInput();
  }
}
