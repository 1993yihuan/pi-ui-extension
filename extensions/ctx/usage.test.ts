import assert from "node:assert/strict";
import test from "node:test";
import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import {
  createContextUsageCache,
  createPanelContextUsage,
  panelContextUsageReader,
  readBranchKey,
  type ContextUsageKey,
  type ContextUsageModel,
} from "./usage.ts";
import { ContextPanel } from "./panel.ts";
import { estimateContext } from "./data.ts";

const usage: ContextUsage = { tokens: 2000, contextWindow: 200000, percent: 1 };
const model: ContextUsageModel = { api: "anthropic-messages", provider: "provider", id: "model-a", contextWindow: 200000 };

/** Leaves are entry objects, like the host's stored entries: stable until a new append. */
function branchManager(leaf: string) {
  const entries = new Map<string, { id: string }>();
  const entry = (id: string) => entries.get(id) ?? entries.set(id, { id }).get(id)!;
  let current = leaf;
  const manager = {
    getSessionId: () => "session-1",
    getLeafId: () => current,
    getLeafEntry: () => entry(current),
    setLeaf(next: string): void { current = next; },
  };
  return { manager, entry };
}

const modelKeyName = (window: number) => ["provider", "model-a", String(window)].join("\u0000");
const keyFor = (manager: { getSessionId(): string; getLeafId(): string | null; getLeafEntry(): unknown }, name = modelKeyName(200000)): ContextUsageKey => ({
  sessionManager: manager, sessionId: manager.getSessionId(), leafId: manager.getLeafId(), leaf: manager.getLeafEntry(), model: name,
});

function host(value: () => ContextUsage | undefined, current: () => ContextUsageModel | undefined = () => model) {
  let reads = 0;
  const { manager } = branchManager("leaf-1");
  const host: { model: ContextUsageModel | undefined; sessionManager: unknown; getContextUsage(): ContextUsage | undefined } = {
    get model(): ContextUsageModel | undefined { return current(); },
    sessionManager: manager,
    getContextUsage: () => { reads += 1; return value(); },
  };
  return { host, manager, reads: () => reads };
}

test("readBranchKey reads the public session identity and refuses an unknown shape", () => {
  const { manager, entry } = branchManager("a");
  assert.deepEqual(readBranchKey(manager), { sessionManager: manager, sessionId: "session-1", leafId: "a", leaf: entry("a") });
  assert.equal(readBranchKey(undefined), undefined);
  assert.equal(readBranchKey(null), undefined);
  assert.equal(readBranchKey({}), undefined);
  assert.equal(readBranchKey({ getSessionId: () => "s", getLeafId: () => null }), undefined,
    "a host without leaf identity can never prove a cached value current");
  assert.equal(readBranchKey({ getSessionId: () => "s", getLeafId: () => null, getLeafEntry: () => { throw new Error("gone"); } }), undefined);
});

test("cached usage survives repeated reads and recomputes when the branch or model changes", () => {
  const { manager } = branchManager("leaf-1");
  let reads = 0;
  let name = modelKeyName(200000);
  const cache = createContextUsageCache(() => { reads++; return usage; }, () => keyFor(manager, name));

  assert.strictEqual(cache.get(), usage);
  assert.strictEqual(cache.get(), usage);
  assert.strictEqual(cache.get(), usage);
  assert.equal(reads, 1, "an unchanged branch must not rescan");

  manager.setLeaf("leaf-2");
  assert.strictEqual(cache.get(), usage);
  assert.equal(reads, 2, "a new leaf must rescan");

  name = modelKeyName(400000);
  cache.get();
  assert.equal(reads, 3, "the same model id with another context window must rescan");
  cache.get();
  assert.equal(reads, 3, "the new state is cached again");

  cache.invalidate();
  cache.get();
  assert.equal(reads, 4, "an in-place change must force a rescan");
});

test("a session switch, a cached undefined result and an unavailable key are handled", () => {
  let reads = 0;
  let { manager } = branchManager("leaf-1");
  const cache = createContextUsageCache(() => { reads++; return undefined; }, () => keyFor(manager));
  assert.equal(cache.get(), undefined);
  assert.equal(cache.get(), undefined);
  assert.equal(reads, 1, "an undefined usage is a result, not a miss");

  manager = branchManager("leaf-1").manager;
  cache.get();
  assert.equal(reads, 2, "another session manager must not reuse the previous session");

  const noKey = createContextUsageCache(() => { reads++; return usage; }, () => undefined);
  noKey.get();
  noKey.get();
  assert.equal(reads, 4, "without a trustworthy key every read reaches the host");
});

