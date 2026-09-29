import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deleteSessionFile } from "./mutations.ts";

test("trash failures never permanently delete the session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-trash-"));
  const path = join(directory, "session.jsonl");
  try {
    await writeFile(path, "session data\n");
    for (const failure of [new Error("spawn trash ENOENT"), new Error("timed out"), { code: 1, stderr: "permission denied\n" }, { code: 2, stderr: "" }]) {
      const pi = { async exec() { if (failure instanceof Error) throw failure; return failure; } } as any;
      const result = await deleteSessionFile(pi, path);
      assert.equal(result.ok, false);
      if (!result.ok) assert.ok(result.error.length > 0);
      assert.equal(await readFile(path, "utf8"), "session data\n");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("successful trash execution passes the session path to trash", async () => {
  const calls: unknown[][] = [];
  const pi = { async exec(...args: unknown[]) { calls.push(args); return { code: 0, stderr: "" }; } } as any;
  assert.deepEqual(await deleteSessionFile(pi, "/tmp/session.jsonl"), { ok: true, method: "trash" });
  assert.deepEqual(calls, [["trash", ["/tmp/session.jsonl"], { timeout: 10_000 }]]);
});
