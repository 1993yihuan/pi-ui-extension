import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { AssistantMessageComponent, VERSION, type MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  getMarkdownTheme,
  initTheme,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { installCompactThinkingAdapter } from "./thinking-adapter.ts";
import { ThinkingTiming } from "./thinking-timing.ts";
import { transformThinkingText, type ThinkingStatus } from "./thinking.ts";
import type { ToolViewMode } from "./types.ts";

const WIDTH = 64;
const ADAPTER_KEY = Symbol.for("pi-ui-extension:compact-thinking-adapter");
const PREVIOUS_KEY = Symbol.for("pi-ui-extension:thinking-click-guard");
const INDICATOR = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
/** Pi's message output padding, then the Thinking quote bar. */
const BAR_ROW = /^ *│ /;
const stripBar = (line: string) => line.replace(BAR_ROW, "");
type StatusFn = (text: string, streaming: boolean) => ThinkingStatus;

function mouse(y: number, x: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return {
    type: "click", button: "left", x, y, screenX: x, screenY: y, width: WIDTH, height: 64,
    shift: false, alt: false, ctrl: false, ...extra,
  };
}

function lines(component: AssistantMessageComponent, width = WIDTH): string[] {
  return component.render(width).map(stripTerminalSequences);
}

function plain(component: AssistantMessageComponent, width = WIDTH): string {
  return lines(component, width).join("\n");
}

function lineIndex(component: AssistantMessageComponent, needle: RegExp | string, last = false): number {
  const matches = lines(component)
    .map((line, index) => (typeof needle === "string" ? line.includes(needle) : needle.test(line)) ? index : -1)
    .filter((index) => index >= 0);
  const index = last ? matches.at(-1) : matches[0];
  assert.ok(index !== undefined, `no rendered line matches ${needle}`);
  return index;
}

function clickLine(
  component: AssistantMessageComponent,
  needle: RegExp | string,
  extra: Partial<TuiMouseEvent> = {},
  x = 1,
  last = false,
): ReturnType<NonNullable<AssistantMessageComponent["handleMouse"]>> {
  const y = lineIndex(component, needle, last);
  return component.handleMouse?.(mouse(y, x, extra));
}

function harness(t: TestContext, providedStatus?: StatusFn) {
  initTheme("dark");
  const prototype = AssistantMessageComponent.prototype as unknown as Record<symbol | "updateContent", any>;
  const initial = prototype.updateContent;
  const state: { mode: ToolViewMode; status?: ThinkingStatus } = { mode: "compact" };
  const status: StatusFn = providedStatus ??
    ((_text, streaming) => state.status ?? { phase: streaming ? "streaming" : "complete" });
  const transformer: MarkdownTransformer = (text, context) => transformThinkingText(text, context, state.mode, status);
  const installed = installCompactThinkingAdapter(() => state.mode, transformer, { status });
  t.after(() => {
    prototype.updateContent = initial;
    delete prototype[ADAPTER_KEY];
    delete prototype[PREVIOUS_KEY];
  });
  const make = (
    content: unknown[],
    streaming: boolean,
    options: { hideThinking?: boolean; transformers?: MarkdownTransformer[]; outputPad?: number } = {},
  ) => {
    const component = new AssistantMessageComponent(
      undefined,
      options.hideThinking ?? false,
      getMarkdownTheme(),
      "Thinking...",
      options.outputPad ?? 1,
      options.transformers ?? [transformer],
    );
    component.updateContent({ role: "assistant", content, stopReason: "stop" } as any, streaming);
    return component;
  };
  const setMode = (mode: ToolViewMode) => {
    state.mode = mode;
  };
  return { state, status, transformer, installed, make, setMode, prototype, initial };
}

test("Compact Thinking streams a live title, expands to the full body, and settles on Thought", (t) => {
  assert.ok(["1.2.0", "1.3.0"].includes(VERSION), `compatibility check required for Pi ${VERSION}`);
  const { state, make, installed } = harness(t);
  assert.equal(installed, true);
  const first = "The user asks about the plugin version and where it is published.";
  const second = "Then it checks the package manifest and the release notes.";
  const component = make([{ type: "thinking", thinking: `${first}\n\n${second}` }], true);

  const live = lines(component);
  assert.equal(live.length, 2, "a spacer plus the single title row");
  assert.match(live.join("\n"), INDICATOR);
  assert.match(live[1]!, /Thinking$/);
  assert.doesNotMatch(live.join("\n"), /plugin version/, "a collapsed live run hides its body");

  const toggled = clickLine(component, /Thinking$/);
  assert.equal(toggled?.handled, true);
  const expanded = lines(component);
  assert.match(expanded[1]!, /Thinking$/, "the live title keeps its indicator when expanded");
  assert.equal(expanded[2], "", "one blank row separates title and body");
  const body = expanded.slice(3);
  assert.ok(body.length > 1);
  assert.ok(body.filter((line) => line.trim()).every((line) => BAR_ROW.test(line)),
    "every populated body row carries the grey bar");
  assert.ok(body.includes(""), "paragraph breaks stay bare");
  assert.ok(body.every((line) => visibleWidth(line) <= WIDTH));
  assert.deepEqual(
    body.filter((line) => line.trim()).map(stripBar).join(" ").replace(/\s+/g, " ").trim(),
    `${first} ${second}`,
    "the whole Thinking text is wrapped at terminal width",
  );

  // Streaming growth keeps the expansion and the earlier text.
  component.updateContent({
    role: "assistant", stopReason: "stop",
    content: [{ type: "thinking", thinking: `${first}\n\n${second}\n\nA third paragraph arrives.` }],
  } as any, true);
  const grown = lines(component);
  assert.ok(grown.slice(3).every((line) => BAR_ROW.test(line) || line === ""));
  assert.match(grown.join(" "), /plugin version/);
  assert.match(grown.join(" "), /A third paragraph arrives\./);

  // thinking_end settles the title while the message is still streaming.
  state.status = { phase: "complete", duration: { ms: 1300, approximate: false } };
  component.updateContent({
    role: "assistant", stopReason: "stop",
    content: [{ type: "thinking", thinking: `${first}\n\n${second}` }],
  } as any, true);
  const settled = lines(component);
  assert.equal(settled[1]!.trim(), "− Thought · 1.3s", "an expanded completed run shows the minus disclosure");
  assert.match(settled.join(" "), /plugin version/, "completion keeps the block expanded");

  clickLine(component, /Thought/);
  const collapsed = lines(component);
  assert.equal(collapsed.length, 2);
  assert.equal(collapsed[1]!.trim(), "+ Thought · 1.3s");
  assert.doesNotMatch(collapsed.join("\n"), /plugin version/);
});

test("only the Thinking title toggles it; body clicks, wheel, and other buttons do not", (t) => {
  const { make } = harness(t);
  const component = make([
    { type: "thinking", thinking: "Private reasoning about the next step." },
    { type: "text", text: "Public answer" },
  ], false);
  clickLine(component, /Thought/);
  assert.match(plain(component), /Private reasoning/);

  const bodyLine = lineIndex(component, /Private reasoning/);
  component.handleMouse?.(mouse(bodyLine, 2));
  assert.match(plain(component), /Private reasoning/, "a body click must not collapse the block");

  clickLine(component, /Thought/, { type: "wheel", button: "none", wheelDelta: 3 });
  assert.match(plain(component), /Private reasoning/, "the wheel must not toggle");

  clickLine(component, /Thought/, { button: "right" });
  assert.match(plain(component), /Private reasoning/, "other buttons must not toggle");

  clickLine(component, /Public answer/);
  assert.match(plain(component), /Private reasoning/, "the surrounding message text must not toggle");

  clickLine(component, /Thought/);
  assert.doesNotMatch(plain(component), /Private reasoning/);
});

test("Hidden keeps the title and measured time without ever leaking the body", (t) => {
  const { state, make, setMode } = harness(t);
  state.status = { phase: "complete", duration: { ms: 1300, approximate: false } };
  setMode("hidden");
  const component = make([
    { type: "thinking", thinking: "PRIVATE_THINKING_BODY" },
    { type: "text", text: "Public answer" },
  ], false);
  assert.equal(lines(component)[1]!.trim(), "Thought · 1.3s", "Hidden has no disclosure glyph");
  assert.doesNotMatch(plain(component), /PRIVATE_THINKING_BODY/);
  clickLine(component, /Thought/);
  assert.doesNotMatch(plain(component), /PRIVATE_THINKING_BODY|Thinking\.\.\./,
    "a Hidden click must not reveal the body or Pi's fallback label");
  assert.equal(lines(component)[1]!.trim(), "Thought · 1.3s");
});

test("Normal keeps Pi's full Thinking body and native click behavior", (t) => {
  const { make, setMode } = harness(t);
  setMode("normal");
  const component = make([{ type: "thinking", thinking: "NORMAL_MODE_BODY_TEXT" }], false);
  assert.match(plain(component), /NORMAL_MODE_BODY_TEXT/);
  clickLine(component, /NORMAL_MODE_BODY_TEXT/);
  assert.match(plain(component), /Thinking\.\.\./, "Pi's native click still collapses the block");
  assert.doesNotMatch(plain(component), /NORMAL_MODE_BODY_TEXT/);
  clickLine(component, /Thinking\.\.\./);
  assert.match(plain(component), /NORMAL_MODE_BODY_TEXT/, "Pi's native click still restores the block");
});

test("Pi's own hideThinkingBlock keeps its native read-only label", (t) => {
  const { make } = harness(t);
  const component = make([{ type: "thinking", thinking: "HIDDEN_BY_PI_BODY" }], false, { hideThinking: true });
  assert.match(plain(component), /Thinking\.\.\./);
  assert.doesNotMatch(plain(component), /HIDDEN_BY_PI_BODY|Thought/);
  clickLine(component, /Thinking\.\.\./);
  assert.doesNotMatch(plain(component), /HIDDEN_BY_PI_BODY/, "the native override must not expose raw Thinking");
});

test("expansion is independent per message instance and per Thinking run", (t) => {
  const { make } = harness(t);
  const content = [
    { type: "thinking", thinking: "FIRST_RUN_BODY" },
    { type: "text", text: "Middle answer" },
    { type: "thinking", thinking: "SECOND_RUN_BODY" },
  ];
  const component = make(content, false);
  clickLine(component, /Thought/);
  assert.match(plain(component), /FIRST_RUN_BODY/);
  assert.doesNotMatch(plain(component), /SECOND_RUN_BODY/, "a sibling run stays collapsed");
  clickLine(component, /Thought/, {}, 1, true);
  const both = plain(component);
  assert.match(both, /FIRST_RUN_BODY/);
  assert.match(both, /SECOND_RUN_BODY/, "the second run toggles on its own title");

  const sibling = make(content, false);
  assert.doesNotMatch(plain(sibling), /FIRST_RUN_BODY|SECOND_RUN_BODY/, "another instance starts collapsed");
  assert.equal(lines(component).filter((line) => line.includes("− Thought")).length, 2);
});

test("resize and invalidate keep the expansion of an open Thinking block", (t) => {
  const { make } = harness(t);
  const component = make([{ type: "thinking", thinking: "RESIZE_BODY_TEXT that is long enough to wrap at a narrow width" }], false);
  clickLine(component, /Thought/);
  const wide = lines(component, 72);
  const narrow = lines(component, 24);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 24));
  assert.ok(narrow.filter((line) => BAR_ROW.test(line)).length > wide.filter((line) => BAR_ROW.test(line)).length);
  component.invalidate();
  assert.match(plain(component, 72), /RESIZE_BODY_TEXT/, "invalidate rebuilds children without collapsing");
  assert.equal(lines(component, 72).filter((line) => line.includes("− Thought")).length, 1);
});

