import assert from "node:assert/strict";
import test from "node:test";
import type { ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";
import { createToolUsageTracker, toolNamesFromBranch } from "./usage.ts";

function ended(toolName: string, details: unknown = {}): ToolExecutionEndEvent {
  return {
    type: "tool_execution_end",
    toolCallId: `${toolName}-call`,
    toolName,
    result: { content: [], details },
    isError: false,
  };
}

test("tracks top-level tools for the current question and session", () => {
  const tracker = createToolUsageTracker(["read", "read", "bash"]);
  tracker.startExchange();
  tracker.record(ended("read"));
  // Multiple internal LLM turns in one answer must continue accumulating.
  tracker.record(ended("read"));

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "read", kind: "tool", exchange: 2, session: 4 },
    { name: "bash", kind: "tool", exchange: 0, session: 1 },
  ]);

  tracker.startExchange();
  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "read", kind: "tool", exchange: 0, session: 4 },
    { name: "bash", kind: "tool", exchange: 0, session: 1 },
  ]);
});

test("counts nested Fabric trace operations as their actual tools", () => {
  const tracker = createToolUsageTracker();
  tracker.startExchange();
  tracker.record({ ...ended("fabric_exec", {
    success: true,
    trace: {
      kind: "pi-fabric.execution",
      version: 1,
      outcome: "succeeded",
      phases: [],
      operations: [
        { type: "call", sequence: 1, ref: "pi.read", provider: "pi", action: "read", args: {}, outcome: "succeeded" },
        { type: "call", sequence: 2, ref: "pi.bash", provider: "pi", action: "bash", args: {}, outcome: "succeeded" },
        { type: "call", sequence: 3, ref: "mcp.context7.query-docs", provider: "mcp", action: "query-docs", args: {}, outcome: "succeeded" },
        { type: "call", sequence: 4, ref: "extensions.ask_user_question", provider: "extensions", action: "ask_user_question", args: {}, outcome: "succeeded" },
      ],
      counts: { droppedValues: 0, truncatedValues: 0, redactedValues: 0, droppedOperations: 0 },
    },
  }), toolCallId: "call_outer_fabric" });

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "ask_user_question", kind: "tool", exchange: 1, session: 1 },
    { name: "bash", kind: "tool", exchange: 1, session: 1 },
    { name: "fabric_exec", kind: "tool", exchange: 1, session: 1 },
    { name: "read", kind: "tool", exchange: 1, session: 1 },
    { name: "context7", kind: "mcp", exchange: 1, session: 1 },
  ]);
});

test("does not double-count nested lifecycle events replayed by Fabric", () => {
  const tracker = createToolUsageTracker();
  tracker.startExchange();
  tracker.record(ended("read", {},));
  tracker.record({ ...ended("read"), toolCallId: "fabric_nested", result: { content: [], details: {} } });
  assert.equal(tracker.getSnapshot().counts.find((count) => count.name === "read")?.exchange, 1);
});

test("adds the MCP server for proxy calls without hiding the gateway count", () => {
  const tracker = createToolUsageTracker();
  tracker.startExchange();
  tracker.record(ended("mcp", { mode: "call", server: "codebase-memory-mcp", tool: "search_graph" }));

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "mcp", kind: "tool", exchange: 1, session: 1 },
    { name: "codebase-memory-mcp", kind: "mcp", exchange: 1, session: 1 },
  ]);
});

test("counts each MCP call made by mcpScript", () => {
  const tracker = createToolUsageTracker([], () => ["codebase-memory-mcp", "context-mode"]);
  tracker.startExchange();
  tracker.record(ended("mcpScript", {
    mode: "script",
    calls: [
      { operation: "search", query: "graph", ok: true },
      { operation: "call", path: "codebase-memory-mcp_search_graph", ok: true },
      { operation: "call", path: "codebase-memory-mcp_get_code_snippet", ok: true },
      { operation: "call", path: "context-mode_ctx_search", ok: false, error: "failed" },
    ],
  }));

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "mcpScript", kind: "tool", exchange: 1, session: 1 },
    { name: "codebase-memory-mcp", kind: "mcp", exchange: 2, session: 2 },
    { name: "context-mode", kind: "mcp", exchange: 1, session: 1 },
  ]);
});

