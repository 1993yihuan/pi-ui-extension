import { open, stat, type FileHandle } from "node:fs/promises";

type SessionPath = { readonly path: string };
type CachedCount = {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly head: string;
  readonly tail: string;
  readonly count: number;
  readonly pending: Buffer;
};

/** A small prefix/old-EOF fingerprint catches many in-place rewrites before append. */
async function signature(file: FileHandle, size: number): Promise<{ head: string; tail: string }> {
  const length = Math.min(128, size);
  const read = async (start: number): Promise<string> => {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await file.read(buffer, offset, length - offset, start + offset);
      if (bytesRead === 0) throw new Error("Session changed while counting");
      offset += bytesRead;
    }
    return buffer.toString("base64");
  };
  return { head: await read(0), tail: await read(size - length) };
}

function isUserQuestion(line: Buffer): boolean {
  const text = line.toString("utf8");
  if (!/"role"\s*:\s*"user"/.test(text)) return false;
  try {
    const entry: unknown = JSON.parse(text);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const outer = entry as { type?: unknown; message?: unknown };
    return outer.type === "message" && outer.message !== null &&
      typeof outer.message === "object" &&
      (outer.message as { role?: unknown }).role === "user";
  } catch {
    return false;
  }
}

/**
 * Count only top-level user messages in Pi JSONL files. Subsequent appends
 * read just the new bytes; incomplete UTF-8/JSONL lines are buffered across
 * refreshes. A valid final line without newline is counted provisionally.
 */
export function createUserPromptCounter(options: { readonly onBytesRead?: (size: number) => void } = {}) {
  const cache = new Map<string, CachedCount>();

  const countFile = async (path: string): Promise<number | undefined> => {
    let file: FileHandle | undefined;
    try {
      file = await open(path, "r");
      const info = await file.stat();
      if (!info.isFile()) throw new Error("Not a regular session file");
      const previous = cache.get(path);
      if (previous?.size === info.size && previous.dev === info.dev &&
          previous.ino === info.ino && previous.mtimeMs === info.mtimeMs &&
          previous.ctimeMs === info.ctimeMs) {
        return previous.count + Number(previous.pending.length > 0 && isUserQuestion(previous.pending));
      }

      const mayAppend = previous !== undefined && info.dev === previous.dev &&
        info.ino === previous.ino && info.size > previous.size;
      const oldSignature = mayAppend ? await signature(file, previous.size) : undefined;
      const append = mayAppend && oldSignature?.head === previous.head &&
        oldSignature?.tail === previous.tail;
      const start = append ? previous.size : 0;
      let count = append ? previous.count : 0;
      let pending = append ? previous.pending : Buffer.alloc(0);

      if (start < info.size) {
        const input = file.createReadStream({ start, end: info.size - 1, autoClose: false });
        let parts: Buffer[] = pending.length ? [pending] : [];
        let buffered = pending.length;
        for await (const chunk of input) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          options.onBytesRead?.(bytes.length);
          let offset = 0;
          for (;;) {
            const newline = bytes.indexOf(10, offset);
            if (newline === -1) break;
            const fragment = bytes.subarray(offset, newline);
            const line = parts.length ? Buffer.concat([...parts, fragment], buffered + fragment.length) : fragment;
            if (isUserQuestion(line)) count++;
            parts = [];
            buffered = 0;
            offset = newline + 1;
          }
          if (offset < bytes.length) {
            const fragment = bytes.subarray(offset);
            parts.push(fragment);
            buffered += fragment.length;
          }
          if (buffered > 32 * 1024 * 1024) throw new Error("JSONL line exceeds safe memory bound");
        }
        pending = parts.length ? Buffer.concat(parts, buffered) : Buffer.alloc(0);
      }
      const after = await file.stat();
      const atPath = await stat(path);
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs ||
          after.ctimeMs !== info.ctimeMs || atPath.ino !== info.ino ||
          atPath.dev !== info.dev) throw new Error("Session changed while counting");
      const { head, tail } = await signature(file, info.size);
      cache.set(path, {
        dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs, head, tail, count, pending,
      });
      return count + Number(pending.length > 0 && isUserQuestion(pending));
    } catch {
      cache.delete(path);
      return undefined;
    } finally {
      await file?.close();
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
