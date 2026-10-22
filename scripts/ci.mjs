import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const EXPECTED_CHECKS = ["22.19.0", "24"].flatMap(node =>
  ["1.2.0", "1.3.0", "1.4.0"].map(pi => `check (${node}, ${pi})`));

export function docsOnly(paths) {
  return paths.length > 0 && paths.every(path =>
    /^README(?:\.[\w-]+)?\.md$/.test(path) || path === "LICENSE" ||
    /^docs\/.*\.(md|png|jpe?g|gif|svg|webp)$/.test(path));
}

export function aggregateResults(needs) {
  if (needs.changes?.result !== "success") return false;
  const docs = needs.changes.outputs.docs_only === "true";
  return needs.docs?.result === (docs ? "success" : "skipped") &&
    needs.check?.result === (docs ? "skipped" : "success");
}

export function classifyEvent(event, git = args => execFileSync("git", args, { encoding: "utf8", timeout: 30_000 })) {
  const base = event.pull_request?.base?.sha ?? event.before;
  const head = event.pull_request?.head?.sha ?? event.after;
  const valid = value => typeof value === "string" && /^[0-9a-f]{40}$/.test(value) && !/^0+$/.test(value);
  if (!valid(base) || !valid(head)) return false;
  try {
    const from = event.pull_request ? git(["merge-base", base, head]).trim() : base;
    // Include both sides of renames/deletions; no executable path can hide in a docs rename.
    return docsOnly(git(["diff", "--no-renames", "--name-only", "-z", from, head, "--"]).split("\0").filter(Boolean));
  } catch { return false; } // An unknown diff always gets the full matrix.
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === "classify") {
    const result = classifyEvent(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")));
    appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${result}\n`);
    console.log(result ? "Documentation-only change" : "Full compatibility matrix required");
  } else if (process.argv[2] === "aggregate") {
    if (!aggregateResults(JSON.parse(process.env.NEEDS_JSON))) throw new Error("Required CI checks did not succeed");
    console.log("CI result: success");
  } else throw new Error("Usage: node scripts/ci.mjs classify|aggregate");
}
