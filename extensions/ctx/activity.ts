import nodePath from "node:path";

export type ToolActivityStatus = "running" | "done" | "failed";
export type ToolActivity = {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly status: ToolActivityStatus;
  readonly startedAt: number;
  readonly durationMs?: number;
};
export type ResponsePerformance = {
  readonly ttftMs?: number;
  readonly tokensPerSecond?: number;
  readonly estimated?: boolean;
};
export type TurnActivity = {
  readonly number: number;
  readonly startedAt: number;
  readonly durationMs?: number;
  readonly performance?: ResponsePerformance;
  readonly tools: readonly ToolActivity[];
};
export type RunActivitySnapshot = {
  readonly phase: "idle" | "running" | "settled";
  readonly turnNumber?: number;
  readonly startedAt?: number;
  readonly durationMs?: number;
  readonly performance?: ResponsePerformance;
  readonly averagePerformance?: ResponsePerformance;
  readonly turns: readonly TurnActivity[];
  readonly activeTools: readonly ToolActivity[];
  readonly recentTools: readonly ToolActivity[];
  readonly completedCount: number;
  readonly failedCount: number;
};
export type ToolStart = { readonly toolCallId: string; readonly toolName: string; readonly args: unknown };
export type ToolEnd = { readonly toolCallId: string; readonly isError: boolean };
export type ActivityTracker = {
  startRun(now?: number): void;
  startTurn(turnIndex: number, now?: number): void;
  finishTurn(turnIndex: number, now?: number): void;
  startResponse(now?: number): void;
  updateResponseEstimate(estimatedOutputTokens: number, now?: number): void;
  finishResponse(outputTokens: number, now?: number): void;
  startTool(event: ToolStart, now?: number): void;
  finishTool(event: ToolEnd, now?: number): void;
  settle(now?: number): void;
  reset(): void;
  getSnapshot(): RunActivitySnapshot;
};

