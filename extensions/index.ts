import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  DefaultPackageManager,
  estimateTokens,
  getAgentDir,
  loadProjectContextFiles,
  SettingsManager,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { installContextEstimates } from "./ctx/data.ts";
import { createActivityTracker, type ActivityTracker } from "./ctx/activity.ts";
import { installFooter, type FooterController } from "./footer/index.ts";
import { isFabricFullCodeMode } from "./fabric-detection.ts";
import { mcpResourceEntriesFromConfig, mcpResourceEntriesFromStatus, mergeMcpResourceEntries } from "./mcp/resources.ts";
import {
  createDefaultSidebarPanels,
  SESSION_PANEL_ID,
} from "./sidebar/default-panels.ts";
import type { ResourceButtonId } from "./session/panel.ts";
import { installSidebar, type SidebarController } from "./sidebar/index.ts";
import { deleteSessionFile } from "./session/mutations.ts";
import type { SessionListItem } from "./session/panel.ts";
import { installToolViewController } from "./tool-view/controller.ts";
import type { ToolViewMode } from "./tool-view/types.ts";
import {
  createToolUsageTracker,
  type ToolUsageTracker,
} from "./tool-view/usage.ts";

const SESSION_SWITCH_COMMAND = "sidebar-session-switch";
const SESSION_RENAME_COMMAND = "sidebar-session-rename";
const SESSION_DELETE_COMMAND = "sidebar-session-delete";
const SESSION_CLEAR_COMMAND = "sidebar-session-clear-others";

export type ResourceEntry = { name: string; description: string; content?: string };

/** Format every resource row for the scrollable resource picker. */
export function resourceDialogOptions(rows: readonly ResourceEntry[]): string[] {
  return rows.map((row) => {
    const desc = row.description.length > 110 ? `${row.description.slice(0, 109)}…` : row.description;
    return `${row.name} — ${desc}`;
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

/**
 * Show a modal picker dialog listing resource rows. Long descriptions show a
 * wide preview; selecting a row opens a second dialog with the full content.
 * When `content` is given (single AGENTS.md), the full file content is shown
 * directly in a scrollable editor dialog (Esc closes, nothing is written back).
 */
function showResourceDialog(
  ctx: { ui: { select(title: string, options: string[]): Promise<string | undefined>; editor(title: string, prefill?: string): Promise<string | undefined> } },
  button: ResourceButtonId,
  rows: readonly ResourceEntry[],
  content?: string,
): void {
  if (content !== undefined) {
    void ctx.ui.editor("AGENTS.md (read-only · Esc to close)", content).then(() => {});
    return;
  }
  const title = button === "skills"
    ? "Skills"
    : button === "extensions"
      ? "Extensions"
      : button === "mcp"
        ? "MCP"
        : "Context";
  const visible = resourceDialogOptions(rows);
  void ctx.ui.select(
    `${title} (${rows.length}) · ↵ full description`,
    visible,
  ).then((choice) => {
    if (!choice) return;
    const index = visible.indexOf(choice);
    const row = index >= 0 ? rows[index] : undefined;
    if (row) {
      void ctx.ui.editor(`${row.name} (full description · Esc to close)`, row.description).then(() => {});
    }
  });
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
      description: command.description?.replace(/\s+/g, " ").trim() || "Skill command",
    }));
  const agentDir = getAgentDir();
  if (button === "agents") return loadProjectContextFiles({ cwd, agentDir }).map((file) => ({
    name: basename(file.path),
    description: file.content.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith("#")) ?? "Context file",
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
        ? `package ${info.source.replace(/^(npm:|git:)/, "")}`
        : info.scope),
  }));

  return extensions;
}

/**
 * Move every saved session except `keepId` to trash. Recoverable deletion only,
 * and one failure never stops the remaining sessions from being cleared.
 */
async function clearOtherSessions(
  pi: ExtensionAPI,
  cwd: string,
  sessionDir: string,
  keepId: string,
): Promise<{ readonly deleted: number; readonly failed: number; readonly firstError?: string }> {
  const sessions = await SessionManager.list(cwd, sessionDir);
  const targets = sessions.filter((session) => session.id !== keepId);
  let deleted = 0;
  let firstError: string | undefined;
  for (const target of targets) {
    const result = await deleteSessionFile(pi, target.path);
    if (result.ok) deleted++;
    else firstError ??= result.error;
  }
  return { deleted, failed: targets.length - deleted, ...(firstError === undefined ? {} : { firstError }) };
}

