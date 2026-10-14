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
    registerTool() { throw new Error("Tool View must not register tools"); },
    registerToolRenderer() {},
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
    assert.equal(statuses.at(-1), "Tool View: Normal");
    assert.equal(notices.at(-1), "Tool View: Normal");
    assert.deepEqual(expandedValues.slice(-2), [true, false]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the single Tool View mode controls Thinking, persists once, and refreshes historical messages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "unified-tool-view-"));
  const modeFile = join(directory, "mode.json");
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const notices: string[] = [];
  const expanded: boolean[] = [];
  let transformer: any;
  let refreshed = 0;
  let toolsExpanded = false;
  let registeredToolDefinitions = 0;
  const pi = {
    registerTool() { registeredToolDefinitions++; },
    registerToolRenderer() {},
    registerMarkdownTransformer(callback: any) { transformer = callback; },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerShortcut() {},
    getSettings: () => ({ hideThinkingBlock: false }),
    getCommands: () => [],
    on(name: string, cb: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), cb]); },
  } as any;
  const ctx = {
    mode: "tui",
    sessionManager: { getSessionId: () => "current-session" },
    ui: {
      setStatus() {},
      notify(message: string) { notices.push(message); },
      getToolsExpanded: () => toolsExpanded,
      setToolsExpanded(value: boolean) { expanded.push(value); toolsExpanded = value; },
      setHiddenThinkingLabel() { refreshed++; },
    },
  } as any;
  const context = { messageType: "assistant-thinking", isStreaming: false, availableWidth: 40 };
  try {
    const controller = await installToolViewController(pi, { modeFile });
    assert.equal(controller.getMode(), "compact");
    assert.equal(typeof transformer, "function");
    assert.match(transformer("private thought", context), /Thinking · Done.*▸ Expand/);
    for (const callback of handlers.get("session_start") ?? []) callback({}, ctx);

    await controller.setMode("normal", ctx);
    assert.equal(transformer("private thought", context), "private thought");
    await commands.get("tool-view").handler("hidden", ctx);
    assert.equal(transformer("private thought", context), "Thinking · Hidden");
    assert.equal(controller.getMode(), "hidden");
    assert.deepEqual(JSON.parse(await readFile(modeFile, "utf8")), { mode: "hidden" });
    assert.equal(refreshed, 2, "one public refresh per mode change, including historical Thinking");
    assert.deepEqual(expanded, [true, false, true, false], "tool transcript refresh still occurs");
    assert.equal(commands.has("thinking-view"), false, "no separate Thinking command");
    assert.equal(registeredToolDefinitions, 0);
    assert.match(notices.join("\n"), /Tool View: Hidden/);

    const restarted = await installToolViewController(pi, { modeFile });
    assert.equal(restarted.getMode(), "hidden", "existing mode file persists Thinking and Tools together");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unified Tool View warns if Pi hides Thinking natively without breaking tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-thinking-fallback-"));
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  const pi = {
    registerToolRenderer() {},
    registerCommand() {},
    registerShortcut() {},
    getSettings: () => ({ hideThinkingBlock: true }),
    getCommands: () => [],
    on(name: string, cb: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), cb]); },
  } as any;
  const ctx = {
    mode: "tui",
    sessionManager: { getSessionId: () => "current-session" },
    ui: {
      setStatus() {},
      notify(message: string) { notices.push(message); },
      getToolsExpanded: () => false,
      setToolsExpanded() {},
    },
  } as any;
  try {
    const controller = await installToolViewController(pi, { modeFile: join(directory, "mode.json") });
    for (const callback of handlers.get("session_start") ?? []) callback({}, ctx);
    await controller.setMode("normal", ctx);
    assert.equal(controller.getMode(), "normal");
    assert.match(notices.join("\n"), /hideThinkingBlock: false/);
    assert.match(notices.join("\n"), /cannot transform Thinking display/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
