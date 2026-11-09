import { resolve } from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createDialogUI } from "../dialogs/index.ts";
import { confirmSessionCleanup } from "../dialogs/session-cleanup.ts";
import { errorMessage, t } from "../i18n.ts";
import { previewSessionCleanup } from "./cleanup-preview.ts";
import { openSessionManager, readSessionPins, toggleSessionPin } from "./manager.ts";
import { deleteSessionFile } from "./mutations.ts";
import { renameSavedSession, sameSessionFile } from "./rename.ts";
import type { SessionListItem } from "./panel.ts";
import {
  readActiveSessionPaths,
  sessionFileUnchanged,
  snapshotClearableSession,
  type SessionFileSnapshot,
} from "./safety.ts";

const SESSION_SWITCH_COMMAND = "sidebar-session-switch";
const SESSION_RENAME_COMMAND = "sidebar-session-rename";
const SESSION_DELETE_COMMAND = "sidebar-session-delete";
const SESSION_CLEAR_COMMAND = "sidebar-session-clear-others";
const SESSION_MANAGER_COMMAND = "sessions-manager";

export type SessionUiDeps = {
  readonly pinsFile: string;
  readonly activeSessionsDir: string;
  readonly refreshSessions: () => void;
  readonly loadSessionRows: (ctx: ExtensionContext) => Promise<readonly SessionListItem[]>;
  readonly isLeaseHealthy: () => boolean;
};

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

