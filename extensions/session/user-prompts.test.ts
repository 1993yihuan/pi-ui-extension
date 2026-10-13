import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUserPromptCounter } from "./user-prompts.ts";

const user = (id: string) => JSON.stringify({ type: "message", id, message: { role: "user", content: [{ type: "text", text: "Question" }] } });
const assistant = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: 'nested text "role":"user" should not count' }] } });
const tool = JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "codemode", nestedCalls: { calls: [{ id: "nested", name: "bash", role: "user" }] } } });

test("counts only top-level user messages, not Pi tool/assistant/nested records", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-prompts-"));
  try {
    const path = join(root, "session.jsonl");
    writeFileSync(path, [
      JSON.stringify({ type: "session", id: "example" }),
      user("user-1"),
      assistant,
      tool,
      '{"type":"message","message":{"role":"user"', // corrupted partial line
      JSON.stringify({ type: "custom_message", message: { role: "user" } }),
      user("user-2"),
      JSON.stringify({ type: "message", message: { role: "assistant" } }),
    ].join("\n") + "\n");
    const count = createUserPromptCounter();
    assert.deepEqual(await count([{ path }]), [2]);
    assert.deepEqual(await count([{ path }]), [2], "unchanged session uses cached count");
    appendFileSync(path, user("user-3") + "\n");
    assert.deepEqual(await count([{ path }]), [3], "appended session invalidates cache");
    assert.deepEqual(await count([{ path: join(root, "missing.jsonl") }]), [undefined], "missing files do not report an incorrect zero");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("counts independent session files with bounded concurrency, including empty sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-prompt-batch-"));
  try {
    const paths = Array.from({ length: 26 }, (_, i) => {
      const path = join(root, `${i}.jsonl`);
      writeFileSync(path, [JSON.stringify({ type: "session", id: String(i) }), ...Array.from({ length: i % 5 }, (_, k) => user(`${i}-${k}`))].join("\n") + "\n");
      return { path };
    });
    const count = createUserPromptCounter();
    assert.deepEqual(await count(paths), paths.map((_, i) => i % 5));
    assert.deepEqual(await count(paths.slice(0, 2)), [0, 1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("counts only appended bytes and keeps incomplete UTF-8/JSONL rows exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-prompt-incremental-"));
  try {
    const path = join(root, "session.jsonl");
    const initial = JSON.stringify({ type: "session", id: "example" }) + "\n" + user("first") + "\n" + assistant + "\n";
    writeFileSync(path, initial);
    let bytesRead = 0;
    const count = createUserPromptCounter({ onBytesRead: (size) => { bytesRead += size; } });
    assert.deepEqual(await count([{ path }]), [1]);
    assert.equal(bytesRead, Buffer.byteLength(initial), "initial scan reads the whole file");
    const total = bytesRead;
    assert.deepEqual(await count([{ path }]), [1]);
    assert.equal(bytesRead, total, "unchanged files require no streaming reads");

    const unicode = user("你好-😊");
    const buffer = Buffer.from(unicode + "\n");
    const split = buffer.indexOf(Buffer.from("😊")) + 2; // split in the middle of a UTF-8 codepoint
    appendFileSync(path, buffer.subarray(0, split));
    assert.deepEqual(await count([{ path }]), [1], "incomplete JSON must not count");
    appendFileSync(path, buffer.subarray(split));
    assert.deepEqual(await count([{ path }]), [2]);
    assert.equal(bytesRead - total, buffer.length, "appended data is read only once");

    appendFileSync(path, user("no-newline"));
    assert.deepEqual(await count([{ path }]), [3], "complete final JSON without newline counts provisionally");
    appendFileSync(path, "\n" + tool + "\n");
    assert.deepEqual(await count([{ path }]), [3], "newline must not count provisional question twice");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rebuilds count on same-size rewrite, truncation, inode replacement and in-place prefix rewrite", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-prompt-rewrite-"));
  try {
    const path = join(root, "session.jsonl");
    writeFileSync(path, user("first") + "\n");
    const count = createUserPromptCounter();
    assert.deepEqual(await count([{ path }]), [1]);

    // Same-sized content is not an append, even with the same inode.
    writeFileSync(path, JSON.stringify({ type: "session", message: { role: "assistant" } }) + "\n");
    assert.deepEqual(await count([{ path }]), [0]);
    writeFileSync(path, "");
    assert.deepEqual(await count([{ path }]), [0]);
    writeFileSync(path, user("second") + "\n" + user("third") + "\n");
    assert.deepEqual(await count([{ path }]), [2]);

    const replacement = join(root, "replacement.jsonl");
    writeFileSync(replacement, user("replacement") + "\n");
    renameSync(replacement, path);
    assert.deepEqual(await count([{ path }]), [1], "replaced inode invalidates old offsets");

    const original = user("replacement") + "\n";
    writeFileSync(path, original);
    assert.deepEqual(await count([{ path }]), [1]);
    // The old prefix has changed, even though the file now grew.
    writeFileSync(path, "x".repeat(Buffer.byteLength(original)) + "\n" + user("appended") + "\n");
    assert.deepEqual(await count([{ path }]), [1], "changed prefix must trigger a fresh scan");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
