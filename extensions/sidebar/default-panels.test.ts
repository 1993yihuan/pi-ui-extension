import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSidebarPanels, createToolViewScrollView, SESSION_PANEL_ID, TOOL_VIEW_PANEL_ID } from "./default-panels.ts";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { ToolViewPanel } from "../tool-view/panel.ts";

function options(showToolViewModeSelector?: boolean): Parameters<typeof createDefaultSidebarPanels>[0] {
  return {
    getContextUsage: () => undefined,
    getModel: () => "test-model",
    getThinkingLevel: () => "off",
    getToolViewMode: () => "compact",
    getToolUsage: () => undefined,
    onSelectToolViewMode() {},
    showToolViewModeSelector: () => showToolViewModeSelector ?? true,
    loadSessions: async () => [],
    onSelectSession() {},
    onRenameSession() {},
    onDeleteSession() {},
    onDeleteOthers() {},
    onOpenResources() {},
  };
}

test("registers sessions without removed standalone panels", () => {
  const ids = createDefaultSidebarPanels(options(true)).map((panel) => panel.id);
  assert.deepEqual(ids, [SESSION_PANEL_ID, "context", TOOL_VIEW_PANEL_ID]);
  assert.ok(!ids.includes("activity"));
  assert.ok(ids.includes("context"));
  const context = createDefaultSidebarPanels(options(true)).find(panel => panel.id === "context")!;
  const sessions = createDefaultSidebarPanels(options(true)).find(panel => panel.id === SESSION_PANEL_ID)!;
  assert.equal(sessions.layout?.maxSize, 9);
  assert.equal(context.layout?.minSize, 10);
  assert.ok(!ids.includes("resources"));
  assert.ok(!ids.includes("mcp"));
});


test("always registers Tool View without Fabric", () => {
  const ids = createDefaultSidebarPanels(options(true)).map((panel) => panel.id);
  assert.ok(ids.includes(TOOL_VIEW_PANEL_ID));
});

test("keeps Tool View registered when Fabric hides only its selector", () => {
  const ids = createDefaultSidebarPanels(options(false)).map((panel) => panel.id);
  assert.ok(ids.includes(TOOL_VIEW_PANEL_ID));
});

test("keeps Tool View anchored at the top when usage rows overflow", () => {
  const tui = { addInputListener: () => () => {}, requestRender() {} } as any;
  const theme = { fg: (_color: string, text: string) => text } as any;
  const panel = new ToolViewPanel(theme, {
    tui,
    getDesiredWidth: () => 60,
    getMode: () => "compact",
    getUsage: () => ({ counts: Array.from({ length: 30 }, (_, index) => ({
      name: `tool-${index}`,
      kind: "tool" as const,
      exchange: 0,
      session: index + 1,
    })) }),
    onSelect() {},
  });
  const scroll = createToolViewScrollView(panel, theme);
  scroll.updateLayout(8, 10, () => {});
  assert.equal(scroll.scrollbar, "hidden");

  scroll.updateLayout(10, 10, () => {});
  assert.equal(scroll.scrollbar, "hidden");

  scroll.updateLayout(40, 10, () => {});
  assert.equal(scroll.scrollTop, 0);
  assert.equal(scroll.isFollowingEnd, false);
  assert.equal(scroll.scrollbar, "always");
  panel.dispose();
});

test("keeps the Tool View bottom border visible when usage rows overflow", () => {
  const tui = { addInputListener: () => () => {}, requestRender() {} } as any;
  const theme = { fg: (_color: string, text: string) => text } as any;
  const panel = new ToolViewPanel(theme, {
    tui,
    getDesiredWidth: () => 30,
    getMode: () => "compact",
    getUsage: () => ({ counts: Array.from({ length: 20 }, (_, index) => ({
      name: `tool-${index}`,
      kind: "tool" as const,
      exchange: 0,
      session: index + 1,
    })) }),
    onSelect() {},
  });
  const scroll = createToolViewScrollView(panel, theme);
  const frame = renderLayoutFrame(scroll, 30, 8, () => {});
  assert.equal(frame.lines.at(-1), "╰────────────────────────────╯");
  panel.dispose();
});
