import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkNodeRequirements } from "./check-docs.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const manifest = JSON.parse(read("../package.json"));
const rootReadme = (name) => ({ file: name, content: read(`../${name}`), required: true });

test("both root READMEs state the package's Node minimum", () => {
  checkNodeRequirements(manifest.engines.node, [rootReadme("README.md"), rootReadme("README.zh-CN.md")]);
});

test("an outdated, missing or undeclared Node minimum fails", () => {
  const engines = ">=22.19.0";
  assert.throws(
    () => checkNodeRequirements(engines, [
      { file: "README.md", content: "Requires **Node.js >= 22.19.0** and **Pi fullscreen mode**.", required: true },
      { file: "README.zh-CN.md", content: "需要 **Node.js >= 22.12.0**。", required: true },
    ]),
    /README\.zh-CN\.md: 22\.12\.0 \(expected >= 22\.19\.0/,
  );
  assert.throws(
    () => checkNodeRequirements(engines, [{ file: "README.zh-CN.md", content: "需要 Node.js 与 npm。", required: true }]),
    /Missing Node\.js minimum in README\.zh-CN\.md: expected Node\.js >= 22\.19\.0/,
  );
  assert.throws(() => checkNodeRequirements(undefined, []), /engines\.node/);
  assert.throws(() => checkNodeRequirements(">=22", []), /engines\.node/);
  // Documents that only mention a matrix version are not a minimum; stating one must match.
  checkNodeRequirements(engines, [{ file: "docs/NOTES.md", content: "CI covers Node.js **22.19.0 / 24**.", required: false }]);
  assert.throws(
    () => checkNodeRequirements(engines, [{ file: "docs/NOTES.md", content: "Needs Node >= 24.", required: false }]),
    /docs\/NOTES\.md: 24 \(expected >= 22\.19\.0/,
  );
});

test("Markdown emphasis and inline code do not hide the Node minimum", () => {
  const engines = ">=22.19.0";
  // Same shapes used by the real documents: whole line bold, only the comparison bold, inline code.
  for (const content of [
    "Requires **Node.js >= 22.19.0** and npm.",
    "Requires **Node.js** **>= 22.19.0** and npm.",
    "Requires `Node.js >= 22.19.0` and npm.",
    "Node.js **>= 22.19.0** and npm.",
    "Node.js >= `22.19.0` and npm.",
  ]) {
    checkNodeRequirements(engines, [{ file: "docs/STYLE.md", content, required: false }]);
  }
  for (const content of [
    "Requires **Node.js >= 24.0.0** and npm.",
    "Node.js **>= 24.0.0** and npm.",
    "Requires `Node.js >= 22.20.0` and npm.",
  ]) {
    assert.throws(
      () => checkNodeRequirements(engines, [{ file: "docs/STYLE.md", content, required: false }]),
      /docs\/STYLE\.md: \d+\.\d+\.\d+ \(expected >= 22\.19\.0/,
    );
  }
  // The real development guide states the minimum in the "only the comparison bold" shape.
  checkNodeRequirements(engines, [{ file: "docs/DEVELOPMENT.md", content: read("../docs/DEVELOPMENT.md"), required: false }]);
});

test("one wrong requirement in a document still fails next to a correct one", () => {
  assert.throws(
    () => checkNodeRequirements(">=22.19.0", [{
      file: "docs/NOTES.md",
      content: "Requires **Node.js >= 22.19.0**.\n\nOlder setups need Node.js >= 18.20.0.",
      required: false,
    }]),
    /docs\/NOTES\.md: 18\.20\.0 \(expected >= 22\.19\.0/,
  );
});
