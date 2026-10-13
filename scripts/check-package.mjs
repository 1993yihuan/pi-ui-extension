import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const list = JSON.parse(execFileSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
));
const files = new Set(list[0]?.files?.map((entry) => entry.path));
if (!files.size) throw new Error("npm pack returned no package files");

const excludedTests = [...files].filter((path) => /\.test\.[cm]?[jt]sx?$/.test(path));
if (excludedTests.length) {
  throw new Error(`Tests found in npm package: ${excludedTests.join(", ")}`);
}

function runtimeSources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return runtimeSources(path);
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [relative(root, path).split(sep).join("/")];
  });
}

const required = ["README.md", "README.zh-CN.md", "LICENSE", ...runtimeSources(join(root, "extensions"))];
const missing = required.filter((path) => !files.has(path));
if (missing.length) {
  throw new Error(`Runtime sources missing from npm package: ${missing.join(", ")}`);
}

console.log(`npm package OK: ${files.size} files, 0 tests, all ${required.length - 3} runtime sources included`);
