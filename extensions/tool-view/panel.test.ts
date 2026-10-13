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

function renderPanel(): string[] {
  const tui = { addInputListener: () => () => {}, requestRender() {} } as any;
  const theme = { fg: (_color: string, text: string) => text } as any;
  return new ToolViewPanel(theme, {
    tui,
    getDesiredWidth: () => 60,
    getMode: () => "compact",
    getUsage: () => ({
      counts: [
        { name: "read", kind: "tool", exchange: 1, session: 4 },
        { name: "context-mode", kind: "mcp", exchange: 1, session: 3 },
      ],
    }),
    onSelect() {},
  }).render(60);
}

test("renders separate Direct and Nested groups for same-named tool calls", () => {
  const tui = { addInputListener: () => () => {}, requestRender() {} } as any;
  const theme = { fg: (_color: string, text: string) => text } as any;
  const panel = new ToolViewPanel(theme, {
    tui,
    getDesiredWidth: () => 54,
    getMode: () => "compact",
    getUsage: () => ({ counts: [
      { name: "codemode", kind: "tool", exchange: 1, session: 2 },
      { name: "read", kind: "tool", exchange: 1, session: 2 },
      { name: "read", kind: "tool", scope: "nested", exchange: 3, session: 8 },
      { name: "bash", kind: "tool", scope: "nested", exchange: 5, session: 30 },
      { name: "docs", kind: "mcp", exchange: 1, session: 2 },
    ] }),
    onSelect() {},
  });
  const rendered = panel.render(54).join("\n");
  assert.match(rendered, /DIRECT TOOLS[\s\S]*codemode\s+1\/2[\s\S]*read\s+1\/2/);
  assert.match(rendered, /NESTED TOOLS[\s\S]*read\s+3\/8/);
  assert.match(rendered, /NESTED TOOLS[\s\S]*bash\s+5\/30/);
  assert.match(rendered, /MCP[\s\S]*docs\s+1\/2/);
  assert.ok(rendered.indexOf("DIRECT TOOLS") < rendered.indexOf("NESTED TOOLS"));
  assert.ok(rendered.indexOf("NESTED TOOLS") < rendered.indexOf("MCP"));
  panel.dispose();
});

test("keeps the mode selector visible alongside Tool and MCP usage", () => {
  const lines = renderPanel();
  const output = lines.join("\n");
  assert.equal(lines.length, 7);
  assert.match(output, /Normal/);
  assert.match(output, /Compact/);
  assert.match(output, /Hidden/);
  assert.match(output, /TOOLS/);
  assert.match(output, /read/);
  assert.match(output, /MCP/);
  assert.match(output, /context-mode/);
});
