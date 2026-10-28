import { existsSync, readFileSync, statSync } from "node:fs";
import { createDialogUI } from "./dialogs/index.ts";
import { confirmSessionCleanup } from "./dialogs/session-cleanup.ts";
import { previewSessionCleanup } from "./session/cleanup-preview.ts";
import { basename, dirname, join, resolve } from "node:path";
import {
  DefaultPackageManager,
  estimateTokens,
  getAgentDir,
  loadProjectContextFiles,
  SettingsManager,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { installContextEstimates } from "./ctx/data.ts";
import { createActivityTracker, createStreamingTokenSampler, type ActivityTracker } from "./ctx/activity.ts";
import { installFooter, type FooterController } from "./footer/index.ts";
import { adapterMcpServers, buildMcpStatusSnapshot, describeMcpStatus, type McpStatusSnapshot } from "./mcp/status-center.ts";
import {
  createDefaultSidebarPanels,
  SESSION_PANEL_ID,
} from "./sidebar/default-panels.ts";
import type { ResourceButtonId } from "./session/panel.ts";
import { installSidebar, type SidebarController } from "./sidebar/index.ts";
import { deleteSessionFile } from "./session/mutations.ts";
import {
  createActiveSessionLease,
  readActiveSessionPaths,
  sessionFileUnchanged,
  snapshotClearableSession,
  type SessionFileSnapshot,
} from "./session/safety.ts";
import { createSessionCatalog } from "./session/catalog.ts";
import { openSessionManager, readSessionPins, sortedSessions, toggleSessionPin } from "./session/manager.ts";
import { renameSavedSession, sameSessionFile } from "./session/rename.ts";
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
const SESSION_MANAGER_COMMAND = "sessions-manager";
const SESSION_PINS_FILE = join(getAgentDir(), "pi-ui-extension", "session-pins.json");
const ACTIVE_SESSIONS_DIR = join(getAgentDir(), "pi-ui-extension", "active-sessions");

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
export function showResourceDialog(
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
      void ctx.ui.editor(`${row.name} (read-only · Esc to close)`, row.content ?? row.description).then(() => {});
    }
  });
}