test("the panel cache keys the exact context window and skips models it cannot attribute", () => {
  // Normal model: one host read across frames, and a window change on the same id rescans.
  let current: ContextUsageModel = model;
  const normal = host(() => usage, () => current);
  const cache = createPanelContextUsage(normal.host);
  for (let frame = 0; frame < 5; frame++) assert.strictEqual(cache.get(), usage);
  assert.equal(normal.reads(), 1);
  current = { ...model, contextWindow: 400000 };
  assert.strictEqual(cache.get(), usage);
  assert.equal(normal.reads(), 2, "a changed context window must rescan even with the same provider and id");

  // Virtual model: its limits come from the routed physical model, so never serve a cached one.
  const virtual = host(() => usage, () => ({ ...model, api: "pi-virtual", contextWindow: 0 }));
  const virtualCache = createPanelContextUsage(virtual.host);
  virtualCache.get();
  virtualCache.get();
  assert.equal(virtual.reads(), 2, "a virtual model must always read the host");

  // Unknown router: the host reports a window this model does not own, so the answer is never reused.
  const mismatched = host(() => ({ tokens: 10, contextWindow: 400000, percent: 0 }), () => model);
  const mismatchedCache = createPanelContextUsage(mismatched.host);
  mismatchedCache.get();
  mismatchedCache.get();
  assert.equal(mismatched.reads(), 2);

  // A model without a context window or an unknown session shape is never cached either.
  const noWindow = host(() => undefined, () => ({ api: "x", provider: "p", id: "i" }));
  createPanelContextUsage(noWindow.host).get();
  createPanelContextUsage(noWindow.host).get();
  assert.equal(noWindow.reads(), 2);
  const noBranch = host(() => usage, () => model);
  noBranch.host.sessionManager = {};
  const noBranchCache = createPanelContextUsage(noBranch.host);
  noBranchCache.get();
  noBranchCache.get();
  assert.equal(noBranch.reads(), 2);
});

test("a zero-window model caches the host's undefined answer instead of re-reading it", () => {
  const zeroWindow = host(() => undefined, () => ({ ...model, contextWindow: 0 }));
  const cache = createPanelContextUsage(zeroWindow.host);
  for (let frame = 0; frame < 5; frame++) assert.equal(cache.get(), undefined);
  assert.equal(zeroWindow.reads(), 1);
});

test("the panel reader never falls back to the host when the cache legitimately has no value", () => {
  const { manager } = branchManager("leaf-1");
  let reads = 0;
  const cache = createContextUsageCache(() => { reads++; return undefined; }, () => keyFor(manager));
  const reader = panelContextUsageReader(cache, () => { reads += 100; return usage; });
  for (let frame = 0; frame < 5; frame++) assert.equal(reader(), undefined);
  assert.equal(reads, 1, "a cached undefined must not trigger a direct host read");

  const direct = panelContextUsageReader(undefined, () => { reads += 1000; return usage; });
  assert.strictEqual(direct(), usage);
  assert.equal(reads, 1001, "without a cache the host answers");
});

test("the CTX panel renders without rescanning usage until the branch moves", () => {
  const counting = host(() => usage);
  const cache = createPanelContextUsage(counting.host);
  const panel = new ContextPanel({ fg: (_color: string, text: string) => text } as any, {
    getDesiredWidth: () => 50,
    getUsage: panelContextUsageReader(cache, () => usage),
    getCacheHitRate: () => 0,
    getEstimate: () => estimateContext([{ role: "user", content: "abcd" }]),
    getModel: () => "model",
    getThinkingLevel: () => "off",
  });
  for (let frame = 0; frame < 5; frame++) assert.ok(panel.render(50)[2].includes("1%/200K"));
  assert.equal(counting.reads(), 1, "five frames on one branch read usage once");

  counting.manager.setLeaf("leaf-2");
  panel.render(50);
  assert.equal(counting.reads(), 2, "a branch switch rescans on the next frame");

  cache.invalidate();
  panel.render(50);
  assert.equal(counting.reads(), 3, "an invalidated frame rescans");
});

test("the CTX panel shows an unknown usage without re-reading it on every frame", () => {
  const counting = host(() => undefined, () => ({ ...model, contextWindow: 0 }));
  const cache = createPanelContextUsage(counting.host);
  const panel = new ContextPanel({ fg: (_color: string, text: string) => text } as any, {
    getDesiredWidth: () => 40,
    getUsage: panelContextUsageReader(cache, () => { throw new Error("host read from the panel"); }),
    getModel: () => "model",
    getThinkingLevel: () => "off",
  });
  for (let frame = 0; frame < 5; frame++) assert.ok(panel.render(40)[2].includes("?"));
  assert.equal(counting.reads(), 1);
});
