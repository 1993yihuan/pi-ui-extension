import assert from "node:assert/strict";
import test from "node:test";
import { createReadTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { estimateContext, installContextEstimates } from "./data.ts";

const result = (n: number) => ({ role: "toolResult", toolName: "sample_runner", toolCallId: String(n), content: [{ type: "text", text: "x".repeat(n * 4) }], details: { fullOutput: "x".repeat(100000), operations: [{ toolName: "read" }] } });
const tool = { name: "sample_runner", description: "Execute TypeScript", parameters: createReadTool(process.cwd()).parameters };

test("context estimate keeps tool schemas, summaries, images and active branch semantics", () => {
  const snapshot = estimateContext([{role:"user",content:"abcd"}, result(4), {role:"compactionSummary",summary:"abcd"}], "abcd", "context hook", [tool]);
  assert.equal(snapshot.categories.find(c => c.name === "Tools")?.tokens, Math.ceil(JSON.stringify(tool).length / 4));
  assert.equal(snapshot.categories.find(c => c.name === "Summary")?.tokens, 28);
  assert.ok(snapshot.total > 0);
  assert.equal(estimateContext([{role:"user",content:[{type:"image",data:"x".repeat(10000)}]}]).total, 0);
});

test("tracker filters active tools, refreshes schemas, caches snapshots and resets", () => {
  const handlers = new Map<string, Function>();
  let active = ["sample_runner"];
  let all = [tool];
  const tracker = installContextEstimates({
    on: (name: string, fn: Function) => handlers.set(name, fn),
    getActiveTools: () => active,
    getAllTools: () => all,
  } as any, () => {});
  const ctx = {sessionManager: SessionManager.inMemory(), getSystemPrompt: () => ""};
  handlers.get("session_start")!({}, ctx);
  assert.equal(tracker.getSnapshot().source, "active branch");
  const cached = tracker.getSnapshot();
  assert.strictEqual(tracker.getSnapshot(), cached);
  active = [];
  handlers.get("agent_settled")!({}, ctx);
  assert.equal(tracker.getSnapshot().categories.find(c => c.name === "Tools")?.tokens, 0);
  handlers.get("session_shutdown")!();
  assert.equal(tracker.getSnapshot().source, "unavailable");
});

test("delta tracks the previous settled run and resets", () => {
  const handlers = new Map<string, Function>();
  const tracker = installContextEstimates({
    on: (name: string, fn: Function) => handlers.set(name, fn),
    getActiveTools: () => [],
    getAllTools: () => [],
  } as any, () => {});
  const session = SessionManager.inMemory();
  const ctx = { sessionManager: session, getSystemPrompt: () => "" };
  handlers.get("session_start")!({}, ctx);
  assert.equal(tracker.getSnapshot().total, 0);
  session.appendMessage({ role: "user", content: [{ type: "text", text: "x".repeat(4000) }] } as any);
  handlers.get("turn_end")!({}, ctx);
  assert.equal(tracker.getDelta(), 1000);
  handlers.get("agent_settled")!({}, ctx);
  assert.equal(tracker.getDelta(), 1000);
  handlers.get("turn_end")!({}, ctx);
  assert.equal(tracker.getDelta(), 0);
  session.appendMessage({ role: "user", content: [{ type: "text", text: "x".repeat(400) }] } as any);
  handlers.get("agent_settled")!({}, ctx);
  assert.equal(tracker.getDelta(), 100);
  handlers.get("session_compact")!({}, ctx);
  assert.equal(tracker.getDelta(), undefined);
  assert.equal(tracker.getSnapshot().total, 1100);
});
test("the active branch projection includes custom context entries", () => {
  const handlers = new Map<string, Function>();
  const tracker = installContextEstimates({
    on: (name: string, fn: Function) => handlers.set(name, fn),
    getActiveTools: () => [], getAllTools: () => [],
  } as any, () => {});
  const session = SessionManager.inMemory();
  session.appendCustomMessageEntry("automation", "custom body", false);
  handlers.get("session_start")!({}, { sessionManager: session, getSystemPrompt: () => "" });
  assert.ok(tracker.getSnapshot().categories.find(c => c.name === "Other")!.tokens! > 0,
    "a custom message is estimated from the SDK projection");
});

test("restoring CTX respects SDK context removals, replacements and branch changes", () => {
  const session = SessionManager.inMemory();
  assert.equal(typeof session.appendContextEdit, "function", "context edits need the supported SDK API");
  const handlers = new Map<string, Function>();
  const tracker = installContextEstimates({
    on: (name: string, fn: Function) => handlers.set(name, fn),
    getActiveTools: () => [], getAllTools: () => [],
  } as any, () => {});
  const ctx = { sessionManager: session, getSystemPrompt: () => "" };
  const user = session.appendMessage({ role: "user", content: "x".repeat(400), timestamp: 1 });
  const tool = session.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "read-1", content: [{ type: "text", text: "x".repeat(40000) }], isError: false, timestamp: 2 });
  session.appendContextEdit(user, { content: "abcd" });
  session.appendContextEdit(tool, null);
  for (const name of ["session_start", "turn_end", "agent_settled", "session_tree"]) {
    handlers.get(name)!({}, ctx);
    assert.equal(tracker.getSnapshot().total, 1, name);
    assert.equal(tracker.getSnapshot().categories.find(category => category.name === "Tool Results")?.tokens, 0);
  }
  session.branch(tool);
  handlers.get("session_tree")!({}, ctx);
  assert.equal(tracker.getSnapshot().total, 10100, "edits on another branch do not apply");
  session.appendCompaction("kept summary", null, 40400);
  handlers.get("session_compact")!({}, ctx);
  assert.ok(tracker.getSnapshot().categories.find(category => category.name === "Summary")!.tokens! > 0);
});
