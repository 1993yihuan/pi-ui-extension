import {
  AssistantMessageComponent,
  VERSION,
  type MarkdownTransformer,
} from "@earendil-works/pi-coding-agent";
import { Markdown, MouseRegion, Text } from "@earendil-works/pi-tui";
import type { ToolViewMode } from "./types.ts";

const VERIFIED_PI_VERSIONS = new Set(["1.2.0", "1.3.0"]);
const GUARD_KEY = Symbol.for("pi-ui-extension:thinking-click-guard");

type Internals = {
  contentContainer?: { children?: unknown[] };
  markdownTransformers?: readonly MarkdownTransformer[];
};
type GuardRecord = {
  original: AssistantMessageComponent["updateContent"];
  patched: AssistantMessageComponent["updateContent"];
};
type GuardedPrototype = typeof AssistantMessageComponent.prototype & {
  [GUARD_KEY]?: GuardRecord;
};
type MutableThinkingRegion = {
  child: unknown;
  onMouse: (event: Parameters<MouseRegion["handleMouse"]>[0]) => ReturnType<MouseRegion["handleMouse"]>;
};

function thinkingRunCount(message: Parameters<AssistantMessageComponent["updateContent"]>[0]): number {
  let count = 0;
  let inThinking = false;
  for (const block of message.content) {
    if (block.type !== "thinking") {
      inThinking = false;
    } else if (block.thinking.trim() && !inThinking) {
      count++;
      inThinking = true;
    }
  }
  return count;
}

/**
 * Pi's native click toggles each Thinking region to the global "Thinking..."
 * placeholder, bypassing Markdown transformers. Suppress that click only on
 * visible Thinking regions belonging to this extension in Compact/Hidden.
 * Normal and natively collapsed (Text) regions retain Pi's behavior.
 *
 * This is a version-gated compatibility guard, NOT a click-to-expand feature.
 * Refuse unknown component shapes rather than altering their mouse handling.
 */
export function installThinkingClickGuard(
  getMode: () => ToolViewMode,
  transformer: MarkdownTransformer,
): boolean {
  const prototype = AssistantMessageComponent.prototype as GuardedPrototype;
  if (!VERIFIED_PI_VERSIONS.has(VERSION) ||
      typeof prototype.updateContent !== "function" ||
      typeof prototype.setHiddenThinkingLabel !== "function") return false;

  const existing = prototype[GUARD_KEY];
  if (existing) {
    if (prototype.updateContent !== existing.patched) return false;
    // /reload: unwrap our previous guard so callbacks use the current mode.
    prototype.updateContent = existing.original;
  }
  const original = prototype.updateContent;
  const patched: typeof original = function (this: AssistantMessageComponent, ...args) {
    original.apply(this, args);
    const internals = this as unknown as Internals;
    if (!internals.markdownTransformers?.includes(transformer)) return;
    const children = internals.contentContainer?.children;
    if (!Array.isArray(children)) return;
    const regions = children.filter((child): child is MouseRegion => child instanceof MouseRegion)
      .map((region) => region as unknown as MutableThinkingRegion);
    if (regions.length !== thinkingRunCount(args[0]) ||
        regions.some((region) => !(region.child instanceof Markdown || region.child instanceof Text) ||
          typeof region.onMouse !== "function")) return;

    for (const region of regions) {
      if (!(region.child instanceof Markdown)) continue;
      const nativeHandler = region.onMouse;
      region.onMouse = (event) => {
        if (event.type === "click" && event.button === "left" &&
            (getMode() === "compact" || getMode() === "hidden")) {
          return { handled: true };
        }
        return nativeHandler(event);
      };
    }
  };
  prototype.updateContent = patched;
  prototype[GUARD_KEY] = { original, patched };
  return true;
}