/** Read-only MCP status picker; only safe metadata is displayed. */
export function showMcpStatusDialog(
  ctx: { ui: { select(title: string, options: string[]): Promise<string | undefined>; editor(title: string, prefill?: string): Promise<string | undefined>; notify(message: string, level: "info" | "warning"): void } },
  snapshot: McpStatusSnapshot,
): void {
  const rows = snapshot.servers.map((server) => ({
    name: server.name,
    description: describeMcpStatus(server),
    details: [
      `Server: ${server.name}`,
      `Source: ${server.source}`,
      `Enabled: ${server.enabled ? "yes" : "no"}`,
      `Observed by adapter: ${server.loaded ? "yes" : "no"}`,
      `Status: ${describeMcpStatus(server)}`,
      "",
      "Only an adapter's explicit connection state establishes connected/failed.",
      "Pi native connection health is not exposed to UI extensions.",
      "Use Pi's built-in /mcp manager for live connection details.",
    ].join("\n"),
  }));
  const warnings = snapshot.warnings.map((warning) => ({
    name: "⚠ Configuration warning",
    description: warning,
    details: `${warning}\nCheck your MCP configuration with Pi's built-in /mcp manager.`,
  }));
  const all = [...rows, ...warnings];
  if (all.length === 0) {
    ctx.ui.notify("No MCP servers found. Use /mcp to configure servers.", "info");
    return;
  }
  const choices = resourceDialogOptions(all);
  const enabledCount = snapshot.servers.filter((server) => server.enabled).length;
  void ctx.ui.select(
    `MCP Status · ${enabledCount} enabled / ${snapshot.servers.length} total · ↵ details`,
    choices,
  ).then((choice) => {
    if (!choice) return;
    const index = choices.indexOf(choice);
    const item = all[index];
    if (item) void ctx.ui.editor(`${item.name} · MCP (read-only)`, item.details).then(() => {});
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
 * Move only still-safe, previously approved session files to trash.
 * Recheck protections before every deletion; one trash failure never stops others.
 */
async function clearOtherSessions(
  pi: ExtensionAPI,
  targets: readonly { readonly id: string; readonly path: string; readonly snapshot: SessionFileSnapshot }[],
  canDelete: (target: { readonly id: string; readonly path: string; readonly snapshot: SessionFileSnapshot }) => Promise<boolean>,
): Promise<{ readonly deleted: number; readonly failed: number; readonly skipped: number; readonly firstError?: string }> {
  let deleted = 0;
  let skipped = 0;
  let firstError: string | undefined;
  for (const target of targets) {
    if (!(await canDelete(target))) {
      skipped++;
      continue;
    }
    const result = await deleteSessionFile(pi, target.path);
    if (result.ok) deleted++;
    else firstError ??= result.error;
  }
  return { deleted, skipped, failed: targets.length - deleted - skipped, ...(firstError === undefined ? {} : { firstError }) };
}

export default async function piUiExtension(pi: ExtensionAPI): Promise<void> {
  const toolView = await installToolViewController(pi);
  const activeLease = createActiveSessionLease(ACTIVE_SESSIONS_DIR);
  let activeLeaseHealthy = true;
  const updateActiveLease = (ctx: ExtensionContext): void => {
    try {
      activeLease.update(ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile());
      activeLeaseHealthy = true;
    } catch (error) {
      activeLeaseHealthy = false;
      ctx.ui.notify(`Active session protection unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  };
  let mcpResources: readonly ResourceEntry[] = [];
  let liveMcpServers: NonNullable<ReturnType<typeof adapterMcpServers>> = [];
  let hasStartedSession = false;
  let registeredServers: unknown = [];
  let mcpCwd = process.cwd();
  let mcpTrusted = false;
  let mcpStatus: McpStatusSnapshot = { servers: [], warnings: [] };
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
  let sessionManagerOpen = false;
  const safeReadPins = (): ReadonlySet<string> => {
    try { return readSessionPins(SESSION_PINS_FILE); }
    catch { return new Set(); } // Broken preferences must not hide saved sessions.
  };
  const sessionCatalog = createSessionCatalog();
  const loadSessionRows = async (ctx: ExtensionContext): Promise<readonly SessionListItem[]> => {
    const currentId = ctx.sessionManager.getSessionId();
    const pinned = safeReadPins();
    const sessions = await sessionCatalog(ctx.cwd, ctx.sessionManager.getSessionDir());
    return sortedSessions(sessions.map((session) => ({
      id: session.id,
      title: session.name ?? session.firstMessage,
      modified: session.modified,
      userPromptCount: session.userPromptCount,
      current: session.id === currentId,
      pinned: pinned.has(session.id),
    })), "recent");
  };
  const canManageSessions = (ctx: ExtensionContext): boolean => {
    if (ctx.isIdle()) return true;
    ctx.ui.notify("Wait for the current run to finish before managing sessions", "warning");
    return false;
  };
  const selectSession = (ctx: ExtensionContext, session: SessionListItem): void => {
    if (session.current || switchRequested || !canManageSessions(ctx)) return;
    switchRequested = true;
    pi.sendUserMessage(`/${SESSION_SWITCH_COMMAND} ${session.id}`, { expandPromptTemplates: true });
  };
  const renameSession = (ctx: ExtensionContext, session: SessionListItem): void => {
    if (!canManageSessions(ctx)) return;
    pi.sendUserMessage(`/${SESSION_RENAME_COMMAND} ${session.id}`, { expandPromptTemplates: true });
  };
  const deleteSession = (ctx: ExtensionContext, session: SessionListItem): void => {
    if (session.current) {
      ctx.ui.notify("Cannot delete the currently active session", "warning");
      return;
    }
    if (!canManageSessions(ctx)) return;
    pi.sendUserMessage(`/${SESSION_DELETE_COMMAND} ${session.id}`, { expandPromptTemplates: true });
  };
  const launchSessionManager = async (ctx: ExtensionContext): Promise<void> => {
    if (sessionManagerOpen || !canManageSessions(ctx)) return;
    sessionManagerOpen = true;
    try {
      await openSessionManager({
        ui: createDialogUI(ctx.ui),
        loadSessions: () => loadSessionRows(ctx),
        togglePin: (id) => toggleSessionPin(SESSION_PINS_FILE, id),
        onPinChanged: () => refreshSessions(),
        onSwitch: (session) => selectSession(ctx, session),
        onRename: (session) => renameSession(ctx, session),
        onDelete: (session) => deleteSession(ctx, session),
      });
    } catch (error) {
      ctx.ui.notify(`Failed to open Sessions manager: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      sessionManagerOpen = false;
    }
  };
  const getMcpServerNames = () => mcpResources.map((server) => server.name);
  const updateMcpStatus = (): void => {
    mcpStatus = buildMcpStatusSnapshot(getAgentDir(), mcpCwd, mcpTrusted, registeredServers, liveMcpServers);
    mcpResources = mcpStatus.servers
      .filter((server) => server.enabled)
      .map((server) => ({ name: server.name, description: describeMcpStatus(server) }));
    const branch = getCurrentBranch?.();
    if (branch) toolUsage?.resetSession(branch, getMcpServerNames(), { preserveExchange: true });
    sidebar?.refresh();
  };
  const unsubscribeMcpStatus = pi.events.on("pi-mcp-adapter/status/v1", (value) => {
    const observation = adapterMcpServers(value);
    if (!observation) return;
    liveMcpServers = observation;
    updateMcpStatus();
  });
  pi.on("mcp_servers_change", (event) => {
    registeredServers = event.servers;
    updateMcpStatus();
  });

  pi.registerCommand(SESSION_MANAGER_COMMAND, {
    description: "Search, sort, page, pin, switch, rename and delete saved sessions",
    handler: async (_args, ctx) => launchSessionManager(ctx),
  });

  pi.registerCommand(SESSION_RENAME_COMMAND, {
    description: "Rename a saved session selected from the sidebar",
    handler: async (args, ctx) => {
      const sessionId = args.trim();
      if (!sessionId) {
        ctx.ui.notify("Missing session id", "error");
        return;
      }
      if (!canManageSessions(ctx)) return;

      try {
        const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
        const target = sessions.find((session) => session.id === sessionId);
        if (!target) {
          ctx.ui.notify("Session no longer exists", "error");
          refreshSessions();
          return;
        }
        const title = target.name ?? target.firstMessage;
        // Captured before the dialog: the file must still be this exact file afterwards.
        const before = await snapshotClearableSession(target.path);
        if (!before) {
          ctx.ui.notify("Session file is missing or is not a regular file", "error");
          refreshSessions();
          return;
        }
        const nextName = await createDialogUI(ctx.ui).input("Rename session", title);
        const next = nextName?.trim();
        if (!next) return;

        // Revalidate after the dialog: idle, same session, same file, unchanged content.
        if (!canManageSessions(ctx)) return;
        if (target.id === ctx.sessionManager.getSessionId()) {
          // Pi writes the live session itself, so appends are expected here; only a
          // removed or replaced file means the rename would land elsewhere.
          if (!(await sameSessionFile(target.path, before))) {
            ctx.ui.notify("Session file was removed or replaced during rename; nothing was saved", "warning");
            refreshSessions();
            return;
          }
          pi.setSessionName(next);
          ctx.ui.notify("Session renamed", "info");
          return;
        }
        const renamed = await renameSavedSession({
          cwd: ctx.cwd,
          sessionDir: ctx.sessionManager.getSessionDir(),
          sessionId: target.id,
          path: target.path,
          name: next,
          before,
          activePaths: () => readActiveSessionPaths(ACTIVE_SESSIONS_DIR),
        });
        refreshSessions();
        ctx.ui.notify(renamed.ok ? "Session renamed" : renamed.message, renamed.ok ? "info" : renamed.level);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to rename session: ${message}`, "error");
      }
    },
  });

  pi.registerCommand(SESSION_DELETE_COMMAND, {
    description: "Delete a saved session selected from the sidebar",
    handler: async (args, ctx) => {
      if (!canManageSessions(ctx)) return;
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
        const before = statSync(target.path);
        const confirmed = await createDialogUI(ctx.ui).confirm(
          "Delete session",
          `Move “${target.name ?? target.firstMessage ?? target.id}” to trash? This session cannot be restored from Pi; it can be recovered from your system trash.`,
        );
        if (!confirmed) return;
        // Revalidate after the user interacted with the modal.
        if (!ctx.isIdle() || target.id === ctx.sessionManager.getSessionId() ||
            (await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir()))
              .find((session) => session.id === sessionId)?.path !== target.path) return;
        if (readActiveSessionPaths(ACTIVE_SESSIONS_DIR).has(resolve(target.path))) {
          ctx.ui.notify("Session is in use by another Pi instance; deletion cancelled", "warning");
          return;
        }
        const after = statSync(target.path);
        if (before.dev !== after.dev || before.ino !== after.ino ||
            before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          ctx.ui.notify("Session changed during confirmation; deletion cancelled", "warning");
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
    description: "Preview and move eligible noncurrent, unpinned saved sessions to trash",
    handler: async (_args, ctx) => {
      try {
        if (!canManageSessions(ctx)) return;
        if (!activeLeaseHealthy) {
          ctx.ui.notify("Bulk cleanup is disabled: active session protection is unavailable", "error");
          return;
        }
        const currentSessionId = ctx.sessionManager.getSessionId();
        const pinnedIds = readSessionPins(SESSION_PINS_FILE);
        const activePaths = readActiveSessionPaths(ACTIVE_SESSIONS_DIR);
        const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
        const { candidates, summary } = await previewSessionCleanup(sessions, currentSessionId, pinnedIds, activePaths);
        const confirmed = await confirmSessionCleanup(ctx.ui, summary);
        if (!confirmed) return;

        // Confirmed IDs are an upper bound: never include sessions created or
        // replaced while the dialog was open.
        const stillListed = new Map((await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir()))
          .map((session) => [session.id, session.path]));
        const result = await clearOtherSessions(pi, candidates, async (target) => {
          if (!ctx.isIdle() || target.id === ctx.sessionManager.getSessionId() ||
              stillListed.get(target.id) !== target.path) return false;
          if (readSessionPins(SESSION_PINS_FILE).has(target.id) ||
              readActiveSessionPaths(ACTIVE_SESSIONS_DIR).has(resolve(target.path))) return false;
          return sessionFileUnchanged(target.path, target.snapshot);
        });
        refreshSessions();
        if (result.failed > 0) {
          ctx.ui.notify(
            `Cleared ${result.deleted}; ${result.skipped} protected/changed; ${result.failed} failed: ${result.firstError ?? "unknown error"}`,
            "error",
          );
          return;
        }
        ctx.ui.notify(`Cleared ${result.deleted} session(s) to trash; ${result.skipped} protected/changed`, "info");
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
  const streamingTokens = createStreamingTokenSampler(estimateTokens, (tokens, observedAt) => {
    activity?.updateResponseEstimate(tokens, observedAt);
  });
  const contextEstimates = installContextEstimates(pi, refreshContextUi);
  const refreshSessions = () => {
    sidebar?.updatePanel(SESSION_PANEL_ID, undefined);
  };
  pi.on("before_agent_start", (_event) => {
    // Pi emits this for idle custom triggerTurn runs as well as user prompts.
    // Both start a new usage exchange; never assume a prompt exists.
    contextEstimates.resetDelta();
    toolUsage?.startExchange();
    sidebar?.refresh();
  });
  pi.on("agent_start", (_event, ctx) => {
    // A fresh Pi session creates its JSONL file only after its first user message.
    updateActiveLease(ctx);
    activity?.startRun();
    refreshContextUi();
  });
  pi.on("turn_start", (event) => {
    activity?.startTurn(event.turnIndex);
    sidebar?.refresh();
  });
  pi.on("before_provider_request", () => {
    streamingTokens.reset();
    activity?.startResponse();
  });
  pi.on("message_update", (event) => {
    if (activity) streamingTokens.observe(event.message);
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
  pi.on("agent_settled", (event) => {
    activity?.settle(undefined, event.aborted === true);
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
    // A reload may start without session_shutdown. Release the old layout and
    // mouse listeners while their original context is still valid; otherwise
    // a second sidebar can wrap the first and leave priority listeners behind.
    activity?.reset();
    sidebar?.dispose();
    footer?.dispose();
    clearControllers();
    // Keep an early first-start snapshot, but never carry another session's
    // adapter health over a reload.
    if (hasStartedSession) liveMcpServers = [];
    hasStartedSession = true;
    updateActiveLease(ctx);
    mcpCwd = ctx.cwd;
    mcpTrusted = ctx.isProjectTrusted();
    registeredServers = pi.getMcpServers();
    updateMcpStatus();
    toolViewMode = toolView.getMode();
    getCurrentBranch = () => ctx.sessionManager.getBranch();
    const branch = ctx.sessionManager.getBranch();
    resetCacheUsage(branch);
    toolUsage = createToolUsageTracker([], getMcpServerNames);
    toolUsage.resetSession(branch);
    if (ctx.mode !== "tui") return;

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
          loadSessions: () => loadSessionRows(ctx),
          onSelectSession: (session): void => selectSession(ctx, session),
          onRenameSession: (session): void => renameSession(ctx, session),
          onDeleteSession: (session): void => deleteSession(ctx, session),
          onTogglePinSession: (session): void => {
            try {
              const pinned = toggleSessionPin(SESSION_PINS_FILE, session.id);
              refreshSessions();
              ctx.ui.notify(pinned ? "会话已置顶" : "已取消置顶", "info");
            } catch (error) {
              ctx.ui.notify(`保存置顶失败：${error instanceof Error ? error.message : String(error)}`, "error");
            }
          },
          onOpenSessionManager: (): void => { void launchSessionManager(ctx); },
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
            if (button === "mcp") {
              updateMcpStatus();
              showMcpStatusDialog({ ui: createDialogUI(ctx.ui) }, mcpStatus);
              return;
            }
            void loadResourceEntries(pi, ctx.cwd, mcpResources, ctx.isProjectTrusted(), button)
              .then((rows) => {
                if (!rows || rows.length === 0) {
                  ctx.ui.notify("No resources of this kind loaded", "info");
                  return;
                }
                if (button === "agents" && rows.length === 1) {
                  showResourceDialog({ ui: createDialogUI(ctx.ui) }, button, rows, rows[0]!.content);
                  return;
                }
                showResourceDialog({ ui: createDialogUI(ctx.ui) }, button, rows);
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
    activeLease.dispose();
    unsubscribeToolViewMode();
    unsubscribeMcpStatus();
    liveMcpServers = [];

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
