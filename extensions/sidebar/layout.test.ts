import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ScrollView, VStack, type Component } from "@earendil-works/pi-tui";
import { getScrollViewsAt, renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { createSidebarScrollView } from "./layout.ts";

const component: Component = {
  render: () => Array.from({ length: 20 }, (_, index) => `line ${index + 1}`),
  invalidate(): void {},
};

const theme = {
  fg: (_color: string, text: string) => text,
} as Theme;

test("sidebar fills rows below its content so main-view backgrounds cannot leak through", () => {
  const shortComponent: Component = {
    render: () => ["content"],
    invalidate(): void {},
  };
  const scroll = createSidebarScrollView(shortComponent, theme, () => 4);
  const lines = scroll.render(8);

  assert.equal(lines.length, 4);
  assert.equal(lines[0], "content");
  assert.deepEqual(lines.slice(1), Array(3).fill("\x1b[0m        "));
});

test("sidebar does not add padding beyond the terminal viewport", () => {
  const scroll = createSidebarScrollView(component, theme, () => 5);
  assert.equal(scroll.render(8).length, 20);
});

test("sidebar layout preserves nested panel scroll views for wheel hit testing", () => {
  const activityScroll = new ScrollView(component);
  const sidebar = new VStack([
    { component: activityScroll, maxSize: 5 },
  ]);
  const sidebarScroll = createSidebarScrollView(sidebar, theme, () => 10);
  const frame = renderLayoutFrame(sidebarScroll, 8, 5, () => {});

  assert.deepEqual(getScrollViewsAt(frame, 1, 1), [activityScroll, sidebarScroll]);
  assert.equal(activityScroll.viewportHeight, 5);
  assert.equal(activityScroll.scrollBy(3), 0);
  assert.equal(activityScroll.scrollTop, 3);
});

test("sidebar scroll view exposes overflowing content through vertical scrolling", () => {
  const scroll = createSidebarScrollView(component, theme);
  scroll.updateLayout(20, 5, () => {});

  assert.equal(scroll.viewportHeight, 5);
  assert.equal(scroll.scrollTop, 0);
  assert.equal(scroll.scrollBy(3), 0);
  assert.equal(scroll.scrollTop, 3);
  assert.equal(scroll.scrollBy(100), 88);
  assert.equal(scroll.scrollTop, 15);
});

test("sidebar scroll view does not follow new content to the bottom", () => {
  const scroll = createSidebarScrollView(component, theme);
  scroll.updateLayout(20, 5, () => {});
  scroll.scrollBy(4);
  scroll.updateLayout(30, 5, () => {});

  assert.equal(scroll.scrollTop, 4);
});
