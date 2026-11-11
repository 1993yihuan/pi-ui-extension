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
test("starting a new run clears the previous delta and measures from the reset baseline", () => {
  const handlers = new Map<string, Function>();
  const tracker = installContextEstimates({
    on: (name: string, fn: Function) => handlers.set(name, fn),
    getActiveTools: () => [], getAllTools: () => [],
  } as any, () => {});
  const session = SessionManager.inMemory();
  const ctx = { sessionManager: session, getSystemPrompt: () => "" };
  handlers.get("session_start")!({}, ctx);
  session.appendMessage({ role: "user", content: "x".repeat(4000), timestamp: 1 });
  handlers.get("agent_settled")!({}, ctx);
  assert.equal(tracker.getDelta(), 1000);

  tracker.resetDelta();
  assert.equal(tracker.getDelta(), undefined, "a new run must immediately discard the previous delta");
  assert.equal(tracker.getSnapshot().total, 1000, "reset preserves the current snapshot");
  session.appendMessage({ role: "user", content: "x".repeat(400), timestamp: 2 });
  handlers.get("context")!({ messages: session.buildSessionProjection().messages }, ctx);
  assert.equal(tracker.getSnapshot().total, 1100);
  assert.equal(tracker.getDelta(), undefined, "context refresh must not resurrect the previous delta");
  handlers.get("turn_end")!({}, ctx);
  assert.equal(tracker.getDelta(), 100, "the new run measures only its own growth");
  handlers.get("agent_settled")!({}, ctx);
  assert.equal(tracker.getDelta(), 100);
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

function trackingTracker(options: { systemPrompt?: string; active?: string[]; all?: unknown[] } = {}) {
  const handlers = new Map<string, Function>();
  const state = { systemPrompt: options.systemPrompt ?? "", active: options.active ?? [], all: options.all ?? [], changes: 0 };
  const tracker = installContextEstimates({
    on: (name: string, fn: Function) => handlers.set(name, fn),
    getActiveTools: () => state.active,
    getAllTools: () => state.all,
  } as any, () => { state.changes += 1; });
  const session = SessionManager.inMemory();
  const project = session.buildSessionProjection.bind(session);
  let projections = 0;
  session.buildSessionProjection = () => { projections += 1; return project(); };
  const ctx = { sessionManager: session, getSystemPrompt: () => state.systemPrompt };
  return { tracker, handlers, state, session, ctx, projections: () => projections };
}

test("turn_end and the agent_settled that follows reuse one projection for the same branch", () => {
  const { tracker, handlers, session, ctx, projections, state } = trackingTracker();
  handlers.get("session_start")!({}, ctx);
  const base = projections();
  session.appendMessage({ role: "user", content: "x".repeat(4000), timestamp: 1 } as any);
  handlers.get("turn_end")!({}, ctx);
  assert.equal(projections(), base + 1);
  const settled = tracker.getSnapshot();
  assert.equal(tracker.getDelta(), 1000);

  handlers.get("agent_settled")!({}, ctx);
  assert.equal(projections(), base + 1, "an unchanged leaf must not rebuild the projection");
  assert.equal(tracker.getDelta(), 1000, "delta semantics survive the reuse");
  assert.equal(tracker.getSnapshot().total, settled.total);
  assert.equal(state.changes, 3, "every refresh still notifies the UI");

  session.appendMessage({ role: "user", content: "x".repeat(400), timestamp: 2 } as any);
  handlers.get("agent_settled")!({}, ctx);
  assert.equal(projections(), base + 2, "a new leaf rebuilds the projection");
  assert.equal(tracker.getDelta(), 100);
});

test("the reused message estimate still re-reads the system prompt and active tools", () => {
  const { tracker, handlers, session, ctx, projections, state } = trackingTracker({ active: ["sample_runner"], all: [tool] });
  handlers.get("session_start")!({}, ctx);
  const base = projections();
  session.appendMessage({ role: "user", content: "abcd", timestamp: 1 } as any);
  handlers.get("turn_end")!({}, ctx);
  const first = tracker.getSnapshot();
  const tokens = (name: string) => tracker.getSnapshot().categories.find(category => category.name === name)!.tokens;
  assert.equal(tokens("System"), 0);
  assert.equal(tokens("Tools"), Math.ceil(JSON.stringify(tool).length / 4));

  state.systemPrompt = "abcd";
  state.active = [];
  handlers.get("agent_settled")!({}, ctx);
  assert.equal(projections(), base + 1, "the message projection is still reused");
  assert.equal(tokens("System"), 1, "a changed system prompt is picked up without a new leaf");
  assert.equal(tokens("Tools"), 0, "a changed tool loadout is picked up without a new leaf");
  assert.equal(tokens("Messages"), first.categories.find(category => category.name === "Messages")!.tokens);
});

test("branch switches and compaction rebuild the message estimate", () => {
  const { tracker, handlers, session, ctx, projections } = trackingTracker();
  handlers.get("session_start")!({}, ctx);
  const base = projections();
  const user = session.appendMessage({ role: "user", content: "x".repeat(4000), timestamp: 1 } as any);
  session.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "read-1", content: [{ type: "text", text: "x".repeat(40000) }], isError: false, timestamp: 2 } as any);
  handlers.get("turn_end")!({}, ctx);
  assert.equal(projections(), base + 1);

  session.branch(user);
  const beforeSwitch = projections();
  handlers.get("session_tree")!({}, ctx);
  assert.equal(projections() - beforeSwitch, 1, "a branch switch rebuilds");
  assert.equal(tracker.getSnapshot().total, 1000);

  // appendCompaction projects internally, so measure only the handler's own work.
  session.appendCompaction("kept summary", null, 1000);
  const beforeCompact = projections();
  handlers.get("session_compact")!({}, ctx);
  assert.equal(projections() - beforeCompact, 1, "compaction rebuilds");
  assert.ok(tracker.getSnapshot().categories.find(category => category.name === "Summary")!.tokens! > 0);
});

test("a context edit appended after a reuse rebuilds instead of serving the old projection", () => {
  const { tracker, handlers, session, ctx, projections } = trackingTracker();
  handlers.get("session_start")!({}, ctx);
  const base = projections();
  const user = session.appendMessage({ role: "user", content: "x".repeat(4000), timestamp: 1 } as any);
  handlers.get("turn_end")!({}, ctx);
  handlers.get("agent_settled")!({}, ctx);
  assert.equal(projections(), base + 1);
  session.appendContextEdit(user, { content: "abcd" });
  handlers.get("turn_end")!({}, ctx);
  assert.equal(projections(), base + 2);
  assert.equal(tracker.getSnapshot().total, 1);
});