test("reinstalling the adapter never stacks and other components keep native clicks", (t) => {
  const { make, prototype, initial, transformer } = harness(t);
  assert.equal(installCompactThinkingAdapter(() => "compact", transformer, { status: () => ({ phase: "complete" }) }), true);
  assert.equal(prototype[ADAPTER_KEY].original, initial, "reinstall must not stack prototype wrappers");

  const component = make([{ type: "thinking", thinking: "OWNED_BODY" }], false);
  clickLine(component, /Thought/);
  assert.match(plain(component), /OWNED_BODY/);

  const foreign = make(
    [{ type: "thinking", thinking: "FOREIGN_BODY" }],
    false,
    { transformers: [(text, context) => transformThinkingText(text, context, "compact", () => ({ phase: "complete" }))] },
  );
  assert.match(plain(foreign), /\+ Thought/, "the fallback title still applies");
  clickLine(foreign, /Thought/);
  assert.match(plain(foreign), /Thinking\.\.\./, "a different transformer keeps Pi's native click");

  const bare = make([{ type: "thinking", thinking: "NATIVE_BODY" }], false, { transformers: [] });
  clickLine(bare, /NATIVE_BODY/);
  assert.match(plain(bare), /Thinking\.\.\./);
});

test("decorating never mutates the assistant message", (t) => {
  const { state, make } = harness(t);
  const content = [
    { type: "thinking", thinking: "immutable body" },
    { type: "text", text: "reply" },
  ];
  const snapshot = structuredClone(content);
  const component = make(content, true);
  clickLine(component, /Thinking$/);
  state.status = { phase: "complete", duration: { ms: 2400, approximate: false } };
  component.updateContent({ role: "assistant", stopReason: "stop", content } as any, false);
  clickLine(component, /Thought/);
  assert.deepEqual(content, snapshot);
});

