import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";

type SessionPath = { readonly path: string };
type CachedCount = { readonly size: number; readonly mtimeMs: number; readonly count: number };

/**
 * Pi SessionManager.list() supplies messageCount (all user/assistant/tool results),
 * not the number of user questions. Read just the top-level user messages in
 * the corresponding JSONL file, without retaining any message content.
 *
 * Bounded concurrency, streaming input, and mtime/size caching keep Sidebar
 * refreshes responsive even with many historical sessions.
 */
export function createUserPromptCounter() {
  const cache = new Map<string, CachedCount>();

  const countFile = async (path: string): Promise<number | undefined> => {
    try {
      const info = await stat(path);
      const previous = cache.get(path);
      if (previous?.size === info.size && previous.mtimeMs === info.mtimeMs) return previous.count;

      let count = 0;
      const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          // Most JSONL rows are assistant/tool results; only parse possible
          // user messages, avoiding expensive JSON.parse of large tool output.
          if (!/"role"\s*:\s*"user"/.test(line)) continue;
          try {
            const entry: unknown = JSON.parse(line);
            if (entry && typeof entry === "object" && "type" in entry &&
                entry.type === "message" && "message" in entry &&
                entry.message && typeof entry.message === "object" &&
                "role" in entry.message && entry.message.role === "user") count++;
          } catch { /* Corrupt/truncated rows are not user questions. */ }
        }
      } finally {
        lines.close();
      }
      cache.set(path, { size: info.size, mtimeMs: info.mtimeMs, count });
      return count;
    } catch {
      cache.delete(path);
      return undefined; // Show unknown rather than falsely claiming zero questions.
    }
  };

  return async (sessions: readonly SessionPath[]): Promise<(number | undefined)[]> => {
    const result = new Array<number | undefined>(sessions.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, sessions.length) }, async () => {
      while (next < sessions.length) {
        const index = next++;
        result[index] = await countFile(sessions[index]!.path);
      }
    }));
    const paths = new Set(sessions.map((session) => session.path));
    for (const path of cache.keys()) if (!paths.has(path)) cache.delete(path);
    return result;
  };
}
