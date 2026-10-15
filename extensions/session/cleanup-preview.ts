import { resolve } from "node:path";
import { snapshotClearableSession, type SessionFileSnapshot } from "./safety.ts";

export type CleanupSummary = {
  readonly eligible: number;
  readonly current: number;
  readonly pinned: number;
  readonly active: number;
  readonly unavailable: number;
  readonly protected: number;
};

export type CleanupCandidate = { readonly id: string; readonly path: string; readonly snapshot: SessionFileSnapshot };

/** Classify every visible project session once, then snapshot eligible paths in bounded batches. */
export async function previewSessionCleanup<T extends { readonly id: string; readonly path: string }>(
  sessions: readonly T[], currentId: string, pinned: ReadonlySet<string>, activePaths: ReadonlySet<string>,
): Promise<{ readonly candidates: readonly CleanupCandidate[]; readonly summary: CleanupSummary }> {
  const summary = { eligible: 0, current: 0, pinned: 0, active: 0, unavailable: 0, protected: 0 };
  const potential: T[] = [];
  for (const session of sessions) {
    if (session.id === currentId) summary.current++;
    else if (pinned.has(session.id)) summary.pinned++;
    else if (activePaths.has(resolve(session.path))) summary.active++;
    else potential.push(session);
  }
  const candidates: CleanupCandidate[] = [];
  for (let start = 0; start < potential.length; start += 8) {
    const batch = await Promise.all(potential.slice(start, start + 8).map(async (session) => ({
      id: session.id, path: session.path, snapshot: await snapshotClearableSession(session.path),
    })));
    for (const item of batch) {
      if (item.snapshot) candidates.push({ id: item.id, path: item.path, snapshot: item.snapshot });
      else summary.unavailable++;
    }
  }
  summary.eligible = candidates.length;
  summary.protected = summary.current + summary.pinned + summary.active + summary.unavailable;
  return { candidates, summary };
}
