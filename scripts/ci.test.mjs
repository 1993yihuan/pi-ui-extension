import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  EXPECTED_CHECKS, NODE_VERSIONS, PI_VERSIONS, SDK_PACKAGES, aggregateResults, classifyEvent, docsOnly,
  sdkInstallArgs, sdkVersionErrors,
} from "./ci.mjs";

test("the required matrix matches the workflow, the declared minimum and the pinned development SDK", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const workflow = read("../.github/workflows/ci.yml");
  const manifest = JSON.parse(read("../package.json"));
  const axis = key => [...workflow.match(new RegExp(`\n\\s*${key}: \\[([^\\]]*)\\]`))[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  const nodes = axis("node-version");
  const pi = axis("pi-version");
  assert.deepEqual(nodes, NODE_VERSIONS, "ci.yml and the release gate must list the same Node versions");
  assert.deepEqual(pi, PI_VERSIONS, "ci.yml and the release gate must list the same Pi SDK versions");
  assert.equal(manifest.engines.node, `>=${nodes[0]}`,
    `package.json must declare the lowest tested Node version as its runtime minimum`);
  // The peer minimum stays the version npm ci installs; the newer axis is verified, not required.
  const pinned = manifest.devDependencies["@earendil-works/pi-coding-agent"];
  assert.equal(pinned, PI_VERSIONS[0], "npm ci must install the lowest tested Pi SDK");
  assert.equal(new Set(PI_VERSIONS).size, PI_VERSIONS.length, "an axis must not repeat a Pi SDK version");
  assert.ok(PI_VERSIONS.length > 1, "the maintained range needs more than the minimum tested Pi SDK");
  for (const name of ["pi-coding-agent", "pi-tui"]) {
    const dependency = `@earendil-works/${name}`;
    assert.equal(manifest.peerDependencies[dependency], `>=${pinned}`,
      `${dependency} must declare the CI-installed Pi SDK as the minimum supported version`);
    assert.equal(manifest.devDependencies[dependency], pinned,
      `${dependency} development version must match the CI-installed Pi SDK`);
  }
  assert.equal(EXPECTED_CHECKS.length, nodes.length * pi.length, "no extra or missing matrix job");
  // Each axis must switch and verify the whole Pi family, not only the two peer packages.
  assert.match(workflow, /install-sdk \$\{\{ matrix\.pi-version \}\}/);
  assert.match(workflow, /verify-sdk \$\{\{ matrix\.pi-version \}\}/);
});
test("an SDK axis cannot pass with a mixed or incomplete Pi family", () => {
  const complete = Object.fromEntries(SDK_PACKAGES.map(name => [name, "1.5.0"]));
  assert.deepEqual(sdkVersionErrors("1.5.0", complete, "test"), ["the installed Pi CLI ships no dist/bundle/cli.js for the host bundle tests"]);
  assert.equal(sdkVersionErrors("1.4.0", complete, "test").length, SDK_PACKAGES.length + 1,
    "a 1.5 install cannot pass as the 1.4 axis");
  assert.match(sdkVersionErrors("1.5.0", { ...complete, "pi-tui": "1.4.0" }, "test")[0], /pi-tui: expected 1\.5\.0, got 1\.4\.0/);
  assert.match(sdkVersionErrors("1.5.0", { ...complete, "pi-schema": "1.4.0" }, "test").join(), /pi-schema: expected 1\.5\.0/);
  const { "pi-mcp": _missing, ...incomplete } = complete;
  assert.match(sdkVersionErrors("1.5.0", incomplete, "test").join(), /pi-mcp is not installed/);
  for (const version of PI_VERSIONS) {
    const args = sdkInstallArgs(version);
    assert.ok(SDK_PACKAGES.every(name => args.includes(`@earendil-works/${name}@${version}`)));
    assert.ok(args.includes("--no-save") && args.includes("--no-package-lock"),
      "a matrix install must not rewrite the manifest or the lockfile");
  }
  assert.throws(() => sdkInstallArgs("1.3.0"), /Unknown Pi SDK version/);
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
