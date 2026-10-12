import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { installToolViewController } from "./controller.ts";

const privateCode = "const apiKey = 'DO_NOT_DISPLAY';\ntext(await tools.search({ token: apiKey }));";
const secretOutput = "PRIVATE_OUTPUT_TEXT";
const privateArgs = '{"token":"PRIVATE_NESTED_ARGS"}';
const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

test("Codemode uses the official native renderer in Normal, summary in Compact, and no row in Hidden", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codemode-view-"));
  const renderers: ToolRendererResolver[] = [];
  const callbacks = new Map<string, Array<(event: any, ctx: any) => void>>();
  let registered = 0;
  let expanded = false;
  const expansions: boolean[] = [];
  const ui = {
    setStatus() {},
    notify() {},
    getToolsExpanded: () => expanded,
    setToolsExpanded(next: boolean) { expanded = next; expansions.push(next); },
  };
  const ctx = { mode: "tui", ui, sessionManager: { getSessionId: () => "session" }, cwd: directory } as any;
  const pi = {
    registerTool() { registered++; throw new Error("Tool execution must remain with Pi"); },
    registerToolRenderer(resolver: ToolRendererResolver) { renderers.push(resolver); },
    registerCommand() {},
    registerShortcut() {},
    getCommands: () => [],
    on(event: string, cb: (event: any, ctx: any) => void) {
      callbacks.set(event, [...(callbacks.get(event) ?? []), cb]);
    },
  } as any;
  try {
    const controller = await installToolViewController(pi, { modeFile: join(directory, "mode.json") });
    assert.equal(renderers.length, 1);
    assert.equal(registered, 0);
    for (const callback of callbacks.get("session_start") ?? []) callback({}, ctx);

    const { codemodeRenderers } = await import(
      "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/renderer.js"
    );
    const { initTheme } = await import(
      "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
    );
    const { ToolExecutionComponent } = await import(
      "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js"
    );
    initTheme("dark");
    const resolver = renderers[0]!;
    const native: ToolRenderers = { ...codemodeRenderers };
    assert.strictEqual(resolver("custom_tool", () => native), native);
    const renderer = resolver("codemode", () => native)!;
    assert.equal(renderer.renderShell, "self");

    const result = {
      content: [
        { type: "text" as const, text: "Script completed\nWall time 1.2 seconds\nOutput:\n" },
        { type: "text" as const, text: secretOutput + "\nresult" },
        { type: "image" as const, data: "abc", mimeType: "image/png" },
      ],
      details: {
        calls: [
          { id: "x/1", name: "search", args: privateArgs, status: "ok", durationMs: 200 },
          { id: "x/2", name: "write", args: privateArgs, status: "error", error: secretOutput, durationMs: 350 },
          { id: "x/3", name: "read", args: privateArgs, status: "cancelled", durationMs: 50 },
        ],
      },
      isError: false,
      durationMs: 1250,
    };
    const transcript = new ToolExecutionComponent(
      "codemode", "call", { code: privateCode }, {}, renderer, { requestRender() {} } as any, directory,
    );
    transcript.updateResult(result, false);
    const visible = () => stripAnsi(transcript.render(110).join("\n"));

    // Default compact mode summarizes metadata, never executable code or nested arguments.
    assert.match(visible(), /codemode.*2 lines/);
    assert.match(visible(), /3 calls/);
    assert.match(visible(), /1 成功/);
    assert.match(visible(), /1 失败/);
    assert.match(visible(), /1 取消/);
    assert.match(visible(), /2 行输出/);
    assert.match(visible(), /1 images/);
    assert.match(visible(), /1.3s/);
    assert.doesNotMatch(visible(), /DO_NOT_DISPLAY|PRIVATE_OUTPUT_TEXT|PRIVATE_NESTED_ARGS/);
    transcript.setExpanded(true);
    assert.doesNotMatch(visible(), /DO_NOT_DISPLAY|PRIVATE_OUTPUT_TEXT|PRIVATE_NESTED_ARGS/);

    await controller.setMode("normal", ctx);
    transcript.setExpanded(true);
    assert.match(visible(), /DO_NOT_DISPLAY/);
    assert.match(visible(), /PRIVATE_OUTPUT_TEXT/);
    assert.match(visible(), /PRIVATE_NESTED_ARGS/);

    await controller.setMode("hidden", ctx);
    transcript.setExpanded(false);
    assert.deepEqual(transcript.render(110), []);
    transcript.setExpanded(true);
    assert.deepEqual(transcript.render(110), []);

    await controller.setMode("compact", ctx);
    transcript.setExpanded(false);
    assert.match(visible(), /3 calls/);

    // The in-progress callback is a metadata-only summary as well.
    transcript.updateResult({
      content: [], details: {
        calls: [
          { id: "y/1", name: "search", args: privateArgs, status: "ok" },
          { id: "y/2", name: "read", args: privateArgs, status: "running" },
        ],
      }, isError: false,
    }, true);
    assert.match(visible(), /运行中/);
    assert.match(visible(), /1 进行中/);
    assert.doesNotMatch(visible(), /DO_NOT_DISPLAY|PRIVATE_NESTED_ARGS/);

    transcript.updateResult({
      content: [{ type: "text", text: secretOutput }],
      details: { calls: [{ id: "z/1", name: "write", args: privateArgs, status: "error", error: secretOutput }] },
      isError: true,
      durationMs: 400,
    }, false);
    transcript.setExpanded(true);
    assert.match(visible(), /执行失败/);
    assert.match(visible(), /1 失败/);
    assert.match(visible(), /400ms/);
    assert.doesNotMatch(visible(), /DO_NOT_DISPLAY|PRIVATE_OUTPUT_TEXT|PRIVATE_NESTED_ARGS/);
    assert.equal(expansions.length, 6, "mode switching requests transcript refresh");
    assert.equal(registered, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codemode Compact handles missing, malformed, or very large metadata without throwing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codemode-empty-"));
  let resolver: ToolRendererResolver | undefined;
  const pi = {
    registerToolRenderer(cb: ToolRendererResolver) { resolver = cb; },
    registerCommand() {}, registerShortcut() {}, on() {},
  } as any;
  try {
    await installToolViewController(pi, { modeFile: join(directory, "mode.json") });
    const renderer = resolver!("codemode", () => ({}))!;
    const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value } as any;
    const context = { args: { code: 123 }, state: {}, durationMs: NaN, isError: false } as any;
    const call = renderer.renderCall!({ code: 123 }, theme, context);
    assert.match(call.render(100).join(""), /codemode/);
    const response = renderer.renderResult!(
      { content: [], details: { calls: [{ status: "unknown" }, null, { status: "ok" }] } },
      { isPartial: false, expanded: false }, theme, context,
    );
    assert.match(response.render(100).join(""), /3 calls/);
    assert.match(response.render(100).join(""), /1 成功/);
    assert.doesNotMatch(response.render(100).join(""), /NaN/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
