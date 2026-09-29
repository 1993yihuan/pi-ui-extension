import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installToolViewController } from "./controller.ts";

type Handler = (event: any, ctx: any) => unknown;

test("applies a mode change from another context wrapper in the active session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-view-controller-"));
  const modeFile = join(directory, "mode.json");
  const handlers = new Map<string, Handler[]>();
  const statuses: string[] = [];
  const notices: string[] = [];
  const expandedValues: boolean[] = [];
  const sessionManager = { getSessionId: () => "session-1" };
  let toolsExpanded = false;

  const pi = {
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
    getCommands: () => [],
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as any;
  const ui = {
    setStatus(_id: string, value: string | undefined) { if (value) statuses.push(value); },
    notify(message: string) { notices.push(message); },
    getToolsExpanded: () => toolsExpanded,
    setToolsExpanded(value: boolean) {
      toolsExpanded = value;
      expandedValues.push(value);
    },
  };

  try {
    const controller = await installToolViewController(pi, { modeFile });
    const sessionCtx = { mode: "tui", ui, sessionManager } as any;
    for (const handler of handlers.get("session_start") ?? []) handler({}, sessionCtx);

    // Pi may create another ExtensionContext wrapper for a panel/command while
    // retaining the same active SessionManager identity.
    const panelCtx = { mode: "tui", ui, sessionManager } as any;
    await controller.setMode("normal", panelCtx);

    assert.equal(controller.getMode(), "normal");
    assert.deepEqual(JSON.parse(await readFile(modeFile, "utf8")), { mode: "normal" });
    assert.equal(statuses.at(-1), "工具：完整");
    assert.equal(notices.at(-1), "工具显示模式：完整（normal）");
    assert.deepEqual(expandedValues.slice(-2), [true, false]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
