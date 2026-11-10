import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { SelectList, visibleWidth, type Component, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { t } from "../i18n.ts";
import { modalFrame } from "./index.ts";
import type { CleanupSummary } from "../session/cleanup-preview.ts";

/** Centered, cancellation-first preview with an explicit protection breakdown. */
export async function confirmSessionCleanup(ui: ExtensionUIContext, summary: CleanupSummary): Promise<boolean> {
  const description = t("cleanup.confirm", {
    eligible: summary.eligible,
    protected: summary.protected,
    current: summary.current,
    pinned: summary.pinned,
    active: summary.active,
    unavailable: summary.unavailable,
  });
  if (typeof ui.custom !== "function") {
    return summary.eligible > 0 && ui.confirm(t("cleanup.title"), description);
  }
  return ui.custom<boolean>((tui, theme, _keys, done) => {
    const cancel = t("dialog.cancel");
    const actions = summary.eligible > 0 ? [cancel, t("cleanup.move", { count: summary.eligible })] : [cancel];
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
        const total = t("cleanup.eligible", { count: summary.eligible });
        const kept = t("cleanup.protected", { count: summary.protected });
        const tiny = rows < 17;
        const compact = rows < 28 || width < 34;
        const reasons = [
          [t("cleanup.reason.current"), summary.current],
          [t("cleanup.reason.pinned"), summary.pinned],
          [t("cleanup.reason.active"), summary.active],
          [t("cleanup.reason.unavailable"), summary.unavailable],
        ] as const;
        // CJK labels are 1 code unit but 2 terminal cells wide, so pad by display columns, not by string length.
        const labelWidth = Math.max(...reasons.map(([label]) => visibleWidth(label)));
        const countWidth = Math.max(...reasons.map(([, count]) => String(count).length));
        const details = compact
          ? [
              t("cleanup.compact.current", { current: summary.current, pinned: summary.pinned }),
              t("cleanup.compact.other", { active: summary.active, unavailable: summary.unavailable }),
            ]
          : reasons.map(([label, count]) =>
              `${label}${" ".repeat(Math.max(0, labelWidth - visibleWidth(label)))}  ${String(count).padStart(countWidth)}`);
        const info = tiny ? [
          theme.fg("success", total), theme.fg("warning", kept),
          ...details.map(text => theme.fg("muted", text)),
        ] : [
          theme.fg("success", theme.bold(total)),
          theme.fg("warning", kept),
          "",
          theme.fg("muted", t("cleanup.reasons")),
          ...details.map(text => theme.fg("muted", text)),
          "",
          theme.fg("warning", t("cleanup.warning")),
          "",
        ];
        actionsY = 3 + info.length;
        return modalFrame(theme, width, t("cleanup.title"), [
          ...info, ...list.render(Math.max(1, width - 4)),
        ], t("dialog.footer.danger"), true);
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
