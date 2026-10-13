import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
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
