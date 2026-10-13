import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, symlinkSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createActiveSessionLease, readActiveSessionPaths, sessionFileUnchanged,
  snapshotInactiveSession, SESSION_QUIET_PERIOD_MS,
} from "./safety.ts";

test("separate Pi instances protect their active session paths until shutdown", () => {
  const root = mkdtempSync(join(tmpdir(), "session-leases-"));
  try {
    const directory = join(root, "active-sessions");
    const first = createActiveSessionLease(directory);
    const second = createActiveSessionLease(directory);
    const pathA = join(root, "a.jsonl"), pathB = join(root, "b.jsonl"), pathC = join(root, "c.jsonl");
    first.update("a", pathA);
    second.update("b", pathB);
    assert.deepEqual([...readActiveSessionPaths(directory)].sort(), [pathA, pathB]);
    first.update("c", pathC);
    assert.deepEqual([...readActiveSessionPaths(directory)].sort(), [pathB, pathC], "switching sessions releases the old path");
    first.dispose();
    assert.deepEqual([...readActiveSessionPaths(directory)], [pathB]);
    second.dispose();
    assert.equal(readActiveSessionPaths(directory).size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale PID is ignored, but malformed lease data blocks dangerous cleanup", () => {
  const root = mkdtempSync(join(tmpdir(), "session-leases-stale-"));
  try {
    assert.equal(readActiveSessionPaths(join(root, "missing")).size, 0);
    const stale = join(root, "stale.json");
    writeFileSync(stale, JSON.stringify({ pid: 999999999, sessionId: "x", path: join(root, "x.jsonl") }));
    assert.equal(readActiveSessionPaths(root).size, 0);
    writeFileSync(join(root, "invalid.json"), "{not-valid");
    assert.throws(() => readActiveSessionPaths(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bulk cleanup protects recently changed sessions and refuses changed or replaced files", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-cleanup-safety-"));
  try {
    const path = join(root, "candidate.jsonl");
    writeFileSync(path, "old session\n");
    assert.equal(await snapshotInactiveSession(path), undefined, "a recently edited session is not a candidate");
    const now = Date.now();
    const old = new Date(now - SESSION_QUIET_PERIOD_MS - 60_000);
    utimesSync(path, old, old);
    const snapshot = await snapshotInactiveSession(path, now);
    assert.ok(snapshot);
    assert.equal(await sessionFileUnchanged(path, snapshot!), true);
    appendFileSync(path, "user resumed writing\n");
    assert.equal(await sessionFileUnchanged(path, snapshot!), false, "resume during confirmation blocks deletion");
    utimesSync(path, old, old);
    const next = await snapshotInactiveSession(path, now);
    assert.ok(next);
    rmSync(path);
    writeFileSync(path, "new contents\n");
    assert.equal(await sessionFileUnchanged(path, next!), false, "replaced files are protected");

    const link = join(root, "link.jsonl");
    symlinkSync(path, link);
    assert.equal(await snapshotInactiveSession(link, now), undefined, "symlinks cannot be bulk deleted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
