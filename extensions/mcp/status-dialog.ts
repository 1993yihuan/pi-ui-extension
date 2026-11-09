import { errorMessage, t } from "../i18n.ts";
import { resourceDialogOptions, type ResourceDialogUi, type ResourceEntry } from "../resources.ts";
import { describeMcpStatus, type McpStatusSnapshot } from "./status-center.ts";

type StatusRow = ResourceEntry & { details: string };

function yesNo(value: boolean): string {
  return value ? t("mcp.yes") : t("mcp.no");
}

/**
 * Read-only MCP status picker; only safe metadata is displayed.
 * A rejected picker or detail view is reported with notify, same as resource loading.
 */
export function showMcpStatusDialog(
  ctx: { ui: ResourceDialogUi },
  snapshot: McpStatusSnapshot,
): void {
  const fail = (error: unknown) => {
    ctx.ui.notify(t("mcp.openFailed", { error: errorMessage(error) }), "error");
  };
  const rows: StatusRow[] = snapshot.servers.map((server) => ({
    name: server.name,
    description: describeMcpStatus(server),
    details: [
      t("mcp.detail.server", { name: server.name }),
      t("mcp.detail.source", { source: server.source }),
      t("mcp.detail.enabled", { value: yesNo(server.enabled) }),
      t("mcp.detail.observed", { value: yesNo(server.loaded) }),
      t("mcp.detail.status", { status: describeMcpStatus(server) }),
      "",
      t("mcp.detail.note"),
    ].join("\n"),
  }));
  const warnings: StatusRow[] = snapshot.warnings.map((warning) => ({
    name: t("mcp.warningName"),
    description: warning,
    details: t("mcp.warningDetails", { warning }),
  }));
  const all = [...rows, ...warnings];
  if (all.length === 0) {
    ctx.ui.notify(t("mcp.none"), "info");
    return;
  }
  const choices = resourceDialogOptions(all);
  const enabledCount = snapshot.servers.filter((server) => server.enabled).length;
  void ctx.ui.select(
    t("mcp.picker", { enabled: enabledCount, total: snapshot.servers.length }),
    choices,
  ).then((choice) => {
    if (!choice) return;
    const index = choices.indexOf(choice);
    const item = all[index];
    if (item) void ctx.ui.editor(t("mcp.editor", { name: item.name }), item.details).catch(fail);
  }).catch(fail);
}
