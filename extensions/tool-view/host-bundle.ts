import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

export type HostBundleComponents = {
  AssistantMessageComponent: typeof AssistantMessageComponent;
  ToolExecutionComponent: typeof ToolExecutionComponent;
};

/**
 * Pi's bundled CLI shares its chunk modules with dist/bundle/index.js, but not
 * with the extension's separately loaded unbundled SDK. Resolve only the
 * currently running, recognizable Pi CLI, never a guessed npm installation.
 * Unknown distributions retain the existing SDK guard and native UI fallback.
 */
export async function loadActivePiBundle(cliEntry = process.argv[1]): Promise<HostBundleComponents | undefined> {
  if (!cliEntry) return undefined;
  try {
    const entry = realpathSync(cliEntry);
    if (basename(dirname(entry)) !== "bundle" ||
        !["cli.js", "cli-runtime.js"].includes(basename(entry))) return undefined;
    const module = await import(pathToFileURL(join(dirname(entry), "index.js")).href) as Partial<HostBundleComponents>;
    if (typeof module.AssistantMessageComponent?.prototype?.updateContent !== "function" ||
        typeof module.ToolExecutionComponent?.prototype?.render !== "function") return undefined;
    return module as HostBundleComponents;
  } catch {
    return undefined;
  }
}