test("narrow terminals wrap CJK and emoji Thinking text inside one bar", (t) => {
  const { make } = harness(t);
  const body = "用户想知道 pi-ui-extension 的最新版本，并核对 package.json 的版本号 🚀 与发布说明。".repeat(2);
  const component = make([{ type: "thinking", thinking: body }], false);
  clickLine(component, /Thought/);
  const narrow = lines(component, 20);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 20), "no row may overflow the terminal");
  const rows = narrow.filter((line) => BAR_ROW.test(line));
  assert.ok(rows.length > 1);
  assert.match(rows.join(""), /package\.json/);
  assert.match(rows.join(""), /🚀/);
});

test("thinking_end settles the title before the assistant message ends", (t) => {
  let now = 1000;
  const timing = new ThinkingTiming(() => now);
  const start = [{ type: "thinking", thinking: "" }];
  const done = [{ type: "thinking", thinking: "finished reasoning" }];
  timing.observe({ type: "thinking_start", contentIndex: 0, partial: { role: "assistant", content: start } } as any);
  now = 2300;
  timing.observe({ type: "thinking_end", contentIndex: 0, partial: { role: "assistant", content: done } } as any);
  const { make } = harness(t, (text, streaming) => timing.status(text, streaming));
  const component = make(done, true);
  assert.equal(lines(component)[1]!.trim(), "+ Thought · 1.3s",
    "the run is complete while the assistant message still streams");
});