const MAX_SUMMARY_LENGTH = 80;
export const EMPTY_ACTIVITY: RunActivitySnapshot = Object.freeze({
  phase: "idle", turns: Object.freeze([]), activeTools: Object.freeze([]), recentTools: Object.freeze([]), completedCount: 0, failedCount: 0,
});
type SpeedLabel = "fast" | "normal" | "slow";
function ttftSpeed(ms: number): SpeedLabel { return ms < 2_000 ? "fast" : ms < 5_000 ? "normal" : "slow"; }
function tpsSpeed(tps: number): SpeedLabel { return tps >= 50 ? "fast" : tps >= 20 ? "normal" : "slow"; }
export function formatTtft(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "~"
    : `${value < 1_000 ? "1s" : `${Math.max(0, value / 1_000).toFixed(1)}s`}[${ttftSpeed(value)}]`;
}
export function formatTps(value: number | undefined, estimated = false): string {
  return value === undefined || !Number.isFinite(value) ? "~"
    : `${estimated ? "~" : ""}${Math.max(0, value).toFixed(1)}[${tpsSpeed(value)}]`;
}
export function formatResponsePerformance(performance?: ResponsePerformance): string {
  return `TTFT ${formatTtft(performance?.ttftMs)} · TPS ${formatTps(performance?.tokensPerSecond, performance?.estimated)}`;
}
export function formatAveragePerformance(performance?: ResponsePerformance): string {
  return `TTFT avg ${formatTtft(performance?.ttftMs)} · TPS avg ${formatTps(performance?.tokensPerSecond)}`;
}
export function formatDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1_000);
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim() : "";
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function shortenPath(value: unknown, cwd: string): string {
  const input = clean(value); if (!input) return "";
  const absolute = nodePath.isAbsolute(input) ? nodePath.normalize(input) : nodePath.resolve(cwd, input);
  const relative = nodePath.relative(cwd, absolute);
  if (relative === "") return ".";
  if (relative !== ".." && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative)) return relative;
  const home = clean(process.env.HOME);
  if (home) {
    const homeRelative = nodePath.relative(home, absolute);
    if (homeRelative === "") return "~";
    if (homeRelative !== ".." && !homeRelative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(homeRelative)) return `~/${homeRelative}`;
  }
  return absolute;
}
function truncateSummary(value: string): string { return value.length > MAX_SUMMARY_LENGTH ? `${value.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : value; }
export function summarizeTool(toolName: string, args: unknown, cwd: string): string {
  const input = asRecord(args); if (!input) return "";
  const path = () => shortenPath(input.path, cwd);
  switch (toolName) {
    case "bash": return truncateSummary(clean(input.command));
    case "read": case "edit": case "write": case "ls": return truncateSummary(path());
    case "grep": case "find": {
      const pattern = clean(input.pattern), target = path();
      return truncateSummary(pattern && target ? `${pattern} in ${target}` : pattern || target);
    }
    default: return "";
  }
}

export function createActivityTracker(cwd: string, onChange: () => void): ActivityTracker {
  let phase: RunActivitySnapshot["phase"] = "idle";
  let turnNumber: number | undefined, startedAt: number | undefined, durationMs: number | undefined;
  let requestStartedAt: number | undefined, firstTokenAt: number | undefined, performance: ResponsePerformance | undefined;
  let turns: TurnActivity[] = [];
  let activeTools = new Map<string, ToolActivity>();
  let recentTools: ToolActivity[] = [];
  let completedCount = 0, failedCount = 0;
  const notify = (): void => onChange();
  const at = (now?: number): number => Math.max(0, Number.isFinite(now) ? Math.trunc(now as number) : Date.now());
  const turnNo = (index: number): number => Math.max(0, Number.isFinite(index) ? Math.trunc(index) : 0) + 1;
  const updateCurrentTurn = (update: (turn: TurnActivity) => TurnActivity): void => {
    turns = turns.map((turn) => turn.number === turnNumber ? Object.freeze(update(turn)) : turn);
  };
  const snapshotPerformance = (): ResponsePerformance | undefined => performance ? Object.freeze({ ...performance }) : undefined;
  const averagePerformance = (): ResponsePerformance | undefined => {
    const samples = turns.map((turn) => turn.performance).filter((sample): sample is ResponsePerformance => Boolean(sample));
    const ttftSamples = samples.map((sample) => sample.ttftMs).filter((value): value is number => value !== undefined && Number.isFinite(value));
    const tpsSamples = samples.map((sample) => sample.tokensPerSecond).filter((value): value is number => value !== undefined && Number.isFinite(value));
    if (ttftSamples.length === 0 && tpsSamples.length === 0) return undefined;
    return Object.freeze({
      ...(ttftSamples.length > 0 ? { ttftMs: ttftSamples.reduce((sum, value) => sum + value, 0) / ttftSamples.length } : {}),
      ...(tpsSamples.length > 0 ? { tokensPerSecond: tpsSamples.reduce((sum, value) => sum + value, 0) / tpsSamples.length } : {}),
    });
  };

  return {
    startRun(now): void {
      phase = "running"; turnNumber = undefined; startedAt = at(now); durationMs = undefined;
      requestStartedAt = undefined; firstTokenAt = undefined; performance = undefined; turns = [];
      activeTools = new Map(); recentTools = []; completedCount = 0; failedCount = 0; notify();
    },
    startTurn(index, now): void {
      const number = turnNo(index);
      if (turnNumber === number && phase === "running") return;
      phase = "running"; turnNumber = number; durationMs = undefined; performance = undefined;
      turns = [...turns, Object.freeze({ number, startedAt: at(now), tools: Object.freeze([]) })]; notify();
    },
    finishTurn(index, now): void {
      const number = turnNo(index), endedAt = at(now);
      turns = turns.map((turn) => turn.number === number && turn.durationMs === undefined
        ? Object.freeze({ ...turn, durationMs: Math.max(0, endedAt - turn.startedAt), ...(snapshotPerformance() ? { performance: snapshotPerformance() } : {}) })
        : turn);
      notify();
    },
    startResponse(now): void {
      requestStartedAt = at(now); firstTokenAt = undefined; performance = undefined; notify();
    },
    updateResponseEstimate(tokens, now): void {
      if (requestStartedAt === undefined || !Number.isFinite(tokens) || tokens <= 0) return;
      const observedAt = at(now);
      if (firstTokenAt === undefined) {
        firstTokenAt = observedAt; performance = Object.freeze({ ttftMs: Math.max(0, observedAt - requestStartedAt) }); notify(); return;
      }
      const generationMs = Math.max(0, observedAt - firstTokenAt);
      if (generationMs <= 0 || !performance) return;
      performance = Object.freeze({ ...performance, tokensPerSecond: tokens / (generationMs / 1_000), estimated: true }); notify();
    },
    finishResponse(tokens, now): void {
      const first = firstTokenAt; requestStartedAt = undefined; firstTokenAt = undefined;
      if (first === undefined || !performance) return;
      const generationMs = Math.max(0, at(now) - first);
      if (!Number.isFinite(tokens) || tokens <= 0 || generationMs <= 0) return;
      performance = Object.freeze({ ttftMs: performance.ttftMs, tokensPerSecond: tokens / (generationMs / 1_000) });
      updateCurrentTurn((turn) => ({ ...turn, performance: snapshotPerformance() })); notify();
    },
    startTool(event, now): void {
      const id = clean(event.toolCallId); if (!id) return;
      activeTools.set(id, Object.freeze({ id, name: clean(event.toolName) || "tool", summary: summarizeTool(event.toolName, event.args, cwd), status: "running", startedAt: at(now) }));
      phase = "running"; durationMs = undefined; notify();
    },
    finishTool(event, now): void {
      const id = clean(event.toolCallId), active = activeTools.get(id); if (!active) return;
      activeTools.delete(id);
      const status: ToolActivityStatus = event.isError ? "failed" : "done";
      const completed = Object.freeze({ ...active, status, durationMs: Math.max(0, at(now) - active.startedAt) });
      if (status === "failed") failedCount += 1; else completedCount += 1;
      updateCurrentTurn((turn) => ({ ...turn, tools: Object.freeze([...turn.tools, completed]) }));
      recentTools = [completed, ...recentTools].slice(0, 3); notify();
    },
    settle(now): void {
      if ((phase === "idle" || phase === "settled") && activeTools.size === 0) return;
      const endedAt = at(now);
      for (const active of activeTools.values()) {
        const failed = Object.freeze({ ...active, status: "failed" as const, durationMs: Math.max(0, endedAt - active.startedAt) });
        updateCurrentTurn((turn) => ({ ...turn, tools: Object.freeze([...turn.tools, failed]) }));
        recentTools.unshift(failed); failedCount += 1;
      }
      activeTools = new Map(); recentTools = recentTools.slice(0, 3);
      if (turnNumber !== undefined) {
        turns = turns.map((turn) => turn.number === turnNumber && turn.durationMs === undefined
          ? Object.freeze({ ...turn, durationMs: Math.max(0, endedAt - turn.startedAt), ...(snapshotPerformance() ? { performance: snapshotPerformance() } : {}) }) : turn);
      }
      phase = "settled"; durationMs = Math.max(0, endedAt - (startedAt ?? endedAt)); notify();
    },
    reset(): void {
      phase = "idle"; turnNumber = undefined; startedAt = undefined; durationMs = undefined;
      requestStartedAt = undefined; firstTokenAt = undefined; performance = undefined; turns = [];
      activeTools = new Map(); recentTools = []; completedCount = 0; failedCount = 0; notify();
    },
    getSnapshot(): RunActivitySnapshot {
      return Object.freeze({ phase, ...(turnNumber === undefined ? {} : { turnNumber }), ...(startedAt === undefined ? {} : { startedAt }),
        ...(durationMs === undefined ? {} : { durationMs }), ...(performance ? { performance: snapshotPerformance() } : {}),
        ...(averagePerformance() ? { averagePerformance: averagePerformance() } : {}),
        turns: Object.freeze(turns.map((turn) => Object.freeze({ ...turn, tools: Object.freeze([...turn.tools]) }))),
        activeTools: Object.freeze([...activeTools.values()]), recentTools: Object.freeze([...recentTools]), completedCount, failedCount });
    },
  };
}
