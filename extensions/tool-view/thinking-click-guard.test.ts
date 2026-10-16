import assert from "node:assert/strict";
import test from "node:test";
import {
  AssistantMessageComponent,
  VERSION,
  type MarkdownTransformer,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { initTheme, getMarkdownTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { installThinkingClickGuard } from "./thinking-click-guard.ts";
import { transformThinkingText } from "./thinking.ts";
import type { ToolViewMode } from "./types.ts";

const WIDTH = 70;
function rendered(component: AssistantMessageComponent): string[] {
  return component.render(WIDTH).map(stripTerminalSequences);
}
function click(component: AssistantMessageComponent, needle: string, last = false): void {
  const lines = rendered(component);
  const index = last ? lines.map((line, i) => line.includes(needle) ? i : -1).filter(i => i >= 0).at(-1)!
    : lines.findIndex((line) => line.includes(needle));
  assert.ok(index >= 0, `click target ${needle} not found`);
  const result = component.handleMouse?.({
    type: "click", button: "left", x: 3, y: index,
    screenX: 3, screenY: index, width: WIDTH, height: lines.length,
  } as any);
  assert.equal(result?.handled, true);
}
function message(...content: Array<{ type: string; thinking?: string; text?: string }>): any {
  return { role: "assistant", content, stopReason: "stop" };
}

test("Compact Thinking duration does not disappear when clicked; Normal keeps native click behavior", () => {
  assert.ok(["1.2.0", "1.3.0"].includes(VERSION), `compatibility check required for Pi ${VERSION}`);
  initTheme("dark");
  const prototype = AssistantMessageComponent.prototype;
  const initial = prototype.updateContent;
  let mode: ToolViewMode = "compact";
  const transformer: MarkdownTransformer = (text, ctx) =>
    transformThinkingText(text, ctx, mode, () => ({ ms: 2045, approximate: false }));
  try {
    assert.equal(installThinkingClickGuard(() => mode, transformer), true);
    const c = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, [transformer]);
    c.updateContent(message(
      { type: "thinking", thinking: "Private A" },
      { type: "text", text: "Public response" },
      { type: "thinking", thinking: "Private B" },
    ), false);
    assert.equal(rendered(c).filter(line => line.includes("Thinking · 2s")).length, 2);
    click(c, "Thinking · 2s");
    click(c, "Thinking · 2s", true);
    assert.equal(rendered(c).filter(line => line.includes("Thinking · 2s")).length, 2);
    assert.doesNotMatch(rendered(c).join("\n"), /Thinking\.\.\.|Private A|Private B/);
    assert.match(rendered(c).join("\n"), /Public response/);

    mode = "normal";
    c.setHiddenThinkingLabel("Thinking...");
    assert.match(rendered(c).join("\n"), /Private A/);
    click(c, "Private A");
    assert.match(rendered(c).join("\n"), /Thinking\.\.\./);
    click(c, "Thinking...");
    assert.match(rendered(c).join("\n"), /Private A/, "Normal can restore native hidden Thinking");

    mode = "hidden";
    c.setHiddenThinkingLabel("Thinking...");
    assert.equal(rendered(c).filter(line => line.includes("Thinking · 2s")).length, 2);
    click(c, "Thinking · 2s");
    click(c, "Thinking · 2s", true);
    assert.equal(rendered(c).filter(line => line.includes("Thinking · 2s")).length, 2);
    assert.doesNotMatch(rendered(c).join("\n"), /Thinking\.\.\./);
    assert.doesNotMatch(rendered(c).join("\n"), /Private A|Private B/);
    c.updateContent(message({ type: "thinking", thinking: "Private streaming details" }), true);
    assert.match(rendered(c).join("\n"), /Thinking… · 2s/);
    assert.doesNotMatch(rendered(c).join("\n"), /Private streaming details/);
    click(c, "Thinking… · 2s");
    assert.doesNotMatch(rendered(c).join("\n"), /Private streaming details|Thinking\.\.\./);
  } finally {
    prototype.updateContent = initial;
    delete (prototype as any)[Symbol.for("pi-ui-extension:thinking-click-guard")];
  }
});

test("click guard scopes interception to its own transformer and survives reinstall without stacking", () => {
  initTheme("dark");
  const prototype = AssistantMessageComponent.prototype;
  const initial = prototype.updateContent;
  let mode: ToolViewMode = "compact";
  const first: MarkdownTransformer = (text, ctx) => transformThinkingText(text, ctx, mode);
  const second: MarkdownTransformer = (text, ctx) => transformThinkingText(text, ctx, mode);
  try {
    assert.equal(installThinkingClickGuard(() => mode, first), true);
    assert.equal(installThinkingClickGuard(() => mode, second), true);
    const record = (prototype as any)[Symbol.for("pi-ui-extension:thinking-click-guard")];
    assert.equal(record.original, initial, "reinstall must not stack prototype wrappers");

    const newer = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, [second]);
    newer.updateContent(message({ type: "thinking", thinking: "Secret" }), false);
    click(newer, "Thinking");
    assert.match(rendered(newer).join("\n"), /Thinking/);

    const older = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, [first]);
    older.updateContent(message({ type: "thinking", thinking: "Private" }), false);
    click(older, "Thinking");
    assert.match(rendered(older).join("\n"), /Thinking\.\.\./,
      "the current extension must not change a different component's native clicks");

    const native = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1);
    native.updateContent(message({ type: "thinking", thinking: "Native" }), false);
    click(native, "Native");
    assert.match(rendered(native).join("\n"), /Thinking\.\.\./);
  } finally {
    prototype.updateContent = initial;
    delete (prototype as any)[Symbol.for("pi-ui-extension:thinking-click-guard")];
  }
});
