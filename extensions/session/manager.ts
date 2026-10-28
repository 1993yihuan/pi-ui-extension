import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { SessionListItem } from "./panel.ts";

export type SessionSort = "recent" | "oldest" | "prompts" | "title";
export const SESSION_PAGE_SIZE = 8;

const MAX_PINS = 2000;
const MAX_PINS_BYTES = 128_000;
const PIN_ID = /^[a-zA-Z0-9._-]{1,128}$/;

/** Store only opaque session ids; session contents and titles never leave Pi. */
export function readSessionPins(path: string): ReadonlySet<string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
  if (text.length > MAX_PINS_BYTES) throw new Error("Session pins file is too large");
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length > MAX_PINS ||
      !parsed.every((id) => typeof id === "string" && PIN_ID.test(id))) {
    throw new Error("Invalid session pins file");
  }
  return new Set(parsed as string[]);
}

/** The reader and the writer share one count and size limit, checked before anything is written. */
function serializeSessionPins(pins: ReadonlySet<string>): string {
  const ids = [...pins];
  if (ids.length > MAX_PINS) throw new Error(`Session pins cannot exceed ${MAX_PINS} entries`);
  const text = JSON.stringify(ids);
  if (text.length > MAX_PINS_BYTES) throw new Error(`Session pins cannot exceed ${MAX_PINS_BYTES} characters`);
  return text;
}

/** Atomic, user-private persistence. Never write back a corrupt pins file. */
function writeSessionPins(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  // "wx" claims the temporary name exclusively. Ownership starts at open, so a partial
  // write that throws still cleans up its own file, while EEXIST never touches a foreign one.
  const fd = openSync(temporary, "wx", 0o600);
  let opened = true;
  try {
    writeFileSync(fd, text, { encoding: "utf8" });
    closeSync(fd);
    opened = false;
    renameSync(temporary, path);
  } finally {
    if (opened) { try { closeSync(fd); } catch { /* keep the original failure */ } }
    rmSync(temporary, { force: true });
  }
}

function lockOwnerFile(lock: string): string {
  return `${lock}/owner.json`;
}

/**
 * An existing lock always fails the write: two processes can both judge an old lock dead,
 * and the later one would delete the lock its peer just took. Only a human removes leftovers.
 */
function acquirePinsLock(lock: string): void {
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Session pins are locked by another process; retry shortly (leftover lock: ${lockOwnerFile(lock)})`,
      );
    }
    throw error;
  }
  try {
    writeFileSync(lockOwnerFile(lock), JSON.stringify({ pid: process.pid }), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    rmSync(lock, { recursive: true, force: true });
    throw error;
  }
}

/** Pins are read-modify-written under a per-file lock so concurrent processes never drop an update. */
export function toggleSessionPin(path: string, id: string): boolean {
  if (!PIN_ID.test(id)) throw new Error("Invalid session identifier");
  const lock = `${path}.lock`;
  acquirePinsLock(lock);
  try {
    const pins = new Set(readSessionPins(path));
    const pinned = !pins.has(id);
    if (pinned) pins.add(id);
    else pins.delete(id);
    writeSessionPins(path, serializeSessionPins(pins));
    return pinned;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
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

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim() || "Unknown error";
}

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
  let sessions: readonly SessionListItem[] = [];
  let loadError: string | undefined;
  /** Keeps the last good list, sort, filter and page when a load fails. */
  const reload = async (): Promise<void> => {
    try {
      sessions = await options.loadSessions();
      loadError = undefined;
    } catch (error) {
      // A blank message must still read as a failure, never as an empty list.
      loadError = errorText(error);
      ui.notify(`刷新会话列表失败：${loadError}`, "warning");
    }
  };
  await reload();
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
      `Sessions · ${current.total}/${sessions.length} · ${page + 1}/${current.pages}${query ? ` · 搜索：${safeLabel(query)}` : ""}` +
        (loadError ? ` · ⚠ 加载失败：${safeLabel(loadError)}` : ""),
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
      await reload();
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
        let pinned: boolean;
        try {
          pinned = options.togglePin(session.id);
        } catch (error) {
          ui.notify(`保存置顶失败：${error instanceof Error ? error.message : String(error)}`, "error");
          continue;
        }
        // Already persisted: show it even if the reload below fails.
        sessions = sessions.map((item) => (item.id === session.id ? { ...item, pinned } : item));
        try {
          options.onPinChanged();
        } catch (error) {
          // The pin is already saved: a sidebar refresh failure is not a save failure.
          ui.notify(`刷新侧边栏失败：${errorText(error)}`, "warning");
        }
        page = 0;
        await reload();
        ui.notify(pinned ? "会话已置顶" : "已取消置顶", "info");
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
