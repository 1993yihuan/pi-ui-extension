import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { MessageUpdateEvent } from "@earendil-works/pi-coding-agent";
import type { ThinkingStatus } from "./thinking.ts";

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
  /** Runs whose explicit end arrived without a measurable start. Phase only. */
  private ended = new Set<string>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  reset(): void {
    this.active = undefined;
    this.completed.clear();
    this.ended.clear();
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
      } else if (this.active.ended && event.contentIndex === this.active.lastIndex) {
        // The same block started again after ending: a new run, new stopwatch.
        this.active = {
          startIndex: current.start, lastIndex: event.contentIndex,
          startedAt: time, text: current.text, ended: false,
        };
      } else {
        // A further block of the same, still-open run keeps its first start.
        this.active.lastIndex = event.contentIndex;
        this.active.text = current.text;
        this.active.ended = false;
      }
      return;
    }
    if (!this.active || this.active.startIndex !== current.start ||
        this.active.lastIndex !== event.contentIndex || time < this.active.startedAt) {
      // An end event without a matching start still tells us the run finished,
      // so the title settles instead of spinning forever; it stays timeless.
      if (event.type === "thinking_end") this.rememberEnded(current.text);
      return;
    }
    this.active.text = current.text;
    if (event.type !== "thinking_end") return;

    this.active.ended = true;
    // An empty run has nothing to time, but its phase is now complete.
    if (!current.text) return;
    const ms = time - this.active.startedAt;
    if (!Number.isFinite(ms) || ms < 0) {
      this.rememberEnded(current.text);
      return;
    }
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

  private rememberEnded(text: string): void {
    if (!text) return;
    const key = digest(text);
    if (this.ended.has(key)) return;
    this.ended.add(key);
    if (this.ended.size > MAX_COMPLETED) this.ended.delete(this.ended.keys().next().value!);
  }

  /**
   * Display phase for one Thinking run. Phase and timing trust are separate:
   * an explicit thinking_end ends the run even while the assistant message
   * keeps streaming, so the title settles before message_end, while an
   * unmeasured or ambiguous run simply shows no time.
   */
  status(text: string, streaming: boolean): ThinkingStatus {
    const active = this.active;
    // A live run wins over any historical record for identical text.
    if (streaming && active && !active.ended && active.text === text) return { phase: "streaming" };
    const measured = this.completed.get(digest(text));
    if (typeof measured === "number") {
      return { phase: "complete", duration: { ms: measured, approximate: false } };
    }
    // null marks ambiguous duplicate content; ended marks an end seen without a start.
    if (measured === null || this.ended.has(digest(text))) return { phase: "complete" };
    if (active && active.text === text) return { phase: "complete" };
    return { phase: streaming ? "streaming" : "complete" };
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
