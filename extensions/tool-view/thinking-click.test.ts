import assert from "node:assert/strict";
import test from "node:test";
import {
  AssistantMessageComponent,
  VERSION,
  type MarkdownTransformer,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { initTheme, getMarkdownTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { installThinkingClickAdapter } from "./thinking-click.ts";
import { transformThinkingText } from "./thinking.ts";
import type { ToolViewMode } from "./types.ts";

const lineText = (component: AssistantMessageComponent) =>
  component.render(72).map(stripTerminalSequences);

function clickAt(component: AssistantMessageComponent, needle: string): void {
  const lines = lineText(component);
  const row = lines.findIndex((line) => line.includes(needle));
  assert.ok(row >= 0, `Expected a click target containing ${needle}`);
  const result = component.handleMouse?.({
    type: "click", button: "left",
    x: 4, y: row,
    screenX: 4, screenY: row,
    width: 72, height: lines.length,
  } as any);
  assert.equal(result?.handled, true);
}

test("Compact expands only the clicked Thinking, then collapses, preserving other blocks", () => {
  assert.ok(["1.1.0", "1.2.0"].includes(VERSION), `Update compatibility test for Pi ${VERSION}`);
  initTheme("dark");
  let mode: ToolViewMode = "compact";
  const ours: MarkdownTransformer = (markdown, ctx) => transformThinkingText(markdown, ctx, mode, true);
  const other: MarkdownTransformer = (markdown, ctx) =>
    ctx.messageType === "assistant-thinking" ? markdown.replaceAll("other", "OTHER") : markdown;
  const adapter = installThinkingClickAdapter(() => mode, ours);
  assert.equal(adapter.enabled, true);
  const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, [other, ours]);
  const first = "UNIQUE_FIRST_SECRET";
  const second = "UNIQUE_SECOND_SECRET";
  const message: any = {
    role: "assistant", stopReason: "stop",
    content: [
      { type: "thinking", thinking: `${first} other\nFirst detail` },
      { type: "text", text: "Between sections" },
      { type: "thinking", thinking: `${second}\nSecond detail` },
    ],
  };

  component.updateContent(message, false);
  assert.equal(lineText(component).filter((l) => l.includes("Thinking · Done")).length, 2);
  assert.match(lineText(component).join("\n"), /Thinking · Done\s+▸ Expand/);
  assert.ok(component.render(72).join("\n").includes(String.fromCharCode(27) + "[2m▸ Expand"),
    "collapsed hint should retain faint styling in the real Pi renderer");
  clickAt(component, "Thinking · Done");
  assert.match(lineText(component).join("\n"), /Thinking · Done\s+▾ Collapse/);
  assert.ok(component.render(72).join("\n").includes(String.fromCharCode(27) + "[2m▾ Collapse"),
    "expanded hint should retain faint styling in the real Pi renderer");
  assert.match(lineText(component).join("\n"), /UNIQUE_FIRST_SECRET OTHER/);
  assert.doesNotMatch(lineText(component).join("\n"), /UNIQUE_SECOND_SECRET/);
  assert.equal(lineText(component).filter((l) => l.includes("Thinking · Done") && !l.includes("▾")).length, 1);
  // Pi rerenders after resize, theme change or a new stream update. The
  // expansion state must be preserved for the same assistant component.
  component.setHiddenThinkingLabel("Thinking...");
  assert.match(lineText(component).join("\n"), /UNIQUE_FIRST_SECRET OTHER/);
  clickAt(component, "▾ Collapse");
  assert.equal(lineText(component).filter((l) => l.includes("Thinking · Done")).length, 2);

  // Expand the second block only: hit its second Done row.
  const rows = lineText(component);
  const secondRow = rows.length - 1 - [...rows].reverse().findIndex((line) => line.includes("Thinking · Done"));
  assert.ok(secondRow >= 0);
  component.handleMouse?.({
    type: "click", button: "left", x: 4, y: secondRow,
    screenX: 4, screenY: secondRow, width: 72, height: rows.length,
  } as any);
  assert.doesNotMatch(lineText(component).join("\n"), /UNIQUE_FIRST_SECRET/);
  assert.match(lineText(component).join("\n"), /UNIQUE_SECOND_SECRET/);

  mode = "normal";
  adapter.reset();
  component.setHiddenThinkingLabel("Thinking...");
  assert.match(lineText(component).join("\n"), /UNIQUE_FIRST_SECRET/);
  assert.match(lineText(component).join("\n"), /UNIQUE_SECOND_SECRET/);
  clickAt(component, "UNIQUE_FIRST_SECRET");
  assert.match(lineText(component).join("\n"), /UNIQUE_FIRST_SECRET/, "Normal mode must remain fully visible");

  mode = "hidden";
  adapter.reset();
  component.setHiddenThinkingLabel("Thinking...");
  assert.equal(lineText(component).filter(l => l.includes("Thinking · Hidden")).length, 2);
  clickAt(component, "Thinking · Hidden");
  assert.equal(lineText(component).filter(l => l.includes("Thinking · Hidden")).length, 2);
  assert.doesNotMatch(lineText(component).join("\n"), /UNIQUE_FIRST_SECRET/);
  assert.doesNotMatch(lineText(component).join("\n"), /Thinking\.\.\./);
});

test("multiple messages have independent expanded state, including live-stream refresh", () => {
  initTheme("dark");
  let mode: ToolViewMode = "compact";
  const ours: MarkdownTransformer = (markdown, ctx) => transformThinkingText(markdown, ctx, mode, true);
  const adapter = installThinkingClickAdapter(() => mode, ours);
  const first = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, [ours]);
  const second = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, [ours]);
  const make = (text: string) => ({
    role: "assistant", stopReason: "stop",
    content: [{ type: "thinking", thinking: text }],
  }) as any;
  first.updateContent(make("FIRST_MESSAGE_FULL_TEXT"), false);
  second.updateContent(make("SECOND_MESSAGE_FULL_TEXT"), false);
  clickAt(first, "Thinking · Done");
  assert.match(lineText(first).join("\n"), /FIRST_MESSAGE_FULL_TEXT/);
  assert.match(lineText(second).join("\n"), /Thinking · Done/);
  first.updateContent(make("FIRST_MESSAGE_FULL_TEXT stream continuation\nintermediate detail\nmore detail\nnewest detail"), true);
  assert.match(lineText(first).join("\n"), /FIRST_MESSAGE_FULL_TEXT stream continuation/);
  assert.match(lineText(first).join("\n"), /Thinking · Live\s+▾ Collapse/);
  clickAt(first, "▾ Collapse");
  assert.doesNotMatch(lineText(first).join("\n"), /FIRST_MESSAGE_FULL_TEXT/);
  assert.match(lineText(first).join("\n"), /Thinking · Live\s+▸ Expand/);
  adapter.reset();
  first.setHiddenThinkingLabel("Thinking...");
  assert.match(lineText(first).join("\n"), /newest detail/, "streaming compact tail is restored");
});
