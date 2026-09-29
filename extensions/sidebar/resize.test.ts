import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { installSidebar } from "./index.ts";
import type { SidebarPanelDefinition } from "./registry.ts";

test("sidebar ignores hidden divider hits and cancels drags after terminal resize", async () => {
  let overlays = 0, hidden = 0;
  const listeners = new Set<any>();
  const root = { render: () => [], invalidate() {} };
  const tui: any = {
    [Symbol.for("@earendil-works/pi-tui/viewport")]: true,
    terminal: { columns: 100, rows: 40 }, layoutRoot: root,
    inputListeners: listeners,
    addInputListener(fn: any) { listeners.add(fn); return () => listeners.delete(fn); },
    setLayoutRoot(next: any) { this.layoutRoot = next; },
    requestRender() {},
    showOverlay() { overlays++; return { hide() { hidden++; } }; },
  };
  const controller = installSidebar(tui, { fg: (_: string, text: string) => text } as any, []);
  const input = (data: string) => [...listeners][0]?.(data);
  try {
    assert.equal(controller.mounted, true);
    assert.equal(input("\x1b[<0;80;5M"), undefined);
    assert.equal(overlays, 0);
    tui.terminal.columns = 160;
    assert.deepEqual(input("\x1b[<0;140;5M"), { consume: true });
    assert.deepEqual(input("\x1b[<0;130;5m"), { consume: true });
    assert.equal(tui.layoutRoot.entries[2].basis, 30);
    assert.equal(hidden, 1);
    assert.deepEqual(input("\x1b[<0;130;5M"), { consume: true });
    tui.terminal.columns = 100;
    await delay(50);
    assert.equal(hidden, 2);
    assert.equal(input("\x1b[<0;70;5m"), undefined);
    assert.equal(tui.layoutRoot.entries[2].basis, 30);
    tui.terminal.columns = 160;
    input("\x1b[<0;130;5M");
    tui.terminal.rows = 30;
    assert.equal(input("\x1b[<0;120;5m"), undefined);
    assert.equal(hidden, 3);
    assert.equal(tui.layoutRoot.entries[2].basis, 30);
  } finally { controller.dispose(); }
  assert.equal(listeners.size, 0);
  assert.equal(tui.layoutRoot, root);
});

test("sidebar paints separator rows instead of leaving stale main-view colors", () => {
  const root = { render: () => [], invalidate() {} };
  const tui: any = {
    [Symbol.for("@earendil-works/pi-tui/viewport")]: true,
    terminal: { columns: 160, rows: 6 }, layoutRoot: root,
    inputListeners: new Set(),
    addInputListener() { return () => {}; },
    setLayoutRoot(next: any) { this.layoutRoot = next; },
    requestRender() {},
  };
  const panel = (id: string): SidebarPanelDefinition => ({
    id,
    create: () => ({ component: { render: () => [id], invalidate() {} } }),
  });
  const controller = installSidebar(
    tui,
    { fg: (_: string, text: string) => text } as any,
    [panel("one"), panel("two")],
  );
  try {
    const lines = tui.layoutRoot.entries[2].component.render(32);
    assert.equal(lines[1], `\x1b[0m${" ".repeat(32)}`);
  } finally { controller.dispose(); }
});