test("a Thinking run that has only emitted thinking_start still shows a live title", (t) => {
  const { make, state } = harness(t);
  const empty = [{ type: "thinking", thinking: "" }];
  const component = make(empty, true);
  const pending = lines(component);
  assert.equal(pending.length, 1, "Pi skips the empty block, so the adapter adds the live title");
  assert.match(pending[0]!, INDICATOR);
  assert.match(pending[0]!, /Thinking$/);

  state.status = { phase: "complete" };
  component.updateContent({
    role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "now it has text" }],
  } as any, false);
  assert.equal(lines(component).filter((line) => /Thinking|Thought/.test(line)).length, 1,
    "the placeholder is replaced by the real run");

  const idle = make(empty, false);
  assert.doesNotMatch(plain(idle), /Thinking|Thought/, "an idle empty block shows nothing");
});

test("Pi's hide switch and adjacent runs leave exactly one Thinking title", (t) => {
  const { make } = harness(t);
  const empty = [{ type: "thinking", thinking: "" }];

  const hidden = make(empty, true, { hideThinking: true });
  assert.equal(lines(hidden).length, 0, "hideThinkingBlock must not gain a placeholder title");

  const adjacent = make([{ type: "thinking", thinking: "first" }, { type: "thinking", thinking: "" }], true);
  assert.equal(
    lines(adjacent).filter((line) => /Thinking|Thought/.test(line)).length,
    1,
    "an empty block inside a rendered run must not add a second title",
  );

  const onlyEmpty = make([{ type: "thinking", thinking: "" }, { type: "text", text: "answer" }, ...empty], true);
  assert.equal(lines(onlyEmpty).filter((line) => /Thinking|Thought/.test(line)).length, 1,
    "a trailing empty run shows one live title next to the answer");

  const movedOn = make([{ type: "thinking", thinking: "" }, { type: "text", text: "answer" }], true);
  assert.doesNotMatch(plain(movedOn), /Thinking|Thought/, "a run that already moved on to text leaves no title");
});

test("an empty Thinking title opens on click and stays open when text arrives", (t) => {
  const { make } = harness(t, () => ({ phase: "streaming" }));
  const component = make([{ type: "thinking", thinking: "" }], true);
  assert.equal(lines(component).length, 1);
  assert.match(lines(component)[0]!, INDICATOR);

  const toggled = component.handleMouse?.(mouse(0, 1));
  assert.equal(toggled?.handled, true, "the live placeholder title is clickable");
  assert.equal(toggled?.render, true);

  component.updateContent({
    role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "first delta arrives" }],
  } as any, true);
  const grown = lines(component);
  assert.match(grown[1]!, INDICATOR, "the same run keeps the live title");
  assert.match(grown.join("\n"), /first delta arrives/, "the opened run reveals the body as soon as it has text");
});

test("an ended empty run shows no spinner", (t) => {
  const { make } = harness(t, () => ({ phase: "complete" }));
  const component = make([{ type: "thinking", thinking: "" }], true);
  assert.equal(lines(component).length, 0, "a completed empty run leaves nothing behind");
});

