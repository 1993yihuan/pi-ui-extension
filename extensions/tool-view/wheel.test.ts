import assert from "node:assert/strict";
import test from "node:test";
import { renderLayoutFrame, getScrollViewsAt } from "@earendil-works/pi-tui/dist/layout.js";
import { ToolViewPanel } from "./panel.ts";
import { createToolViewScrollView } from "../sidebar/default-panels.ts";

test("Tool View passes wheel events to its enclosing ScrollView while retaining clicks", async () => {
  let listener: any;
  const selections: string[] = [];
  const tui: any = { addInputListener(fn: any) { listener = fn; return () => {}; }, requestRender() {} };
  const theme: any = { fg: (_: string, text: string) => text };
  const panel = new ToolViewPanel(theme, {
    tui, getDesiredWidth: () => 60, getMode: () => "compact",
    getUsage: () => ({ counts: Array.from({ length: 30 }, (_, i) => ({ name: `tool-${i}`, kind: "tool", exchange: 0, session: 1 })) }),
    onSelect(mode) { selections.push(mode); },
  });
  try {
    const scroll = createToolViewScrollView(panel, theme);
    tui.currentLayout = renderLayoutFrame(scroll, 60, 8, () => {});
    for (const button of [64, 65]) assert.equal(listener(`\x1b[<${button};5;4M`), undefined);
    const targets = getScrollViewsAt(tui.currentLayout, 4, 3);
    assert.equal(targets[0], scroll.scrollView);
    targets[0]!.scrollBy(3);
    assert.equal(scroll.scrollTop, 3);
    targets[0]!.scrollBy(-3);
    tui.currentLayout = renderLayoutFrame(scroll, 60, 8, () => {});
    assert.deepEqual(listener("\x1b[<0;5;2M"), { consume: true });
    assert.deepEqual(listener("\x1b[<0;5;2m"), { consume: true });
    await Promise.resolve();
    assert.deepEqual(selections, ["normal"]);
  } finally { panel.dispose(); }
});
