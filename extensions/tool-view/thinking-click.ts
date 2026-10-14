import { AssistantMessageComponent, VERSION, type MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { Markdown, MouseRegion, Text } from "@earendil-works/pi-tui";
import type { ToolViewMode } from "./types.ts";
import { thinkingActionHeader } from "./thinking.ts";

// The public Markdown transformer does not receive a message/block identity or
// a mouse callback. This adapter touches only the verified Pi 1.1/1.2
// AssistantMessageComponent shape. Any mismatch leaves Pi's own click handler
// intact; it does not patch TUI-wide mouse dispatch.
const TESTED_VERSIONS = new Set(["1.1.0", "1.2.0"]);
const PATCH_KEY = Symbol.for("pi-ui-extension:thinking-click-adapter");

type MouseHandler = (event: { type: string; button: string }) => unknown;
type ThinkingRegion = {
  child: Markdown | Text;
  onMouse: MouseHandler;
};
type AssistantInternals = {
  contentContainer: { children: unknown[] };
  lastMessage?: { content?: readonly { type: string; thinking?: string }[] };
  isStreaming: boolean;
  hideThinkingBlock: boolean;
  markdownTransformers: readonly MarkdownTransformer[];
  thinkingVisibilityOverrides: Map<number, boolean>;
  updateContent: AssistantMessageComponent["updateContent"];
};
type MarkdownInternals = { options: { transform?: (markdown: string, width: number) => string } };
type PatchedPrototype = typeof AssistantMessageComponent.prototype & {
  [PATCH_KEY]?: { original: typeof AssistantMessageComponent.prototype.updateContent; patched: typeof AssistantMessageComponent.prototype.updateContent };
};

function countThinkingRuns(content: readonly { type: string; thinking?: string }[]): number {
  let runs = 0;
  let active = false;
  for (const block of content) {
    if (block.type !== "thinking") {
      if (active) runs++;
      active = false;
    } else if (typeof block.thinking === "string" && block.thinking.trim()) {
      active = true;
    }
  }
  return runs + Number(active);
}

/**
 * A narrow compatibility adapter, installed once per Pi component prototype.
 * Mode changes reset all per-component expansions; the original message stays
 * untouched and Pi still owns all rendering and native mouse dispatch.
 */
export function installThinkingClickAdapter(
  getMode: () => ToolViewMode,
  ownTransformer: MarkdownTransformer,
): { enabled: boolean; reset(): void } {
  const prototype = AssistantMessageComponent.prototype as PatchedPrototype;
  if (!TESTED_VERSIONS.has(VERSION) ||
      typeof prototype.updateContent !== "function" ||
      typeof prototype.setHiddenThinkingLabel !== "function") {
    return { enabled: false, reset() {} };
  }
  const previous = prototype[PATCH_KEY];
  // Prevent wrappers piling up on /reload; refuse to replace someone else's
  // newer patch if the implementation has changed unexpectedly.
  if (previous) {
    if (prototype.updateContent !== previous.patched) return { enabled: false, reset() {} };
    prototype.updateContent = previous.original;
  }
  const original = prototype.updateContent;
  let expanded = new WeakMap<AssistantMessageComponent, Set<number>>();

  const patched: typeof prototype.updateContent = function (this: AssistantMessageComponent, ...args) {
    original.apply(this, args);
    const instance = this as unknown as AssistantInternals;
    const entries = instance.lastMessage?.content;
    const children = instance.contentContainer?.children;
    const transformers = instance.markdownTransformers;
    const mode = getMode();
    if (!Array.isArray(entries) || !Array.isArray(children) ||
        !Array.isArray(transformers) || !transformers.includes(ownTransformer) ||
        !(instance.thinkingVisibilityOverrides instanceof Map)) return;
    const expected = countThinkingRuns(entries);
    if (expected === 0) return;
    const regions = children.filter((child): child is ThinkingRegion => child instanceof MouseRegion);
    if (regions.length !== expected ||
        regions.some((region) =>
          typeof region.onMouse !== "function" ||
          !(region.child instanceof Markdown || region.child instanceof Text) ||
          (region.child instanceof Markdown &&
            typeof (region.child as unknown as MarkdownInternals).options !== "object"))) return;

    const state = expanded.get(this) ?? new Set<number>();
    expanded.set(this, state);
    for (const [index, region] of regions.entries()) {
      if (mode === "compact" && state.has(index) && !instance.hideThinkingBlock &&
          region.child instanceof Markdown) {
        // Bypass *only this plugin's* summary transformer for this specific
        // expanded Markdown. Other extensions' transformers still run in the
        // original order, with their own per-render width and streaming state.
        const markdown = region.child as unknown as MarkdownInternals;
        const otherTransformers = transformers.filter((t) => t !== ownTransformer);
        markdown.options.transform = (source, availableWidth) => {
          let result = source;
          for (const transformer of otherTransformers) {
            try {
              const transformed = transformer(result, {
                messageType: "assistant-thinking",
                isStreaming: instance.isStreaming,
                availableWidth,
              });
              if (typeof transformed === "string") result = transformed;
            } catch { /* Match Pi's public Markdown transformer error isolation. */ }
          }
          // Keep the clickable Thinking heading visible when expanded, so
          // clicking the same spot collapses the same block again.
          const header = thinkingActionHeader(instance.isStreaming, true, Math.max(1, availableWidth));
          return `${header}\n\n${result}`;
        };
      }

      const nativeHandler = region.onMouse;
      region.onMouse = (event) => {
        if (event.type !== "click" || event.button !== "left") return nativeHandler(event);
        // Leave native behavior available if the user deliberately hid Thinking
        // in Pi itself. Do not reveal a block that is natively hidden.
        if (instance.hideThinkingBlock || instance.thinkingVisibilityOverrides.get(index) === true) {
          return nativeHandler(event);
        }
        if (mode === "compact") {
          if (state.has(index)) state.delete(index);
          else state.add(index);
          if (instance.lastMessage) instance.updateContent(instance.lastMessage as Parameters<typeof instance.updateContent>[0], instance.isStreaming);
          return { handled: true };
        }
        // Normal is always full; Hidden stays hidden. Neither should allow the
        // native click to turn their intentional display into 'Thinking...'.
        return { handled: true };
      };
    }
  };
  prototype.updateContent = patched;
  prototype[PATCH_KEY] = { original, patched };
  return {
    enabled: true,
    reset() { expanded = new WeakMap(); },
  };
}
