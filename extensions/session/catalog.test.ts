import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSessionCatalog, SESSION_TITLE_PREVIEW_LIMIT } from "./catalog.ts";

test("catalog shares unchanged summaries, reads only changed files and tracks discovery/removal", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-catalog-")), directory = join(root, "sessions");
  const makeSession = (cwd: string, title: string) => {
    const session = SessionManager.create(cwd, directory);
    session.appendMessage({ role: "user", content: title, timestamp: 1000 });
    session.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "1", content: [{ type: "text", text: "x".repeat(100000) }], isError: false, timestamp: 1001 });
    return session;
  };
  try {
    const a = makeSession(root, "A"), b = makeSession(root, "B");
    makeSession(tmpdir(), "Another project");
    const handle = await open(a.getSessionFile()!);
    const prototype = Object.getPrototypeOf(handle);
    const original = prototype.createReadStream;
    await handle.close();
    let reads = 0;
    t.mock.method(prototype, "createReadStream", function (this: FileHandle, ...args: any[]) {
      reads++;
      return Reflect.apply(original, this, args);
    });
    const catalog = createSessionCatalog();
    const first = await catalog(root, directory);
    assert.equal(first.length, 2);
    assert.equal(reads, 3);
    assert.ok(first.every(session => session.userPromptCount === 1));
    const [second, third] = await Promise.all([catalog(root, directory), catalog(root, directory)]);
    assert.equal(reads, 3, "overlapping UI refreshes must not read unchanged histories");
    assert.strictEqual(second.find(session => session.id === a.getSessionId()), first.find(session => session.id === a.getSessionId()));
    // Concurrent file reads may finish in either order; the UI sorts these summaries.
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    assert.deepEqual([...third].sort(byId), [...second].sort(byId));
    a.appendMessage({ role: "user", content: "Second question", timestamp: 2000 });
    a.appendSessionInfo("Renamed A");
    const updated = await catalog(root, directory);
    assert.equal(reads, 4);
    assert.equal(updated.find(session => session.id === a.getSessionId())?.name, "Renamed A");
    assert.equal(updated.find(session => session.id === a.getSessionId())?.userPromptCount, 2);
    const sdk = await SessionManager.list(root, directory);
    for (const summary of updated) {
      const expected = sdk.find(session => session.id === summary.id)!;
      assert.equal(summary.firstMessage, expected.firstMessage);
      assert.equal(summary.modified.getTime(), expected.modified.getTime());
      assert.equal(summary.name, expected.name);
    }
    rmSync(b.getSessionFile()!);
    assert.equal((await catalog(root, directory)).length, 1);
    assert.equal(reads, 4);
    const c = makeSession(root, "C");
    assert.ok((await catalog(root, directory)).some(session => session.id === c.getSessionId()));
    assert.equal(reads, 5);
    // Replacement at the same path must invalidate the cached identity.
    const replacement = `${c.getSessionFile()!}.replacement`;
    writeFileSync(replacement, [
      { type: "session", id: "replacement", cwd: root, timestamp: new Date(3000).toISOString() },
      { type: "message", message: { role: "user", content: "Replaced", timestamp: 3000 } },
    ].map(entry => JSON.stringify(entry)).join("\n"));
    renameSync(replacement, c.getSessionFile()!);
    assert.ok((await catalog(root, directory)).some(session => session.id === "replacement"));
    assert.equal(reads, 6);
    writeFileSync(c.getSessionFile()!, "invalid history\n");
    assert.equal((await catalog(root, directory)).length, 1);
    rmSync(directory, { recursive: true });
    assert.deepEqual(await catalog(root, directory), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const rootCannotBeBlocked = process.getuid?.() === 0 ? "chmod does not restrict root" : false;

test("catalog keeps unreadable cached summaries within the requested project", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-catalog-project-fallback-"));
  try {
    const current = SessionManager.create(root, root);
    current.appendMessage({ role: "user", content: "Current project", timestamp: 1 });
    const otherCwd = join(root, "other-project");
    const other = SessionManager.create(otherCwd, root);
    other.appendMessage({ role: "user", content: "Other project", timestamp: 1 });
    const catalog = createSessionCatalog();
    assert.deepEqual((await catalog(root, root)).map(row => row.id), [current.getSessionId()]);
    const handle = await open(current.getSessionFile()!);
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    current.appendMessage({ role: "user", content: "Changed", timestamp: 2 });
    other.appendMessage({ role: "user", content: "Changed", timestamp: 2 });
    const failure = t.mock.method(prototype, "createReadStream", () => {
      throw Object.assign(new Error("fixture read denied"), { code: "EACCES" });
    });
    const rows = await catalog(root, root);
    assert.deepEqual(rows.map(row => ({ id: row.id, title: row.firstMessage, unavailable: row.unavailable, prompts: row.userPromptCount })), [
      { id: current.getSessionId(), title: "Current project", unavailable: true, prompts: 1 },
    ]);
    assert.deepEqual((await catalog(otherCwd, root)).map(row => row.id), [other.getSessionId()]);
    failure.mock.restore();
    const recovered = await catalog(root, root);
    assert.deepEqual(recovered.map(row => ({ id: row.id, unavailable: row.unavailable, prompts: row.userPromptCount })), [
      { id: current.getSessionId(), unavailable: undefined, prompts: 2 },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("catalog keeps the last good summary while a session file cannot be read", { skip: rootCannotBeBlocked }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-catalog-unreadable-"));
  try {
    const session = SessionManager.create(root, root);
    session.appendMessage({ role: "user", content: "Kept", timestamp: 1 });
    const path = session.getSessionFile()!;
    const catalog = createSessionCatalog();
    const first = await catalog(root, root);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.unavailable, undefined);
    // New content invalidates the cached snapshot, so the next refresh must re-read.
    session.appendMessage({ role: "user", content: "Second question", timestamp: 2 });
    chmodSync(path, 0o000);
    const unreadable = await catalog(root, root);
    assert.equal(unreadable.length, 1, "an unreadable file must not remove the session");
    assert.equal(unreadable[0]!.id, session.getSessionId());
    assert.equal(unreadable[0]!.unavailable, true);
    assert.equal(unreadable[0]!.userPromptCount, 1, "the last good summary is kept");
    assert.equal(unreadable[0]!.firstMessage, "Kept");
    chmodSync(path, 0o600);
    const recovered = await catalog(root, root);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.id, session.getSessionId());
    assert.equal(recovered[0]!.unavailable, undefined, "a readable file clears the unavailable flag");
    assert.equal(recovered[0]!.userPromptCount, 2, "a readable file refreshes the summary");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("catalog never invents a summary for a file it could not read", { skip: rootCannotBeBlocked }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-catalog-never-read-"));
  try {
    const session = SessionManager.create(root, root);
    session.appendMessage({ role: "user", content: "Never read", timestamp: 1 });
    const path = session.getSessionFile()!;
    chmodSync(path, 0o000);
    const catalog = createSessionCatalog();
    assert.deepEqual(await catalog(root, root), [], "a first failed read yields no row");
    chmodSync(path, 0o600);
    const recovered = await catalog(root, root);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.unavailable, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("catalog does not cache a file changed during its read", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-catalog-race-"));
  try {
    const session = SessionManager.create(root, root);
    session.appendMessage({ role: "user", content: "Before", timestamp: 1 });
    const path = session.getSessionFile()!;
    const handle = await open(path), prototype = Object.getPrototypeOf(handle), original = prototype.createReadStream;
    await handle.close();
    let changed = false;
    t.mock.method(prototype, "createReadStream", function (this: FileHandle, ...args: any[]) {
      if (!changed) {
        changed = true;
        appendFileSync(path, JSON.stringify({ type: "message", message: { role: "user", content: "During", timestamp: 2 } }) + "\n");
      }
      return Reflect.apply(original, this, args);
    });
    const catalog = createSessionCatalog();
    assert.deepEqual(await catalog(root, root), []);
    const stable = await catalog(root, root);
    assert.equal(stable[0]?.userPromptCount, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("catalog bounds long session names and text previews without caching full messages", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-catalog-preview-"));
  try {
    const session = SessionManager.create(root, root);
    session.appendMessage({ role: "user", content: "A".repeat(20_000), timestamp: 1 });
    session.appendSessionInfo("N".repeat(20_000));
    const mixed = SessionManager.create(root, root);
    mixed.appendMessage({ role: "user", content: [
      { type: "text", text: "First" },
      { type: "text", text: "B".repeat(20_000) },
      { type: "text", text: "should not be cached" },
    ], timestamp: 1 });
    const unicode = SessionManager.create(root, root);
    unicode.appendMessage({ role: "user", content: "Z".repeat(SESSION_TITLE_PREVIEW_LIMIT - 2) + "💻💻", timestamp: 1 });

    const catalog = createSessionCatalog();
    const summaries = await catalog(root, root);
    const long = summaries.find(row => row.id === session.getSessionId())!;
    assert.equal(long.firstMessage, "A".repeat(SESSION_TITLE_PREVIEW_LIMIT - 1) + "…");
    assert.equal(long.name, "N".repeat(SESSION_TITLE_PREVIEW_LIMIT - 1) + "…");
    const multi = summaries.find(row => row.id === mixed.getSessionId())!;
    assert.equal(multi.firstMessage.length, SESSION_TITLE_PREVIEW_LIMIT);
    assert.ok(multi.firstMessage.startsWith("First BBB"));
    assert.ok(multi.firstMessage.endsWith("…"));
    const emoji = summaries.find(row => row.id === unicode.getSessionId())!;
    assert.ok(emoji.firstMessage.endsWith("…"));
    assert.ok(!/[\uD800-\uDBFF](?=…$)/.test(emoji.firstMessage), "surrogate pair must not be cut in half");
    assert.equal((await catalog(root, root)).find(row => row.id === session.getSessionId()), long,
      "unchanged previews are reused from the cache");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
