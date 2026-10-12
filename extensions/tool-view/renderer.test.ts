import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import type { ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { installToolViewController } from "./controller.ts";

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as any;

test("reports an actionable compatibility error on Pi without the renderer API", async () => {
  await assert.rejects(
    installToolViewController({} as any, { modeFile: join(tmpdir(), "pi-ui-missing-renderer-test.json") }),
    /Update Pi.*this extension/,
  );
});

test("uses one official renderer resolver without replacing or executing Pi tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-renderer-"));
  const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
  const resolvers: ToolRendererResolver[] = [];
  const commands = new Map<string, any>();
  const counters = { nativeCall: 0, nativeResult: 0, registered: 0 };
  let expanded = false;
  const expandedChanges: boolean[] = [];
  const ctx = {
    mode: "tui",
    cwd: directory,
    sessionManager: { getSessionId: () => "renderer-test" },
    ui: {
      setStatus() {},
      notify() {},
      getToolsExpanded: () => expanded,
      setToolsExpanded(value: boolean) { expanded = value; expandedChanges.push(value); },
    },
  } as any;
  const pi = {
    registerTool() { counters.registered++; throw new Error("Must not shadow Pi tool"); },
    registerToolRenderer(resolver: ToolRendererResolver) { resolvers.push(resolver); },
    registerCommand(name: string, data: any) { commands.set(name, data); },
    registerShortcut() {},
    getCommands: () => [],
    on(name: string, handler: (event: any, ctx: any) => void) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as any;
  const native: ToolRenderers = {
    renderShell: "default",
    renderCall(_args, _theme, context) {
      counters.nativeCall++;
      context.state.seenCall = true;
      return new Text("NATIVE CALL", 0, 0);
    },
    renderResult(_result, _options, _theme, context) {
      counters.nativeResult++;
      assert.equal(context.state.seenCall, true);
      return new Text("NATIVE RESULT", 0, 0);
    },
  };
  const result = { content: [{ type: "text" as const, text: "first\nsecond" }], details: {}, isError: false };
  const render = (renderer: ToolRenderers, state: any, args: any, opts: any = {}) => {
    const context = {
      cwd: directory, state, args, isPartial: false, isError: false,
      expanded: false, outputPad: 1, ...opts,
    } as any;
    const call = renderer.renderCall!(args, theme, context);
    const response = renderer.renderResult!(result, { expanded: context.expanded, isPartial: false }, theme, context);
    return [call.render(120).join("\n"), response.render(120).join("\n")].join("\n");
  };
  try {
    const controller = await installToolViewController(pi, { modeFile: join(directory, "mode.json") });
    assert.equal(resolvers.length, 1);
    assert.equal(counters.registered, 0);
    for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
    const resolver = resolvers[0]!;

    // Do not alter unrelated tools or their renderer definitions.
    assert.strictEqual(resolver("other", () => native), native);
    for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
      assert.equal(resolver(name, () => native)?.renderShell, "self");
    }

    const read = resolver("read", () => native)!;
    const args = { path: "example.ts" };
    const state = {};
    assert.match(render(read, state, args), /read example.ts/);
    assert.match(render(read, state, args), /2 lines/);
    assert.equal(counters.nativeCall, 0, "compact must not run native renderer unnecessarily");

    await controller.setMode("normal", ctx);
    const normal = render(read, state, args);
    assert.match(normal, /NATIVE CALL/);
    assert.match(normal, /NATIVE RESULT/);
    assert.equal(counters.nativeCall, 1);
    assert.equal(counters.nativeResult, 1);

    await controller.setMode("hidden", ctx);
    const hidden = render(read, state, args);
    assert.equal(hidden, "\n", "hidden mode must produce no visible call or result");
    assert.equal(counters.nativeResult, 2, "finishing a native renderer must release its resources");

    // Skill reads retain their original renderer even in hidden mode.
    assert.match(
      render(read, {}, { path: join(directory, ".pi", "skills", "review", "SKILL.md") }),
      /NATIVE CALL/,
    );
    await controller.setMode("compact", ctx);
    assert.match(render(read, {}, args, { expanded: true }), /NATIVE CALL/);
    assert.match(render(read, {}, args, { isError: true }), /NATIVE CALL/);
    const nextSelf = { ...native, renderShell: "self" as const };
    await controller.setMode("normal", ctx);
    assert.match(render(resolver("read", () => nextSelf)!, {}, args), /NATIVE RESULT/);

    // Exercise the actual Pi transcript component, not only renderer callbacks.
    const { ToolExecutionComponent } = await import(
      "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js"
    );
    const { initTheme } = await import(
      "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
    );
    initTheme("dark");
    await controller.setMode("compact", ctx);
    const transcript = new ToolExecutionComponent(
      "read", "renderer-call", args, {}, read, { requestRender() {} } as any, directory,
    );
    transcript.updateResult(result, false);
    const plain = (lines: string[]) => lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
    assert.match(plain(transcript.render(100)), /read example.ts/);
    await controller.setMode("hidden", ctx);
    transcript.setExpanded(false);
    assert.deepEqual(transcript.render(100), [], "hidden mode should remove the complete transcript row");
    await controller.setMode("normal", ctx);
    transcript.setExpanded(false);
    assert.match(plain(transcript.render(100)), /NATIVE CALL/);

    await controller.setMode("compact", ctx);
    assert.deepEqual(JSON.parse(await readFile(join(directory, "mode.json"), "utf8")), { mode: "compact" });
    assert.equal(expandedChanges.length, 16, "every mode change should refresh historical transcript rows");
    assert.equal(commands.has("tool-view"), true);
    assert.equal(counters.registered, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
