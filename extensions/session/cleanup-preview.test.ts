import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { previewSessionCleanup } from "./cleanup-preview.ts";

test("cleanup preview includes recent history and reports exclusive protection reasons", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-ui-cleanup-preview-"));
  try {
    const items = ["current", "pin", "active", "recent", "unavailable"].map(id => ({ id, path: join(root, `${id}.jsonl`) }));
    for (const item of items.slice(0, 4)) writeFileSync(item.path, item.id);
    symlinkSync(items[3]!.path, items[4]!.path);
    const { candidates, summary } = await previewSessionCleanup(items, "current", new Set(["pin"]), new Set([resolve(items[2]!.path)]));
    assert.deepEqual(candidates.map(candidate => candidate.id), ["recent"]);
    assert.deepEqual(summary, { eligible: 1, current: 1, pinned: 1, active: 1, unavailable: 1, protected: 4 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a zero-eligible preview explains every protected session", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-ui-cleanup-empty-"));
  try {
    const current = { id: "current", path: join(root, "current.jsonl") };
    const pinned = { id: "pinned", path: join(root, "pinned.jsonl") };
    const other = { id: "other", path: join(root, "other.jsonl") };
    const data = await previewSessionCleanup([current, pinned, other], "current", new Set(["pinned"]), new Set([other.path]));
    assert.deepEqual(data.candidates, []);
    assert.deepEqual(data.summary, { eligible: 0, current: 1, pinned: 1, active: 1, unavailable: 0, protected: 3 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
