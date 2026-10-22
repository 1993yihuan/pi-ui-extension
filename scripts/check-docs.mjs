import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rootReadme = /^README(?:\.[\w-]+)?\.md$/;

/**
 * Every explicit Node minimum must equal package.json engines.node.
 * Root READMEs must state it; other documents are only checked for drift.
 */
export function checkNodeRequirements(enginesNode, documents) {
  const expected = /^>=(\d+\.\d+\.\d+)$/.exec(enginesNode ?? "")?.[1];
  if (!expected) throw new Error(`package.json engines.node must declare a ">=x.y.z" minimum: ${enginesNode}`);
  for (const { file, content, required } of documents) {
    // Emphasis, code and strikethrough markers are Markdown formatting, not part of the version.
    const plain = content.replace(/[*_~`]+/g, "");
    const declared = [...plain.matchAll(/Node(?:\.js)?\s*>=\s*(\d+(?:\.\d+)*)/g)].map((match) => match[1]);
    if (declared.length === 0) {
      if (required) throw new Error(`Missing Node.js minimum in ${file}: expected Node.js >= ${expected}`);
      continue;
    }
    for (const version of declared) {
      if (version !== expected) {
        throw new Error(`Outdated Node.js minimum in ${file}: ${version} (expected >= ${expected} from engines.node)`);
      }
    }
  }
}

function documents(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? documents(path) : entry.name.endsWith(".md") ? [path] : [];
  });
}

function checkDocs() {
  const { name: packageName, version, engines } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const rootDocuments = readdirSync(root).filter(name => rootReadme.test(name)).map(name => join(root, name));
  const files = [...rootDocuments, ...documents(join(root, "docs"))];
  const mustDeclare = new Set(rootDocuments);
  const nodeRequirements = [];
  for (const file of files) {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file));
    nodeRequirements.push({ file, content, required: mustDeclare.has(file) });
    if (!content.endsWith("\n") || /^(<<<<<<< |=======\s*$|>>>>>>> )/m.test(content)) throw new Error(`Invalid Markdown formatting: ${file}`);
    // Keep pinned installation examples aligned with the package being released.
    for (const [pattern, expected] of [
      [/pi install npm:pi-ui-extension@([^\s\x60]+)/g, version],
      [/pi install git:github\.com\/1993yihuan\/pi-ui-extension@([^\s\x60]+)/g, `v${version}`],
    ]) {
      for (const match of content.matchAll(pattern)) {
        if (match[1] !== expected) throw new Error(`Outdated installation version in ${file}: ${match[1]} (expected ${expected} for ${packageName})`);
      }
    }
    // Fenced examples are not document links. External links are not fetched in CI.
    const prose = content.replace(/^(`{3,}|~{3,}).*\n[\s\S]*?^\1\s*$/gm, "");
    for (const match of prose.matchAll(/!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)) {
      const target = match[1] ?? match[2];
      if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("#")) continue;
      const path = resolve(dirname(file), decodeURIComponent(target.split(/[?#]/)[0]));
      if (!existsSync(path)) throw new Error(`Broken local link in ${file}: ${target}`);
    }
  }
  checkNodeRequirements(engines?.node, nodeRequirements);
  console.log(`Documentation OK: ${files.length} Markdown files, valid UTF-8, local links and the declared Node.js minimum`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) checkDocs();