/** Session commands and the sidebar actions that launch them. */
export function createSessionUi(pi: ExtensionAPI, deps: SessionUiDeps) {
  let switchRequested = false;
  let sessionManagerOpen = false;

  const canManageSessions = (ctx: ExtensionContext): boolean => {
    if (ctx.isIdle()) return true;
    ctx.ui.notify(t("notify.waitManage"), "warning");
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
      ctx.ui.notify(t("notify.cannotDeleteActive"), "warning");
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
        loadSessions: () => deps.loadSessionRows(ctx),
        togglePin: (id) => toggleSessionPin(deps.pinsFile, id),
        onPinChanged: () => deps.refreshSessions(),
        onSwitch: (session) => selectSession(ctx, session),
        onRename: (session) => renameSession(ctx, session),
        onDelete: (session) => deleteSession(ctx, session),
      });
    } catch (error) {
      ctx.ui.notify(t("notify.managerFailed", { error: errorMessage(error) }), "error");
    } finally {
      sessionManagerOpen = false;
    }
  };

  const register = (): void => {
    pi.registerCommand(SESSION_MANAGER_COMMAND, {
      description: t("cmd.manager"),
      handler: async (_args, ctx) => launchSessionManager(ctx),
    });

    pi.registerCommand(SESSION_RENAME_COMMAND, {
      description: t("cmd.rename"),
      handler: async (args, ctx) => {
        const sessionId = args.trim();
        if (!sessionId) {
          ctx.ui.notify(t("notify.missingId"), "error");
          return;
        }
        if (!canManageSessions(ctx)) return;

        try {
          const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
          const target = sessions.find((session) => session.id === sessionId);
          if (!target) {
            ctx.ui.notify(t("notify.sessionGone"), "error");
            deps.refreshSessions();
            return;
          }
          const title = target.name ?? target.firstMessage;
          // Captured before the dialog: the file must still be this exact file afterwards.
          const before = await snapshotClearableSession(target.path);
          if (!before) {
            ctx.ui.notify(t("notify.fileMissing"), "error");
            deps.refreshSessions();
            return;
          }
          const nextName = await createDialogUI(ctx.ui).input(t("dialog.renameTitle"), title);
          const next = nextName?.trim();
          if (!next) return;

          // Revalidate after the dialog: idle, same session, same file, unchanged content.
          if (!canManageSessions(ctx)) return;
          if (target.id === ctx.sessionManager.getSessionId()) {
            // Pi writes the live session itself, so appends are expected here; only a
            // removed or replaced file means the rename would land elsewhere.
            if (!(await sameSessionFile(target.path, before))) {
              ctx.ui.notify(t("notify.renameReplaced"), "warning");
              deps.refreshSessions();
              return;
            }
            pi.setSessionName(next);
            ctx.ui.notify(t("notify.renamed"), "info");
            return;
          }
          const renamed = await renameSavedSession({
            cwd: ctx.cwd,
            sessionDir: ctx.sessionManager.getSessionDir(),
            sessionId: target.id,
            path: target.path,
            name: next,
            before,
            activePaths: () => readActiveSessionPaths(deps.activeSessionsDir),
          });
          deps.refreshSessions();
          ctx.ui.notify(renamed.ok ? t("notify.renamed") : renamed.message, renamed.ok ? "info" : renamed.level);
        } catch (error) {
          ctx.ui.notify(t("notify.renameFailed", { error: errorMessage(error) }), "error");
        }
      },
    });

    pi.registerCommand(SESSION_DELETE_COMMAND, {
      description: t("cmd.delete"),
      handler: async (args, ctx) => {
        if (!canManageSessions(ctx)) return;
        const sessionId = args.trim();
        if (!sessionId) {
          ctx.ui.notify(t("notify.missingId"), "error");
          return;
        }
        if (sessionId === ctx.sessionManager.getSessionId()) {
          ctx.ui.notify(t("notify.cannotDeleteActive"), "warning");
          return;
        }

        try {
          const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
          const target = sessions.find((session) => session.id === sessionId);
          if (!target) {
            ctx.ui.notify(t("notify.sessionGone"), "error");
            deps.refreshSessions();
            return;
          }
          const before = await snapshotClearableSession(target.path);
          if (!before) {
            ctx.ui.notify(t("notify.fileMissingDelete"), "warning");
            deps.refreshSessions();
            return;
          }
          const confirmed = await createDialogUI(ctx.ui).confirm(
            t("dialog.deleteTitle"),
            t("dialog.deleteBody", { title: target.name ?? target.firstMessage ?? target.id }),
          );
          if (!confirmed) return;
          // Revalidate after the user interacted with the modal.
          if (!ctx.isIdle() || target.id === ctx.sessionManager.getSessionId() ||
              (await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir()))
                .find((session) => session.id === sessionId)?.path !== target.path) return;
          if (readActiveSessionPaths(deps.activeSessionsDir).has(resolve(target.path))) {
            ctx.ui.notify(t("notify.inUse"), "warning");
            return;
          }
          // Match bulk cleanup: lstat rejects links, and ctime detects same-size
          // rewrites even when a concurrent process restores mtime.
          if (!(await sessionFileUnchanged(target.path, before))) {
            ctx.ui.notify(t("notify.changedConfirm"), "warning");
            return;
          }
          const result = await deleteSessionFile(pi, target.path);
          if (!result.ok) {
            ctx.ui.notify(t("notify.deleteFailed", { error: result.error }), "error");
            return;
          }
          deps.refreshSessions();
          ctx.ui.notify(t("notify.trashed"), "info");
        } catch (error) {
          ctx.ui.notify(t("notify.deleteFailed", { error: errorMessage(error) }), "error");
        }
      },
    });

    pi.registerCommand(SESSION_CLEAR_COMMAND, {
      description: t("cmd.clear"),
      handler: async (_args, ctx) => {
        try {
          if (!canManageSessions(ctx)) return;
          if (!deps.isLeaseHealthy()) {
            ctx.ui.notify(t("notify.bulkDisabled"), "error");
            return;
          }
          const currentSessionId = ctx.sessionManager.getSessionId();
          const pinnedIds = readSessionPins(deps.pinsFile);
          const activePaths = readActiveSessionPaths(deps.activeSessionsDir);
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
            if (readSessionPins(deps.pinsFile).has(target.id) ||
                readActiveSessionPaths(deps.activeSessionsDir).has(resolve(target.path))) return false;
            return sessionFileUnchanged(target.path, target.snapshot);
          });
          deps.refreshSessions();
          if (result.failed > 0) {
            ctx.ui.notify(
              t("notify.clearedPartial", {
                deleted: result.deleted,
                skipped: result.skipped,
                failed: result.failed,
                error: result.firstError ?? t("notify.unknown"),
              }),
              "error",
            );
            return;
          }
          ctx.ui.notify(t("notify.cleared", { deleted: result.deleted, skipped: result.skipped }), "info");
        } catch (error) {
          ctx.ui.notify(t("notify.clearFailed", { error: errorMessage(error) }), "error");
        }
      },
    });

    pi.registerCommand(SESSION_SWITCH_COMMAND, {
      description: t("cmd.switch"),
      handler: async (args, ctx) => {
        const sessionId = args.trim();
        if (!sessionId) {
          switchRequested = false;
          ctx.ui.notify(t("notify.missingId"), "error");
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
            ctx.ui.notify(t("notify.sessionGone"), "error");
            deps.refreshSessions();
            return;
          }

          const result = await ctx.switchSession(target.path);
          // Do not use the old command ctx after a successful replacement.
          if (!result.cancelled) return;
          switchRequested = false;
          ctx.ui.notify(t("notify.switchCancelled"), "info");
        } catch (error) {
          switchRequested = false;
          ctx.ui.notify(t("notify.switchFailed", { error: errorMessage(error) }), "error");
        }
      },
    });
  };

  return {
    register,
    canManageSessions,
    selectSession,
    renameSession,
    deleteSession,
    launchSessionManager,
    clearCommand: SESSION_CLEAR_COMMAND,
  };
}
