import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { transformThinkingText } from "./thinking.ts";

test("one Tool View mode controls both Thinking and tool transcript presentation", () => {
  const source = [
    "Old first line", "Old second line", "Older discarded text",
    "Old fourth line", "Old fifth line",
    "Recent first", "Recent second", "Recent third", "Recent fourth",
    "Recent fifth", "Recent sixth", "Recent seventh",
  ].join("\n");
  const streaming = { messageType: "assistant-thinking", isStreaming: true, availableWidth: 30 } as const;
  const done = { ...streaming, isStreaming: false };

  assert.equal(transformThinkingText(source, streaming, "normal"), source);
  assert.equal(transformThinkingText(source, done, "normal"), source);
  assert.equal(transformThinkingText(source, streaming, "hidden"), "Thinking…");
  assert.equal(transformThinkingText(source, done, "hidden"), "Thinking");
  const compact = transformThinkingText(source, streaming, "compact");
  assert.doesNotMatch(compact, /Old first|Old second|Older discarded/);
  assert.match(compact, /Recent first/);
  assert.match(compact, /Recent seventh/);
  assert.equal(compact.split("\n").length, 8, "status plus seven recent wrapped rows");
  assert.equal(compact.split("\n").slice(1).length, 7);
  assert.ok(compact.split("\n").every((line) => visibleWidth(line) <= 30));
  assert.equal(transformThinkingText(source, done, "compact"), "Thinking");
  assert.equal(transformThinkingText(source, { ...streaming, messageType: "assistant" }, "hidden"), source);
  assert.equal(transformThinkingText(source, { ...streaming, messageType: "user" }, "compact"), source);

  const long = "abcdef ".repeat(180);
  const tail = transformThinkingText(long, { ...streaming, availableWidth: 15 }, "compact");
  assert.equal(tail.split("\n").length, 8, "a long paragraph keeps seven terminal-wrapped rows plus the header");
  assert.ok(tail.split("\n").every((line) => visibleWidth(line) <= 15));

  const wrapped = "OLD_PRIVATE_START\n" + "word ".repeat(40) + "\nLAST_VISIBLE";
  const narrow = transformThinkingText(wrapped, { ...streaming, availableWidth: 12 }, "compact");
  assert.equal(narrow.split("\n").length, 8, "wrap boundaries, not original newlines, determine the last seven rows");
  assert.doesNotMatch(narrow, /OLD_PRIVATE_START/);
  assert.match(narrow, /LAST_VISIBLE$/);
  assert.ok(narrow.split("\n").every((line) => visibleWidth(line) <= 12));
});

test("Thinking elapsed labels come from measured intervals and fit narrow terminals", () => {
  const done = { messageType: "assistant-thinking", isStreaming: false, availableWidth: 48 } as const;
  const live = { ...done, isStreaming: true };
  const measured = () => ({ ms: 5149, approximate: false });
  const inProgress = () => ({ ms: 5149, approximate: true });
  assert.equal(transformThinkingText("private details", done, "compact", measured), "Thinking · 5s");
  assert.equal(transformThinkingText("private details", done, "compact"), "Thinking");
  assert.equal(transformThinkingText("private details", done, "normal", measured), "private details");
  assert.equal(transformThinkingText("private details", done, "hidden", measured), "Thinking · 5s");
  assert.equal(transformThinkingText("private details", done, "hidden"), "Thinking");
  assert.equal(transformThinkingText("private details", live, "hidden", inProgress), "Thinking… · ~5s");
  assert.equal(transformThinkingText("private details", live, "hidden"), "Thinking…");
  const output = transformThinkingText("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine", live, "compact", inProgress);
  assert.match(output, /^Thinking… · ~5s\n/);
  assert.doesNotMatch(output, /\none\n|\ntwo\n/);
  assert.match(output, /nine$/);
  assert.equal(output.split("\n").length, 8, "status plus seven thinking rows");

  assert.equal(transformThinkingText("private details", done, "compact", () => ({ ms: 540, approximate: false })),
    "Thinking · 0.5s");
  assert.equal(transformThinkingText("private details", done, "hidden", () => ({ ms: 540, approximate: false })),
    "Thinking · 0.5s");
  assert.equal(transformThinkingText("private details", done, "compact", () => ({ ms: 65000, approximate: false })),
    "Thinking · 1m05s");
  for (const width of [5, 8, 12, 16, 18, 24, 26, 27, 34, 72]) {
    for (const ctx of [done, live]) {
      for (const mode of ["compact", "hidden"] as const) {
        const lines = transformThinkingText("a long sentence ".repeat(40), {
          ...ctx, availableWidth: width,
        }, mode, measured).split("\n");
        assert.ok(lines.length <= (mode === "hidden" ? 1 : 8));
        assert.ok(lines.every((line) => visibleWidth(line) <= width), `${mode} overflow at width ${width}`);
      }
    }
  }
});

test("real Pi assistant message component applies unified modes to existing and streaming Thinking", async () => {
  const { initTheme, getMarkdownTheme } = await import(
    "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
  );
  const { AssistantMessageComponent } = await import(
    "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js"
  );
  initTheme("dark");
  let mode: "normal" | "compact" | "hidden" = "compact";
  const privateText = "OLD_PRIVATE_THINKING_TEXT_SHOULD_NOT_APPEAR";
  const message = {
    role: "assistant",
    content: [{ type: "thinking", thinking: `${privateText}\nmore old notes\nold three\nold four\nold five\nrecent one\nrecent two\nrecent three\nrecent four\nrecent five\nrecent six\nrecent seven` }],
    stopReason: "stop",
  } as any;
  const component = new AssistantMessageComponent(
    undefined, false, getMarkdownTheme(), "Thinking...", 1,
    [(text, context) => transformThinkingText(text, context, mode)],
  );
  const visible = () => component.render(48).join("\n").replace(/\x1b\[[0-9;]*m/g, "");

  component.updateContent(message, true);
  assert.doesNotMatch(visible(), /OLD_PRIVATE_THINKING_TEXT_SHOULD_NOT_APPEAR/);
  assert.match(visible(), /recent seven/);
  assert.doesNotMatch(visible(), /old five/);
  component.updateContent(message, false);
  assert.match(visible(), /Thinking/);
  assert.doesNotMatch(visible(), /Thinking · Done/);
  assert.doesNotMatch(visible(), /recent seven/);

  mode = "normal";
  component.setHiddenThinkingLabel("Thinking...");
  assert.match(visible(), /OLD_PRIVATE_THINKING_TEXT_SHOULD_NOT_APPEAR/);
  mode = "hidden";
  component.setHiddenThinkingLabel("Thinking...");
  assert.match(visible(), /Thinking/);
  assert.doesNotMatch(visible(), /Thinking · Done/);
  assert.doesNotMatch(visible(), /OLD_PRIVATE_THINKING_TEXT_SHOULD_NOT_APPEAR/);
});
