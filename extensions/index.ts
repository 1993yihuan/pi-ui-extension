import { join } from "node:path";
import {
  estimateTokens,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { installContextEstimates } from "./ctx/data.ts";
import { createActivityTracker, createStreamingTokenSampler, type ActivityTracker } from "./ctx/activity.ts";
import { createDialogUI } from "./dialogs/index.ts";
import { installFooter, type FooterController } from "./footer/index.ts";
import { errorMessage, t } from "./i18n.ts";
import { adapterMcpServers, buildMcpStatusSnapshot, describeMcpStatus, type McpStatusSnapshot } from "./mcp/status-center.ts";
import { showMcpStatusDialog } from "./mcp/status-dialog.ts";
import { loadResourceEntries, showResourceDialog, type ResourceEntry } from "./resources.ts";
import { createSessionCatalog } from "./session/catalog.ts";
import { createSessionUi } from "./session/commands.ts";
import { readSessionPins, sortedSessions, toggleSessionPin } from "./session/manager.ts";
import type { SessionListItem } from "./session/panel.ts";
import { createActiveSessionLease } from "./session/safety.ts";
import {
  createDefaultSidebarPanels,
  SESSION_PANEL_ID,
} from "./sidebar/default-panels.ts";
import { installSidebar, type SidebarController } from "./sidebar/index.ts";
import { installToolViewController } from "./tool-view/controller.ts";
import type { ToolViewMode } from "./tool-view/types.ts";
import {
  createToolUsageTracker,
  type ToolUsageTracker,
} from "./tool-view/usage.ts";

export { loadResourceEntries, resourceDialogOptions, showResourceDialog, type ResourceEntry } from "./resources.ts";
export { showMcpStatusDialog } from "./mcp/status-dialog.ts";

const SESSION_PINS_FILE = join(getAgentDir(), "pi-ui-extension", "session-pins.json");
const SIDEBAR_LAYOUT_FILE = join(getAgentDir(), "pi-ui-extension", "ui-layout.json");
const ACTIVE_SESSIONS_DIR = join(getAgentDir(), "pi-ui-extension", "active-sessions");

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
      ctx.ui.notify(t("notify.activeLease", { error: errorMessage(error) }), "warning");
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
      unavailable: session.unavailable,
      current: session.id === currentId,
      pinned: pinned.has(session.id),
    })), "recent");
  };
  const refreshSessions = (): void => {
    sidebar?.updatePanel(SESSION_PANEL_ID, undefined);
  };
  const sessions = createSessionUi(pi, {
    pinsFile: SESSION_PINS_FILE,
    activeSessionsDir: ACTIVE_SESSIONS_DIR,
    refreshSessions,
    loadSessionRows,
    isLeaseHealthy: () => activeLeaseHealthy,
  });
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
  sessions.register();

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
          onSelectSession: (session): void => sessions.selectSession(ctx, session),
          onRenameSession: (session): void => sessions.renameSession(ctx, session),
          onDeleteSession: (session): void => sessions.deleteSession(ctx, session),
          onTogglePinSession: (session): void => {
            try {
              const pinned = toggleSessionPin(SESSION_PINS_FILE, session.id);
              refreshSessions();
              ctx.ui.notify(pinned ? t("session.notify.pinned") : t("session.notify.unpinned"), "info");
            } catch (error) {
              ctx.ui.notify(t("session.notify.pinFailed", { error: errorMessage(error) }), "error");
            }
          },
          onOpenSessionManager: (): void => { void sessions.launchSessionManager(ctx); },
          onDeleteOthers: (): void => {
            if (!ctx.isIdle()) {
              ctx.ui.notify(t("notify.waitClear"), "warning");
              return;
            }
            pi.sendUserMessage(`/${sessions.clearCommand}`, { expandPromptTemplates: true });
          },
          onOpenResources: (button): void => {
            if (!ctx.isIdle()) {
              ctx.ui.notify(t("notify.waitResources"), "warning");
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
                  ctx.ui.notify(t("notify.noResources"), "info");
                  return;
                }
                if (button === "agents" && rows.length === 1) {
                  showResourceDialog({ ui: createDialogUI(ctx.ui) }, button, rows, rows[0]!.content);
                  return;
                }
                showResourceDialog({ ui: createDialogUI(ctx.ui) }, button, rows);
              })
              .catch((error) => {
                ctx.ui.notify(t("notify.loadResourcesFailed", { error: errorMessage(error) }), "error");
              });
          },
        });
        // Wiring only: the sidebar owns the file format and all width policy.
        sidebar = installSidebar(tui, theme, panels, { layoutPath: SIDEBAR_LAYOUT_FILE });
        if (!sidebar.mounted) {
          ctx.ui.setStatus("pi-ui-extension:sidebar", t("notify.sidebarFullscreen"));
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
