import type {
  Component,
  OverlayHandle,
  OverlayOptions,
  TUI,
  TuiInputListener,
} from "@earendil-works/pi-tui";

const SGR_MOUSE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;
const PREVIEW_FRAME_INTERVAL_MS = 16;

export type SgrMouseEvent = {
  readonly button: number;
  readonly x: number;
  readonly y: number;
  readonly release: boolean;
  readonly motion: boolean;
};

export function parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
  const match = data.match(SGR_MOUSE);
  if (!match) return undefined;
  const button = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (![button, x, y].every(Number.isFinite) || x < 1 || y < 1) return undefined;
  return { button, x, y, release: match[4] === "m", motion: (button & 32) !== 0 };
}

export class SidebarDivider implements Component {
  constructor(
    private readonly paint: (line: string) => string,
    private readonly getHeight: () => number,
  ) {}
  render(): string[] { return Array.from({ length: Math.max(1, this.getHeight()) }, () => this.paint("│")); }
  invalidate(): void {}
}

/** Install ahead of Pi's built-in fullscreen mouse handler so sidebar gestures can consume events first. */
export function installPriorityInputListener(tui: TUI, listener: TuiInputListener): () => void {
  const unsubscribe = tui.addInputListener(listener);
  const listeners = (tui as unknown as { inputListeners?: Set<TuiInputListener> }).inputListeners;
  if (listeners instanceof Set && listeners.delete(listener)) {
    const existing = [...listeners];
    listeners.clear();
    listeners.add(listener);
    for (const item of existing) listeners.add(item);
  }
  return unsubscribe;
}

export type MouseResizeOptions = {
  readonly tui: TUI;
  readonly preview: Component;
  readonly isVisible: () => boolean;
  readonly getDividerX: () => number;
  readonly clampSidebarWidth: (width: number) => number;
  readonly commitSidebarWidth: (width: number) => void;
};

export function installMouseResize(options: MouseResizeOptions): () => void {
  let dragging = false;
  let dragColumns = 0;
  let dragRows = 0;
  let geometryTimer: ReturnType<typeof setInterval> | undefined;
  let previewHandle: OverlayHandle | undefined;
  let pendingX: number | undefined;
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  let lastFrameAt = 0;
  let disposed = false;
  const previewOptions: OverlayOptions = {
    width: 1,
    maxHeight: "100%",
    row: 0,
    col: Math.max(0, options.getDividerX() - 1),
    nonCapturing: true,
  };

  const clearFrameTimer = (): void => {
    if (frameTimer) clearTimeout(frameTimer);
    frameTimer = undefined;
  };
  const hidePreview = (): void => {
    previewHandle?.hide();
    previewHandle = undefined;
  };
  const cancelDrag = (): void => {
    dragging = false;
    pendingX = undefined;
    clearFrameTimer();
    if (geometryTimer) clearInterval(geometryTimer);
    geometryTimer = undefined;
    hidePreview();
  };
  const geometryValid = (): boolean => options.isVisible()
    && (!dragging || (dragColumns === options.tui.terminal.columns && dragRows === options.tui.terminal.rows));
  const flushPreview = (): void => {
    clearFrameTimer();
    if (disposed || !geometryValid()) { cancelDrag(); return; }
    if (pendingX === undefined) return;
    previewOptions.col = Math.max(0, pendingX - 1);
    pendingX = undefined;
    lastFrameAt = performance.now();
    options.tui.requestRender();
  };
  const schedulePreview = (x: number): void => {
    pendingX = x;
    if (frameTimer) return;
    const elapsed = performance.now() - lastFrameAt;
    frameTimer = setTimeout(flushPreview, Math.max(0, PREVIEW_FRAME_INTERVAL_MS - elapsed));
    frameTimer.unref?.();
  };
  const sidebarWidthAt = (x: number): number => options.clampSidebarWidth(options.tui.terminal.columns - x);
  const previewXFor = (x: number): number => options.tui.terminal.columns - sidebarWidthAt(x);

  const listener: TuiInputListener = (data) => {
    if (disposed || !geometryValid()) { cancelDrag(); return undefined; }
    const mouse = parseSgrMouseEvent(data);
    if (!mouse) return undefined;

    if (mouse.release) {
      if (!dragging) return undefined;
      cancelDrag();
      options.commitSidebarWidth(sidebarWidthAt(mouse.x));
      return { consume: true };
    }
    if (!mouse.motion && (mouse.button & 3) === 0 && (mouse.button & 64) === 0) {
      if (Math.abs(mouse.x - options.getDividerX()) > 1) return undefined;
      if (dragging) return { consume: true };
      dragging = true;
      dragColumns = options.tui.terminal.columns;
      dragRows = options.tui.terminal.rows;
      // Only watch geometry during a drag, including resizes with no further mouse input.
      geometryTimer = setInterval(() => { if (!geometryValid()) cancelDrag(); }, PREVIEW_FRAME_INTERVAL_MS);
      geometryTimer.unref?.();
      previewOptions.col = Math.max(0, options.getDividerX() - 1);
      previewHandle = options.tui.showOverlay(options.preview, previewOptions);
      return { consume: true };
    }
    if (mouse.motion && dragging) {
      schedulePreview(previewXFor(mouse.x));
      return { consume: true };
    }
    return dragging ? { consume: true } : undefined;
  };

  const unsubscribe = installPriorityInputListener(options.tui, listener);

  return () => {
    disposed = true;
    cancelDrag();
    unsubscribe();
  };
}
