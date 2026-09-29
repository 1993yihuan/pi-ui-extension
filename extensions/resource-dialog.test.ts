import assert from "node:assert/strict";
import test from "node:test";
import { loadResourceEntries, resourceDialogOptions, type ResourceEntry } from "./index.ts";

test("resource categories avoid unrelated package discovery and reuse loaded context content", async (t) => {
 const { SettingsManager, DefaultPackageManager } = await import("@earendil-works/pi-coding-agent");
 const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
 const { tmpdir } = await import("node:os");
 const { join } = await import("node:path");
 t.mock.method(SettingsManager, "create", () => { throw new Error("unexpected settings read"); });
 t.mock.method(DefaultPackageManager.prototype, "resolve", async () => { throw new Error("unexpected package scan"); });
 const mcp = [{name:"demo",description:"MCP server"}];
 assert.strictEqual(await loadResourceEntries({} as any, "/nonexistent", mcp, false, "mcp"), mcp);
 const pi = {getCommands:()=>[{source:"skill",name:"skill:review",description:" Review  code "},{source:"extension",name:"other"}]} as any;
 assert.deepEqual(await loadResourceEntries(pi, "/nonexistent", [], false, "skills"), [{name:"review",description:"Review code"}]);
 const directory = await mkdtemp(join(tmpdir(), "resource-context-"));
 try {
  const content = "# Project\n\nLocal context description\n";
  await writeFile(join(directory, "AGENTS.md"), content);
  const rows = await loadResourceEntries({} as any, directory, [], false, "agents");
  assert.ok(rows.some(row => row.content === content && row.description === "Local context description"));
 } finally { await rm(directory, {recursive:true, force:true}); }
});

test("resource dialog keeps every resource row for selector scrolling", () => {
  const rows: ResourceEntry[] = Array.from({ length: 13 }, (_, index) => ({
    name: `skill-${index + 1}`,
    description: `Description ${index + 1}`,
  }));

  const options = resourceDialogOptions(rows);

  assert.equal(options.length, rows.length);
  assert.equal(options[0], "skill-1 — Description 1");
  assert.equal(options[12], "skill-13 — Description 13");
});

test("resource dialog keeps the existing one-line description limit", () => {
  const options = resourceDialogOptions([{
    name: "skill",
    description: "x".repeat(200),
  }]);

  assert.equal(options[0], `skill — ${"x".repeat(109)}…`);
});
