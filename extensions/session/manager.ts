import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { SessionListItem } from "./panel.ts";

export type SessionSort = "recent" | "oldest" | "prompts" | "title";
export const SESSION_PAGE_SIZE = 8;

/** Store only opaque session ids; session contents and titles never leave Pi. */
export function readSessionPins(path: string): ReadonlySet<string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
  if (text.length > 128_000) throw new Error("Session pins file is too large");
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length > 2000 ||
      !parsed.every((id) => typeof id === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(id))) {
    throw new Error("Invalid session pins file");
  }
  return new Set(parsed as string[]);
}

/** Atomic, user-private persistence. Never write back a corrupt pins file. */
export function toggleSessionPin(path: string, id: string): boolean {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(id)) throw new Error("Invalid session identifier");
  const pins = new Set(readSessionPins(path));
  const pinned = !pins.has(id);
  if (pinned) pins.add(id);
  else pins.delete(id);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify([...pins]), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return pinned;
}

export function sortedSessions(sessions: readonly SessionListItem[], sort: SessionSort): SessionListItem[] {
  return [...sessions].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    const diff = sort === "recent" ? b.modified.getTime() - a.modified.getTime()
      : sort === "oldest" ? a.modified.getTime() - b.modified.getTime()
        : sort === "prompts" ? (b.userPromptCount ?? -1) - (a.userPromptCount ?? -1)
          : a.title.localeCompare(b.title);
    return (Number.isFinite(diff) ? diff : 0) || a.id.localeCompare(b.id);
  });
}

/** Pinned and active sessions are protected from the bulk-clear operation. */
export function sessionsEligibleForClear<T extends { readonly id: string }>(
  sessions: readonly T[], activeId: string, pins: ReadonlySet<string>,
): T[] {
  return sessions.filter((session) => session.id !== activeId && !pins.has(session.id));
}

export function getSessionPage(
  sessions: readonly SessionListItem[], query: string, sort: SessionSort, requestedPage: number,
  pageSize = SESSION_PAGE_SIZE,
): { readonly items: readonly SessionListItem[]; readonly total: number; readonly page: number; readonly pages: number } {
  const q = query.trim().toLocaleLowerCase();
  const filtered = sortedSessions(sessions.filter((session) =>
    !q || session.title.toLocaleLowerCase().includes(q) || session.id.toLocaleLowerCase().includes(q),
  ), sort);
  const pages = Math.max(1, Math.ceil(filtered.length / Math.max(1, pageSize)));
  const page = Math.max(0, Math.min(Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0, pages - 1));
  return {
    items: filtered.slice(page * pageSize, (page + 1) * pageSize),
    total: filtered.length, page, pages,
  };
}

export type SessionManagerUI = {
  select(title: string, choices: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, level: "info" | "warning" | "error"): void;
};

export type SessionManagerOptions = {
  readonly ui: SessionManagerUI;
  readonly loadSessions: () => Promise<readonly SessionListItem[]>;
  readonly togglePin: (id: string) => boolean;
  readonly onPinChanged: () => void;
  readonly onSwitch: (session: SessionListItem) => void;
  readonly onRename: (session: SessionListItem) => void;
  readonly onDelete: (session: SessionListItem) => void;
};

const SORT_CHOICES: ReadonlyArray<{ sort: SessionSort; label: string }> = [
  { sort: "recent", label: "最近更新" },
  { sort: "oldest", label: "最早更新" },
  { sort: "prompts", label: "提问次数" },
  { sort: "title", label: "会话标题" },
];

function safeLabel(title: string): string {
  const cleaned = stripTerminalSequences(title).replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ").trim() || "(未命名会话)";
  return truncateToWidth(cleaned, 65, "…");
}

/** Modal, bounded page of sessions; never executes destructive operations without confirmation. */
export async function openSessionManager(options: SessionManagerOptions): Promise<void> {
  const { ui } = options;
  let query = "";
  let sort: SessionSort = "recent";
  let page = 0;
  let sessions = await options.loadSessions();
  for (;;) {
    const current = getSessionPage(sessions, query, sort, page);
    page = current.page;
    const labels = current.items.map((session, index) =>
      `${index + 1}. ${session.pinned ? "★ " : ""}${session.current ? "● " : ""}${safeLabel(session.title)} · ${session.userPromptCount ?? "?"} 次提问`,
    );
    const actions = [
      "⌕ 搜索 / 清除搜索",
      `↕ 排序：${SORT_CHOICES.find((choice) => choice.sort === sort)!.label}`,
      ...(page > 0 ? ["← 上一页"] : []),
      ...(page + 1 < current.pages ? ["下一页 →"] : []),
      "↻ 刷新列表",
      "关闭",
    ];
    const choice = await ui.select(
      `Sessions · ${current.total}/${sessions.length} · ${page + 1}/${current.pages}${query ? ` · 搜索：${safeLabel(query)}` : ""}`,
      [...labels, ...actions],
    );
    if (!choice || choice === "关闭") return;
    if (choice === actions[0]) {
      const next = await ui.input("搜索会话标题或 ID（留空清除搜索）", query);
      if (next !== undefined) { query = next.trim(); page = 0; }
    } else if (choice === actions[1]) {
      const names = SORT_CHOICES.map(({ label, sort: key }) => `${key === sort ? "● " : "○ "}${label}`);
      const selection = await ui.select("会话排序（置顶始终优先）", names);
      const index = names.indexOf(selection ?? "");
      if (index >= 0) { sort = SORT_CHOICES[index]!.sort; page = 0; }
    } else if (choice === "← 上一页") {
      page--;
    } else if (choice === "下一页 →") {
      page++;
    } else if (choice === "↻ 刷新列表") {
      sessions = await options.loadSessions();
    } else {
      const index = labels.indexOf(choice);
      const session = current.items[index];
      if (index < 0 || !session) continue;
      const menu = [
        ...(session.current ? [] : ["切换到此会话"]),
        "重命名",
        session.pinned ? "取消置顶" : "置顶会话",
        ...(session.current ? [] : ["移到回收站"]),
        "返回列表",
      ];
      const action = await ui.select(`${safeLabel(session.title)} · 管理`, menu);
      if (action === "置顶会话" || action === "取消置顶") {
        try {
          const pinned = options.togglePin(session.id);
          ui.notify(pinned ? "会话已置顶" : "已取消置顶", "info");
          options.onPinChanged();
          sessions = await options.loadSessions();
          page = 0;
        } catch (error) {
          ui.notify(`保存置顶失败：${error instanceof Error ? error.message : String(error)}`, "error");
        }
      } else if (action === "移到回收站") {
        // The central delete command owns the final confirmation for both
        // the sidebar and this manager. Never present two successive prompts.
        options.onDelete(session);
        return;
      } else if (action === "切换到此会话") {
        options.onSwitch(session);
        return;
      } else if (action === "重命名") {
        options.onRename(session);
        return;
      }
    }
  }
}