export default async function piUiExtension(pi: ExtensionAPI): Promise<void> {
  const toolView = await installToolViewController(pi);
  let mcpResources: readonly ResourceEntry[] = [];
  let liveMcpResources: readonly ResourceEntry[] = [];
  const currentMcpResources = (cwd: string, trusted: boolean): readonly ResourceEntry[] =>
    mergeMcpResourceEntries(mcpResourceEntriesFromConfig(getAgentDir(), cwd, trusted), liveMcpResources);
  let toolViewMode: ToolViewMode | undefined;
  let footer: FooterController | undefined;
  let sidebar: SidebarController | undefined;
  let activity: ActivityTracker | undefined;
  let toolUsage: ToolUsageTracker | undefined;
  let getCurrentBranch: (() => readonly unknown[]) | undefined;
  let cacheInputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  const cacheHitRate = (): number => {
    const promptTokens = cacheInputTokens + cacheReadTokens + cacheWriteTokens;
    return promptTokens === 0 ? 0 : cacheReadTokens / promptTokens * 100;
  };
  const addCacheUsage = (usage: unknown): void => {
    if (!usage || typeof usage !== "object") return;
    const values = usage as { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
    const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    cacheInputTokens += number(values.input);
    cacheReadTokens += number(values.cacheRead);
    cacheWriteTokens += number(values.cacheWrite);
  };
  const resetCacheUsage = (branch: readonly unknown[]): void => {
    cacheInputTokens = 0;
    cacheReadTokens = 0;
    cacheWriteTokens = 0;
    for (const entry of branch) {
      if (!entry || typeof entry !== "object") continue;
      const typed = entry as { type?: unknown; message?: { usage?: unknown } };
      if (typed.type === "message") addCacheUsage(typed.message?.usage);
    }
  };
  let switchRequested = false;
  const getMcpServerNames = () => mcpResources.map((server) => server.name);
  const unsubscribeMcpStatus = pi.events.on("pi-mcp-adapter/status/v1", (value) => {
    liveMcpResources = mcpResourceEntriesFromStatus(value);
    mcpResources = mergeMcpResourceEntries(mcpResources, liveMcpResources);
    const branch = getCurrentBranch?.();
    if (branch) toolUsage?.resetSession(branch, getMcpServerNames(), { preserveExchange: true });
    sidebar?.refresh();
  });

  pi.registerCommand(SESSION_RENAME_COMMAND, {
    description: "Rename a saved session selected from the sidebar",
    handler: async (args, ctx) => {
      const sessionId = args.trim();
      if (!sessionId) {
        ctx.ui.notify("Missing session id", "error");
        return;
      }

      try {
        const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
        const target = sessions.find((session) => session.id === sessionId);
        if (!target) {
          ctx.ui.notify("Session no longer exists", "error");
          refreshSessions();
          return;
        }
        const title = target.name ?? target.firstMessage;
        const nextName = await ctx.ui.input("Rename session", title);
        const next = nextName?.trim();
        if (!next) return;

        if (target.id === ctx.sessionManager.getSessionId()) {
          pi.setSessionName(next);
        } else {
          SessionManager.open(target.path).appendSessionInfo(next);
          refreshSessions();
        }
        ctx.ui.notify("Session renamed", "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to rename session: ${message}`, "error");
      }
    },
  });

  pi.registerCommand(SESSION_DELETE_COMMAND, {
    description: "Delete a saved session selected from the sidebar",
    handler: async (args, ctx) => {
      const sessionId = args.trim();
      if (!sessionId) {
        ctx.ui.notify("Missing session id", "error");
        return;
      }
      if (sessionId === ctx.sessionManager.getSessionId()) {
        ctx.ui.notify("Cannot delete the currently active session", "warning");
        return;
      }

      try {
        const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
        const target = sessions.find((session) => session.id === sessionId);
        if (!target) {
          ctx.ui.notify("Session no longer exists", "error");
          refreshSessions();
          return;
        }
        const result = await deleteSessionFile(pi, target.path);
        if (!result.ok) {
          ctx.ui.notify(`Failed to delete session: ${result.error}`, "error");
          return;
        }
        refreshSessions();
        ctx.ui.notify("Session moved to trash", "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to delete session: ${message}`, "error");
      }
    },
  });

  pi.registerCommand(SESSION_CLEAR_COMMAND, {
    description: "Move every saved session except the active one to trash",
    handler: async (_args, ctx) => {
      try {
        const currentSessionId = ctx.sessionManager.getSessionId();
        const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
        const others = sessions.filter((session) => session.id !== currentSessionId);
        if (others.length === 0) {
          ctx.ui.notify("No other sessions to clear", "info");
          return;
        }
        const confirmed = await ctx.ui.confirm(
          "Clear other sessions",
          `Move ${others.length} other session(s) to trash? The active session is kept.`,
        );
        if (!confirmed) return;

        const result = await clearOtherSessions(pi, ctx.cwd, ctx.sessionManager.getSessionDir(), currentSessionId);
        refreshSessions();
        if (result.failed > 0) {
          ctx.ui.notify(
            `Cleared ${result.deleted} session(s); ${result.failed} failed: ${result.firstError ?? "unknown error"}`,
            "error",
          );
          return;
        }
        ctx.ui.notify(`Cleared ${result.deleted} session(s) to trash`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to clear sessions: ${message}`, "error");
      }
    },
  });

  pi.registerCommand(SESSION_SWITCH_COMMAND, {
    description: "Switch to a saved session selected from the sidebar",
    handler: async (args, ctx) => {
      const sessionId = args.trim();
      if (!sessionId) {
        switchRequested = false;
        ctx.ui.notify("Missing session id", "error");
        return;
      }

      try {
        const currentSessionId = ctx.sessionManager.getSessionId();
        if (sessionId === currentSessionId) {
          switchRequested = false;
          return;
        }

        const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
        const target = sessions.find((session) => session.id === sessionId);
        if (!target) {
          switchRequested = false;
          ctx.ui.notify("Session no longer exists", "error");
          refreshSessions();
          return;
        }

        const result = await ctx.switchSession(target.path);
        // Do not use the old command ctx after a successful replacement.
        if (!result.cancelled) return;
        switchRequested = false;
        ctx.ui.notify("Session switch cancelled", "info");
      } catch (error) {
        switchRequested = false;
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to switch session: ${message}`, "error");
      }
    },
  });

  const unsubscribeToolViewMode = toolView.onModeChange((mode) => {
    toolViewMode = mode;
    sidebar?.refresh();
  });

  const refreshContextUi = () => {
    footer?.refresh();
    // CTX reads the activity snapshot during render, so refresh rather than
    // updatePanel — the snapshot is not a panel state payload anymore.
    sidebar?.refresh();
  };
  const contextEstimates = installContextEstimates(pi, refreshContextUi);
  const refreshSessions = () => {
    sidebar?.updatePanel(SESSION_PANEL_ID, undefined);
  };
  pi.on("before_agent_start", () => {
    contextEstimates.resetDelta();
    toolUsage?.startExchange();
    sidebar?.refresh();
  });
  pi.on("agent_start", () => {
    activity?.startRun();
    refreshContextUi();
  });
  pi.on("turn_start", (event) => {
    activity?.startTurn(event.turnIndex);
    sidebar?.refresh();
  });
  pi.on("before_provider_request", () => activity?.startResponse());
  pi.on("message_update", (event) => {
    const estimatedOutputTokens = estimateTokens(event.message);
    if (estimatedOutputTokens > 0) activity?.updateResponseEstimate(estimatedOutputTokens);
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      addCacheUsage(event.message.usage);
      activity?.finishResponse(event.message.usage.output);
    }
    refreshContextUi();
  });
  pi.on("tool_execution_start", (event) => {
    activity?.startTool(event);
    sidebar?.refresh();
  });
  pi.on("tool_execution_end", (event) => {
    activity?.finishTool(event);
    toolUsage?.record(event);
    sidebar?.refresh();
  });
  pi.on("agent_settled", () => {
    activity?.settle();
    refreshSessions();
  });
  pi.on("agent_end", refreshContextUi);
  pi.on("turn_end", (event) => {
    activity?.finishTurn(event.turnIndex);
    refreshContextUi();
  });
  pi.on("session_tree", () => {
    const branch = getCurrentBranch?.();
    if (branch) {
      resetCacheUsage(branch);
      toolUsage?.resetSession(branch);
    }
    refreshContextUi();
    refreshSessions();
  });
  pi.on("session_info_changed", refreshSessions);
  pi.on("model_select", refreshContextUi);
  pi.on("thinking_level_select", refreshContextUi);

  const clearControllers = (): void => {
    sidebar = undefined;
    footer = undefined;
    activity = undefined;
    toolUsage = undefined;
    getCurrentBranch = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    // Pi resets extension UI before starting/reloading a session. Do not call
    // stale controllers from the previous runtime after that reset.
    clearControllers();
    mcpResources = currentMcpResources(ctx.cwd, ctx.isProjectTrusted());
    toolViewMode = toolView.getMode();
    getCurrentBranch = () => ctx.sessionManager.getBranch();
    const branch = ctx.sessionManager.getBranch();
    resetCacheUsage(branch);
    toolUsage = createToolUsageTracker([], getMcpServerNames);
    toolUsage.resetSession(branch);
    if (ctx.mode !== "tui") return;
    const showToolViewModeSelector = (): boolean => !isFabricFullCodeMode(pi.getActiveTools());

    activity = createActivityTracker(ctx.cwd, refreshContextUi);
    footer = installFooter(
      ctx,
      (tui, theme) => {
        const panels = createDefaultSidebarPanels({
          getContextUsage: () => ctx.getContextUsage(),
          getContextEstimate: () => contextEstimates.getSnapshot(),
          getContextDelta: () => contextEstimates.getDelta(),
          getActivity: () => activity?.getSnapshot(),
          getCacheHitRate: cacheHitRate,
          getModel: () => ctx.model?.id ?? "no-model",
          getThinkingLevel: () => pi.getThinkingLevel(),
          getToolViewMode: () => toolViewMode,
          getToolUsage: () => toolUsage?.getSnapshot(),
          onSelectToolViewMode: (mode): void => {
            void toolView.setMode(mode, ctx);
          },
          showToolViewModeSelector,
          loadSessions: async (): Promise<readonly SessionListItem[]> => {
            const currentSessionId = ctx.sessionManager.getSessionId();
            const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
            return sessions.map((session) => ({
              id: session.id,
              title: session.name ?? session.firstMessage,
              modified: session.modified,
              messageCount: session.messageCount,
              current: session.id === currentSessionId,
            }));
          },
          onSelectSession: (session): void => {
            if (session.current || switchRequested) return;
            if (!ctx.isIdle()) {
              ctx.ui.notify("Wait for the current run to finish before switching sessions", "warning");
              return;
            }
            switchRequested = true;
            pi.sendUserMessage(`/${SESSION_SWITCH_COMMAND} ${session.id}`, { expandPromptTemplates: true });
          },
          onRenameSession: (session): void => {
            if (!ctx.isIdle()) {
              ctx.ui.notify("Wait for the current run to finish before renaming sessions", "warning");
              return;
            }
            pi.sendUserMessage(`/${SESSION_RENAME_COMMAND} ${session.id}`, { expandPromptTemplates: true });
          },
          onDeleteSession: (session): void => {
            if (session.current) {
              ctx.ui.notify("Cannot delete the currently active session", "warning");
              return;
            }
            if (!ctx.isIdle()) {
              ctx.ui.notify("Wait for the current run to finish before deleting sessions", "warning");
              return;
            }
            pi.sendUserMessage(`/${SESSION_DELETE_COMMAND} ${session.id}`, { expandPromptTemplates: true });
          },
          onDeleteOthers: (): void => {
            if (!ctx.isIdle()) {
              ctx.ui.notify("Wait for the current run to finish before clearing sessions", "warning");
              return;
            }
            pi.sendUserMessage(`/${SESSION_CLEAR_COMMAND}`, { expandPromptTemplates: true });
          },
          onOpenResources: (button): void => {
            if (!ctx.isIdle()) {
              ctx.ui.notify("Wait for the current run to finish before opening resources", "warning");
              return;
            }
            void loadResourceEntries(pi, ctx.cwd, button === "mcp" ? currentMcpResources(ctx.cwd, ctx.isProjectTrusted()) : mcpResources, ctx.isProjectTrusted(), button)
              .then((rows) => {
                if (!rows || rows.length === 0) {
                  ctx.ui.notify("No resources of this kind loaded", "info");
                  return;
                }
                if (button === "agents" && rows.length === 1) {
                  showResourceDialog(ctx, button, rows, rows[0]!.content);
                  return;
                }
                showResourceDialog(ctx, button, rows);
              })
              .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`Failed to load resources: ${message}`, "error");
              });
          },
        });
        sidebar = installSidebar(tui, theme, panels);
        if (!sidebar.mounted) {
          ctx.ui.setStatus("pi-ui-extension:sidebar", "Right sidebar requires fullscreen mode");
        }
      },
      () => {
        sidebar?.dispose();
        sidebar = undefined;
        ctx.ui.setStatus("pi-ui-extension:sidebar", undefined);
      },
    );
  });

  pi.on("session_shutdown", () => {
    unsubscribeToolViewMode();
    unsubscribeMcpStatus();

    // The sidebar replaces the fullscreen TUI layout root directly, so Pi
    // cannot tear it down on our behalf during session replacement. Dispose
    // both controllers while this session context is still active; otherwise
    // the old sidebar may render once more and access a stale ctx.
    activity?.reset();
    sidebar?.dispose();
    footer?.dispose();
    clearControllers();
    toolViewMode = undefined;
  });
}
