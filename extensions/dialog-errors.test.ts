import assert from "node:assert/strict";
import test from "node:test";
import { t } from "./i18n.ts";
import { showMcpStatusDialog } from "./mcp/status-dialog.ts";
import { showResourceDialog, type ResourceEntry } from "./resources.ts";

const rows: ResourceEntry[] = [{ name: "skill", description: "Review code", content: "full skill" }];

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Fail the test if a dialog promise escapes without notify. */
async function withoutUnhandled(run: () => void): Promise<void> {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    run();
    await settle();
    assert.deepEqual(unhandled, [], "dialog failures must be handled");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

test("a rejected resource picker or preview notifies and does not reject outward", async () => {
  const notices: Array<{ message: string; level: string }> = [];
  const notify = (message: string, level: "info" | "warning" | "error") => notices.push({ message, level });
  await withoutUnhandled(() => {
    showResourceDialog({ ui: {
      async select() { throw new Error("picker down"); },
      async editor() { return undefined; },
      notify,
    } }, "skills", rows);
  });
  assert.deepEqual(notices, [{ message: t("resource.openFailed", { error: "picker down" }), level: "error" }]);

  notices.length = 0;
  await withoutUnhandled(() => {
    showResourceDialog({ ui: {
      async select(_title, choices) { return choices[0]; },
      async editor() { throw new Error("preview down"); },
      notify,
    } }, "skills", rows);
  });
  assert.deepEqual(notices, [{ message: t("resource.openFailed", { error: "preview down" }), level: "error" }]);

  notices.length = 0;
  await withoutUnhandled(() => {
    showResourceDialog({ ui: {
      async select() { return undefined; },
      async editor() { throw new Error("direct preview down"); },
      notify,
    } }, "agents", rows, "full agents");
  });
  assert.deepEqual(notices, [{ message: t("resource.openFailed", { error: "direct preview down" }), level: "error" }]);
});

test("a rejected MCP status picker or detail notifies and does not reject outward", async () => {
  const notices: Array<{ message: string; level: string }> = [];
  const notify = (message: string, level: "info" | "warning" | "error") => notices.push({ message, level });
  const snapshot = {
    servers: [{ name: "docs", source: "project" as const, enabled: true, loaded: true, connection: "connected" as const }],
    warnings: [],
  };
  await withoutUnhandled(() => {
    showMcpStatusDialog({ ui: {
      async select() { throw new Error("status down"); },
      async editor() { return undefined; },
      notify,
    } }, snapshot);
  });
  assert.deepEqual(notices, [{ message: t("mcp.openFailed", { error: "status down" }), level: "error" }]);

  notices.length = 0;
  await withoutUnhandled(() => {
    showMcpStatusDialog({ ui: {
      async select(_title, choices) { return choices[0]; },
      async editor() { throw new Error("detail down"); },
      notify,
    } }, snapshot);
  });
  assert.deepEqual(notices, [{ message: t("mcp.openFailed", { error: "detail down" }), level: "error" }]);
});

test("an empty MCP snapshot still notifies instead of opening a picker", () => {
  const notices: string[] = [];
  showMcpStatusDialog({ ui: {
    async select() { throw new Error("should not select"); },
    async editor() { return undefined; },
    notify(message) { notices.push(message); },
  } }, { servers: [], warnings: [] });
  assert.deepEqual(notices, [t("mcp.none")]);
});
