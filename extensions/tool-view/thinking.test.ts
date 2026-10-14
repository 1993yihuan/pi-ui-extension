import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { thinkingActionHeader, transformThinkingText } from "./thinking.ts";

test("one Tool View mode controls both Thinking and tool transcript presentation", () => {
  const source = [
    "Old first line", "Old second line", "Older discarded text",
    "Recent first", "Recent second", "Recent third",
  ].join("\n");
  const streaming = { messageType: "assistant-thinking", isStreaming: true, availableWidth: 30 } as const;
  const done = { ...streaming, isStreaming: false };

  assert.equal(transformThinkingText(source, streaming, "normal"), source);
  assert.equal(transformThinkingText(source, done, "normal"), source);
  assert.equal(transformThinkingText(source, streaming, "hidden"), "Thinking · Hidden");
  assert.equal(transformThinkingText(source, done, "hidden"), "Thinking · Hidden");
  const compact = transformThinkingText(source, streaming, "compact");
  assert.doesNotMatch(compact, /Old first|Old second|Older discarded/);
  assert.match(compact, /Recent first/);
  assert.match(compact, /Recent third/);
  assert.ok(compact.split("\n").length <= 3);
  assert.ok(compact.split("\n").every((line) => visibleWidth(line) <= 30));
  assert.equal(transformThinkingText(source, done, "compact"), "Thinking · Done");
  assert.equal(transformThinkingText(source, { ...streaming, messageType: "assistant" }, "hidden"), source);
  assert.equal(transformThinkingText(source, { ...streaming, messageType: "user" }, "compact"), source);

  const long = "abcdef ".repeat(180);
  const tail = transformThinkingText(long, { ...streaming, availableWidth: 15 }, "compact");
  assert.ok(tail.split("\n").length <= 3, "long paragraphs must not fill the transcript");
  assert.ok(tail.split("\n").every((line) => visibleWidth(line) <= 15));
});

test("clickable Thinking labels show dim actions and fit narrow terminals", () => {
  const done = { messageType: "assistant-thinking", isStreaming: false, availableWidth: 48 } as const;
  const live = { ...done, isStreaming: true };
  const collapsed = transformThinkingText("private details", done, "compact", true);
  assert.equal(stripTerminalSequences(collapsed), "Thinking · Done   ▸ Expand");
  assert.ok(collapsed.includes(String.fromCharCode(27) + "[2m"), "action uses dim styling");
  assert.equal(stripTerminalSequences(thinkingActionHeader(false, true, 48)), "Thinking · Done   ▾ Collapse");
  assert.equal(stripTerminalSequences(thinkingActionHeader(true, true, 48)), "Thinking · Live   ▾ Collapse");
  assert.equal(transformThinkingText("private details", done, "normal", true), "private details");
  assert.equal(transformThinkingText("private details", done, "hidden", true), "Thinking · Hidden");

  const streaming = transformThinkingText("one\ntwo\nthree\nfour", live, "compact", true);
  assert.match(stripTerminalSequences(streaming), /^Thinking · Live   ▸ Expand\n/);
  assert.match(stripTerminalSequences(streaming), /four/);
  assert.ok(streaming.split("\n").length <= 4, "one action line plus up to three recent rows");

  for (const width of [5, 8, 12, 16, 18, 24, 26, 27, 34, 72]) {
    for (const streaming of [false, true]) {
      for (const expanded of [false, true]) {
        const header = thinkingActionHeader(streaming, expanded, width);
        assert.ok(visibleWidth(header) <= width, `header overflows at ${width}`);
        assert.ok(!header.includes("\n"));
      }
    }
    const liveText = transformThinkingText("a long sentence ".repeat(40), {
      ...live, availableWidth: width,
    }, "compact", true);
    assert.ok(liveText.split("\n").length <= 4);
    assert.ok(liveText.split("\n").every((line) => visibleWidth(line) <= width), `live text overflows at ${width}`);
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
    content: [{ type: "thinking", thinking: `${privateText}\nmore old notes\nrecent one\nrecent two\nrecent three` }],
    stopReason: "stop",
  } as any;
  const component = new AssistantMessageComponent(
    undefined, false, getMarkdownTheme(), "Thinking...", 1,
    [(text, context) => transformThinkingText(text, context, mode)],
  );
  const visible = () => component.render(48).join("\n").replace(/\x1b\[[0-9;]*m/g, "");

  component.updateContent(message, true);
  assert.doesNotMatch(visible(), /OLD_PRIVATE_THINKING_TEXT_SHOULD_NOT_APPEAR/);
  assert.match(visible(), /recent three/);
  component.updateContent(message, false);
  assert.match(visible(), /Thinking · Done/);
  assert.doesNotMatch(visible(), /recent three/);

  mode = "normal";
  component.setHiddenThinkingLabel("Thinking...");
  assert.match(visible(), /OLD_PRIVATE_THINKING_TEXT_SHOULD_NOT_APPEAR/);
  mode = "hidden";
  component.setHiddenThinkingLabel("Thinking...");
  assert.match(visible(), /Thinking · Hidden/);
  assert.doesNotMatch(visible(), /OLD_PRIVATE_THINKING_TEXT_SHOULD_NOT_APPEAR/);
});
