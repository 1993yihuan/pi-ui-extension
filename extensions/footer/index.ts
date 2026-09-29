import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { resolve, relative, sep, isAbsolute } from "node:path";

/** Render cwd with home directory collapsed to `~`, mirroring the built-in footer. */
function formatCwdForFooter(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export type FooterController = {
  refresh(): void;
  dispose(): void;
};

export function installFooter(
  ctx: ExtensionContext,
  onMount?: (tui: TUI, theme: Theme) => void,
  onUnmount?: () => void,
): FooterController {
  let tui: TUI | undefined;

  ctx.ui.setFooter((footerTui, theme, footerData): Component & { dispose(): void } => {
    tui = footerTui;
    onMount?.(footerTui, theme);
    const unsubscribeBranch = footerData.onBranchChange(() => footerTui.requestRender());
    // cwd may change across session reloads; re-render to keep the path fresh.
    const cwd = ctx.cwd;

    return {
      dispose(): void {
        unsubscribeBranch();
        onUnmount?.();
        if (tui === footerTui) tui = undefined;
      },
      invalidate(): void {},
      render(width: number): string[] {
        const branch = footerData.getGitBranch();
        const cwdLabel = formatCwdForFooter(cwd, process.env.HOME ?? process.env.USERPROFILE);
        const cwdSegment = theme.fg("dim", `📁 ${cwdLabel}`);
        const branchSegment = branch ? theme.fg("dim", ` ⎇ ${branch}`) : "";
        return [truncateToWidth(`${cwdSegment}${branchSegment}`, Math.max(0, width), "")];
      },
    };
  });

  return {
    refresh: () => tui?.requestRender(),
    dispose: () => {
      ctx.ui.setFooter(undefined);
      tui = undefined;
    },
  };
}
