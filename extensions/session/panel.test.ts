import assert from "node:assert/strict";
import test from "node:test";
import type { TuiInputListener } from "@earendil-works/pi-tui";
import { SessionPanel, type SessionListItem } from "./panel.ts";

const theme = { fg: (_color: string, text: string) => text } as any;

function session(id: string, title: string): SessionListItem {
  return {
    id,
    title,
    modified: new Date(0),
    messageCount: 1,
    current: false,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("clicking the Sessions title refreshes the saved session list", async () => {
  let listener: TuiInputListener | undefined;
  let loads = 0;
  const snapshots = [
    [session("old", "Old session")],
    [session("new", "New session")],
  ];
  const tui = {
    addInputListener(next: TuiInputListener) {
      listener = next;
      return () => {};
    },
    requestRender() {},
    currentLayout: undefined as any,
  } as any;
  const panel = new SessionPanel(theme, {
    tui,
    getDesiredWidth: () => 40,
    loadSessions: async () => snapshots[Math.min(loads++, snapshots.length - 1)]!,
    onSelect() {},
    onRename() {},
    onOpenResources() {},
    onDelete() {},
    onDeleteOthers() {},
    now: () => 0,
  });
  tui.currentLayout = {
    root: {
      component: panel,
      rect: { x: 10, y: 5, width: 40, height: 7 },
      clip: { x: 10, y: 5, width: 40, height: 7 },
      children: [],
    },
  };

  panel.refresh();
  await flushAsync();
  assert.match(panel.render(40).join("\n"), /Old session/);
  assert.match(panel.render(40)[0]!, /SESSIONS ↻/);

  assert.deepEqual(listener?.("\u001b[<0;20;6M"), { consume: true });
  assert.deepEqual(listener?.("\u001b[<0;20;6m"), { consume: true });
  await flushAsync();

  assert.equal(loads, 2);
  const output = panel.render(40).join("\n");
  assert.match(output, /New session/);
  assert.doesNotMatch(output, /Old session/);
  panel.dispose();
});

test("renders and opens the MCP resource button", async () => {
  let listener: TuiInputListener | undefined;
  let opened: string | undefined;
  const tui = {
    addInputListener(next: TuiInputListener) {
      listener = next;
      return () => {};
    },
    requestRender() {},
    currentLayout: undefined as any,
  } as any;
  const panel = new SessionPanel(theme, {
    tui,
    getDesiredWidth: () => 40,
    loadSessions: async () => [session("one", "One session")],
    onSelect() {},
    onRename() {},
    onDelete() {},
    onDeleteOthers() {},
    onOpenResources(button) { opened = button; },
    now: () => 0,
  });
  tui.currentLayout = {
    root: {
      component: panel,
      rect: { x: 10, y: 5, width: 40, height: 5 },
      clip: { x: 10, y: 5, width: 40, height: 5 },
      children: [],
    },
  };

  panel.refresh();
  await flushAsync();
  assert.match(panel.render(40).join("\n"), /MCP/);

  assert.deepEqual(listener?.("\u001b[<0;43;9M"), { consume: true });
  assert.deepEqual(listener?.("\u001b[<0;43;9m"), { consume: true });
  await flushAsync();

  assert.equal(opened, "mcp");
  panel.dispose();
});

test("releasing outside the Sessions title cancels a refresh click", async () => {
  let listener: TuiInputListener | undefined;
  let loads = 0;
  const tui = {
    addInputListener(next: TuiInputListener) {
      listener = next;
      return () => {};
    },
    requestRender() {},
    currentLayout: undefined as any,
  } as any;
  const panel = new SessionPanel(theme, {
    tui,
    getDesiredWidth: () => 40,
    loadSessions: async () => {
      loads++;
      return [];
    },
    onSelect() {},
    onRename() {},
    onDelete() {},
    onDeleteOthers() {},
    onOpenResources() {},
  });
  tui.currentLayout = {
    root: {
      component: panel,
      rect: { x: 10, y: 5, width: 40, height: 7 },
      clip: { x: 10, y: 5, width: 40, height: 7 },
      children: [],
    },
  };

  panel.refresh();
  await flushAsync();
  listener?.("\u001b[<0;20;6M");
  listener?.("\u001b[<0;20;7m");
  await flushAsync();

  assert.equal(loads, 1);
  panel.dispose();
});

test("renders ⊗ and clears every other session without refreshing", async () => {
  let listener: TuiInputListener | undefined;
  let loads = 0;
  let cleared = 0;
  const tui = {
    addInputListener(next: TuiInputListener) {
      listener = next;
      return () => {};
    },
    requestRender() {},
    currentLayout: undefined as any,
  } as any;
  const panel = new SessionPanel(theme, {
    tui,
    getDesiredWidth: () => 40,
    loadSessions: async () => {
      loads++;
      return [session("one", "One session")];
    },
    onSelect() {},
    onRename() {},
    onDelete() {},
    onDeleteOthers() { cleared++; },
    onOpenResources() {},
    now: () => 0,
  });
  tui.currentLayout = {
    root: {
      component: panel,
      rect: { x: 10, y: 5, width: 40, height: 7 },
      clip: { x: 10, y: 5, width: 40, height: 7 },
      children: [],
    },
  };

  panel.refresh();
  await flushAsync();
  assert.match(panel.render(40)[0]!, /⊗/);

  // ⊗ sits at the right edge of the title row: content column 33 of 38.
  assert.deepEqual(listener?.("\u001b[<0;46;6M"), { consume: true });
  assert.deepEqual(listener?.("\u001b[<0;46;6m"), { consume: true });
  await flushAsync();

  assert.equal(cleared, 1);
  assert.equal(loads, 1);
  panel.dispose();
});

test("hides ⊗ on narrow panels", async () => {
  const tui = {
    addInputListener: () => () => {},
    requestRender() {},
    currentLayout: undefined as any,
  } as any;
  const panel = new SessionPanel(theme, {
    tui,
    getDesiredWidth: () => 16,
    loadSessions: async () => [],
    onSelect() {},
    onRename() {},
    onDelete() {},
    onDeleteOthers() {},
    onOpenResources() {},
    now: () => 0,
  });
  tui.currentLayout = {
    root: {
      component: panel,
      rect: { x: 0, y: 0, width: 16, height: 7 },
      clip: { x: 0, y: 0, width: 16, height: 7 },
      children: [],
    },
  };

  panel.refresh();
  await flushAsync();
  assert.doesNotMatch(panel.render(16)[0]!, /⊗/);
  panel.dispose();
});
