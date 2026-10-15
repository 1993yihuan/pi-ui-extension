import type {
  AgentToolResult,
  Theme,
  ToolRenderers,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { compactCallPrefix } from "./chevron.ts";

type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type MetricColor = "text" | "success" | "error" | "warning" | "muted" | "dim";
type Metric = {
  label: string;
  /** Narrow-screen substitute, used before dropping this metric entirely. */
  shortLabel?: string;
  color: MetricColor;
  group: "calls" | "output";
  /** Lower priority number survives narrower terminals first. */
  priority: number;
};

const CALL_SEPARATOR = " │ ";
const METRIC_SEPARATOR = " · ";
const STATUS_SPACING = "  ";

/** One terminal row regardless of viewport width; no wrapping or padding. */
export function singleLine(line: string): Component {
  return {
    render(width: number): string[] {
      return width > 0 ? [truncateToWidth(line, width, "…")] : [];
    },
    invalidate() {},
  };
}

function formatDuration(durationMs: unknown): string | undefined {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  return durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

function countContent(result: AgentToolResult<any>): { lines: number; images: number } {
  let lines = 0;
  let images = 0;
  for (const block of result.content) {
    if (block.type === "image") images++;
    else if (block.type === "text" &&
      !/^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/.test(block.text)) {
      lines += block.text.split("\n").filter((line) => line.trim().length > 0).length;
    }
  }
  return { lines, images };
}

function codeLineCount(args: unknown): string {
  const code = args !== null && typeof args === "object" && "code" in args
    ? (args as { code?: unknown }).code : undefined;
  if (typeof code !== "string") return "Code: ?";
  return `${code ? code.split("\n").length : 0} code lines`;
}

export function renderCodemodeCompactCall(args: unknown, theme: Theme): Component {
  const label = compactCallPrefix(theme, false) +
    theme.fg("toolTitle", theme.bold("codemode")) +
    theme.fg("dim", `  ${codeLineCount(args)}`);
  return singleLine(label);
}

function formatSummary(
  theme: Theme,
  state: string,
  stateColor: "success" | "error" | "warning",
  metrics: readonly Metric[],
  width: number,
): string {
  const heading = theme.fg(stateColor, state);
  if (width <= visibleWidth(heading)) return truncateToWidth(heading, width, "…");

  // Work out which complete metrics can be shown, then restore display order.
  // Never show half a metric or let Text wrap the row across multiple lines.
  const selected = new Map<Metric, string>();
  const ranked = metrics.slice().sort((a, b) => a.priority - b.priority);
  const compose = (): string => {
    let row = heading;
    let lastGroup: Metric["group"] | undefined;
    for (const metric of metrics) {
      const label = selected.get(metric);
      if (label === undefined) continue;
      // The status glyph is not a metric group. A leading │ after ✓ looks
      // like a stray border; only separate two actual metric groups.
      const separator = !lastGroup ? STATUS_SPACING
        : lastGroup === metric.group ? METRIC_SEPARATOR : CALL_SEPARATOR;
      row += theme.fg("dim", separator) + theme.fg(metric.color, label);
      lastGroup = metric.group;
    }
    return row;
  };
  for (const metric of ranked) {
    selected.set(metric, metric.label);
    if (visibleWidth(compose()) > width) {
      if (metric.shortLabel) selected.set(metric, metric.shortLabel);
      if (visibleWidth(compose()) > width) selected.delete(metric);
    }
  }
  return compose();
}

export function renderCodemodeCompactResult(
  result: AgentToolResult<any>,
  theme: Theme,
  context: RenderContext,
  options: ToolRenderResultOptions,
  runningSince?: number,
): Component {
  const rawCalls: unknown = result.details?.calls;
  const calls: readonly unknown[] = Array.isArray(rawCalls) ? rawCalls : [];
  const statuses = { ok: 0, error: 0, cancelled: 0, running: 0 };
  for (const call of calls) {
    if (!call || typeof call !== "object") continue;
    const state: unknown = (call as { status?: unknown }).status;
    if (state === "ok" || state === "error" || state === "cancelled" || state === "running") {
      statuses[state]++;
    }
  }
  // The outer call may succeed even when a nested tool fails or is cancelled.
  const partialFailure = statuses.error > 0 || statuses.cancelled > 0;
  const status = options.isPartial ? "… Running"
    : context.isError ? "✗ Failed"
    : partialFailure ? "! Partial" : "✓";
  const stateColor = options.isPartial || (partialFailure && !context.isError)
    ? "warning" : context.isError ? "error" : "success";
  const metrics: Metric[] = [];
  const countLabel = (count: number, singular: string): string => `${count} ${singular}${count === 1 ? "" : "s"}`;
  if (calls.length > 0) metrics.push({ label: countLabel(calls.length, "call"), color: "text", group: "calls", priority: 1 });
  if (statuses.ok) metrics.push({ label: `${statuses.ok} ok`, color: "success", group: "calls", priority: 5 });
  if (statuses.error) metrics.push({ label: `${statuses.error} failed`, color: "error", group: "calls", priority: 2 });
  if (statuses.cancelled) metrics.push({ label: `${statuses.cancelled} cancelled`, color: "muted", group: "calls", priority: 3 });
  if (statuses.running) metrics.push({ label: `${statuses.running} running`, color: "warning", group: "calls", priority: 3 });
  if (!options.isPartial) {
    const { lines, images } = countContent(result);
    if (lines) metrics.push({
      label: countLabel(lines, "line"), shortLabel: `${lines} out`,
      color: "muted", group: "output", priority: 6,
    });
    if (images) metrics.push({ label: countLabel(images, "image"), color: "muted", group: "output", priority: 7 });
  }
  // Pi provides durationMs only after completion; partial rows show an
  // estimated elapsed time since their first observed partial result.
  return {
    render(width: number): string[] {
      if (width <= 0) return [];
      const elapsed = options.isPartial && runningSince !== undefined
        ? formatDuration(Math.max(0, Date.now() - runningSince))
        : formatDuration(context.durationMs);
      const visibleMetrics: Metric[] = elapsed
        ? [...metrics, { label: (options.isPartial ? "~" : "") + elapsed, color: "dim", group: "output", priority: 4 }]
        : metrics;
      return [formatSummary(theme, status, stateColor, visibleMetrics, width)];
    },
    invalidate() {},
  };
}
