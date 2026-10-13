import assert from "node:assert/strict";
import test from "node:test";
import { createActivityTracker } from "./activity.ts";
import { ContextPanel } from "./panel.ts";

const theme = { fg: (_color: string, value: string) => value } as any;

test("aborted run keeps completed tools but marks interrupted tools as cancelled", () => {
  const tracker = createActivityTracker(process.cwd(), () => {});
  tracker.startRun(1_000);
  tracker.startTurn(0, 1_000);
  tracker.startTool({ toolCallId: "finished", toolName: "read", args: { path: "readme" } }, 1_100);
  tracker.finishTool({ toolCallId: "finished", isError: false }, 1_200);
  tracker.startTool({ toolCallId: "cancelled", toolName: "bash", args: { command: "sleep 5" } }, 1_300);
  tracker.settle(1_500, true);

  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.phase, "settled");
  assert.equal(snapshot.aborted, true);
  assert.equal(snapshot.completedCount, 1);
  assert.equal(snapshot.failedCount, 0);
  assert.equal(snapshot.cancelledCount, 1);
  assert.equal(snapshot.activeTools.length, 0);
  assert.deepEqual(snapshot.turns[0]?.tools.map((tool) => tool.status), ["done", "cancelled"]);
  tracker.settle(1_600, false);
  assert.equal(tracker.getSnapshot().aborted, true, "duplicate settle must not rewrite the run outcome");

  const panel = new ContextPanel(theme, {
    getDesiredWidth: () => 55,
    getActivity: () => snapshot,
    getUsage: () => undefined,
    getModel: () => "model",
    getThinkingLevel: () => "off",
  });
  assert.match(panel.render(55).join("\n"), /aborted/);

  tracker.startRun(2_000);
  assert.equal(tracker.getSnapshot().aborted, undefined);
  assert.equal(tracker.getSnapshot().cancelledCount, 0);
});

test("a non-aborted run still identifies orphaned tools as failed", () => {
  const tracker = createActivityTracker(process.cwd(), () => {});
  tracker.startRun(1_000);
  tracker.startTurn(0, 1_000);
  tracker.startTool({ toolCallId: "orphan", toolName: "bash", args: {} }, 1_010);
  tracker.settle(1_200, false);
  assert.equal(tracker.getSnapshot().aborted, undefined);
  assert.equal(tracker.getSnapshot().failedCount, 1);
  assert.equal(tracker.getSnapshot().cancelledCount, 0);
  assert.equal(tracker.getSnapshot().recentTools[0]?.status, "failed");
});
