import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import piUiExtension from "../index.ts";

test("entry wires early/late MCP status into restored and live usage without double counting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-ui-mcp-"));
  const handlers = new Map<string, any[]>(), bus = new Map<string, any>();
  const listeners = new Set<any>();
  let branch: any[] = [], footer: any;
  const tui: any = {
    [Symbol.for("@earendil-works/pi-tui/viewport")]: true,
    terminal: { columns: 240, rows: 100 }, layoutRoot: { render: () => [], invalidate() {} }, inputListeners: listeners,
    addInputListener(fn: any) { listeners.add(fn); return () => listeners.delete(fn); },
    requestRender() {}, setLayoutRoot(root: any) { this.layoutRoot = root; },
  };
  const theme: any = { fg: (_: string, text: string) => text, bold: (text: string) => text };
  const pi: any = {
    registerTool() {}, registerCommand() {}, registerShortcut() {},
    getCommands: () => [], getActiveTools: () => [], getAllTools: () => [], getThinkingLevel: () => "off",
    on(name: string, fn: any) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    events: { on(name: string, fn: any) { bus.set(name, fn); return () => bus.delete(name); } },
  };
  const ctx: any = {
    mode: "tui", cwd: directory, getSystemPrompt: () => "", getContextUsage: () => undefined,
    sessionManager: { getBranch: () => branch, buildContextEntries: () => [], getSessionId: () => "test", getSessionDir: () => directory },
    ui: { setStatus() {}, setFooter(factory: any) { footer?.dispose(); footer = factory?.(tui, theme, { onBranchChange: () => () => {}, getGitBranch: () => null }); } },
  };
  const emit = async (name: string, event: any = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
  const status = (names: string[]) => bus.get("pi-mcp-adapter/status/v1")({ version: 1, servers: names.map(name => ({ name })) });
  const details = (server: string) => ({ mode: "script", calls: [{ operation: "call", path: `${server}_ping`, ok: true }] });
  const saved = (server: string) => ({ type: "message", message: { role: "toolResult", toolName: "mcpScript", details: details(server) } });
  const output = () => renderLayoutFrame(tui.layoutRoot, 240, 100, () => {}).lines.join("\n");
  try {
    await piUiExtension(pi);
    status(["early"]);
    branch = [saved("early")];
    await emit("session_start");
    assert.match(output(), /early\s+0\/1/);
    await emit("before_agent_start", { systemPromptOptions: {} });
    branch.push(saved("late"));
    await emit("tool_execution_end", { toolCallId: "call-1", toolName: "mcpScript", isError: false, result: { details: details("late") } });
    assert.doesNotMatch(output(), /late\s+1\/1/);
    status(["early", "late"]);
    assert.match(output(), /late\s+1\/1/);
    status(["early", "late"]);
    assert.match(output(), /late\s+1\/1/);
    branch.push(saved("late"));
    await emit("tool_execution_end", { toolCallId: "call-2", toolName: "mcpScript", isError: false, result: { details: details("late") } });
    assert.match(output(), /late\s+2\/2/);
    branch = [saved("early")];
    await emit("session_tree");
    assert.match(output(), /early\s+0\/1/);
    assert.doesNotMatch(output(), /late\s+2\/2/);
  } finally {
    await emit("session_shutdown");
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(bus.size, 0);
  assert.equal(listeners.size, 0);
});
