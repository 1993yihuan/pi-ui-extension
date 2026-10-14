import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { singleLine } from "./codemode-compact.ts";
import { compactCallPrefix, withCompactResultBranch } from "./chevron.ts";

const theme = {
  fg(_name: string, value: string) { return value; },
} as any;

test("Compact call indentation and result branch use stable, separate columns", () => {
  assert.equal(compactCallPrefix(theme, false), "  ›  ");
  assert.equal(compactCallPrefix(theme, true), "  ⌄  ");
  const result = withCompactResultBranch(singleLine("✓  3 calls · 3 ok  │  249 out · 178ms"), theme);
  assert.equal(result.render(100)[0], "    ⎿  ✓  3 calls · 3 ok  │  249 out · 178ms");

  // The branch belongs to each result, not to the preceding Thinking group.
  assert.equal(withCompactResultBranch(singleLine("✓"), theme).render(80)[0], "    ⎿  ✓");
  assert.equal(withCompactResultBranch(singleLine("✗ Failed"), theme).render(80)[0], "    ⎿  ✗ Failed");
  assert.equal(withCompactResultBranch(singleLine("… Running"), theme).render(80)[0], "    ⎿  … Running");
});

test("Compact result branches degrade on narrow terminals without hiding status", () => {
  const result = withCompactResultBranch(singleLine("✗ Failed  10 out · 125ms"), theme);
  assert.deepEqual(result.render(0), []);
  for (const width of [1, 2, 3, 6, 8, 12, 14, 15, 16, 20, 34]) {
    const rows = result.render(width);
    assert.equal(rows.length, 1);
    assert.ok(visibleWidth(rows[0]!) <= width, `width ${width}: ${rows[0]}`);
    if (width < 15) {
      assert.ok(!rows[0]!.includes("⎿"), "drop decoration before essential status");
      if (width === 1) assert.equal(stripTerminalSequences(rows[0]!), "…");
      else assert.match(stripTerminalSequences(rows[0]!), /^✗/);
    } else {
      assert.match(rows[0]!, /^    ⎿  ✗/);
    }
  }
  let invalidated = false;
  const source: Component = {
    render() { return ["✓"]; },
    invalidate() { invalidated = true; },
  };
  withCompactResultBranch(source, theme).invalidate();
  assert.equal(invalidated, true);
});
