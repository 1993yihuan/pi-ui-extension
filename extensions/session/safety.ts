import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const MAX_LEASE_FILES = 4096;

export type SessionFileSnapshot = {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
};

/** Capture file identity without excluding recent history; refuse links and non-files. */
export async function snapshotClearableSession(path: string): Promise<SessionFileSnapshot | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return undefined;
    return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
  } catch {
    return undefined;
  }
}

export async function sessionFileUnchanged(path: string, expected: SessionFileSnapshot): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && info.dev === expected.dev && info.ino === expected.ino &&
      info.size === expected.size && info.mtimeMs === expected.mtimeMs &&
      info.ctimeMs === expected.ctimeMs;
  } catch {
    return false;
  }
}

type LeaseRecord = { readonly pid: number; readonly sessionId: string; readonly path: string };

/**
 * Each Pi process advertises its active session in a private local directory.
 * PID liveness (not file age) keeps idle sessions protected without a timer.
 * Other Pi processes must load this extension to participate in the registry.
 */
export function createActiveSessionLease(directory: string): {
  update(sessionId: string, path: string | undefined): void;
  dispose(): void;
} {
  const filename = join(directory, `${process.pid}-${randomUUID()}.json`);
  let active = false;
  return {
    update(sessionId, path): void {
      if (!path || !isAbsolute(path)) {
        this.dispose();
        return;
      }
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      const record: LeaseRecord = { pid: process.pid, sessionId, path: resolve(path) };
      try {
        writeFileSync(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
        renameSync(temporary, filename);
        active = true;
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    dispose(): void {
      if (!active) return;
      rmSync(filename, { force: true });
      active = false;
    },
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only a definite ESRCH is proof that this process no longer exists.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Invalid/unreadable registry data blocks bulk deletion rather than guessing. */
export function readActiveSessionPaths(directory: string): ReadonlySet<string> {
  let entries: string[];
  try {
    entries = readdirSync(directory).filter((entry) => entry.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
  if (entries.length > MAX_LEASE_FILES) throw new Error("Too many active session records");
  const active = new Set<string>();
  for (const entry of entries) {
    const file = join(directory, entry);
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 4096) throw new Error("Invalid active session record");
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid active session record");
    const lease = data as Partial<LeaseRecord>;
    if (!Number.isSafeInteger(lease.pid) || (lease.pid ?? 0) <= 0 ||
        typeof lease.sessionId !== "string" || typeof lease.path !== "string" ||
        !isAbsolute(lease.path)) throw new Error("Invalid active session record");
    if (isProcessAlive(lease.pid!)) active.add(resolve(lease.path));
  }
  return active;
}
