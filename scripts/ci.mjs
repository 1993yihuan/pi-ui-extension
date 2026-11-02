import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Single source for the supported matrix; ci.yml and the release gate are checked against it.
export const NODE_VERSIONS = ["22.19.0", "24"];
/**
 * The maintained Pi range. The first entry is the declared peer minimum and the
 * version `npm ci` installs; later entries are verified by switching the whole
 * family, so no axis can silently test a mix of 1.4 and 1.5 classes.
 */
export const PI_VERSIONS = ["1.4.0", "1.5.0"];
/** Everything Pi splits its runtime into: a partial install would mix SDK families. */
export const SDK_PACKAGES = [
  "pi-coding-agent", "pi-tui", "pi-agent-core", "pi-ai", "pi-codemode", "pi-mcp", "pi-telemetry",
];
export const EXPECTED_CHECKS = NODE_VERSIONS.flatMap(node =>
  PI_VERSIONS.map(pi => `check (${node}, Pi ${pi})`));

export function sdkInstallArgs(version) {
  if (!PI_VERSIONS.includes(version)) throw new Error(`Unknown Pi SDK version: ${version}`);
  return ["install", "--no-save", "--no-package-lock", "--no-audit", "--no-fund",
    ...SDK_PACKAGES.map(name => `@earendil-works/${name}@${version}`)];
}

/** Every installed Pi package must be the matrix SDK, and the family must be complete. */
export function sdkVersionErrors(expected, installed, root = "node_modules") {
  const errors = SDK_PACKAGES.filter(name => !installed[name])
    .map(name => `@earendil-works/${name} is not installed`);
  for (const [name, version] of Object.entries(installed)) {
    // A sibling package such as pi-schema only counts when the axis installed it.
    if (version !== expected) errors.push(`@earendil-works/${name}: expected ${expected}, got ${version}`);
  }
  if (!existsSync(`${root}/@earendil-works/pi-coding-agent/dist/bundle/cli.js`)) {
    errors.push("the installed Pi CLI ships no dist/bundle/cli.js for the host bundle tests");
  }
  return errors;
}

export function installedSdkVersions(root = "node_modules") {
  const directory = `${root}/@earendil-works`;
  if (!existsSync(directory)) return {};
  return Object.fromEntries(readdirSync(directory).map(name => [
    name,
    JSON.parse(readFileSync(`${directory}/${name}/package.json`, "utf8")).version,
  ]));
}

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
  } else if (process.argv[2] === "install-sdk") {
    const version = process.argv[3];
    execFileSync("npm", sdkInstallArgs(version), { stdio: "inherit", timeout: 600_000 });
  } else if (process.argv[2] === "verify-sdk") {
    const version = process.argv[3];
    if (!PI_VERSIONS.includes(version)) throw new Error(`Unknown Pi SDK version: ${version}`);
    const installed = installedSdkVersions();
    const errors = sdkVersionErrors(version, installed);
    if (errors.length > 0) throw new Error(`Pi SDK axis ${version} is not consistent:\n${errors.join("\n")}`);
    console.log(`Pi SDK ${version}: ${Object.keys(installed).length} packages verified, host bundle present`);
  } else if (process.argv[2] === "aggregate") {
    if (!aggregateResults(JSON.parse(process.env.NEEDS_JSON))) throw new Error("Required CI checks did not succeed");
    console.log("CI result: success");
  } else throw new Error("Usage: node scripts/ci.mjs classify|aggregate|install-sdk <version>|verify-sdk <version>");
}
