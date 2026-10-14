import assert from "node:assert/strict";
import test from "node:test";
import { ThinkingTiming } from "./thinking-timing.ts";
import { transformThinkingText } from "./thinking.ts";

type ThinkingKind = "thinking_start" | "thinking_delta" | "thinking_end";

function thinkingEvent(kind: ThinkingKind, content: Array<{ type: string; thinking?: string }>, index = 0): any {
  return { type: kind, contentIndex: index, partial: { role: "assistant", content } };
}

test("Thinking stopwatch uses the explicit provider start/end stream events, never the full response duration", () => {
  let now = 1000;
  const timing = new ThinkingTiming(() => now);
  const block = [{ type: "thinking", thinking: "Private reasoning" }];
  assert.equal(timing.duration("Private reasoning", false), undefined, "restored thinking has no timing");
  timing.observe(thinkingEvent("thinking_delta", block));
  assert.equal(timing.duration("Private reasoning", true), undefined, "a delta alone gives no start time");
  timing.observe(thinkingEvent("thinking_start", [{ type: "thinking", thinking: "" }]));
  now = 3100;
  timing.observe(thinkingEvent("thinking_delta", block));
  assert.deepEqual(timing.duration("Private reasoning", true), { ms: 2100, approximate: true });
  now = 6150;
  timing.observe(thinkingEvent("thinking_end", block));
  assert.deepEqual(timing.duration("Private reasoning", false), { ms: 5150, approximate: false });
  assert.equal(transformThinkingText("Private reasoning", {
    messageType: "assistant-thinking", isStreaming: false, availableWidth: 40,
  }, "compact", (text, streaming) => timing.duration(text, streaming)), "Thinking · Done · 5s");
  timing.endMessage();
  assert.deepEqual(timing.duration("Private reasoning", false), { ms: 5150, approximate: false });
  timing.reset();
  assert.equal(timing.duration("Private reasoning", false), undefined, "session switching clears durations");
});

test("Thinking stopwatch handles separate blocks and rejects ambiguous identical content", () => {
  let now = 0;
  const timing = new ThinkingTiming(() => now);
  const one = [{ type: "thinking", thinking: "first" }];
  timing.observe(thinkingEvent("thinking_start", [{ type: "thinking", thinking: "" }]));
  now = 2000;
  timing.observe(thinkingEvent("thinking_end", one));
  const two = [...one, { type: "text" }, { type: "thinking", thinking: "second" }];
  now = 4000;
  timing.observe(thinkingEvent("thinking_start", [...one, { type: "text" }, { type: "thinking", thinking: "" }], 2));
  now = 9000;
  timing.observe(thinkingEvent("thinking_end", two, 2));
  assert.equal(timing.duration("first", false)?.ms, 2000);
  assert.equal(timing.duration("second", false)?.ms, 5000);

  timing.endMessage();
  now = 12000;
  timing.observe(thinkingEvent("thinking_start", [{ type: "thinking", thinking: "" }]));
  now = 14000;
  timing.observe(thinkingEvent("thinking_end", one));
  assert.equal(timing.duration("first", false), undefined, "identical content cannot be matched unambiguously");
  assert.equal(timing.duration("second", false)?.ms, 5000);
});

test("Thinking stopwatch handles adjacent thinking segments as a shared run", () => {
  let now = 0;
  const timing = new ThinkingTiming(() => now);
  const first = [{ type: "thinking", thinking: "part A" }];
  timing.observe(thinkingEvent("thinking_start", [{ type: "thinking", thinking: "" }]));
  now = 1500;
  timing.observe(thinkingEvent("thinking_end", first));
  now = 2000;
  timing.observe(thinkingEvent("thinking_start", [...first, { type: "thinking", thinking: "" }], 1));
  now = 4900;
  timing.observe(thinkingEvent("thinking_end", [...first, { type: "thinking", thinking: "part B" }], 1));
  assert.equal(timing.duration("part A\n\npart B", false)?.ms, 4900);
  timing.endMessage();
  now = 10000;
  timing.observe(thinkingEvent("thinking_end", first));
  assert.equal(timing.duration("part A", false)?.ms, 1500, "orphan end should not overwrite known timing");
});
