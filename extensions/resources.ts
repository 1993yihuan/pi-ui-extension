import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  DefaultPackageManager,
  getAgentDir,
  loadProjectContextFiles,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { errorMessage, t } from "./i18n.ts";
import type { ResourceButtonId } from "./session/panel.ts";

export type ResourceEntry = { name: string; description: string; content?: string };

export type ResourceDialogUi = {
  select(title: string, options: string[]): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
};

/** Format every resource row for the scrollable resource picker. */
export function resourceDialogOptions(rows: readonly ResourceEntry[]): string[] {
  // The selector returns a label, not an index. Prefix each row with an
  // ordinal so identical names/descriptions still select different content.
  return rows.map((row, index) => {
    const desc = row.description.length > 110 ? `${row.description.slice(0, 109)}…` : row.description;
    return `${index + 1}. ${row.name} — ${desc}`;
  });
}

/** Description from the nearest ancestor package.json (bounded at agentDir). */
function packageSummary(extensionPath: string, agentDir: string): string | undefined {
  try {
    const stop = resolve(agentDir);
    let dir = dirname(resolve(extensionPath));
    for (let guard = 0; guard < 8; guard++) {
      if (dir !== stop && !dir.startsWith(stop + "/")) break;
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { description?: string };
        if (typeof parsed.description === "string" && parsed.description.trim()) {
          return parsed.description.trim();
        }
      }
      const parent = dirname(dir);
      if (parent === dir || dir === stop) break;
      dir = parent;
    }
  } catch { /* unreadable — fall through */ }
  return undefined;
}

function reportDialogFailure(ui: ResourceDialogUi, key: "resource.openFailed" | "mcp.openFailed", error: unknown): void {
  ui.notify(t(key, { error: errorMessage(error) }), "error");
}

/**
 * Show a modal picker dialog listing resource rows. Long descriptions show a
 * wide preview; selecting a row opens a second dialog with the full content.
 * When `content` is given (single AGENTS.md), the full file content is shown
 * directly in a scrollable editor dialog (Esc closes, nothing is written back).
 */
export function showResourceDialog(
  ctx: { ui: ResourceDialogUi },
  button: ResourceButtonId,
  rows: readonly ResourceEntry[],
  content?: string,
): void {
  const fail = (error: unknown) => reportDialogFailure(ctx.ui, "resource.openFailed", error);
  if (content !== undefined) {
    void ctx.ui.editor(t("resource.agentsTitle"), content).catch(fail);
    return;
  }
  const title = button === "skills"
    ? t("resource.skills")
    : button === "extensions"
      ? t("resource.extensions")
      : button === "mcp"
        ? t("resource.mcp")
        : t("resource.context");
  const visible = resourceDialogOptions(rows);
  void ctx.ui.select(
    t("resource.picker", { title, count: rows.length }),
    visible,
  ).then((choice) => {
    if (!choice) return;
    const index = visible.indexOf(choice);
    const row = index >= 0 ? rows[index] : undefined;
    if (row) {
      void ctx.ui.editor(t("resource.editor", { name: row.name }), row.content ?? row.description).catch(fail);
    }
  }).catch(fail);
}

/** Load Agents.md contexts, Skills, and Extensions as display rows. */
export async function loadResourceEntries(
  pi: ExtensionAPI,
  cwd: string,
  mcp: readonly ResourceEntry[],
  projectTrusted: boolean,
  button: ResourceButtonId,
): Promise<readonly ResourceEntry[]> {
  if (button === "mcp") return mcp;
  if (button === "skills") return pi.getCommands()
    .filter((command) => command.source === "skill")
    .map((command) => ({
      name: command.name.replace(/^skill:/, ""),
      description: command.description?.replace(/\s+/g, " ").trim() || t("resource.skillFallback"),
    }));
  const agentDir = getAgentDir();
  if (button === "agents") return loadProjectContextFiles({ cwd, agentDir }).map((file) => ({
    name: basename(file.path),
    description: file.content.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith("#")) ?? t("resource.contextFallback"),
    content: file.content,
  }));

  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted,
  });
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resolved = await packageManager.resolve(async () => "skip");
  const byPath = new Map<string, { path: string; source: string; scope: string }>();
  for (const extension of resolved.extensions.filter((item) => item.enabled)) {
    byPath.set(extension.path, {
      path: extension.path,
      source: extension.metadata.source,
      scope: extension.metadata.scope,
    });
  }
  for (const tool of pi.getAllTools()) {
    const info = tool.sourceInfo;
    if (existsSync(info.path) && /\.[cm]?[jt]s$/.test(info.path)) {
      byPath.set(info.path, { path: info.path, source: info.source, scope: info.scope });
    }
  }

  const extensions: ResourceEntry[] = [...byPath.values()].map((info) => ({
    name: info.source && info.source !== "local" && info.source !== "cli"
      ? info.source.replace(/^(npm:|git:)/, "").split("/").pop()!
      : basename(dirname(info.path)) === "extensions" || basename(dirname(info.path)) === "dist"
        ? basename(dirname(dirname(info.path)))
        : basename(info.path).replace(/\.(?:[cm]?[jt]s)$/, ""),
    description: packageSummary(info.path, agentDir)
      ?? (info.source && info.source !== "local" && info.source !== "cli"
        ? t("resource.packageSource", { source: info.source.replace(/^(npm:|git:)/, "") })
        : info.scope),
  }));

  return extensions;
}
