import type { ContextUsage } from "@earendil-works/pi-coding-agent";

/** The branch state that decides what the host projects into the model context. */
export type BranchKey = {
  readonly sessionManager: unknown;
  readonly sessionId: string;
  readonly leafId: string | null;
  readonly leaf: unknown;
};

/** Branch identity plus the exact context window the reported percentages use. */
export type ContextUsageKey = BranchKey & { readonly model: string };

export type ContextUsageCache = {
  get(): ContextUsage | undefined;
  invalidate(): void;
};

/** The parts of an SDK model this cache needs; read defensively, never assumed. */
export type ContextUsageModel = {
  readonly api?: unknown;
  readonly provider?: unknown;
  readonly id?: unknown;
  readonly contextWindow?: unknown;
};

/** A session context that can answer context usage, as `ExtensionContext` does. */
export type ContextUsageHost = {
  readonly model: ContextUsageModel | undefined;
  readonly sessionManager: unknown;
  getContextUsage(): ContextUsage | undefined;
};

/**
 * Wire id of the SDK's virtual catalog entries (`VIRTUAL_MODEL_API` in the
 * host's virtual-models module). The host does not re-export it, so keep the
 * literal in this one place: a virtual model's limits come from the physical
 * model its router picked, which can change while the session branch does not.
 */
const VIRTUAL_MODEL_API = "pi-virtual";

type BranchReadout = {
  getSessionId?: () => string;
  getLeafId?: () => string | null;
  getLeafEntry?: () => unknown;
};

/**
 * Read the branch identity through the public session API. An unexpected shape
 * (another host version, a test double) returns undefined so callers recompute
 * instead of caching against a key they cannot trust.
 */
export function readBranchKey(sessionManager: unknown): BranchKey | undefined {
  const readout = sessionManager as BranchReadout | null | undefined;
  if (!readout ||
      typeof readout.getSessionId !== "function" ||
      typeof readout.getLeafId !== "function" ||
      typeof readout.getLeafEntry !== "function") return undefined;
  try {
    return { sessionManager, sessionId: readout.getSessionId(), leafId: readout.getLeafId(), leaf: readout.getLeafEntry() };
  } catch {
    return undefined;
  }
}

export function sameBranchKey(left: BranchKey, right: BranchKey): boolean {
  return left.sessionManager === right.sessionManager &&
    left.sessionId === right.sessionId &&
    left.leafId === right.leafId &&
    left.leaf === right.leaf;
}

function modelWindow(model: ContextUsageModel | undefined): number | undefined {
  const window = model?.contextWindow;
  return typeof window === "number" && Number.isFinite(window) && window >= 0 ? window : undefined;
}

/**
 * Key for models whose reported window is their own. A virtual model is never
 * keyed: its window comes from the routed physical model and can change without
 * a new leaf, so the caller reads the host every frame instead of caching it.
 */
function modelKey(model: ContextUsageModel | undefined): string | undefined {
  if (!model || model.api === VIRTUAL_MODEL_API) return undefined;
  const provider = typeof model.provider === "string" ? model.provider : undefined;
  const id = typeof model.id === "string" ? model.id : undefined;
  const window = modelWindow(model);
  if (provider === undefined || id === undefined || window === undefined) return undefined;
  return `${provider}\u0000${id}\u0000${window}`;
}

/**
 * A result may only be reused when it belongs to the model in the key. The host
 * reports the window it actually used, so a mismatch means another model answers
 * for this one (an unknown router): never cache that answer.
 */
function sameWindow(model: ContextUsageModel | undefined, value: ContextUsage | undefined): boolean {
  const window = modelWindow(model);
  if (window === undefined) return false;
  return value === undefined ? window === 0 : value.contextWindow === window;
}

/**
 * The host recomputes context usage from a full session projection and token
 * estimate on every call, and caches it for its own footer because that footer
 * renders on every frame. The CTX panel renders on every frame too, so keep the
 * result until the branch leaf or the context window changes. Appends, branch
 * switches, context edits and compaction all move the leaf; a message replaced
 * in place moves nothing and the caller invalidates.
 */
export function createContextUsageCache(
  read: () => ContextUsage | undefined,
  key: () => ContextUsageKey | undefined,
  reuse: (key: ContextUsageKey, value: ContextUsage | undefined) => boolean = () => true,
): ContextUsageCache {
  let cached: { readonly key: ContextUsageKey; readonly value: ContextUsage | undefined } | undefined;
  return {
    get(): ContextUsage | undefined {
      let next: ContextUsageKey | undefined;
      try {
        next = key();
      } catch {
        return read();
      }
      // No trustworthy key: never serve a value this cache cannot prove current.
      if (!next) return read();
      if (cached && sameBranchKey(cached.key, next) && cached.key.model === next.model) return cached.value;
      const value = read();
      cached = reuse(next, value) ? { key: next, value } : undefined;
      return value;
    },
    invalidate(): void {
      cached = undefined;
    },
  };
}

/** CTX usage for one session context, cached only where the key can prove it current. */
export function createPanelContextUsage(host: ContextUsageHost): ContextUsageCache {
  return createContextUsageCache(
    () => host.getContextUsage(),
    () => {
      const model = modelKey(host.model);
      const branch = readBranchKey(host.sessionManager);
      return model === undefined || !branch ? undefined : { ...branch, model };
    },
    (_key, value) => sameWindow(host.model, value),
  );
}

/**
 * Reader for the panel. With a cache present only the cache decides, so a
 * legitimately undefined usage is not re-read from the host on every frame.
 */
export function panelContextUsageReader(
  cache: ContextUsageCache | undefined,
  readHost: () => ContextUsage | undefined,
): () => ContextUsage | undefined {
  return cache ? () => cache.get() : readHost;
}
