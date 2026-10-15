import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { SelectList, type Component, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { modalFrame } from "./index.ts";
import type { CleanupSummary } from "../session/cleanup-preview.ts";

/** Centered, cancellation-first preview with an explicit protection breakdown. */
export async function confirmSessionCleanup(ui: ExtensionUIContext, summary: CleanupSummary): Promise<boolean> {
  const description = `Eligible: ${summary.eligible}; protected/unavailable: ${summary.protected} (` +
    `current ${summary.current}, pinned ${summary.pinned}, active ${summary.active}, unavailable ${summary.unavailable}). ` +
    `Recently modified history is included. Other Pi processes without this extension cannot be detected.`;
  if (typeof ui.custom !== "function") {
    return summary.eligible > 0 && ui.confirm("Clear other sessions", description);
  }
  return ui.custom<boolean>((tui, theme, _keys, done) => {
    const actions = summary.eligible > 0 ? ["Cancel", `Move ${summary.eligible} to Trash`] : ["Cancel"];
    const list = new SelectList(actions.map((label, index) => ({ value: String(index), label })), actions.length, {
      selectedPrefix: text => theme.fg("accent", text),
      selectedText: text => theme.fg("warning", theme.bold(text)),
      description: text => theme.fg("muted", text),
      scrollInfo: text => theme.fg("dim", text),
      noMatch: text => theme.fg("dim", text),
    });
    list.onSelect = item => done(item.value === "1");
    list.onCancel = () => done(false);
    let actionsY = 0;
    const component: Component = {
      render(width) {
        const rows = tui.terminal.rows;
        const total = `Eligible to trash: ${summary.eligible}`;
        const kept = `Protected / unavailable: ${summary.protected}`;
        const tiny = rows < 17;
        const compact = rows < 28 || width < 34;
        const reasons = [
          ["Current session", summary.current],
          ["Pinned sessions", summary.pinned],
          ["Active in another Pi", summary.active],
          ["Unavailable session files", summary.unavailable],
        ] as const;
        const labelWidth = Math.max(...reasons.map(([label]) => label.length));
        const countWidth = Math.max(...reasons.map(([, count]) => String(count).length));
        const details = compact
          ? [`Current ${summary.current} · Pinned ${summary.pinned}`, `Other Pi ${summary.active} · Unavailable ${summary.unavailable}`]
          : reasons.map(([label, count]) => `${label.padEnd(labelWidth)}  ${String(count).padStart(countWidth)}`);
        const info = tiny ? [
          theme.fg("success", total), theme.fg("warning", kept),
          theme.fg("muted", `Cur ${summary.current} · Pin ${summary.pinned} · Pi ${summary.active} · N/A ${summary.unavailable}`),
        ] : [
          theme.fg("success", theme.bold(total)),
          theme.fg("warning", kept),
          "",
          theme.fg("muted", "Protected reasons:"),
          ...details.map(text => theme.fg("muted", text)),
          "",
          theme.fg("warning", "Recent sessions included; unknown Pi instances may be active."),
          "",
        ];
        actionsY = 3 + info.length;
        return modalFrame(theme, width, "Clear other sessions", [
          ...info, ...list.render(Math.max(1, width - 4)),
        ], "↑↓ choose · Enter select · Esc cancel", true);
      },
      invalidate() { list.invalidate(); },
      handleInput(data) { list.handleInput(data); tui.requestRender(); },
      handleMouse(event): TuiMouseEventResult | undefined {
        if (event.y < actionsY) return undefined;
        const result = list.handleMouse({ ...event, x: event.x - 2, y: event.y - actionsY, width: event.width - 4 });
        if (result?.handled) tui.requestRender();
        return result;
      },
    };
    return component;
  }, { overlay: true, overlayOptions: { anchor: "center", width: "68%", maxHeight: "85%", margin: 2 } });
}
