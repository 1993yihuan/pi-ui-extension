import assert from "node:assert/strict";
import test from "node:test";
import { aggregateResults, classifyEvent, docsOnly } from "./ci.mjs";

test("only known documentation changes skip the SDK matrix", () => {
  assert.equal(docsOnly(["README.md", "README.zh-CN.md", "docs/ARCHITECTURE.md"]), true);
  for (const paths of [[], ["extensions/index.ts"], ["docs/tool.js"], ["README.md", "package-lock.json"], [".github/workflows/ci.yml"], ["scripts/ci.mjs"]]) assert.equal(docsOnly(paths), false);
});
test("missing, new-branch or unreadable diffs get full validation", () => {
  const sha = "a".repeat(40), other = "b".repeat(40);
  assert.equal(classifyEvent({ before: "0".repeat(40), after: sha }), false);
  assert.equal(classifyEvent({ before: sha, after: other }, () => { throw Error("missing base"); }), false);
  const calls = [];
  const result = classifyEvent({ pull_request: { base: { sha }, head: { sha: other } } }, args => {
    calls.push(args);
    return args[0] === "merge-base" ? sha : "README.md\0extensions/old.ts\0";
  });
  assert.equal(result, false, "renaming code into docs must still run tests");
  assert.ok(calls[1].includes("--no-renames"));
});
test("CI summary cannot pass after a skipped, failed or cancelled required job", () => {
  for (const docs of [true, false]) {
    const needs = { changes: { result: "success", outputs: { docs_only: String(docs) } }, docs: { result: docs ? "success" : "skipped" }, check: { result: docs ? "skipped" : "success" } };
    assert.equal(aggregateResults(needs), true);
    for (const result of ["failure", "cancelled", "skipped"]) {
      const failed = structuredClone(needs);
      failed[docs ? "docs" : "check"].result = result;
      assert.equal(aggregateResults(failed), false);
    }
    needs.changes.result = "failure";
    assert.equal(aggregateResults(needs), false);
  }
});
