import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function documents(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? documents(path) : entry.name.endsWith(".md") ? [path] : [];
  });
}
const { name: packageName, version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const files = [
  ...readdirSync(root).filter(name => /^README(?:\.[\w-]+)?\.md$/.test(name)).map(name => join(root, name)),
  ...documents(join(root, "docs")),
];
for (const file of files) {
  const content = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file));
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
console.log(`Documentation OK: ${files.length} Markdown files, valid UTF-8 and local links`);