test("attributes direct context-mode bridge tools to the MCP server", () => {
  const tracker = createToolUsageTracker();
  tracker.startExchange();
  tracker.record(ended("ctx_execute"));

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "ctx_execute", kind: "tool", exchange: 1, session: 1 },
    { name: "context-mode", kind: "mcp", exchange: 1, session: 1 },
  ]);
});

test("does not attribute unknown ctx-prefixed tools to context-mode", () => {
  const tracker = createToolUsageTracker();
  tracker.startExchange();
  tracker.record(ended("ctx_custom"));

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "ctx_custom", kind: "tool", exchange: 1, session: 1 },
  ]);
});

test("rebuilds session totals when the active branch changes", () => {
  const firstBranch = [{
    type: "message",
    message: { role: "toolResult", toolName: "read", details: {} },
  }];
  const secondBranch = [{
    type: "message",
    message: { role: "toolResult", toolName: "bash", details: {} },
  }];
  const tracker = createToolUsageTracker(toolNamesFromBranch(firstBranch));
  tracker.startExchange();
  tracker.resetSession(secondBranch);

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "bash", kind: "tool", exchange: 0, session: 1 },
  ]);
});

test("re-attributes restored mcpScript calls after MCP server discovery", () => {
  const entries = [{
    type: "message",
    message: {
      role: "toolResult",
      toolName: "mcpScript",
      details: {
        mode: "script",
        calls: [{ operation: "call", path: "team_core_search", ok: false, error: "failed" }],
      },
    },
  }];
  const tracker = createToolUsageTracker(toolNamesFromBranch(entries));
  tracker.resetSession(entries, ["team_core"]);

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "mcpScript", kind: "tool", exchange: 0, session: 1 },
    { name: "team_core", kind: "mcp", exchange: 0, session: 1 },
  ]);
});

test("keeps same-named Tool and MCP server in separate sections", () => {
  const tracker = createToolUsageTracker();
  tracker.startExchange();
  tracker.record(ended("mcp", { mode: "call", server: "mcp", tool: "status" }));

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "mcp", kind: "tool", exchange: 1, session: 1 },
    { name: "mcp", kind: "mcp", exchange: 1, session: 1 },
  ]);
});

test("rebuilds current-question MCP counts when server discovery arrives late", () => {
  let servers: string[] = [];
  const details = {
    mode: "script",
    calls: [{ operation: "call", path: "team_core_search", ok: true }],
  };
  const entries = [{
    type: "message",
    message: { role: "toolResult", toolName: "mcpScript", details },
  }];
  const tracker = createToolUsageTracker([], () => servers);
  tracker.startExchange();
  tracker.record(ended("mcpScript", details));
  servers = ["team_core"];
  tracker.resetSession(entries, servers, { preserveExchange: true });

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "mcpScript", kind: "tool", exchange: 1, session: 1 },
    { name: "team_core", kind: "mcp", exchange: 1, session: 1 },
  ]);
});

test("clears current-question counts when the active branch changes", () => {
  const tracker = createToolUsageTracker();
  tracker.startExchange();
  tracker.record(ended("read"));
  tracker.resetSession([{
    type: "message",
    message: { role: "toolResult", toolName: "read", details: {} },
  }]);

  assert.deepEqual(tracker.getSnapshot().counts, [
    { name: "read", kind: "tool", exchange: 0, session: 1 },
  ]);
});

test("restores completed tool and MCP counts from a session branch", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "read",
        details: {},
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "mcp",
        details: { mode: "call", server: "codebase-memory-mcp", tool: "search_graph" },
      },
    },
  ];

  assert.deepEqual(toolNamesFromBranch(entries), ["read", "mcp", "codebase-memory-mcp"]);
});