test("Thinking titles, the quote bar and the reply share Pi's output padding", (t) => {
  const { make } = harness(t);
  for (const pad of [0, 1, 3]) {
    const component = make([
      { type: "thinking", thinking: "PADDED_BODY_TEXT" },
      { type: "text", text: "Public reply" },
    ], false, { outputPad: pad });
    const rows = lines(component);
    const title = rows.find((line) => line.includes("Thought"))!;
    const reply = rows.find((line) => line.includes("Public reply"))!;
    assert.equal(title.indexOf("+"), pad, `the title starts at Pi's padding (${pad})`);
    assert.equal(reply.indexOf("Public reply"), pad, "the reply starts at the same column");

    const titleRow = rows.indexOf(title);
    for (let x = 0; x < pad; x++) component.handleMouse?.(mouse(titleRow, x));
    assert.doesNotMatch(plain(component), /PADDED_BODY_TEXT/, "left padding is not a click target");
    component.handleMouse?.(mouse(titleRow, visibleWidth(title)));
    assert.doesNotMatch(plain(component), /PADDED_BODY_TEXT/, "trailing whitespace is not a click target");

    assert.equal(component.handleMouse?.(mouse(titleRow, pad))?.handled, true, "the title itself toggles");
    const open = lines(component);
    const bodyRow = open.find((line) => line.includes("PADDED_BODY_TEXT"))!;
    assert.ok(bodyRow.startsWith(`${" ".repeat(pad)}│ `), "the grey bar sits on the padding column");
    assert.equal(bodyRow.indexOf("PADDED_BODY_TEXT"), pad + 2, "body text clears the padding and the bar");
    assert.ok(open.every((line) => visibleWidth(line) <= WIDTH), "padding never pushes a row past the terminal");
  }
});

test("widths 1 to 20 clip CJK, emoji, paragraphs and code without overflow", (t) => {
  const { make } = harness(t);
  const body = [
    "第一段：用户想知道 🚀 pi-ui-extension 的最新版本。",
    "",
    "- 列表项 😀",
    "- 第二项 CJK 文本",
    "",
    "```ts",
    "const version = \"1.8.3\";",
    "```",
    "",
    "结尾段落。",
  ].join("\n");
  for (const pad of [0, 1, 3]) {
    const component = make([{ type: "thinking", thinking: body }], false, { outputPad: pad });
    component.handleMouse?.(mouse(lineIndex(component, /Thought/), Math.min(pad, 3)));
    for (let width = 1; width <= 20; width++) {
      for (const line of lines(component, width)) {
        assert.ok(visibleWidth(line) <= width, `pad ${pad} width ${width} overflowed: ${JSON.stringify(line)}`);
      }
    }
  }
});

test("a foreign patch on top of our marker makes installation fail closed", (t) => {
  const { prototype, initial, transformer } = harness(t);
  const ourOld = function (this: unknown, ...args: unknown[]) {
    return (initial as (...inner: unknown[]) => unknown).apply(this, args);
  };
  const foreign = function (this: unknown, ...args: unknown[]) {
    return ourOld.apply(this, args);
  };
  prototype[ADAPTER_KEY] = { original: initial, patched: ourOld };
  prototype.updateContent = foreign;
  const install = () => installCompactThinkingAdapter(() => "compact", transformer, {
    status: () => ({ phase: "complete" }),
  });
  assert.equal(install(), false, "an unknown patch on top must never be wrapped again");
  assert.equal(prototype.updateContent, foreign, "the other patch stays untouched");
  assert.deepEqual(prototype[ADAPTER_KEY], { original: initial, patched: ourOld }, "the stale marker is left alone");

  prototype.updateContent = ourOld;
  assert.equal(install(), true, "once our patch is on top again the install succeeds");
  assert.equal(prototype[ADAPTER_KEY].original, initial, "it unwrapped down to Pi's native method");
});

test("an older click-guard generation is unwrapped on upgrade", (t) => {
  const { prototype, initial, transformer } = harness(t);
  delete prototype[ADAPTER_KEY];
  const oldGuard = function (this: unknown, ...args: unknown[]) {
    return (initial as (...inner: unknown[]) => unknown).apply(this, args);
  };
  prototype[PREVIOUS_KEY] = { original: initial, patched: oldGuard };
  prototype.updateContent = oldGuard;
  assert.equal(installCompactThinkingAdapter(() => "compact", transformer, {
    status: () => ({ phase: "complete" }),
  }), true);
  assert.equal(prototype[PREVIOUS_KEY], undefined, "the old marker is cleared");
  assert.equal(prototype[ADAPTER_KEY].original, initial, "Pi's native method is the base again");
});
