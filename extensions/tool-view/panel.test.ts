import assert from "node:assert/strict";
import test from "node:test";
import { ToolViewPanel, groupUsageCounts } from "./panel.ts";

test("groups Tool View usage into Tool and MCP sections", () => {
  const grouped = groupUsageCounts([
    { name: "read", kind: "tool", exchange: 2, session: 10 },
    { name: "codebase-memory-mcp", kind: "mcp", exchange: 1, session: 4 },
    { name: "mcp", kind: "tool", exchange: 1, session: 3 },
    { name: "context-mode", kind: "mcp", exchange: 0, session: 7 },
  ]);

  assert.deepEqual(grouped.tool.map((count) => count.name), ["read", "mcp"]);
  assert.deepEqual(grouped.mcp.map((count) => count.name), ["codebase-memory-mcp", "context-mode"]);
});

function renderPanel(showModeSelector: boolean): string[] {
  const tui = { addInputListener: () => () => {}, requestRender() {} } as any;
  const theme = { fg: (_color: string, text: string) => text } as any;
  return new ToolViewPanel(theme, {
    tui,
    getDesiredWidth: () => 60,
    getMode: () => "compact",
    getUsage: () => ({
      counts: [
        { name: "fabric_exec", kind: "tool", exchange: 1, session: 4 },
        { name: "context-mode", kind: "mcp", exchange: 1, session: 3 },
      ],
    }),
    onSelect() {},
    showModeSelector: () => showModeSelector,
  }).render(60);
}

test("shows a centered Fabric notice while preserving Tool and MCP usage", () => {
  const lines = renderPanel(false);
  const output = lines.join("\n");
  assert.equal(lines.length, 7);
  assert.doesNotMatch(output, /Normal|Compact|Hidden/);
  assert.match(lines[1]!, / {10,}View controlled by Fabric {10,}/);
  assert.match(output, /TOOLS/);
  assert.match(output, /fabric_exec/);
  assert.match(output, /MCP/);
  assert.match(output, /context-mode/);
});

test("shows the mode selector when Fabric is absent", () => {
  const output = renderPanel(true).join("\n");
  assert.match(output, /Normal/);
  assert.match(output, /Compact/);
  assert.match(output, /Hidden/);
  assert.match(output, /fabric_exec/);
});

test("re-evaluates selector visibility after Fabric takes tool ownership", () => {
  let showModeSelector = true;
  const tui = { addInputListener: () => () => {}, requestRender() {} } as any;
  const theme = { fg: (_color: string, text: string) => text } as any;
  const panel = new ToolViewPanel(theme, {
    tui,
    getDesiredWidth: () => 60,
    getMode: () => "compact",
    getUsage: () => ({ counts: [] }),
    onSelect() {},
    showModeSelector: () => showModeSelector,
  });

  assert.match(panel.render(60).join("\n"), /Compact/);
  showModeSelector = false;
  const fullCodeOutput = panel.render(60).join("\n");
  assert.doesNotMatch(fullCodeOutput, /Normal|Compact|Hidden/);
  assert.match(fullCodeOutput, /View controlled by Fabric/);
});
