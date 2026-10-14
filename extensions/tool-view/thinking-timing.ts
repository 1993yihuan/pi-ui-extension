import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { MessageUpdateEvent } from "@earendil-works/pi-coding-agent";

const MAX_COMPLETED = 256;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

type ThinkingEvent = MessageUpdateEvent["assistantMessageEvent"];
type ThinkingBlock = { type: string; thinking?: string };
type ActiveRun = {
  startIndex: number;
  lastIndex: number;
  startedAt: number;
  text: string;
  ended: boolean;
};

function runText(content: readonly ThinkingBlock[], index: number): { start: number; text: string } | undefined {
  if (!content[index] || content[index]!.type !== "thinking") return;
  let start = index;
  while (start > 0 && content[start - 1]?.type === "thinking") start--;
  let end = index + 1;
  while (content[end]?.type === "thinking") end++;
  const text = content.slice(start, end)
    .map((block) => block.thinking?.trim() ?? "")
    .filter(Boolean).join("\n\n");
  return { start, text };
}

/**
 * An in-memory display-only stopwatch. Pi emits explicit thinking_start/end
 * events; assistant.durationMs measures the whole response, NOT Thinking.
 * Hashing content keeps sensitive Thinking text out of long-lived map keys.
 * Unknown, restored, interrupted, or ambiguous timings are not invented.
 */
export class ThinkingTiming {
  private active: ActiveRun | undefined;
  private completed = new Map<string, number | null>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  reset(): void {
    this.active = undefined;
    this.completed.clear();
  }

  endMessage(): void {
    this.active = undefined;
  }

  observe(event: ThinkingEvent): void {
    if (event.type !== "thinking_start" && event.type !== "thinking_delta" && event.type !== "thinking_end") return;
    const content = event.partial.content as ThinkingBlock[];
    const current = runText(content, event.contentIndex);
    if (!current) return;
    const time = this.now();
    if (event.type === "thinking_start") {
      if (!this.active || current.start !== this.active.startIndex ||
          event.contentIndex > this.active.lastIndex + 1 ||
          event.contentIndex < this.active.lastIndex) {
        this.active = {
          startIndex: current.start, lastIndex: event.contentIndex,
          startedAt: time, text: current.text, ended: false,
        };
      } else {
        this.active.lastIndex = event.contentIndex;
        this.active.text = current.text;
        this.active.ended = false;
      }
      return;
    }
    if (!this.active || this.active.startIndex !== current.start ||
        this.active.lastIndex !== event.contentIndex || time < this.active.startedAt) return;
    this.active.text = current.text;
    if (event.type !== "thinking_end" || !current.text) return;

    this.active.ended = true;
    const ms = time - this.active.startedAt;
    if (!Number.isFinite(ms) || ms < 0) return;
    const key = digest(current.text);
    if (this.completed.has(key)) {
      // Identical Thinking content from another response cannot be
      // distinguished by the public Markdown transformer.
      this.completed.set(key, null);
    } else {
      this.completed.set(key, ms);
      if (this.completed.size > MAX_COMPLETED) {
        this.completed.delete(this.completed.keys().next().value!);
      }
    }
  }

  duration(text: string, streaming: boolean): { ms: number; approximate: boolean } | undefined {
    const active = this.active;
    if (streaming && active && !active.ended && active.text === text) {
      const ms = this.now() - active.startedAt;
      if (Number.isFinite(ms) && ms >= 0) return { ms, approximate: true };
    }
    // Streaming may still be true after thinking_end but before message_end.
    const ms = this.completed.get(digest(text));
    return typeof ms === "number" ? { ms, approximate: false } : undefined;
  }
}
