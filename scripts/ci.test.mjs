import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EXPECTED_CHECKS, aggregateResults, classifyEvent, docsOnly } from "./ci.mjs";

test("the required matrix matches the workflow and the pinned development SDK", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const workflow = read("../.github/workflows/ci.yml");
  const dev = JSON.parse(read("../package.json")).devDependencies["@earendil-works/pi-coding-agent"];
  const listed = workflow.match(/pi-version: \[([^\]]*)\]/)[1].match(/\d+\.\d+\.\d+/g);
  assert.equal(listed.at(-1), dev, "the matrix must end with the pinned development SDK");
  assert.ok(listed.includes("1.2.0"), "the minimum supported SDK stays covered");
  assert.equal(workflow.includes(`if: matrix.pi-version != '${dev}'`), true,
    "only the leg that npm ci already installs skips the SDK pin step");
  for (const node of ["22.19.0", "24"]) {
    for (const pi of listed) assert.ok(EXPECTED_CHECKS.includes(`check (${node}, ${pi})`),
      `the release gate must expect check (${node}, ${pi})`);
  }
  assert.equal(EXPECTED_CHECKS.length, 2 * listed.length, "no extra or missing matrix job");
});

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
